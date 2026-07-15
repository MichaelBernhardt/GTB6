"""Create the editable Johannesburg protagonist source with MPFB.

This script intentionally depends on MPFB and the CC0 MakeHuman asset packs installed in
Blender's user data. It creates the real human topology and outfit source; build.py is
responsible for the final interchange/web exports.
"""

import argparse
from array import array
from collections import deque
import math
import os
import sys

import bpy
from mathutils import Euler, Quaternion, Vector

from bl_ext.blender_org.mpfb.services import HumanService, LocationService


def arguments():
    raw = sys.argv[sys.argv.index("--") + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--preview")
    parser.add_argument("--animation-source", required=True)
    return parser.parse_args(raw)


def asset(*parts):
    path = LocationService.get_user_data(os.path.join(*parts))
    if not os.path.isfile(path):
        raise RuntimeError(f"Required MPFB asset is not installed: {path}")
    return path


def create_character():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    phenotype = {
        "gender": 1.0,
        "age": 0.48,
        "muscle": 0.63,
        "weight": 0.52,
        "proportions": 0.55,
        "height": 0.55,
        "cupsize": 0.5,
        "firmness": 0.5,
        "race": {"asian": 0.0, "caucasian": 0.0, "african": 1.0},
    }
    body = HumanService.create_human(
        mask_helpers=True,
        detailed_helpers=True,
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=phenotype,
    )
    body.name = "ProtagonistBody"
    HumanService.set_character_skin(
        asset("skins", "young_african_male", "young_african_male.mhmat"),
        body,
        skin_type="GAMEENGINE",
        material_instances=False,
    )
    rig = HumanService.add_builtin_rig(body, "game_engine", import_weights=True)
    rig.name = "ProtagonistRig"

    eyes = HumanService.add_mhclo_asset(
        asset("eyes", "high-poly", "high-poly.mhclo"),
        body,
        asset_type="eyes",
        subdiv_levels=0,
        material_type="GAMEENGINE",
    )
    eyes.name = "ProtagonistEyes"
    hair = HumanService.add_mhclo_asset(
        asset("hair", "afro01", "afro01.mhclo"),
        body,
        asset_type="hair",
        subdiv_levels=0,
        material_type="GAMEENGINE",
    )
    hair.name = "ProtagonistHair"
    outfit = HumanService.add_mhclo_asset(
        asset("clothes", "male_casualsuit05", "male_casualsuit05.mhclo"),
        body,
        asset_type="clothes",
        subdiv_levels=0,
        material_type="GAMEENGINE",
    )
    outfit.name = "ProtagonistOutfit"
    shoes = HumanService.add_mhclo_asset(
        asset("clothes", "shoes02", "shoes02.mhclo"),
        body,
        asset_type="clothes",
        subdiv_levels=0,
        material_type="GAMEENGINE",
    )
    shoes.name = "ProtagonistShoes"

    for obj in (body, eyes, hair, outfit, shoes):
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return rig, (body, eyes, hair, outfit, shoes)


BONE_RENAMES = {
    "pelvis": "Hips",
    "spine_01": "Spine",
    "spine_02": "Chest",
    "head": "Head",
    "upperarm_l": "UpperArm_L",
    "lowerarm_l": "LowerArm_L",
    "hand_l": "Hand_L",
    "upperarm_r": "UpperArm_R",
    "lowerarm_r": "LowerArm_R",
    "hand_r": "Hand_R",
    "thigh_l": "UpperLeg_L",
    "calf_l": "LowerLeg_L",
    "foot_l": "Foot_L",
    "thigh_r": "UpperLeg_R",
    "calf_r": "LowerLeg_R",
    "foot_r": "Foot_R",
}


def rename_game_bones(rig, meshes):
    for old_name, new_name in BONE_RENAMES.items():
        bone = rig.data.bones.get(old_name)
        if bone is None:
            raise RuntimeError(f"MPFB game rig is missing {old_name}")
        bone.name = new_name
        for obj in meshes:
            vertex_group = obj.vertex_groups.get(old_name)
            if vertex_group is not None:
                vertex_group.name = new_name


def apply_mask_modifiers(obj):
    if obj.data.shape_keys:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        modifier_visibility = [(modifier, modifier.show_viewport) for modifier in obj.modifiers]
        for modifier, _ in modifier_visibility:
            modifier.show_viewport = False
        evaluated_mesh = bpy.data.meshes.new_from_object(
            obj.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph
        )
        old_mesh = obj.data
        obj.data = evaluated_mesh
        bpy.data.meshes.remove(old_mesh)
        for modifier, visible in modifier_visibility:
            modifier.show_viewport = visible
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for modifier in list(obj.modifiers):
        if modifier.type == "MASK":
            bpy.ops.object.modifier_move_to_index(modifier=modifier.name, index=0)
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def separate_loose_parts(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    return [item for item in bpy.context.selected_objects if item.type == "MESH"]


def assign_material(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.material_index = 0


def join_meshes(objects, name, material):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
        assign_material(obj, material)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    result = bpy.context.object
    result.name = name
    assign_material(result, material)
    return result


def apply_clothing_subdivision(obj):
    """Smooth the hero outfit while keeping the body/hair source topology intact."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new("RuntimeSubdivision", "SUBSURF")
    modifier.subdivision_type = "CATMULL_CLARK"
    modifier.levels = 1
    modifier.render_levels = 1
    bpy.ops.object.modifier_move_to_index(modifier=modifier.name, index=0)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def image_pixels(path, width=None, height=None):
    image = bpy.data.images.load(path, check_existing=False)
    if width and height and (image.size[0] != width or image.size[1] != height):
        image.scale(width, height)
    pixels = array("f", [0.0]) * (image.size[0] * image.size[1] * 4)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels


def save_pixels(path, pixels, width=2048, height=2048, file_format="PNG"):
    # None of the four authored materials needs transparency. Keeping these
    # RGB avoids shipping a redundant alpha channel in the two PNG atlases.
    image = bpy.data.images.new(os.path.basename(path), width=width, height=height, alpha=False)
    image.pixels.foreach_set(pixels)
    image.filepath_raw = path
    image.file_format = file_format
    image.save()
    bpy.data.images.remove(image)


def make_skin_eyes_atlas(output):
    skin = image_pixels(asset("skins", "young_african_male", "young_darkskinned_male_diffuse.png"))
    eyes = image_pixels(asset("eyes", "materials", "brown_eye.png"), 512, 512)
    row_width = 512 * 4
    for row in range(512):
        destination = ((1536 + row) * 2048) * 4
        source = row * row_width
        skin[destination:destination + row_width] = eyes[source:source + row_width]
    save_pixels(output, skin, file_format="JPEG")


def make_hair_shoes_atlas(output):
    hair = image_pixels(asset("hair", "afro01", "afro_diffuse.png"), 1024, 2048)
    shoes = image_pixels(asset("clothes", "shoes02", "shoes02_diffuse.png"), 1024, 2048)
    atlas = array("f", [0.0]) * (2048 * 2048 * 4)
    half_row = 1024 * 4
    full_row = 2048 * 4
    for row in range(2048):
        destination = row * full_row
        source = row * half_row
        atlas[destination:destination + half_row] = hair[source:source + half_row]
        atlas[destination + half_row:destination + full_row] = shoes[source:source + half_row]
    save_pixels(output, atlas, file_format="JPEG")


def make_outfit_texture(output, mode):
    pixels = image_pixels(asset("clothes", "male_casualsuit05", "male_casualsuit05_diffuse.png"))
    for index in range(0, len(pixels), 4):
        red, green, blue = pixels[index], pixels[index + 1], pixels[index + 2]
        luminance = red * 0.22 + green * 0.68 + blue * 0.10
        if mode == "jacket":
            pixels[index] = min(1.0, luminance * 0.16)
            pixels[index + 1] = min(1.0, luminance * 0.78)
            pixels[index + 2] = min(1.0, luminance * 0.72)
        else:
            pixels[index] = red * 0.22
            pixels[index + 1] = green * 0.27
            pixels[index + 2] = blue * 0.30
    save_pixels(output, pixels, file_format="JPEG")


def remap_uv(obj, scale_x, offset_x=0.0, scale_y=1.0, offset_y=0.0):
    if not obj.data.uv_layers:
        raise RuntimeError(f"{obj.name} has no UV layer")
    for loop in obj.data.uv_layers.active.data:
        loop.uv.x = offset_x + loop.uv.x * scale_x
        loop.uv.y = offset_y + loop.uv.y * scale_y


def create_material(name, texture_path, roughness):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = 0.0
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(texture_path, check_existing=True)
    material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def prepare_runtime_meshes(meshes, project_root):
    body, eyes, hair, outfit, shoes = meshes
    texture_root = os.path.join(project_root, "public", "textures", "character")
    os.makedirs(texture_root, exist_ok=True)
    skin_path = os.path.join(texture_root, "protagonist-skin-basecolor.jpg")
    jacket_path = os.path.join(texture_root, "protagonist-jacket-basecolor.jpg")
    denim_path = os.path.join(texture_root, "protagonist-denim-basecolor.jpg")
    hair_shoes_path = os.path.join(texture_root, "protagonist-hair-shoes-basecolor.jpg")
    make_skin_eyes_atlas(skin_path)
    make_outfit_texture(jacket_path, "jacket")
    make_outfit_texture(denim_path, "denim")
    make_hair_shoes_atlas(hair_shoes_path)

    skin_material = create_material("SkinEyes", skin_path, 0.62)
    jacket_material = create_material("TealTechnicalJacket", jacket_path, 0.54)
    denim_material = create_material("CharcoalJeans", denim_path, 0.78)
    hair_shoes_material = create_material("HairShoes", hair_shoes_path, 0.74)

    apply_mask_modifiers(body)
    outfit_parts = separate_loose_parts(outfit)
    pants = [part for part in outfit_parts if visible_bounds([part])[0].z < 0.3]
    jacket = [part for part in outfit_parts if part not in pants]
    if len(pants) != 1 or len(jacket) != 3:
        raise RuntimeError(f"Unexpected male_casualsuit05 topology: pants={len(pants)}, jacket={len(jacket)}")

    # Blender's image pixel buffer is bottom-up; the eye tile occupies the
    # lower-left UV quadrant even though PNG viewers display it at top-left.
    remap_uv(eyes, 0.25, 0.0, 0.25, 0.0)
    remap_uv(hair, 0.5)
    remap_uv(shoes, 0.5, 0.5)
    skin_eyes = join_meshes([body, eyes], "SkinEyesMesh", skin_material)
    jacket_mesh = join_meshes(jacket, "TealTechnicalJacketMesh", jacket_material)
    jeans_mesh = join_meshes(pants, "CharcoalJeansMesh", denim_material)
    hair_shoes = join_meshes([hair, shoes], "HairShoesMesh", hair_shoes_material)
    apply_clothing_subdivision(jacket_mesh)
    apply_clothing_subdivision(jeans_mesh)
    return skin_eyes, jacket_mesh, jeans_mesh, hair_shoes


ANIMATED_BONES = [
    "Hips", "Spine", "Chest", "Head",
    "UpperArm_L", "LowerArm_L", "Hand_L", "UpperArm_R", "LowerArm_R", "Hand_R",
    "UpperLeg_L", "LowerLeg_L", "Foot_L", "UpperLeg_R", "LowerLeg_R", "Foot_R",
]


def combined_pose(*poses):
    result = {}
    for pose in poses:
        for name, rotation in pose.items():
            previous = result.get(name, (0.0, 0.0, 0.0))
            result[name] = tuple(previous[index] + rotation[index] for index in range(3))
    return result


def mirrored_stride(amount, lean=0.0):
    return {
        "Chest": (lean, 0.0, -amount * 0.08),
        "UpperArm_L": (amount * 0.55, 0.0, -0.72),
        "UpperArm_R": (-amount * 0.55, 0.0, 0.72),
        "UpperLeg_L": (-amount, 0.0, 0.0),
        "LowerLeg_L": (max(0.0, amount) * 0.55, 0.0, 0.0),
        "UpperLeg_R": (amount, 0.0, 0.0),
        "LowerLeg_R": (max(0.0, -amount) * 0.55, 0.0, 0.0),
    }


def create_animation_contract(rig):
    """Author the exact in-place gameplay set on the real MPFB armature.

    The motion is deliberately restrained and readable at gameplay distance.
    Runtime additive aim/recoil/vehicle adjustments remain layered on top.
    """
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)

    relaxed = {"UpperArm_L": (0.0, 0.0, -0.72), "UpperArm_R": (0.0, 0.0, 0.72)}
    aim = {
        "Chest": (-0.08, 0.0, 0.04),
        "UpperArm_L": (-0.72, 0.1, 0.42), "LowerArm_L": (-0.62, 0.0, -0.12),
        "UpperArm_R": (-0.92, -0.12, -0.24), "LowerArm_R": (-0.72, 0.0, 0.18),
    }
    bicycle = {
        "Spine": (-0.28, 0.0, 0.0), "Chest": (-0.18, 0.0, 0.0),
        "UpperArm_L": (-0.55, 0.0, 0.40), "LowerArm_L": (-0.76, 0.0, -0.12),
        "UpperArm_R": (-0.55, 0.0, -0.40), "LowerArm_R": (-0.76, 0.0, 0.12),
        "UpperLeg_L": (-0.78, 0.0, 0.0), "LowerLeg_L": (1.25, 0.0, 0.0),
        "UpperLeg_R": (-0.28, 0.0, 0.0), "LowerLeg_R": (0.72, 0.0, 0.0),
    }
    specs = {
        "idle": [(0, combined_pose(relaxed, {"Chest": (0.015, 0, 0)})), (30, combined_pose(relaxed, {"Chest": (-0.015, 0, 0), "Head": (0.012, 0, 0)})), (60, combined_pose(relaxed, {"Chest": (0.015, 0, 0)}))],
        "walk": [(0, mirrored_stride(0.42, -0.04)), (15, mirrored_stride(-0.42, -0.04)), (30, mirrored_stride(0.42, -0.04))],
        "sprint": [(0, mirrored_stride(0.78, -0.20)), (10, mirrored_stride(-0.78, -0.20)), (20, mirrored_stride(0.78, -0.20))],
        "aim": [(0, aim), (30, combined_pose(aim, {"Chest": (0.015, 0, 0)}))],
        "aim_forward": [(0, aim), (30, aim)],
        "aim_back": [(0, combined_pose(aim, {"Chest": (0, 0, 0.78), "Head": (0, 0, 0.34)})), (30, combined_pose(aim, {"Chest": (0, 0, 0.78), "Head": (0, 0, 0.34)}))],
        "aim_left": [(0, combined_pose(aim, {"Chest": (0, 0, 0.40), "Head": (0, 0, 0.16)})), (30, combined_pose(aim, {"Chest": (0, 0, 0.40), "Head": (0, 0, 0.16)}))],
        "aim_right": [(0, combined_pose(aim, {"Chest": (0, 0, -0.40), "Head": (0, 0, -0.16)})), (30, combined_pose(aim, {"Chest": (0, 0, -0.40), "Head": (0, 0, -0.16)}))],
        "fire": [(0, aim), (3, combined_pose(aim, {"Chest": (0.10, 0, 0), "UpperArm_R": (0.14, 0, 0)})), (8, aim)],
        "punch_left": [(0, relaxed), (8, {"Chest": (-0.16, 0, -0.20), "UpperArm_L": (-1.18, 0, 0.06), "LowerArm_L": (-0.22, 0, 0)}), (18, relaxed)],
        "punch_right": [(0, relaxed), (8, {"Chest": (-0.16, 0, 0.20), "UpperArm_R": (-1.18, 0, -0.06), "LowerArm_R": (-0.22, 0, 0)}), (18, relaxed)],
        "jump": [(0, combined_pose(relaxed, {"Spine": (-0.10, 0, 0), "UpperLeg_L": (-0.28, 0, 0), "UpperLeg_R": (-0.28, 0, 0), "LowerLeg_L": (0.52, 0, 0), "LowerLeg_R": (0.52, 0, 0)})), (16, {"UpperArm_L": (-0.35, 0, 0.92), "UpperArm_R": (-0.35, 0, -0.92), "UpperLeg_L": (0.10, 0, 0), "UpperLeg_R": (-0.12, 0, 0)}), (28, relaxed)],
        "fall": [(0, {"UpperArm_L": (-0.20, 0, 0.95), "UpperArm_R": (-0.20, 0, -0.95), "UpperLeg_L": (0.10, 0, 0), "UpperLeg_R": (-0.12, 0, 0)}), (30, {"UpperArm_L": (-0.16, 0, 0.90), "UpperArm_R": (-0.16, 0, -0.90), "UpperLeg_L": (-0.10, 0, 0), "UpperLeg_R": (0.12, 0, 0)})],
        "land": [(0, {"Spine": (-0.42, 0, 0), "UpperLeg_L": (-0.58, 0, 0), "UpperLeg_R": (-0.58, 0, 0), "LowerLeg_L": (1.05, 0, 0), "LowerLeg_R": (1.05, 0, 0), "UpperArm_L": (-0.35, 0, 0.72), "UpperArm_R": (-0.35, 0, -0.72)}), (18, relaxed)],
        "tumble": [(0, combined_pose(relaxed, {"Hips": (0, 0, 0)})), (10, {"Hips": (0, 0, 1.55), "Spine": (-0.52, 0, 0), "UpperLeg_L": (-0.68, 0, 0), "UpperLeg_R": (-0.68, 0, 0), "LowerLeg_L": (1.1, 0, 0), "LowerLeg_R": (1.1, 0, 0)}), (20, {"Hips": (0, 0, 3.10), "Spine": (-0.25, 0, 0)}), (30, relaxed)],
        "death": [(0, relaxed), (16, {"Hips": (1.10, 0, 0), "Spine": (-0.32, 0, 0), "UpperArm_L": (0, 0, 0.96), "UpperArm_R": (0, 0, -0.96)}), (36, {"Hips": (1.48, 0, 0), "Spine": (-0.18, 0, 0), "UpperArm_L": (0, 0, 1.05), "UpperArm_R": (0, 0, -1.05)})],
        "cover_idle": [(0, combined_pose(relaxed, {"Spine": (-0.18, 0, 0), "Chest": (0, 0, -0.18)})), (30, combined_pose(relaxed, {"Spine": (-0.16, 0, 0), "Chest": (0, 0, -0.16)}))],
        "cover_move": [(0, combined_pose(mirrored_stride(0.22, -0.18), {"Chest": (0, 0, -0.18)})), (15, combined_pose(mirrored_stride(-0.22, -0.18), {"Chest": (0, 0, -0.18)})), (30, combined_pose(mirrored_stride(0.22, -0.18), {"Chest": (0, 0, -0.18)}))],
        "cover_aim": [(0, combined_pose(aim, {"Spine": (-0.14, 0, 0), "Chest": (0, 0, -0.20)})), (30, combined_pose(aim, {"Spine": (-0.14, 0, 0), "Chest": (0, 0, -0.20)}))],
        "ride_bicycle": [(0, bicycle), (15, combined_pose(bicycle, {"UpperLeg_L": (0.42, 0, 0), "LowerLeg_L": (-0.60, 0, 0), "UpperLeg_R": (-0.42, 0, 0), "LowerLeg_R": (0.58, 0, 0)})), (30, bicycle)],
        "ride_motorbike": [(0, combined_pose(bicycle, {"Spine": (-0.08, 0, 0), "UpperLeg_L": (0.24, 0, 0), "UpperLeg_R": (0.24, 0, 0)})), (30, combined_pose(bicycle, {"Spine": (-0.08, 0, 0), "UpperLeg_L": (0.24, 0, 0), "UpperLeg_R": (0.24, 0, 0)}))],
        "ride_superbike": [(0, combined_pose(bicycle, {"Spine": (-0.30, 0, 0), "Chest": (-0.26, 0, 0), "UpperLeg_L": (0.36, 0, 0), "UpperLeg_R": (0.36, 0, 0)})), (30, combined_pose(bicycle, {"Spine": (-0.30, 0, 0), "Chest": (-0.26, 0, 0), "UpperLeg_L": (0.36, 0, 0), "UpperLeg_R": (0.36, 0, 0)}))],
        "freefall": [(0, {"Spine": (-0.12, 0, 0), "UpperArm_L": (-0.18, 0, 1.18), "UpperArm_R": (-0.18, 0, -1.18), "LowerArm_L": (-0.18, 0, 0), "LowerArm_R": (-0.18, 0, 0), "UpperLeg_L": (0.12, 0, 0.18), "UpperLeg_R": (0.12, 0, -0.18)}), (30, {"Spine": (-0.16, 0, 0), "UpperArm_L": (-0.22, 0, 1.12), "UpperArm_R": (-0.22, 0, -1.12), "LowerArm_L": (-0.12, 0, 0), "LowerArm_R": (-0.12, 0, 0), "UpperLeg_L": (-0.10, 0, 0.16), "UpperLeg_R": (-0.10, 0, -0.16)})],
        "parachute": [(0, {"Spine": (0.08, 0, 0), "UpperArm_L": (-0.48, 0, 1.02), "UpperArm_R": (-0.48, 0, -1.02), "LowerArm_L": (-0.72, 0, 0), "LowerArm_R": (-0.72, 0, 0), "UpperLeg_L": (-0.12, 0, 0.12), "UpperLeg_R": (-0.12, 0, -0.12)}), (30, {"Spine": (0.06, 0, 0), "UpperArm_L": (-0.44, 0, 1.00), "UpperArm_R": (-0.44, 0, -1.00), "LowerArm_L": (-0.68, 0, 0), "LowerArm_R": (-0.68, 0, 0), "UpperLeg_L": (0.08, 0, 0.12), "UpperLeg_R": (0.08, 0, -0.12)})],
    }

    rig.animation_data_create()
    for clip_name, frames in specs.items():
        action = bpy.data.actions.new(clip_name)
        action.use_fake_user = True
        rig.animation_data.action = action
        for frame in range(frames[0][0], frames[-1][0] + 1):
            left_index = max(index for index, (key_frame, _pose) in enumerate(frames) if key_frame <= frame)
            right_index = min(left_index + 1, len(frames) - 1)
            left_frame, left_pose = frames[left_index]
            right_frame, right_pose = frames[right_index]
            blend = 0.0 if right_frame == left_frame else (frame - left_frame) / (right_frame - left_frame)
            bpy.context.scene.frame_set(frame)
            for bone_name in ANIMATED_BONES:
                bone = rig.pose.bones[bone_name]
                bone.rotation_mode = "QUATERNION"
                left_rotation = Euler(left_pose.get(bone_name, (0.0, 0.0, 0.0)), "XYZ").to_quaternion()
                right_rotation = Euler(right_pose.get(bone_name, (0.0, 0.0, 0.0)), "XYZ").to_quaternion()
                bone.rotation_quaternion = left_rotation.slerp(right_rotation, blend)
                bone.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=bone_name)
        for curve in action.layers[0].strips[0].channelbag(action.slots[0]).fcurves:
            for keyframe in curve.keyframe_points:
                keyframe.interpolation = "LINEAR"

    rig.animation_data.action = bpy.data.actions["idle"]
    bpy.context.scene.frame_set(0)
    expected = {
        "idle", "walk", "sprint", "aim", "aim_forward", "aim_back", "aim_left", "aim_right", "fire",
        "punch_left", "punch_right", "jump", "fall", "land", "tumble", "death", "cover_idle", "cover_move",
        "cover_aim", "ride_bicycle", "ride_motorbike", "ride_superbike", "freefall", "parachute",
    }
    if {action.name for action in bpy.data.actions} != expected:
        raise RuntimeError("Generated animation set does not match the 24-clip contract")


def retarget_quaternius_locomotion(rig, animation_source):
    """Bake Quaternius' CC0 walk/sprint legs onto the shaped MPFB game rig.

    Both rigs share the MakeHuman game-rig bone names, but their rest-pose arm
    rolls differ. Lower-body rotations transfer cleanly; the upper body is
    authored against this character's own rest pose to avoid crossed arms.
    Root and pelvis translation are intentionally excluded so both cycles stay
    in place for gameplay movement.
    """
    if not os.path.isfile(animation_source):
        raise RuntimeError(f"Quaternius animation source is not installed: {animation_source}")
    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=animation_source)
    imported_objects = [obj for obj in bpy.data.objects if obj not in before_objects]
    imported_actions = [action for action in bpy.data.actions if action not in before_actions]
    source_rigs = [obj for obj in imported_objects if obj.type == "ARMATURE"]
    if len(source_rigs) != 1:
        raise RuntimeError("Quaternius Standard GLB must contain exactly one armature")
    source_rig = source_rigs[0]
    source_rig.animation_data_create()
    source_actions = {action.name: action for action in imported_actions}
    required = {"Walk_Loop", "Sprint_Loop"}
    if not required.issubset(source_actions):
        raise RuntimeError(f"Quaternius Standard GLB is missing {sorted(required - set(source_actions))}")

    lower_body = {
        "Hips": "pelvis",
        "UpperLeg_L": "thigh_l", "LowerLeg_L": "calf_l", "Foot_L": "foot_l",
        "UpperLeg_R": "thigh_r", "LowerLeg_R": "calf_r", "Foot_R": "foot_r",
    }
    rest_orientations = {}
    for target_name, source_name in lower_body.items():
        target_rest = rig.data.bones[target_name].matrix_local.to_quaternion()
        source_rest = source_rig.data.bones[source_name].matrix_local.to_quaternion()
        rest_orientations[target_name] = (target_rest, source_rest)
    settings = {
        "walk": (source_actions["Walk_Loop"], 0.16, -0.045),
        "sprint": (source_actions["Sprint_Loop"], 0.36, -0.18),
    }
    rig.animation_data_create()
    for target_name, (source_action, arm_swing, lean) in settings.items():
        old_action = bpy.data.actions.get(target_name)
        if old_action:
            bpy.data.actions.remove(old_action)
        target_action = bpy.data.actions.new(target_name)
        target_action.use_fake_user = True
        source_rig.animation_data.action = source_action
        rig.animation_data.action = target_action
        last_frame = int(round(source_action.frame_range[1]))
        for frame in range(last_frame + 1):
            bpy.context.scene.frame_set(frame)
            # The source cycle reaches foot contact at frames 0 and halfway
            # through the clip. Arm opposition must peak at those contacts,
            # not at the intervening passing poses.
            phase = math.cos(frame / last_frame * math.tau)
            authored = {
                "Spine": (lean * 0.42, 0.0, phase * 0.018),
                "Chest": (lean * 0.58, 0.0, -phase * 0.035),
                "Head": (-lean * 0.12, 0.0, phase * 0.012),
                "UpperArm_L": (-phase * arm_swing, 0.0, -0.72),
                "UpperArm_R": (phase * arm_swing, 0.0, 0.72),
                "LowerArm_L": (-0.08 if target_name == "sprint" else 0.0, 0.0, 0.0),
                "LowerArm_R": (-0.08 if target_name == "sprint" else 0.0, 0.0, 0.0),
            }
            for bone_name in ANIMATED_BONES:
                bone = rig.pose.bones[bone_name]
                bone.rotation_mode = "QUATERNION"
                source_name = lower_body.get(bone_name)
                if source_name:
                    # Retain the source knee/ankle timing while shortening its
                    # stylised stride for this character's gameplay velocity.
                    if bone_name == "Hips":
                        stride_scale = 0.30 if target_name == "walk" else 0.35
                    else:
                        stride_scale = 0.55 if target_name == "walk" else 0.42
                    target_rest, source_rest = rest_orientations[bone_name]
                    source_rotation = source_rig.pose.bones[source_name].rotation_quaternion
                    armature_delta = source_rest @ source_rotation @ source_rest.inverted()
                    if bone_name != "Hips":
                        # Locomotion is in the sagittal plane. The source's
                        # stylised hip roll is amplified by this mesh's longer
                        # game-rig legs, so retain only a small amount of
                        # lateral roll/twist and keep the forward knee arc.
                        sagittal = armature_delta.to_euler("XYZ")
                        sagittal.y *= 0.25
                        sagittal.z *= 0.25
                        armature_delta = sagittal.to_quaternion()
                    retargeted = target_rest.inverted() @ armature_delta @ target_rest
                    bone.rotation_quaternion = Quaternion().slerp(retargeted, stride_scale)
                else:
                    bone.rotation_quaternion = Euler(authored.get(bone_name, (0.0, 0.0, 0.0)), "XYZ").to_quaternion()
                bone.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=bone_name)

        foot_samples = {"Foot_L": [], "Foot_R": []}
        for frame in range(last_frame + 1):
            bpy.context.scene.frame_set(frame)
            for foot_name in foot_samples:
                foot_samples[foot_name].append(rig.pose.bones[foot_name].head.copy())
        for foot_name, samples in foot_samples.items():
            forward_travel = max(point.y for point in samples) - min(point.y for point in samples)
            lateral_drift = max(point.x for point in samples) - min(point.x for point in samples)
            lift = max(point.z for point in samples) - min(point.z for point in samples)
            if forward_travel < 0.25 or forward_travel < lateral_drift * 3 or lift < 0.04:
                raise RuntimeError(
                    f"{target_name} {foot_name} is not a forward locomotion arc "
                    f"(forward={forward_travel:.3f}, lateral={lateral_drift:.3f}, lift={lift:.3f})"
                )

    for obj in imported_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    for action in imported_actions:
        bpy.data.actions.remove(action)
    rig.animation_data.action = bpy.data.actions["idle"]
    bpy.context.scene.frame_set(0)


def visible_bounds(objects):
    points = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        points.extend(evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box)
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def connected_component_summary(obj):
    neighbours = [set() for _ in obj.data.vertices]
    for edge in obj.data.edges:
        left, right = edge.vertices
        neighbours[left].add(right)
        neighbours[right].add(left)
    unseen = set(range(len(obj.data.vertices)))
    result = []
    while unseen:
        seed = unseen.pop()
        component = {seed}
        queue = deque([seed])
        while queue:
            for neighbour in neighbours[queue.popleft()]:
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    component.add(neighbour)
                    queue.append(neighbour)
        coordinates = [obj.data.vertices[index].co for index in component]
        result.append({
            "vertices": len(component),
            "z": (round(min(point.z for point in coordinates), 3), round(max(point.z for point in coordinates), 3)),
        })
    return sorted(result, key=lambda item: item["z"][0])


def normalize_height(rig, meshes):
    minimum, maximum = visible_bounds(meshes)
    scale = 1.8 / (maximum.z - minimum.z)
    rig.scale = (scale, scale, scale)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    minimum, _ = visible_bounds(meshes)
    rig.location.z -= minimum.z
    return visible_bounds(meshes)


def look_at(camera, target):
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_preview(path, meshes):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = path
    scene.world = bpy.data.worlds.new("PreviewWorld")
    scene.world.color = (0.018, 0.022, 0.026)

    minimum, maximum = visible_bounds(meshes)
    center = (minimum + maximum) * 0.5
    bpy.ops.object.camera_add(location=(2.65, -4.8, 1.38))
    camera = bpy.context.object
    camera.data.lens = 72
    look_at(camera, (center.x, center.y, 0.94))
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(2.4, -3.2, 3.8))
    bpy.context.object.data.energy = 1050
    bpy.context.object.data.shape = "DISK"
    bpy.context.object.data.size = 4.0
    look_at(bpy.context.object, center)
    bpy.ops.object.light_add(type="AREA", location=(-2.2, -1.4, 2.2))
    bpy.context.object.data.energy = 650
    bpy.context.object.data.size = 3.0
    look_at(bpy.context.object, center)
    bpy.ops.object.light_add(type="AREA", location=(0.0, 2.0, 2.8))
    bpy.context.object.data.energy = 900
    bpy.context.object.data.size = 2.0
    look_at(bpy.context.object, center)

    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, -0.005))
    ground = bpy.context.object
    ground_material = bpy.data.materials.new("PreviewGround")
    ground_material.diffuse_color = (0.035, 0.045, 0.05, 1.0)
    ground.data.materials.append(ground_material)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(ground, do_unlink=True)
    for obj in [item for item in list(bpy.data.objects) if item.type in {"LIGHT", "CAMERA"}]:
        bpy.data.objects.remove(obj, do_unlink=True)


def main():
    args = arguments()
    rig, meshes = create_character()
    normalize_height(rig, meshes)
    rename_game_bones(rig, meshes)
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    meshes = prepare_runtime_meshes(meshes, project_root)
    rig.name = "JohannesburgProtagonist"
    rig["characterContract"] = {
        "version": 1,
        "heightMetres": 1.8,
        "forwardAxis": "+Z",
        "feetAtOrigin": True,
        "fps": 30,
    }
    create_animation_contract(rig)
    retarget_quaternius_locomotion(rig, args.animation_source)
    minimum, maximum = visible_bounds(meshes)
    for obj in meshes:
        obj.data.calc_loop_triangles()
    triangles = sum(len(obj.data.loop_triangles) for obj in meshes)
    print("MPFB_SOURCE", {
        "height": round(maximum.z - minimum.z, 4),
        "triangles": triangles,
        "meshes": {obj.name: (len(obj.data.vertices), len(obj.data.polygons)) for obj in meshes},
        "bones": len(rig.data.bones),
        "clips": sorted(action.name for action in bpy.data.actions),
    })
    if args.preview:
        os.makedirs(os.path.dirname(args.preview), exist_ok=True)
        render_preview(args.preview, meshes)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=args.output)


if __name__ == "__main__":
    main()
