# Johannesburg protagonist production brief

## Direction

The player is a wholly original Black South African man in his late 20s with an athletic-average build, short coiled
hair, a weathered teal technical jacket, charcoal jeans and worn trainers. The design is grounded, readable at normal
third-person distance, and is not based on a real person or an existing game character.

The generated turnaround, face sheet and material sources live under `art/character/`. They are art direction and
bitmap inputs—not animation, a UV layout, or a protected likeness.

## Editable pipeline

1. Author the working character in Blender 4.2+ with MPFB 2.0.16 and only license-verified CC0 body, skin, hair, shirt,
   pants and shoe inputs. Approved upstream sources and committed checksums are recorded in `art/character/sources.lock.json`.
2. Retarget the CC0 Quaternius Universal Animation Library, then clean the game clips against the exact names in
   `public/models/characters/README.md`. Bake at 30 fps and delete all root/object translation curves.
3. Keep the `.blend` under `art/character/work/` and generated FBX under `build/character/`; both paths are ignored.
   `art/character/recipe.json` records dimensions, materials, clips, source locations and weapon sockets.
4. Bake four opaque PBR groups. The 2K base-colour maps ship under `public/textures/character/`; packed normal-X,
   roughness and normal-Z sources live under `art/character/materials/` for the editable material pass.
5. Run `npm run character:build` for the Blender FBX/GLB round trip, then `npm run character:validate` before commit.

## Runtime acceptance

The GLB is installed from an explicit load/retry lifecycle. Missing bones, clips, weights, textures, scale, orientation,
materials or budget fail the load. The loading menu remains on “Getting the player ready”; failure shows a Retry action,
and solo/online startup remains blocked until the real rig validates.

Runtime cross-fades all base clips. Cover twist, drive-by pose/recoil, bicycle cadence, freefall pitch/bank, drunken sway
and tumble direction/progress are applied to the authored bones after mixer evaluation. The same rig remains visible at
all third-person distances and on two-wheelers, and is hidden in first person or enclosed vehicles.
