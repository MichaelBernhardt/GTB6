# Runtime tree library

`joburg-trees.glb` is the required, Blender-authored runtime source for jacaranda, shade, gum, pine, acacia, palm, and
landmark trees. It contains two variants per species, shared PBR materials, no textures or animations, and metadata for
identity, footprint, and the trunk collider.

Rebuild and validate it with:

```sh
npm run foliage:build
npm run foliage:validate
```

Do not edit the GLB directly; see `art/foliage/README.md` for the reproducible source workflow.
