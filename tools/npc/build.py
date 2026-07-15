"""Validate an editable NPC source and export interchange and web files."""

import argparse
import json
import os
import sys

import bpy


REQUIRED_BONES = {
    "Hips", "Spine", "Chest", "Head", "UpperArm_L", "LowerArm_L", "Hand_L",
    "UpperArm_R", "LowerArm_R", "Hand_R", "UpperLeg_L", "LowerLeg_L", "Foot_L",
    "UpperLeg_R", "LowerLeg_R", "Foot_R",
}
REQUIRED_CLIPS = {"idle", "walk", "sprint", "punch_right", "death"}


def arguments():
    raw = sys.argv[sys.argv.index("--") + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--fbx", required=True)
    parser.add_argument("--glb", required=True)
    return parser.parse_args(raw)


def load_character(path, character_id):
    with open(path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    return next(character for character in manifest["characters"] if character["id"] == character_id)


def import_source(path):
    extension = os.path.splitext(path)[1].lower()
    if extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    elif extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
    elif extension in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=path, import_pack_images=False)
    else:
        raise RuntimeError(f"Unsupported NPC source: {extension}")


def validate_and_clean(config):
    bpy.context.scene.render.fps = 30
    bone_names = {bone.name for armature in bpy.data.armatures for bone in armature.bones}
    missing_bones = REQUIRED_BONES - bone_names
    if missing_bones:
        raise RuntimeError(f"Missing humanoid bones: {sorted(missing_bones)}")
    action_names = {action.name for action in bpy.data.actions}
    if action_names != REQUIRED_CLIPS:
        raise RuntimeError(f"Animation contract mismatch; found={sorted(action_names)}")
    for action in bpy.data.actions:
        action.use_fake_user = True
        if hasattr(action, "fcurves"):
            for curve in list(action.fcurves):
                if curve.data_path.endswith("location"):
                    action.fcurves.remove(curve)
        else:
            for slot in action.slots:
                for layer in action.layers:
                    for strip in layer.strips:
                        bag = strip.channelbag(slot, ensure=False)
                        if bag:
                            for curve in list(bag.fcurves):
                                if curve.data_path.endswith("location"):
                                    bag.fcurves.remove(curve)
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    if len(meshes) > 5:
        raise RuntimeError(f"NPC has {len(meshes)} skinned material meshes; limit is five")
    for obj in meshes:
        for vertex in obj.data.vertices:
            weighted = sorted(
                ((element.group, element.weight) for element in vertex.groups if element.weight > 0),
                key=lambda item: item[1], reverse=True,
            )
            for group_index, _weight in weighted[4:]:
                obj.vertex_groups[group_index].remove([vertex.index])
    root = bpy.data.objects.get(f'Npc_{config["id"]}')
    if root is None:
        raise RuntimeError(f'Missing Npc_{config["id"]} root')
    root["npcContract"] = {
        "version": 1,
        "characterId": config["id"],
        "heightMetres": config["heightMetres"],
        "forwardAxis": "+Z",
        "feetAtOrigin": True,
        "fps": 30,
    }


def export_files(args):
    os.makedirs(os.path.dirname(args.fbx), exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=args.fbx, use_selection=False, add_leaf_bones=False, bake_anim=True,
        bake_anim_use_all_actions=True, bake_anim_simplify_factor=0.0, axis_forward="Z", axis_up="Y",
    )
    bpy.ops.export_scene.gltf(
        filepath=args.glb, export_format="GLB", export_animations=True, export_frame_range=False,
        export_force_sampling=False, export_sampling_interpolation_fallback="LINEAR", export_skins=True,
        export_all_influences=False, export_image_format="AUTO", export_yup=True, export_extras=True,
    )


def main():
    args = arguments()
    config = load_character(args.manifest, args.id)
    import_source(args.source)
    validate_and_clean(config)
    export_files(args)


if __name__ == "__main__":
    main()
