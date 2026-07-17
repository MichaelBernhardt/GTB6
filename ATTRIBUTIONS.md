# Attributions

## Map data

- Map data © OpenStreetMap contributors, ODbL. The generated Johannesburg map (`src/world/generated/joburg-map.json`, built by `tools/mapgen`) is derived from [OpenStreetMap](https://www.openstreetmap.org/copyright) data fetched via the Overpass API and is made available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- Elevation data: NASA SRTM (public domain), fetched via [opentopodata.org](https://www.opentopodata.org/).

## Runtime dependencies

- [Three.js](https://threejs.org/) - 3D rendering library, MIT License.
- [Vite](https://vite.dev/) - development server and production build tooling, MIT License.
- [TypeScript](https://www.typescriptlang.org/) - language and compiler, Apache License 2.0.
- [Vitest](https://vitest.dev/) - logic test runner, MIT License.
- [ESLint](https://eslint.org/) and typescript-eslint - lint tooling, MIT License.

## Game assets

San Cordova does not ship third-party art or audio assets.

- City, road, building, prop, non-tree vegetation, vehicle, marker, particle, and water geometry is generated at runtime from Three.js primitives.
- The tree library (`public/models/foliage/joburg-trees.glb`) is wholly original project-authored Blender geometry generated from the committed recipe and Python source under `art/foliage/` and `tools/foliage/`; it uses no downloaded meshes, textures, or plant-generator assets.
- The protagonist (`public/models/characters/protagonist.glb`) and sixteen-character Johannesburg NPC cast (`public/models/npcs/`) are wholly original project characters with no real-person or protected game-character likeness. Their deterministic asset contracts, recipes and source locks live under `art/character/` and `art/npcs/`.
- UI artwork is HTML, CSS, and canvas code authored for this project.
- Engine, firearm, reload, collision, UI, and siren sounds are original runtime synthesis using the Web Audio API.
- Names, setting, mission text, vehicle designs, characters, and game rules are original to this project.

## Generated texture assets

- `public/textures/asphalt-gpt.jpg` - seamless coastal-city asphalt generated for this project with OpenAI GPT Image, then resized and JPEG-optimized locally.
- `public/textures/concrete-gpt.jpg` - seamless weathered concrete pavement generated for this project with OpenAI GPT Image, then resized and JPEG-optimized locally.
- `art/character/references/protagonist-turnaround.jpg` and `protagonist-face.jpg` - original character modeling references generated with OpenAI's built-in image-generation tool.
- `art/character/materials/protagonist-jacket-source.png` and `protagonist-denim-source.png` - seamless material sources generated with OpenAI's built-in image-generation tool, then converted into the protagonist's 2K runtime base-colour maps.
- `art/npcs/references/*-turnaround.png` - sixteen original adult Johannesburg NPC modeling references generated with OpenAI's built-in image-generation tool.
- `art/npcs/materials/*-source.png` - sixteen seamless textile sources generated with OpenAI's built-in image-generation tool, then blended into the garments' real UV base-colour textures.

## Optional authoring sources

The reproducible Blender workflow is configured for MPFB 2.0.16, CC0-only MakeHuman asset packs, and walk/sprint
cycles retargeted from the [CMU Graphics Lab Motion Capture Database](https://mocap.cs.cmu.edu/) (subjects 08 and 09,
BVH conversion by Bruce Hahne). The CMU data is free for all uses; the database was created with funding from
NSF EIA-0196217. These upstream authoring packages are not redistributed in this repository; their URLs, versions,
checksums and license constraints are recorded in `art/character/sources.lock.json` and `art/npcs/sources.lock.json`.

No Grand Theft Auto maps, logos, characters, dialogue, music, sound effects, or other copyrighted assets are included.
