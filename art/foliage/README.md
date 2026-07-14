# Blender tree art source

`npm run foliage:build` deterministically creates an editable Blender source file in `art/foliage/work/`, exports the
web library, validates its hierarchy and budgets, and installs `public/models/foliage/joburg-trees.glb`.

The source is generated from `recipe.json` plus `tools/foliage/create-source.py`; no downloaded meshes, textures, or
third-party plant generators are used. The `.blend` file is deliberately ignored because the script and recipe are the
reproducible source of truth. All fourteen tree assets use metres, stand on the origin plane, and contain applied
transforms, authored normals, opaque/two-sided leaf materials, and a small metadata contract consumed by the game.

Each of the seven tree species has two distinct Blender-authored silhouettes. Runtime seed variation adds a restrained
uniform scale while keeping the model inside its catalog footprint. Shrubs, grass, aloes, agaves, and hedges remain in
the lightweight procedural foliage path.
