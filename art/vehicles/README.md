# Blender vehicle fleet

This directory owns the reproducible Blender sources, recipes, inspection sheets, and art provenance for all five four-wheel vehicles.

- `recipe.json` and `create-source.py` retain the livery-specific Quantum Express pipeline.
- `road-cars.json` and `create-road-car.py` generate the Citi Golf, Vrrr Phaa GTI, Hilux Bakkie, and JMPD Interceptor from one strict catalog while preserving distinct silhouettes and named details.
- `npm run vehicle:build` recreates the editable Blend sources, five optimized GLBs, five four-view turnarounds, taxi atlas, and source lock.
- `npm run vehicle:validate` checks every committed model contract, hierarchy, axis, footprint, grounding, triangle/material/texture/transfer budget, and source checksum.
- Blender 4.2+ and Python 3 with Pillow are required to rebuild. Set `BLENDER=/path/to/blender` when Blender is not on `PATH` or installed at the standard macOS location.

Every runtime model faces +Z, uses +Y up, is centred on X/Z, and is grounded at the tyre contact patches. Geometry is shared between instances; materials are cloned per vehicle so paint overrides, lamps, braking, and wreck state remain independent. The upper `cabin` hierarchy is the sole first-person hidden part, leaving bakkie beds and lower liveries visible.
