# Rigged ambient pedestrian asset contract

`npm run npc:build` creates the four MPFB sources, blends the generated textile tiles into the garments' real UV
textures, retargets the locked Quaternius locomotion source, renders preview/contact sheets, exports ignored FBX/Blend
sources, installs optimized GLBs, and runs `npm run npc:validate`.

Each shipped NPC is positive-Z facing with feet at the origin, 12,000–30,000 triangles, no more than five opaque skinned
materials or four bone influences per vertex, four external 1024×1024 base-colour textures, and the shared 16-bone
humanoid naming contract. The exact in-place, 30 fps clip set is `idle`, `walk`, `sprint`, `punch_right`, and `death`.
Each model plus textures is at most 3 MiB; the quartet is at most 12 MiB.

At runtime the procedural pedestrian remains visible until a rig validates and installs. Templates are cached per URL;
instances share immutable render resources but receive independent skeletons and animation mixers. Load failure never
blocks startup, and despawn stops/detaches the instance without disposing shared GPU resources.
