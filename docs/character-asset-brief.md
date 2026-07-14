# San Cordova protagonist asset brief

## Direction

Create an original, stylised GTA-like Johannesburg protagonist with moderate realism, a strong silhouette, readable
street clothing, and browser-game proportions. The design must not reproduce a Grand Theft Auto character, logo,
wardrobe, photograph, or other protected likeness.

Reference sheets should show neutral front, three-quarter, profile, and back views at matching scale, plus face, hair,
shoe, jacket, and material callouts. Generated images are art direction and texture source material—not a texture that
can be wrapped around an arbitrary mesh.

## Production workflow

1. Start from a redistribution-safe humanoid rig. The free CC0 Quaternius Universal Animation Library is the preferred
   animation source; archive its license and source URL with the working files.
2. Adjust the mesh and clothing to the approved reference sheet without changing the canonical humanoid hierarchy.
3. Export the final UV guide and orthographic mesh renders. Project or paint generated materials onto that exact UV
   layout, clean seams manually, and bake base-colour, normal, and roughness maps.
4. Retarget and trim the required in-place clips in Blender, remove unused tracks and assets, and export one GLB using
   the contract in `public/models/characters/README.md`.
5. Validate scale, orientation, clip names, weapon-hand clearance, shoulder RPG placement, shadows, and file budget in
   the game before replacing `player-placeholder.glb`.

## Acceptance

The character must read clearly at the normal third-person camera distance, remain under the asset budget, hold every
weapon without obvious clipping, preserve cover/bike/parachute bone overrides, and fall back to the procedural player
if the GLB is unavailable or invalid.
