# Protagonist asset contract

`protagonist.glb` is the only playable character visual. There is no visual or reduced-animation fallback: character
loading and validation must succeed before the main menu becomes available.

The committed asset contract is enforced by `npm run character:validate` and again by `RiggedPlayerVisual` at install:

- exactly 1.8 m high, positive-Z facing, feet at the origin;
- 45,000–60,000 triangles, exactly four opaque skinned material meshes, and no more than four influences per vertex;
- exactly four 2K base-colour material groups: `SkinEyes`, `TealTechnicalJacket`, `CharcoalJeans`, `HairShoes`;
- the 16 canonical humanoid bones named in `RiggedPlayerVisual.ts`;
- exactly 24 in-place clips baked at 30 fps: `idle`, `walk`, `sprint`, `aim`, `aim_forward`, `aim_back`, `aim_left`,
  `aim_right`, `fire`, `punch_left`, `punch_right`, `jump`, `fall`, `land`, `tumble`, `death`, `cover_idle`,
  `cover_move`, `cover_aim`, `ride_bicycle`, `ride_motorbike`, `ride_superbike`, `freefall`, and `parachute`;
- a combined GLB and base-colour transfer below 10 MiB, with no transparent hair and no animation translation tracks
  other than the zero-mean pelvis bob/sway on `Hips` in the mocap-retargeted locomotion clips.

`npm run character:build` requires Blender 4.2+ (or `BLENDER=/path/to/blender`) and writes generated FBX/GLB files under
the ignored `build/character/` directory before validating and installing the final GLB. Set `CHARACTER_SOURCE` to the
artist-owned MPFB `.blend` or an FBX source; the committed GLB is accepted as a bootstrap round-trip input. Blender and
FBX working files remain out of Git.
