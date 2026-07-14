"""Create the deterministic, editable Blender source for the Johannesburg tree library.

The geometry is intentionally low-poly and material-led: it must survive thousands of streamed
instances after Three.js bakes each city cell into shared material buckets. Blender owns the forms,
normals, material setup, hierarchy, and metadata; runtime code only clones and uniformly scales them.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def args_after_separator():
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--recipe", required=True)
    return parser.parse_args(values)


ARGS = args_after_separator()
RECIPE = json.loads(Path(ARGS.recipe).read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0


def material(name, colour, roughness=0.92, double_sided=False):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*colour, 1.0)
    value.use_nodes = True
    value.use_backface_culling = not double_sided
    principled = value.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*colour, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    return value


MATERIALS = {
    "BarkDark": material("BarkDark", (0.19, 0.12, 0.065)),
    "BarkWarm": material("BarkWarm", (0.31, 0.21, 0.12)),
    "BarkPale": material("BarkPale", (0.57, 0.52, 0.42)),
    "LeafGreen": material("LeafGreen", (0.19, 0.36, 0.12), double_sided=True),
    "LeafDark": material("LeafDark", (0.095, 0.22, 0.075), double_sided=True),
    "LeafDusty": material("LeafDusty", (0.34, 0.43, 0.28), double_sided=True),
    "LeafOlive": material("LeafOlive", (0.32, 0.39, 0.16), double_sided=True),
    "PineNeedles": material("PineNeedles", (0.075, 0.21, 0.12), double_sided=True),
    "JacarandaBloom": material("JacarandaBloom", (0.43, 0.27, 0.68), double_sided=True),
    "JacarandaDeep": material("JacarandaDeep", (0.29, 0.17, 0.49), double_sided=True),
    "CoralBloom": material("CoralBloom", (0.62, 0.09, 0.035), double_sided=True),
    "PalmFrond": material("PalmFrond", (0.14, 0.36, 0.10), double_sided=True),
    "PalmDry": material("PalmDry", (0.42, 0.34, 0.15), double_sided=True),
}

library = bpy.data.objects.new(RECIPE["library"], None)
library.empty_display_type = "PLAIN_AXES"
library["treeContract"] = {
    "version": RECIPE["contractVersion"],
    "units": "metres",
    "upAxis": "+Y",
    "grounded": True,
    "variantsPerSpecies": 2,
}
scene.collection.objects.link(library)


def cone_between(name, start, end, r0, r1, mat, sides=7):
    start_v, end_v = Vector(start), Vector(end)
    delta = end_v - start_v
    bpy.ops.mesh.primitive_cone_add(
        vertices=sides,
        radius1=r0,
        radius2=r1,
        depth=delta.length,
        end_fill_type="NGON",
        location=(start_v + end_v) * 0.5,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    obj.data.materials.append(MATERIALS[mat])
    return obj


def ico_cluster(name, location, radius, scale, mat, rotation=0.0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler[2] = rotation
    obj.data.materials.append(MATERIALS[mat])
    return obj


def leaf_card(name, location, width, length, yaw, droop, mat):
    # A six-triangle spear/leaf fan, bent at its central vein for a readable silhouette.
    verts = [
        (0, 0, -length * 0.12),
        (-width * 0.48, 0, length * 0.12),
        (-width * 0.28, 0.035, length * 0.48),
        (0, 0.06, length * 0.62),
        (width * 0.28, 0.035, length * 0.48),
        (width * 0.48, 0, length * 0.12),
        (0, -0.03, length * 0.22),
    ]
    faces = [(0, 1, 6), (1, 2, 6), (2, 3, 6), (3, 4, 6), (4, 5, 6), (5, 0, 6)]
    mesh = bpy.data.meshes.new(f"{name}Geometry")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(MATERIALS[mat])
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (droop, 0, yaw)
    return obj


def palm_frond(name, location, yaw, length, width, droop, mat="PalmFrond"):
    stations = 7
    verts = []
    for index in range(stations):
        t = index / (stations - 1)
        half = width * math.sin(math.pi * t) * (1 - t * 0.3)
        forward = length * t
        down = -droop * t * t
        verts.extend([(-half, forward, down), (half, forward, down)])
    faces = []
    for index in range(stations - 1):
        a = index * 2
        faces.extend([(a, a + 1, a + 2), (a + 1, a + 3, a + 2)])
    mesh = bpy.data.meshes.new(f"{name}Geometry")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(MATERIALS[mat])
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler[2] = yaw
    return obj


def begin_model(spec):
    root = bpy.data.objects.new(f"{spec['species']}__{spec['variant']}", None)
    root["treeAsset"] = {
        "species": spec["species"],
        "variant": spec["variant"],
        "maxFootprint": spec["maxFootprint"],
        "trunkCollider": spec["trunkCollider"],
    }
    scene.collection.objects.link(root)
    root.parent = library
    return root, []


def finish_model(root, parts):
    for obj in parts:
        obj.parent = root
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        obj.select_set(False)
    # One joined mesh per variant keeps the runtime source lightweight; glTF retains material groups.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    mesh = bpy.context.object
    mesh.name = f"{root.name}__mesh"
    mesh.data.name = f"{root.name}Geometry"
    mesh.parent = root
    bpy.context.view_layer.update()
    corners = [mesh.matrix_world @ Vector(corner) for corner in mesh.bound_box]
    min_x, max_x = min(point.x for point in corners), max(point.x for point in corners)
    min_y, max_y = min(point.y for point in corners), max(point.y for point in corners)
    min_z = min(point.z for point in corners)
    mesh.location.x -= (min_x + max_x) * 0.5
    mesh.location.y -= (min_y + max_y) * 0.5
    mesh.location.z -= min_z
    for polygon in mesh.data.polygons:
        polygon.use_smooth = True
    # Smooth corner normals without subdivision: organic light response at the same triangle count.
    for face in mesh.data.polygons:
        if len(face.vertices) <= 4:
            face.use_smooth = True


def broadleaf(spec, style):
    root, parts = begin_model(spec)
    v = spec["variant"]
    if style == "jacaranda":
        height, radius = (7.4 + 0.35 * v), 4.6
        bark = "BarkDark"
        leaf = "JacarandaBloom" if v else "LeafGreen"
        accent = "JacarandaDeep" if v else "LeafDark"
        trunk_end = (0.08 * v, -0.05, 3.25 + 0.2 * v)
        parts.append(cone_between("trunk", (0, 0, 0), trunk_end, 0.38, 0.19, bark, 8))
        forks = [(-1.55, -0.45, 5.35), (1.45, 0.6, 5.45), (0.35, 1.5, 5.65)]
        clusters = [(-2.15, -0.8, 6.05, 1.65, 1.15), (1.95, 0.75, 6.2, 1.75, 1.1),
                    (0.1, 1.8, 6.45, 1.55, 1.0), (0.0, -1.6, 6.35, 1.65, 1.08)]
    elif style == "shade-tree":
        height, radius = (8.1 + 0.35 * v), 5.5
        bark = "BarkPale" if v else "BarkWarm"
        leaf, accent = "LeafGreen", "LeafDark"
        trunk_end = (-0.08, 0.08 * v, 3.65 + 0.2 * v)
        parts.append(cone_between("trunk", (0, 0, 0), trunk_end, 0.5, 0.22, bark, 9))
        forks = [(-1.75, -0.5, 5.75), (1.8, 0.45, 5.8), (-0.2, 1.8, 5.95), (0.4, -1.55, 5.65)]
        clusters = [(-2.45, -0.9, 6.7, 2.05, 1.28), (2.3, 0.75, 6.85, 2.0, 1.25),
                    (-0.2, 2.25, 6.95, 1.95, 1.2), (0.25, -2.0, 6.8, 1.95, 1.2), (0, 0, 7.35, 2.25, 1.25)]
    elif style == "acacia":
        height, radius = (5.5 + 0.25 * v), 3.75
        bark, leaf, accent = "BarkDark", "LeafOlive", "LeafDark"
        trunk_end = (0, 0, 2.75 + 0.2 * v)
        parts.append(cone_between("trunk", (0, 0, 0), trunk_end, 0.34, 0.16, bark, 7))
        forks = [(-1.65, -0.2, 4.2), (1.55, 0.3, 4.25), (0.1, 1.5, 4.05)]
        clusters = [(-1.75, -0.45, 4.7, 1.65, 0.52), (1.7, 0.5, 4.75, 1.7, 0.5),
                    (0.0, 1.45, 4.65, 1.55, 0.48), (0.0, -1.25, 4.6, 1.65, 0.5)]
    else:  # landmark-tree
        height, radius = (11.8 + 0.45 * v), 7.7
        bark, leaf, accent = "BarkDark", ("CoralBloom" if v else "LeafGreen"), "LeafDark"
        trunk_end = (0.25 * (1 if v else -1), 0.1, 5.5 + 0.25 * v)
        parts.append(cone_between("trunk", (0, 0, 0), trunk_end, 0.88, 0.36, bark, 10))
        parts.append(cone_between("root-flare-a", (-1.0, 0, 0), (0, 0, 1.1), 0.18, 0.55, bark, 6))
        parts.append(cone_between("root-flare-b", (0.9, 0.5, 0), (0, 0, 1.0), 0.16, 0.5, bark, 6))
        forks = [(-3.1, -0.75, 8.2), (3.15, 0.8, 8.45), (-0.4, 3.0, 8.55), (0.55, -2.9, 8.25), (2.2, -2.2, 8.8)]
        clusters = [(-3.45, -1.0, 9.4, 2.8, 1.45), (3.45, 1.0, 9.6, 2.85, 1.45),
                    (-0.45, 3.45, 9.75, 2.65, 1.35), (0.55, -3.25, 9.5, 2.7, 1.4),
                    (2.35, -2.2, 9.9, 2.55, 1.35), (0, 0, 10.45, 3.1, 1.5)]

    if v:
        # Rotate, compress and stagger the second crown layout so variants differ in silhouette,
        # not only in colour. The final centring pass keeps both safely inside one catalog footprint.
        forks = [(y * 0.9, -x * 0.9, z + (0.12 if index % 2 else -0.08)) for index, (x, y, z) in enumerate(forks)]
        clusters = [(y * 0.94, -x * 0.9, z + (0.18 if index % 2 else -0.06), r * (0.94 + 0.03 * (index % 3)), squash)
                    for index, (x, y, z, r, squash) in enumerate(clusters)]
        if style == "acacia":
            parts.append(cone_between("split-leader", (0.06, 0.02, 0.3), (-0.5, 0.22, 3.25), 0.24, 0.11, bark, 7))

    for index, endpoint in enumerate(forks):
        start = (trunk_end[0] * 0.8, trunk_end[1] * 0.8, trunk_end[2] * (0.72 + 0.04 * (index % 2)))
        parts.append(cone_between(f"limb-{index}", start, endpoint, 0.18 if style != "landmark-tree" else 0.3,
                                  0.06 if style != "landmark-tree" else 0.1, bark, 6))
    for index, (x, y, z, r, squash) in enumerate(clusters):
        use_mat = accent if index % 3 == 1 else leaf
        parts.append(ico_cluster(f"crown-{index}", (x, y, z), r, (1.0, 0.88 + 0.05 * (index % 2), squash), use_mat, index * 0.71))

    card_count = 8 if style != "landmark-tree" else 12
    for index in range(card_count):
        angle = index * math.tau / card_count + v * 0.17
        r = radius * (0.77 + 0.07 * (index % 3))
        z = height - 1.25 + 0.32 * ((index * 5) % 4)
        parts.append(leaf_card(f"leaf-fan-{index}", (math.cos(angle) * r, math.sin(angle) * r, z),
                               0.62 if style != "landmark-tree" else 0.9,
                               1.0 if style != "landmark-tree" else 1.35,
                               angle - math.pi / 2, 0.18 + 0.05 * (index % 2), leaf))
    finish_model(root, parts)


def gum(spec):
    root, parts = begin_model(spec)
    v = spec["variant"]
    height = 12.2 + 0.55 * v
    lean = 0.22 if v else -0.12
    parts.append(cone_between("pale-trunk", (0, 0, 0), (lean, 0.12, height - 1.1), 0.34, 0.12, "BarkPale", 8))
    parts.append(cone_between("bark-sock", (0, 0, 0), (lean * 0.18, 0.02, 2.4), 0.38, 0.29, "BarkWarm", 8))
    forks = [(-1.05, -0.2, height - 0.4), (1.2, 0.35, height), (0.25, 1.35, height - 0.8)]
    for index, endpoint in enumerate(forks):
        parts.append(cone_between(f"limb-{index}", (lean, 0.1, height - 3.0 + index * 0.3), endpoint, 0.11, 0.035, "BarkPale", 6))
        parts.append(ico_cluster(f"tuft-{index}", endpoint, 1.1 + 0.1 * (index % 2), (1.0, 0.8, 0.72), "LeafDusty", index))
    for index in range(7):
        angle = index * math.tau / 7 + v * 0.21
        parts.append(leaf_card(f"gum-leaves-{index}", (math.cos(angle) * 1.65 + lean, math.sin(angle) * 1.65, height - 0.7 + 0.35 * (index % 3)),
                               0.42, 0.9, angle - math.pi / 2, 0.42, "LeafDusty"))
    finish_model(root, parts)


def pine(spec):
    root, parts = begin_model(spec)
    v = spec["variant"]
    if v == 0:
        height = 8.8
        parts.append(cone_between("trunk", (0, 0, 0), (0, 0, height), 0.34, 0.08, "BarkWarm", 7))
        for tier in range(5):
            z0 = 1.5 + tier * 1.25
            radius = 3.05 - tier * 0.48
            parts.append(cone_between(f"needle-tier-{tier}", (0, 0, z0), (0, 0, z0 + 2.4), radius, 0.03, "PineNeedles", 9))
    else:
        height = 8.4
        parts.append(cone_between("trunk", (0, 0, 0), (0.2, -0.1, 6.4), 0.39, 0.16, "BarkWarm", 8))
        for index, endpoint in enumerate([(-1.6, -0.4, 7.0), (1.7, 0.4, 7.15), (0, 1.5, 7.1)]):
            parts.append(cone_between(f"limb-{index}", (0.15, -0.08, 5.5), endpoint, 0.15, 0.04, "BarkWarm", 6))
        for index, location in enumerate([(-1.45, -0.45, 7.35), (1.45, 0.45, 7.45), (0, 1.35, 7.4), (0, -1.15, 7.35), (0, 0, 7.85)]):
            parts.append(ico_cluster(f"umbrella-{index}", location, 1.35 if index < 4 else 1.6, (1.0, 0.9, 0.45), "PineNeedles", index))
    finish_model(root, parts)


def palm(spec):
    root, parts = begin_model(spec)
    v = spec["variant"]
    height = 7.7 + v * 0.45
    points = [(0, 0, 0), (0.08, 0, 2.0), (0.2 + v * 0.12, 0.05, 4.1), (0.35 + v * 0.28, 0.12, height)]
    for index in range(len(points) - 1):
        parts.append(cone_between(f"trunk-{index}", points[index], points[index + 1], 0.31 - index * 0.035, 0.275 - index * 0.04, "BarkWarm", 8))
    top = points[-1]
    parts.append(ico_cluster("crown-heart", top, 0.42, (1, 1, 0.8), "LeafDark"))
    for index in range(8):
        angle = index * math.tau / 8 + v * 0.11
        mat = "PalmDry" if index == 7 and v else "PalmFrond"
        parts.append(palm_frond(f"frond-{index}", top, angle, 2.6 + 0.18 * (index % 2), 0.43, 1.2 + 0.18 * (index % 3), mat))
    finish_model(root, parts)


for specification in RECIPE["variants"]:
    species = specification["species"]
    if species in {"jacaranda", "shade-tree", "acacia", "landmark-tree"}:
        broadleaf(specification, species)
    elif species == "gum":
        gum(specification)
    elif species == "pine":
        pine(specification)
    elif species == "palm":
        palm(specification)
    else:
        raise RuntimeError(f"Unhandled tree species: {species}")

# Make export stable and inspectable.
for obj in bpy.data.objects:
    obj.select_set(False)
bpy.context.view_layer.objects.active = None
scene.world = bpy.data.worlds.new("TreeLibraryWorld")
scene.world.color = (0.035, 0.035, 0.035)
Path(ARGS.output).parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(Path(ARGS.output).resolve()))
print(f"Created editable tree source: {ARGS.output}")
