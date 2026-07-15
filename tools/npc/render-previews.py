"""Render a four-view turnaround and five-clip contact sheet from an NPC blend."""

import argparse
from array import array
import os
import sys

import bpy
from mathutils import Vector


def arguments():
    raw = sys.argv[sys.argv.index("--") + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--turnaround", required=True)
    parser.add_argument("--contacts", required=True)
    parser.add_argument("--work", required=True)
    return parser.parse_args(raw)


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_scene():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 360
    scene.render.resolution_y = 540
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.get("NpcPreviewWorld") or bpy.data.worlds.new("NpcPreviewWorld")
    scene.world.color = (0.055, 0.06, 0.068)
    bpy.ops.object.camera_add(location=(0, -4.6, 1.25))
    camera = bpy.context.object; camera.data.lens = 74; scene.camera = camera
    for location, energy, size in [((-2.8, -3.4, 4.2), 850, 3.2), ((3.0, -2.0, 2.6), 600, 2.8), ((0, 3.2, 3.5), 900, 2.4)]:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object; light.data.energy = energy; light.data.shape = "DISK"; light.data.size = size
        look_at(light, (0, 0, 0.9))
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, -0.004))
    ground = bpy.context.object; ground.name = "NpcPreviewGround"
    material = bpy.data.materials.new("NpcPreviewGroundMaterial"); material.diffuse_color = (0.035, 0.04, 0.046, 1)
    material.roughness = 0.82; ground.data.materials.append(material)
    return scene, camera


def render_frame(scene, camera, rig, action, frame, location, output):
    rig.animation_data.action = bpy.data.actions[action]
    scene.frame_set(frame)
    rig.location.z = -0.53 if action == "death" else 0
    camera.location = location; look_at(camera, (0, 0, 0.88))
    scene.render.filepath = output; bpy.ops.render.render(write_still=True)


def composite(paths, output):
    sources = [bpy.data.images.load(path, check_existing=False) for path in paths]
    width, height = sources[0].size
    canvas = array("f", [0.0]) * (width * len(sources) * height * 4)
    source_pixels = []
    for source in sources:
        pixels = array("f", [0.0]) * (width * height * 4); source.pixels.foreach_get(pixels); source_pixels.append(pixels)
    source_row = width * 4; canvas_row = width * len(sources) * 4
    for row in range(height):
        for column, pixels in enumerate(source_pixels):
            source_start = row * source_row; target_start = row * canvas_row + column * source_row
            canvas[target_start:target_start + source_row] = pixels[source_start:source_start + source_row]
    image = bpy.data.images.new(os.path.basename(output), width=width * len(sources), height=height, alpha=False)
    image.pixels.foreach_set(canvas); image.filepath_raw = output; image.file_format = "JPEG"; image.save()
    bpy.data.images.remove(image)
    for source in sources: bpy.data.images.remove(source)


def main():
    args = arguments(); os.makedirs(args.work, exist_ok=True); os.makedirs(os.path.dirname(args.turnaround), exist_ok=True)
    scene, camera = setup_scene(); rig = bpy.data.objects[f'Npc_{args.id}']
    views = [(0, -4.6, 1.24), (-4.6, 0, 1.24), (0, 4.6, 1.24), (3.1, -4.1, 1.28)]
    turnaround_parts = []
    for index, location in enumerate(views):
        path = os.path.join(args.work, f"{args.id}-view-{index}.png"); turnaround_parts.append(path)
        render_frame(scene, camera, rig, "idle", 15, location, path)
    composite(turnaround_parts, args.turnaround)
    clip_frames = [("idle", 15), ("walk", 0), ("sprint", 0), ("punch_right", 15), ("death", 30)]
    contact_parts = []
    for action, frame in clip_frames:
        path = os.path.join(args.work, f"{args.id}-{action}.png"); contact_parts.append(path)
        render_frame(scene, camera, rig, action, frame, (2.7, -4.4, 1.28), path)
    composite(contact_parts, args.contacts)


if __name__ == "__main__":
    main()
