"""Create the deterministic Blender source for the Quantum Express minibus.

Blender uses Z-up and the minibus faces -Y. The glTF exporter converts that to the runtime
contract: Y-up and +Z forward. Dimensions deliberately retain the existing taxi footprint.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy


def parse_args():
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--recipe", required=True)
    parser.add_argument("--texture", required=True)
    return parser.parse_args(values)


ARGS = parse_args()
RECIPE = json.loads(Path(ARGS.recipe).read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0


def material(name, colour, roughness, metallic=0.0, image=None, emissive=None, emission_strength=0.0):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*colour, 1.0)
    value.use_nodes = True
    value.use_backface_culling = False
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*colour, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if image:
        texture = value.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = image
        value.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    if emissive:
        colour_input = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
        strength_input = shader.inputs.get("Emission Strength")
        if colour_input:
            colour_input.default_value = (*emissive, 1.0)
        if strength_input:
            strength_input.default_value = emission_strength
    return value


atlas = bpy.data.images.load(str(Path(ARGS.texture).resolve()), check_existing=False)
atlas.name = "QuantumExpressBaseColor"
atlas.pack()

MATERIALS = {
    "body": material("TaxiBody", (0.91, 0.92, 0.88), 0.24, 0.18),
    "livery": material("TaxiLivery", (1.0, 1.0, 1.0), 0.42, image=atlas),
    "glass": material("TaxiGlass", (0.055, 0.12, 0.15), 0.16, 0.16),
    "trim": material("TaxiTrim", (0.028, 0.035, 0.038), 0.55, 0.22),
    "chrome": material("TaxiChrome", (0.48, 0.52, 0.53), 0.2, 0.9),
    "tire": material("TaxiTire", (0.018, 0.022, 0.024), 0.82),
    "light": material("TaxiLight", (0.92, 0.88, 0.68), 0.12, 0.08, emissive=(1.0, 0.72, 0.3), emission_strength=1.15),
    "brake": material("TaxiBrake", (0.22, 0.008, 0.006), 0.18, emissive=(0.5, 0.0, 0.0), emission_strength=1.8),
    "plate": material("TaxiPlate", (1.0, 1.0, 1.0), 0.45, image=atlas),
}


root = bpy.data.objects.new(RECIPE["assetName"], None)
root.empty_display_type = "PLAIN_AXES"
root["taxiContract"] = {
    "version": RECIPE["contractVersion"],
    "units": "metres",
    "forwardAxis": RECIPE["forwardAxis"],
    "upAxis": RECIPE["upAxis"],
    "grounded": True,
    "textureSize": RECIPE["textureSize"],
    "triangleRange": RECIPE["triangleRange"],
    "boundsMetres": RECIPE["dimensionsMetres"],
    "firstPersonHiddenNodes": RECIPE["firstPersonHiddenNodes"],
    "sharedGeometry": True,
    "mutableMaterialsPerInstance": True,
}
scene.collection.objects.link(root)


def empty(name, parent=root, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.parent = parent
    obj.location = location
    scene.collection.objects.link(obj)
    return obj


def finish_mesh(obj, mat, bevel=0.0, segments=3):
    obj.data.materials.append(mat)
    if bevel > 0:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        modifier = obj.modifiers.new("production_bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    for polygon in obj.data.polygons:
        polygon.use_smooth = bevel > 0
    return obj


def box(name, dimensions, location, mat, parent=root, bevel=0.0, segments=3, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.parent = parent
    return finish_mesh(obj, mat, bevel, segments)


def profile_prism(name, width, points, mat, parent, bevel=0.0):
    vertices = []
    half = width * 0.5
    for x in (-half, half):
        vertices.extend((x, y, z) for y, z in points)
    count = len(points)
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        following = (index + 1) % count
        faces.append((index, following, count + following, count + index))
    mesh = bpy.data.meshes.new(f"{name}Geometry")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.parent = parent
    scene.collection.objects.link(obj)
    return finish_mesh(obj, mat, bevel, 3)


def textured_quad(name, vertices, uv_pixels, mat, parent=root):
    mesh = bpy.data.meshes.new(f"{name}Geometry")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        pixel = uv_pixels[loop.vertex_index]
        layer.data[loop.index].uv = (pixel[0] / 2048.0, 1.0 - pixel[1] / 2048.0)
    obj = bpy.data.objects.new(name, mesh)
    obj.parent = parent
    scene.collection.objects.link(obj)
    return finish_mesh(obj, mat)


def glass_quad(name, vertices, parent):
    mesh = bpy.data.meshes.new(f"{name}Geometry")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.parent = parent
    scene.collection.objects.link(obj)
    return finish_mesh(obj, MATERIALS["glass"])


# Main shell: a grounded, cab-over high roof with a short sloping nose.
body = box("body", (2.02, 4.96, 0.82), (0, 0, 0.81), MATERIALS["body"], bevel=0.11, segments=5)
cabin = empty("cabin")
shell_points = [(-2.43, 0.98), (-2.18, 1.13), (-1.79, 2.08), (-1.52, 2.27), (2.37, 2.27), (2.48, 1.02)]
profile_prism("cabin_shell", 1.96, shell_points, MATERIALS["body"], cabin, bevel=0.045)
roof = box("roof", (1.88, 3.84, 0.13), (0, 0.35, 2.245), MATERIALS["body"], cabin, bevel=0.06, segments=4)

# Dark opaque glazing keeps the game on the fast opaque path while retaining the photo's window rhythm.
glass = empty("glass", cabin)
side_windows = [
    ("front", -1.43, 0.68),
    ("sliding_front", -0.52, 0.86),
    ("sliding_rear", 0.46, 0.84),
    ("rear", 1.42, 0.82),
]
for side_name, x in (("left", -0.992), ("right", 0.992)):
    for window_name, y, length in side_windows:
        z = 1.63 if window_name != "front" else 1.58
        box(f"window_{side_name}_{window_name}", (0.025, length, 0.67), (x, y, z), MATERIALS["glass"], glass, bevel=0.075, segments=4)

# Split sloped windscreen and rear window. Front is -Y in Blender, +Z after glTF conversion.
for name, x0, x1 in (("window_front_left", -0.86, -0.035), ("window_front_right", 0.035, 0.86)):
    glass_quad(name, [(x0, -2.195, 1.14), (x1, -2.195, 1.14), (x1, -1.805, 1.98), (x0, -1.805, 1.98)], glass)
glass_quad("window_rear", [(-0.82, 2.486, 1.23), (0.82, 2.486, 1.23), (0.82, 2.44, 1.98), (-0.82, 2.44, 1.98)], glass)

# Mirrors and their short stalks are separate named cabin components.
for side_name, x in (("left", -1.105), ("right", 1.105)):
    box(f"mirror_stalk_{side_name}", (0.2, 0.055, 0.055), (x * 0.94, -1.73, 1.63), MATERIALS["trim"], cabin, bevel=0.018, segments=2)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, location=(x, -1.73, 1.64), scale=(0.13, 0.2, 0.11))
    mirror = bpy.context.object
    mirror.name = f"mirror_{side_name}"
    mirror.parent = cabin
    finish_mesh(mirror, MATERIALS["trim"])

# Sliding-door rail and panel seams on the passenger (right) side.
box("sliding_door_rail", (0.035, 1.94, 0.035), (1.018, 0.43, 0.96), MATERIALS["trim"], root, bevel=0.012, segments=2)
for y in (-0.98, 1.34):
    box(f"door_seam_{'front' if y < 0 else 'rear'}", (0.028, 0.025, 0.82), (1.02, y, 0.83), MATERIALS["trim"], root, bevel=0.008, segments=2)

# Original generated ribbon and exact deterministic copy on both side panels. U reverses on
# opposite physical sides so words read normally from either pavement, never mirror backwards.
side_uv = [(2048, 2048), (0, 2048), (0, 840), (2048, 840)]
textured_quad("livery_left", [(-1.017, -2.25, 0.47), (-1.017, 2.30, 0.47), (-1.017, 2.30, 1.11), (-1.017, -2.25, 1.11)], side_uv, MATERIALS["livery"])
textured_quad("livery_right", [(1.017, 2.30, 0.47), (1.017, -2.25, 0.47), (1.017, -2.25, 1.11), (1.017, 2.30, 1.11)], side_uv, MATERIALS["livery"])
brand_uv = [(1750, 760), (300, 760), (300, 500), (1750, 500)]
textured_quad("brand_left", [(-1.019, -1.72, 1.05), (-1.019, 1.45, 1.05), (-1.019, 1.45, 1.27), (-1.019, -1.72, 1.27)], brand_uv, MATERIALS["livery"])
textured_quad("brand_right", [(1.019, 1.45, 1.05), (1.019, -1.72, 1.05), (1.019, -1.72, 1.27), (1.019, 1.45, 1.27)], brand_uv, MATERIALS["livery"])

# Front/rear bumpers, grille, lamps, and fictional registration plates.
bumper_front = box("bumper_front", (1.88, 0.18, 0.22), (0, -2.53, 0.48), MATERIALS["trim"], bevel=0.055, segments=3)
bumper_rear = box("bumper_rear", (1.9, 0.18, 0.2), (0, 2.53, 0.48), MATERIALS["trim"], bevel=0.05, segments=3)
grille = empty("grille")
box("grille_surround", (1.04, 0.055, 0.4), (0, -2.492, 0.77), MATERIALS["trim"], grille, bevel=0.04, segments=3)
for index in range(5):
    box(f"grille_slat_{index + 1}", (0.9, 0.035, 0.027), (0, -2.526, 0.63 + index * 0.065), MATERIALS["chrome"], grille, bevel=0.009, segments=2)

for side_name, x in (("left", -0.59), ("right", 0.59)):
    box(f"headlight_{side_name}", (0.48, 0.075, 0.22), (x, -2.505, 0.9), MATERIALS["light"], root, bevel=0.065, segments=4)
    box(f"brakelight_{side_name}", (0.3, 0.07, 0.48), (x * 1.22, 2.505, 0.93), MATERIALS["brake"], root, bevel=0.05, segments=4)

plate_pixels = [(64, 314), (608, 314), (608, 72), (64, 72)]
textured_quad("plate_front", [(-0.36, -2.626, 0.34), (0.36, -2.626, 0.34), (0.36, -2.626, 0.54), (-0.36, -2.626, 0.54)], plate_pixels, MATERIALS["plate"])
textured_quad("plate_rear", [(0.36, 2.626, 0.34), (-0.36, 2.626, 0.34), (-0.36, 2.626, 0.54), (0.36, 2.626, 0.54)], plate_pixels, MATERIALS["plate"])


def wheel(name, location):
    pivot = empty(name, root, location)
    pivot.rotation_mode = "YXZ" if name in ("wheel_fl", "wheel_fr") else "XYZ"
    bpy.ops.mesh.primitive_torus_add(major_segments=48, minor_segments=16, location=(0, 0, 0), rotation=(0, math.pi / 2, 0), major_radius=0.31, minor_radius=0.095)
    tire = bpy.context.object
    tire.name = f"{name}_tire"
    tire.parent = pivot
    finish_mesh(tire, MATERIALS["tire"])
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.225, depth=0.25, location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
    rim = bpy.context.object
    rim.name = f"{name}_rim"
    rim.parent = pivot
    finish_mesh(rim, MATERIALS["chrome"], 0.012, 2)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.095, depth=0.275, location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
    hub = bpy.context.object
    hub.name = f"{name}_hub"
    hub.parent = pivot
    finish_mesh(hub, MATERIALS["trim"], 0.01, 2)
    for index in range(6):
        spoke = box(f"{name}_spoke_{index + 1}", (0.27, 0.052, 0.29), (0, 0, 0), MATERIALS["chrome"], pivot, bevel=0.016, segments=2, rotation=(index * math.pi / 3, 0, 0))
        spoke.scale.z = 0.72
    return pivot


wheel("wheel_fl", (-0.88, -1.6, 0.405))
wheel("wheel_fr", (0.88, -1.6, 0.405))
wheel("wheel_rl", (-0.88, 1.6, 0.405))
wheel("wheel_rr", (0.88, 1.6, 0.405))

# Underside silhouettes keep daylight views from looking hollow.
box("chassis", (1.58, 3.75, 0.18), (0, 0.15, 0.4), MATERIALS["trim"], bevel=0.035, segments=2)
box("exhaust", (0.09, 2.25, 0.09), (0.57, 0.75, 0.31), MATERIALS["chrome"], bevel=0.028, segments=3)

for obj in scene.objects:
    if obj.type == "MESH":
        obj["castShadow"] = True
        obj["receiveShadow"] = True

output = Path(ARGS.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)
print(f"Created Quantum Express Blender source: {output}")
