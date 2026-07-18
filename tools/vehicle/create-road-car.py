"""Generate editable Blender sources for the four original Johannesburg road cars.

Blender uses Z-up and each car faces -Y. The glTF exporter converts that to the game's
Y-up, +Z-forward contract. Every visible part is generated deterministically from the
committed catalog; no downloaded mesh, logo, or manufacturer geometry is involved.
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
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--kind", required=True)
    return parser.parse_args(values)


ARGS = parse_args()
CATALOG = json.loads(Path(ARGS.catalog).read_text())
CAR = next((entry for entry in CATALOG["cars"] if entry["kind"] == ARGS.kind), None)
if not CAR:
    raise RuntimeError(f"Unknown road-car kind: {ARGS.kind}")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0


def material(name, colour, roughness, metallic=0.0, emissive=None, emission_strength=0.0):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*colour, 1.0)
    value.use_nodes = True
    value.use_backface_culling = False
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*colour, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if emissive:
        colour_input = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
        strength_input = shader.inputs.get("Emission Strength")
        if colour_input:
            colour_input.default_value = (*emissive, 1.0)
        if strength_input:
            strength_input.default_value = emission_strength
    return value


MATERIALS = {
    "paint": material("VehiclePaint", tuple(CAR["paintColour"]), 0.22, 0.34),
    "glass": material("VehicleGlass", (0.035, 0.095, 0.13), 0.15, 0.22),
    "trim": material("VehicleTrim", (0.018, 0.025, 0.03), 0.58, 0.18),
    "chrome": material("VehicleChrome", (0.5, 0.55, 0.57), 0.19, 0.92),
    "tire": material("VehicleTire", (0.012, 0.016, 0.018), 0.86),
    "light": material("VehicleLight", (0.96, 0.91, 0.68), 0.11, 0.08, (1.0, 0.72, 0.28), 1.15),
    "brake": material("VehicleBrake", (0.22, 0.005, 0.004), 0.17, 0.02, (0.55, 0.0, 0.0), 1.8),
    "plate": material("VehiclePlate", (0.89, 0.88, 0.78), 0.48),
}
if CAR["style"] == "police":
    MATERIALS.update({
        "livery": material("VehicleLivery", (0.045, 0.18, 0.34), 0.34, 0.12),
        "blue": material("VehicleBlueLight", (0.01, 0.1, 0.8), 0.08, emissive=(0.01, 0.08, 1.0), emission_strength=5.2),
        "red": material("VehicleRedLight", (0.8, 0.015, 0.01), 0.08, emissive=(1.0, 0.01, 0.0), emission_strength=5.2),
    })

root = bpy.data.objects.new(CAR["assetName"], None)
root.empty_display_type = "PLAIN_AXES"
root["vehicleContract"] = {
    "version": CATALOG["contractVersion"],
    "kind": CAR["kind"],
    "units": "metres",
    "forwardAxis": CATALOG["forwardAxis"],
    "upAxis": CATALOG["upAxis"],
    "grounded": True,
    "boundsMetres": CAR["dimensionsMetres"],
    "triangleRange": CAR["triangleRange"],
    "firstPersonHiddenNodes": CATALOG["firstPersonHiddenNodes"],
    "paintMaterial": "VehiclePaint",
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


def finish_mesh(obj, mat, bevel=0.0, segments=3, smooth=None):
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
    use_smooth = bevel > 0 if smooth is None else smooth
    for polygon in obj.data.polygons:
        polygon.use_smooth = use_smooth
    obj["castShadow"] = True
    obj["receiveShadow"] = True
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


def glass_quad(name, vertices, parent):
    mesh = bpy.data.meshes.new(f"{name}Geometry")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.parent = parent
    scene.collection.objects.link(obj)
    return finish_mesh(obj, MATERIALS["glass"], smooth=False)


width, height, length = CAR["dimensionsMetres"]
style = CAR["style"]
wheel_radius = CAR["wheelRadiusMetres"]
wheelbase = CAR["wheelbaseMetres"]
half_length = length * 0.5
paint_width = width - 0.14

# Distinct, grounded silhouettes. The profile shell replaces the old stacked rounded boxes with
# proper bonnet, screen, roof, and hatch/deck breaks visible from street level.
if style == "compact":
    body_height, cabin_width = 0.69, width * 0.86
    cabin_points = [(-1.42, 0.68), (-1.14, 0.83), (-0.72, 1.30), (0.74, 1.30), (1.48, 0.84), (1.55, 0.68)]
    window_z, window_height, side_window_length = 0.91, 0.34, 1.84
elif style == "sport":
    body_height, cabin_width = 0.58, width * 0.84
    cabin_points = [(-1.55, 0.57), (-1.16, 0.68), (-0.61, 1.10), (0.70, 1.10), (1.36, 0.71), (1.56, 0.57)]
    window_z, window_height, side_window_length = 0.79, 0.28, 1.76
elif style == "bakkie":
    body_height, cabin_width = 0.83, width * 0.84
    cabin_points = [(-2.02, 0.82), (-1.68, 1.02), (-1.20, 2.05), (0.30, 2.05), (0.55, 1.78), (0.58, 0.82)]
    window_z, window_height, side_window_length = 1.40, 0.49, 1.65
else:
    body_height, cabin_width = 0.65, width * 0.85
    cabin_points = [(-1.62, 0.64), (-1.28, 0.77), (-0.72, 1.22), (0.76, 1.22), (1.40, 0.76), (1.61, 0.64)]
    window_z, window_height, side_window_length = 0.92, 0.31, 1.92

body = box("body", (paint_width, length - 0.18, body_height), (0, 0, 0.34 + body_height * 0.5), MATERIALS["paint"], bevel=0.11, segments=5)
cabin = empty("cabin")
profile_prism("cabin_shell", cabin_width, cabin_points, MATERIALS["paint"], cabin, bevel=0.045)
roof_y = sum(point[0] for point in cabin_points[2:4]) * 0.5
roof_length = abs(cabin_points[3][0] - cabin_points[2][0]) + 0.18
roof_center_z = max(point[1] for point in cabin_points) + 0.035 if style == "police" else height - 0.045
roof = box("roof", (cabin_width * 0.96, roof_length, 0.09), (0, roof_y, roof_center_z), MATERIALS["paint"], cabin, bevel=0.038, segments=3)

glass = empty("glass", cabin)
for side_name, x in (("left", -cabin_width * 0.505), ("right", cabin_width * 0.505)):
    box(f"window_{side_name}_front", (0.022, side_window_length * 0.48, window_height), (x, -0.43, window_z), MATERIALS["glass"], glass, bevel=0.055, segments=4)
    box(f"window_{side_name}_rear", (0.022, side_window_length * 0.47, window_height), (x, 0.53, window_z), MATERIALS["glass"], glass, bevel=0.055, segments=4)

front_low = cabin_points[1]
front_high = cabin_points[2]
rear_high = cabin_points[3]
rear_low = cabin_points[4]
glass_quad("window_front_left", [(-cabin_width * 0.46, front_low[0] - 0.012, front_low[1] + 0.05), (-0.025, front_low[0] - 0.012, front_low[1] + 0.05), (-0.025, front_high[0] - 0.012, front_high[1] - 0.08), (-cabin_width * 0.46, front_high[0] - 0.012, front_high[1] - 0.08)], glass)
glass_quad("window_front_right", [(0.025, front_low[0] - 0.012, front_low[1] + 0.05), (cabin_width * 0.46, front_low[0] - 0.012, front_low[1] + 0.05), (cabin_width * 0.46, front_high[0] - 0.012, front_high[1] - 0.08), (0.025, front_high[0] - 0.012, front_high[1] - 0.08)], glass)
glass_quad("window_rear", [(-cabin_width * 0.43, rear_low[0] + 0.012, rear_low[1] + 0.05), (cabin_width * 0.43, rear_low[0] + 0.012, rear_low[1] + 0.05), (cabin_width * 0.43, rear_high[0] + 0.012, rear_high[1] - 0.08), (-cabin_width * 0.43, rear_high[0] + 0.012, rear_high[1] - 0.08)], glass)

for side_name, x in (("left", -width * 0.5 + 0.07), ("right", width * 0.5 - 0.07)):
    mirror = box(f"mirror_{side_name}", (0.14, 0.27, 0.16), (x, front_high[0] + 0.2, window_z), MATERIALS["trim"], cabin, bevel=0.05, segments=4)
    box(f"mirror_stalk_{side_name}", (0.15, 0.045, 0.045), (x * 0.92, front_high[0] + 0.2, window_z - 0.03), MATERIALS["trim"], cabin, bevel=0.012, segments=2)

# Door shut-lines, handles, sills, and arches give each side readable scale at driving distance.
for side_name, x in (("left", -paint_width * 0.505), ("right", paint_width * 0.505)):
    for index, y in enumerate((-0.52, 0.55)):
        box(f"door_seam_{side_name}_{index + 1}", (0.025, 0.022, body_height * 0.62), (x, y, 0.56), MATERIALS["trim"], bevel=0.006, segments=2)
        box(f"door_handle_{side_name}_{index + 1}", (0.035, 0.18, 0.045), (x * 1.006, y + 0.22, body_height + 0.11), MATERIALS["chrome"], bevel=0.012, segments=2)
    box(f"side_skirt_{side_name}", (0.08, length * 0.66, 0.14), (x, 0, 0.37), MATERIALS["trim"], bevel=0.035, segments=3)

# Front/rear fascia stays just inside the contracted length; lamps prove +Z-forward after export.
front_y, rear_y = -half_length + 0.055, half_length - 0.055
bumper_front = box("bumper_front", (paint_width * 0.96, 0.11, 0.20), (0, front_y, 0.43), MATERIALS["trim"], bevel=0.045, segments=3)
bumper_rear = box("bumper_rear", (paint_width * 0.96, 0.11, 0.20), (0, rear_y, 0.43), MATERIALS["trim"], bevel=0.045, segments=3)
grille = empty("grille")
grille_width = width * (0.56 if style == "sport" else 0.43)
box("grille_surround", (grille_width, 0.045, 0.27), (0, -half_length + 0.023, 0.67), MATERIALS["trim"], grille, bevel=0.032, segments=3)
for index in range(5):
    box(f"grille_slat_{index + 1}", (grille_width * 0.86, 0.022, 0.018), (0, -half_length + 0.012, 0.58 + index * 0.045), MATERIALS["chrome"], grille, bevel=0.006, segments=2)

lamp_x = width * 0.30
for side_name, x in (("left", -lamp_x), ("right", lamp_x)):
    box(f"headlight_{side_name}", (width * 0.25, 0.075, 0.18), (x, -half_length + 0.038, 0.79), MATERIALS["light"], bevel=0.055, segments=4)
    box(f"brakelight_{side_name}", (width * 0.20, 0.072, 0.22), (x, half_length - 0.038, 0.72), MATERIALS["brake"], bevel=0.05, segments=4)
box("plate_front", (0.48, 0.035, 0.17), (0, -half_length + 0.018, 0.43), MATERIALS["plate"], bevel=0.016, segments=2)
box("plate_rear", (0.48, 0.035, 0.17), (0, half_length - 0.018, 0.43), MATERIALS["plate"], bevel=0.016, segments=2)


def wheel(name, location):
    pivot = empty(name, root, location)
    pivot.rotation_mode = "YXZ" if name in ("wheel_fl", "wheel_fr") else "XYZ"
    major_radius, minor_radius = wheel_radius * 0.75, wheel_radius * 0.25
    bpy.ops.mesh.primitive_torus_add(major_segments=40, minor_segments=12, location=(0, 0, 0), rotation=(0, math.pi / 2, 0), major_radius=major_radius, minor_radius=minor_radius)
    tire = bpy.context.object
    tire.name = f"{name}_tire"
    tire.parent = pivot
    finish_mesh(tire, MATERIALS["tire"], smooth=True)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=wheel_radius * 0.59, depth=0.20, location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
    rim = bpy.context.object
    rim.name = f"{name}_rim"
    rim.parent = pivot
    finish_mesh(rim, MATERIALS["chrome"], 0.008, 2)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=wheel_radius * 0.22, depth=0.225, location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
    hub = bpy.context.object
    hub.name = f"{name}_hub"
    hub.parent = pivot
    finish_mesh(hub, MATERIALS["trim"], 0.006, 2)
    for index in range(5):
        spoke = box(f"{name}_spoke_{index + 1}", (0.23, wheel_radius * 0.12, wheel_radius * 0.72), (0, 0, 0), MATERIALS["chrome"], pivot, bevel=0.012, segments=2, rotation=(index * math.tau / 5, 0, 0))
        spoke.scale.z = 0.55
    return pivot


wheel_x = width * 0.5 - 0.12
front_axle_y, rear_axle_y = -wheelbase * 0.5, wheelbase * 0.5
wheel("wheel_fl", (-wheel_x, front_axle_y, wheel_radius))
wheel("wheel_fr", (wheel_x, front_axle_y, wheel_radius))
wheel("wheel_rl", (-wheel_x, rear_axle_y, wheel_radius))
wheel("wheel_rr", (wheel_x, rear_axle_y, wheel_radius))

# Model-specific detail is deliberately structural, not a badge swap.
if style == "compact":
    for side, x in (("left", -paint_width * 0.507), ("right", paint_width * 0.507)):
        box(f"rub_strip_{side}", (0.035, length * 0.66, 0.07), (x, 0.05, 0.66), MATERIALS["trim"], bevel=0.018, segments=2)
    box("hatch_lip", (width * 0.66, 0.12, 0.07), (0, half_length - 0.12, 1.03), MATERIALS["paint"], bevel=0.025, segments=2)
elif style == "sport":
    box("front_splitter", (width * 0.78, 0.22, 0.08), (0, -half_length + 0.11, 0.28), MATERIALS["trim"], bevel=0.025, segments=3)
    spoiler = box("spoiler", (width * 0.66, 0.26, 0.07), (0, half_length - 0.3, 1.11), MATERIALS["paint"], cabin, bevel=0.025, segments=3)
    for x in (-0.45, 0.45):
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.07, depth=0.24, location=(x, half_length - 0.12, 0.34), rotation=(math.pi / 2, 0, 0))
        exhaust = bpy.context.object
        exhaust.name = f"exhaust_{'left' if x < 0 else 'right'}"
        exhaust.parent = root
        finish_mesh(exhaust, MATERIALS["chrome"], 0.008, 2)
elif style == "bakkie":
    bed = empty("bakkie-bed")
    bed_start, bed_end = 0.52, half_length - 0.10
    bed_length = bed_end - bed_start
    box("bed_floor", (paint_width * 0.88, bed_length, 0.12), (0, (bed_start + bed_end) * 0.5, 0.83), MATERIALS["trim"], bed, bevel=0.025, segments=2)
    box("bed_front_wall", (paint_width * 0.92, 0.12, 0.58), (0, bed_start, 1.08), MATERIALS["paint"], bed, bevel=0.035, segments=3)
    box("tailgate", (paint_width * 0.92, 0.12, 0.58), (0, bed_end, 1.08), MATERIALS["paint"], bed, bevel=0.035, segments=3)
    for side_name, x in (("left", -paint_width * 0.46), ("right", paint_width * 0.46)):
        box(f"bed_rail_{side_name}", (0.13, bed_length, 0.58), (x, (bed_start + bed_end) * 0.5, 1.08), MATERIALS["paint"], bed, bevel=0.04, segments=3)
    for x in (-paint_width * 0.36, paint_width * 0.36):
        box(f"sports_bar_post_{'left' if x < 0 else 'right'}", (0.075, 0.075, 0.68), (x, bed_start + 0.18, 1.47), MATERIALS["chrome"], bed, bevel=0.025, segments=3)
    box("sports_bar_top", (paint_width * 0.78, 0.075, 0.075), (0, bed_start + 0.18, 1.82), MATERIALS["chrome"], bed, bevel=0.025, segments=3)
    box("roof_antenna", (0.035, 0.035, 0.25), (0, 0.0, 2.025), MATERIALS["trim"], cabin, bevel=0.008, segments=2)
elif style == "police":
    for side_name, x in (("left", -paint_width * 0.509), ("right", paint_width * 0.509)):
        box(f"jmpd_panel_{side_name}", (0.025, length * 0.54, 0.32), (x, 0.04, 0.68), MATERIALS["livery"], bevel=0.018, segments=2)
        for index in range(3):
            box(f"chevron_{side_name}_{index + 1}", (0.028, 0.24, 0.06), (x * 1.002, 0.48 + index * 0.29, 0.89), MATERIALS["plate"], bevel=0.012, segments=2, rotation=(0, 0, (-1 if side_name == "left" else 1) * 0.35))
    lightbar = empty("lightbar", cabin)
    box("lightbar_mount", (1.08, 0.19, 0.065), (0, 0.08, 1.27), MATERIALS["trim"], cabin, bevel=0.02, segments=2)
    box("lightbar_blue", (0.46, 0.19, 0.13), (-0.27, 0.08, 1.335), MATERIALS["blue"], lightbar, bevel=0.035, segments=3)
    box("lightbar_red", (0.46, 0.19, 0.13), (0.27, 0.08, 1.335), MATERIALS["red"], lightbar, bevel=0.035, segments=3)

# Dark chassis, suspension rails, and exhaust prevent hollow silhouettes on crests.
box("chassis", (width * 0.72, length * 0.68, 0.13), (0, 0.04, 0.31), MATERIALS["trim"], bevel=0.028, segments=2)
box("exhaust", (0.075, length * 0.48, 0.075), (width * 0.22, length * 0.12, 0.25), MATERIALS["chrome"], bevel=0.024, segments=3)

output = Path(ARGS.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)
print(f"Created {CAR['assetName']} Blender source: {output}")
