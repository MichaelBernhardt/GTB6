# Quantum Express vehicle asset

This directory owns the reproducible Blender source and art provenance for the uniform taxi fleet.

- `npm run vehicle:build` creates the 2048² atlas, Blender source, optimized GLB, preview turnaround, and checksums.
- `npm run vehicle:validate` checks the committed model contract, hierarchy, axes, bounds, triangle/texture/transfer budgets, opaque materials, and source checksums.
- Blender 4.2+ and Python 3 with Pillow are required to rebuild. Set `BLENDER=/path/to/blender` when Blender is not on `PATH` or installed at the standard macOS location.

The runtime model faces +Z, uses +Y up, is centred on X/Z, and is grounded at the tyre contact patches. Geometry and textures are shared between taxi instances; materials are cloned per taxi so lights and wreck state remain independent.
