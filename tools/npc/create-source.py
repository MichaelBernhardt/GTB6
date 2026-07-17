"""Create one editable pedestrian source from the locked MPFB assets."""

import argparse
from array import array
import importlib.util
import json
import os
import sys

import bpy
from mathutils import Vector

from bl_ext.blender_org.mpfb.services import HumanService, LocationService


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
COMMON_PATH = os.path.join(PROJECT_ROOT, "tools", "character", "create-source.py")
COMMON_SPEC = importlib.util.spec_from_file_location("character_source_common", COMMON_PATH)
common = importlib.util.module_from_spec(COMMON_SPEC)
COMMON_SPEC.loader.exec_module(common)


def arguments():
    raw = sys.argv[sys.argv.index("--") + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--walk-bvh", required=True)
    parser.add_argument("--run-bvh", required=True)
    return parser.parse_args(raw)


def asset(*parts):
    path = LocationService.get_user_data(os.path.join(*parts))
    if not os.path.isfile(path):
        raise RuntimeError(f"Required MPFB asset is not installed: {path}")
    return path


def load_manifest(path, character_id):
    with open(path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    return next(character for character in manifest["characters"] if character["id"] == character_id)


def create_character(config):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    phenotype = {"gender": 1.0 if config.get("sex") == "male" else 0.0, **config["phenotype"]}
    body = HumanService.create_human(
        mask_helpers=True,
        detailed_helpers=True,
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=phenotype,
    )
    body.name = f'{config["id"]}:Body'
    HumanService.set_character_skin(
        asset("skins", config["skin"], f'{config["skin"]}.mhmat'),
        body,
        skin_type="GAMEENGINE",
        material_instances=False,
    )
    rig = HumanService.add_builtin_rig(body, "game_engine", import_weights=True)
    rig.name = f'{config["id"]}:Rig'
    eyes = HumanService.add_mhclo_asset(
        asset("eyes", "high-poly", "high-poly.mhclo"), body,
        asset_type="eyes", subdiv_levels=0, material_type="GAMEENGINE",
    )
    hair = HumanService.add_mhclo_asset(
        asset("hair", config["hair"], f'{config["hair"]}.mhclo'), body,
        asset_type="hair", subdiv_levels=0, material_type="GAMEENGINE",
    )
    outfit = HumanService.add_mhclo_asset(
        asset("clothes", config["outfit"], f'{config["outfit"]}.mhclo'), body,
        asset_type="clothes", subdiv_levels=0, material_type="GAMEENGINE",
    )
    shoe_mhclo = config.get("shoeMhclo", f'{config["shoes"]}.mhclo')
    shoes = HumanService.add_mhclo_asset(
        asset("clothes", config["shoes"], shoe_mhclo), body,
        asset_type="clothes", subdiv_levels=0, material_type="GAMEENGINE",
    )
    for obj in (body, eyes, hair, outfit, shoes):
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return rig, (body, eyes, hair, outfit, shoes)


def save_pixels(path, pixels, width=1024, height=1024):
    image = bpy.data.images.new(os.path.basename(path), width=width, height=height, alpha=False)
    image.pixels.foreach_set(pixels)
    image.filepath_raw = path
    image.file_format = "JPEG"
    image.save()
    bpy.data.images.remove(image)


def load_pixels(path, width=1024, height=1024):
    return common.image_pixels(path, width, height)


def make_skin_texture(config, output):
    skin = load_pixels(asset("skins", config["skin"], config["skinDiffuse"]))
    tint = config["skinTint"]
    for index in range(0, len(skin), 4):
        skin[index] = min(1.0, skin[index] * tint[0])
        skin[index + 1] = min(1.0, skin[index + 1] * tint[1])
        skin[index + 2] = min(1.0, skin[index + 2] * tint[2])
    save_pixels(output, skin)


def make_eye_texture(output):
    save_pixels(output, load_pixels(asset("eyes", "materials", "brown_eye.png")))


def make_outfit_texture(config, output):
    original = load_pixels(asset("clothes", config["outfit"], f'{config["outfit"]}_diffuse.png'))
    textile = load_pixels(os.path.join(PROJECT_ROOT, config["materialSource"]))
    # Optional RGBA overlay in the outfit's UV space: uniform markings (hi-vis panels, lettering,
    # badges, per-piece recolours) composite over the tinted fabric wherever alpha > 0.
    overlay = load_pixels(os.path.join(PROJECT_ROOT, config["outfitOverlay"])) if config.get("outfitOverlay") else None
    result = array("f", [0.0]) * len(original)
    for index in range(0, len(original), 4):
        red, green, blue = original[index], original[index + 1], original[index + 2]
        luminance = red * 0.22 + green * 0.68 + blue * 0.10
        shade = 0.42 + luminance * 0.72
        row = index // (1024 * 4)
        secondary = config.get("secondaryColor") if row / 1024 < config.get("secondaryBelow", -1) else None
        source = secondary if secondary else (textile[index], textile[index + 1], textile[index + 2])
        result[index] = min(1.0, source[0] * shade)
        result[index + 1] = min(1.0, source[1] * shade)
        result[index + 2] = min(1.0, source[2] * shade)
        result[index + 3] = 1.0
    if overlay is not None:
        for index in range(0, len(result), 4):
            alpha = overlay[index + 3]
            if alpha <= 0.004:
                continue
            red, green, blue = original[index], original[index + 1], original[index + 2]
            luminance = red * 0.22 + green * 0.68 + blue * 0.10
            marking_shade = 0.62 + luminance * 0.5  # markings inherit a softened cloth shading so they sit IN the fabric
            for channel in range(3):
                value = min(1.0, overlay[index + channel] * marking_shade)
                result[index + channel] = result[index + channel] * (1.0 - alpha) + value * alpha
    save_pixels(output, result)


def make_hair_shoes_atlas(config, output):
    hair_file = config.get("hairDiffuse", f'{config["hair"]}_diffuse.png')
    hair = load_pixels(asset("hair", config["hair"], hair_file), 512, 1024)
    shoe_file = config.get("shoeDiffuse", f'{config["shoes"]}_diffuse.png')
    shoes = load_pixels(asset("clothes", config["shoes"], shoe_file), 512, 1024)
    for pixels, tint in ((hair, config["hairTint"]), (shoes, config["shoeTint"])):
        for index in range(0, len(pixels), 4):
            pixels[index] = min(1.0, pixels[index] * tint[0])
            pixels[index + 1] = min(1.0, pixels[index + 1] * tint[1])
            pixels[index + 2] = min(1.0, pixels[index + 2] * tint[2])
    atlas = array("f", [0.0]) * (1024 * 1024 * 4)
    half_row = 512 * 4
    full_row = 1024 * 4
    for row in range(1024):
        destination = row * full_row
        source = row * half_row
        atlas[destination:destination + half_row] = hair[source:source + half_row]
        atlas[destination + half_row:destination + full_row] = shoes[source:source + half_row]
    save_pixels(output, atlas)


def prepare_runtime_meshes(config, meshes):
    body, eyes, hair, outfit, shoes = meshes
    texture_root = os.path.join(PROJECT_ROOT, "public", "textures", "npcs")
    os.makedirs(texture_root, exist_ok=True)
    stem = config["id"]
    skin_path = os.path.join(texture_root, f"{stem}-skin-basecolor.jpg")
    eyes_path = os.path.join(texture_root, f"{stem}-eyes-basecolor.jpg")
    outfit_path = os.path.join(texture_root, f"{stem}-outfit-basecolor.jpg")
    hair_shoes_path = os.path.join(texture_root, f"{stem}-hair-shoes-basecolor.jpg")
    make_skin_texture(config, skin_path)
    make_eye_texture(eyes_path)
    make_outfit_texture(config, outfit_path)
    make_hair_shoes_atlas(config, hair_shoes_path)
    skin_material = common.create_material("Skin", skin_path, 0.66)
    eyes_material = common.create_material("Eyes", eyes_path, 0.48)
    outfit_material = common.create_material("Outfit", outfit_path, 0.72)
    hair_shoes_material = common.create_material("HairShoes", hair_shoes_path, 0.76)
    common.apply_mask_modifiers(body)
    common.remap_uv(hair, 0.5)
    common.remap_uv(shoes, 0.5, 0.5)
    common.assign_material(body, skin_material); body.name = "SkinMesh"
    common.assign_material(eyes, eyes_material); eyes.name = "EyesMesh"
    common.assign_material(outfit, outfit_material)
    outfit.name = "OutfitMesh"
    hair_shoes = common.join_meshes([hair, shoes], "HairShoesMesh", hair_shoes_material)
    # The polygon hair cards are the cheapest place to recover the pedestrian
    # budget. Decimation preserves the MPFB weights/UVs while keeping the face,
    # hands and garment silhouettes at their authored density.
    bpy.context.view_layer.objects.active = hair_shoes
    hair_shoes.select_set(True)
    for obj in (body, eyes, outfit, hair_shoes):
        obj.data.calc_loop_triangles()
    fixed_triangles = len(body.data.loop_triangles) + len(eyes.data.loop_triangles) + len(outfit.data.loop_triangles)
    hair_triangles = len(hair_shoes.data.loop_triangles)
    decimate = hair_shoes.modifiers.new("NpcHairBudget", "DECIMATE")
    decimate.ratio = max(0.2, min(0.9, (28500 - fixed_triangles) / hair_triangles))
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    hair_shoes.select_set(False)
    return body, eyes, outfit, hair_shoes


def normalize_height(rig, meshes, height):
    minimum, maximum = common.visible_bounds(meshes)
    scale = height / (maximum.z - minimum.z)
    rig.scale = (scale, scale, scale)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    minimum, _maximum = common.visible_bounds(meshes)
    rig.location.z -= minimum.z


def create_animation_contract(rig, walk_bvh, run_bvh):
    common.create_animation_contract(rig)
    keep = {"idle", "walk", "sprint", "punch_right", "death"}
    for action in list(bpy.data.actions):
        if action.name not in keep:
            bpy.data.actions.remove(action)
    common.retarget_cmu_locomotion(rig, walk_bvh, run_bvh)
    if {action.name for action in bpy.data.actions} != keep:
        raise RuntimeError("Generated animation set does not match the five-clip NPC contract")


def main():
    args = arguments()
    config = load_manifest(args.manifest, args.id)
    rig, source_meshes = create_character(config)
    normalize_height(rig, source_meshes, config["heightMetres"])
    common.rename_game_bones(rig, source_meshes)
    meshes = prepare_runtime_meshes(config, source_meshes)
    rig.name = f'Npc_{config["id"]}'
    rig["npcContract"] = {
        "version": 1,
        "characterId": config["id"],
        "heightMetres": config["heightMetres"],
        "forwardAxis": "+Z",
        "feetAtOrigin": True,
        "fps": 30,
    }
    create_animation_contract(rig, args.walk_bvh, args.run_bvh)
    minimum, maximum = common.visible_bounds(meshes)
    for obj in meshes:
        obj.data.calc_loop_triangles()
    triangles = sum(len(obj.data.loop_triangles) for obj in meshes)
    print("MPFB_NPC_SOURCE", {
        "id": config["id"],
        "height": round(maximum.z - minimum.z, 4),
        "triangles": triangles,
        "meshes": {obj.name: (len(obj.data.vertices), len(obj.data.polygons)) for obj in meshes},
        "bones": len(rig.data.bones),
        "clips": sorted(action.name for action in bpy.data.actions),
    })
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=args.output)


if __name__ == "__main__":
    main()
