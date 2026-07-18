"""Export one generated road-car GLB and render four verification views."""

import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector


values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--preview-dir", required=True)
parser.add_argument("--root", required=True)
args = parser.parse_args(values)

root = bpy.data.objects.get(args.root)
contract = root.get("vehicleContract", {}) if root else {}
if not root or contract.get("version") != 1:
    raise RuntimeError(f"Road-car source is missing the {args.root} v1 contract")

output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for child in root.children_recursive:
    child.select_set(True)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(
    filepath=str(output),
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_apply=True,
    export_extras=True,
    export_animations=False,
    export_skins=False,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_cameras=False,
    export_lights=False,
)
print(f"Exported road-car GLB: {output}")


def look_at(camera, target):
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()


width, height, length = contract["boundsMetres"]
world = bpy.data.worlds.new("PreviewWorld") if not bpy.data.worlds else bpy.data.worlds[0]
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.055, 0.07, 0.085, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
scene = bpy.context.scene
scene.world = world
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 800
scene.render.resolution_y = 450
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.render.image_settings.color_mode = "RGBA"

bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -0.012))
ground = bpy.context.object
ground.name = "preview_ground"
ground_mat = bpy.data.materials.new("PreviewGround")
ground_mat.diffuse_color = (0.12, 0.14, 0.16, 1)
ground_mat.use_nodes = True
ground.data.materials.append(ground_mat)

for name, location, energy, size in (
    ("key", (-5, -5, 7), 1450, 5.5),
    ("fill", (5, -1, 4), 900, 4.0),
    ("rim", (1, 6, 5), 1100, 3.0),
):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    light = bpy.data.objects.new(name, data)
    light.location = location
    scene.collection.objects.link(light)
    light.rotation_euler = (Vector((0, 0, height * 0.5)) - light.location).to_track_quat("-Z", "Y").to_euler()

camera_data = bpy.data.cameras.new("PreviewCamera")
camera = bpy.data.objects.new("PreviewCamera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
camera_data.lens = 56
distance = max(6.0, length * 1.55)
side_distance = max(5.3, length * 1.3)
preview_dir = Path(args.preview_dir).resolve()
preview_dir.mkdir(parents=True, exist_ok=True)
views = [
    ((distance * 0.72, -distance, height * 2.0), "front-left"),
    ((-distance * 0.72, distance, height * 1.9), "rear-right"),
    ((side_distance, 0.0, height * 1.6), "side"),
    ((0.0, -distance * 1.08, height * 1.55), "front"),
]
for index, (location, label) in enumerate(views):
    camera.location = location
    look_at(camera, (0, 0, height * 0.48))
    scene.render.filepath = str(preview_dir / f"{index}-{label}.png")
    bpy.ops.render.render(write_still=True)
print(f"Rendered road-car verification views: {preview_dir}")
