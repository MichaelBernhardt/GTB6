# Tree asset brief

## Goal

Replace every runtime-generated tree with a required, compact Blender-authored asset while preserving the city
streamer's deterministic placement, material merging, culling, and regeneration behaviour. Small foliage remains in
the procedural path; there is intentionally no procedural tree fallback.

## Library contract

- One `JohannesburgTreeLibrary` v1 GLB root, metres, Y-up, with every asset centred on X/Z and grounded at Y=0.
- Seven South African/Joburg-readable species: jacaranda, shade tree, gum, plantation/stone pine, acacia, coastal palm,
  and landmark fig/coral tree. Each ships two distinct variants.
- Opaque `MeshStandardMaterial` surfaces only. Leaf and frond materials are double-sided but stay out of the blended
  transparency path; the library has no texture, skin, animation, light, or camera dependencies.
- Per-asset metadata records species, variant, maximum footprint, and slim trunk collider. Runtime adds only a seeded
  0.84–1.0 uniform scale and clones geometry so streamed cell baking can safely dispose each source instance.
- Roadside and park trees use the same library: roadside trees retain shared source geometry for per-chunk instancing,
  while park trees follow the normal static world merge. Runtime-generated trunk-and-sphere trees are not permitted.
- Startup waits for both the protagonist and tree GLBs. Missing, malformed, or incomplete tree assets keep the city
  closed and expose Retry; a procedural substitute is not permitted.

## Workflow and budgets

`npm run foliage:build` creates the ignored editable `.blend` from `art/foliage/recipe.json` and
`tools/foliage/create-source.py`, exports `public/models/foliage/joburg-trees.glb`, updates the committed SHA-256 lock,
and invokes `npm run foliage:validate`. The validator caps the whole library at 1 MiB and checks all fourteen roots,
metadata, PBR materials, normals, grounding, centring, catalog footprints, trunk colliders, and per-species triangles.

The current asset is about 167 KiB and 3,344 triangles across the entire library. Per-instance budgets remain between
240 and 500 triangles, allowing the existing per-cell geometry baker to retain its small draw-call and streaming cost.
