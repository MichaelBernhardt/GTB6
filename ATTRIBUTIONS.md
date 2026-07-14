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

- City, road, building, prop, vegetation, vehicle, marker, particle, and water geometry is generated at runtime from Three.js primitives.
- The rigged player placeholder (`public/models/characters/player-placeholder.glb`) is original project geometry and animation generated from Three.js primitives by `tools/character/build-placeholder.mjs`.
- UI artwork is HTML, CSS, and canvas code authored for this project.
- Engine, firearm, reload, collision, UI, and siren sounds are original runtime synthesis using the Web Audio API.
- Names, setting, mission text, vehicle designs, characters, and game rules are original to this project.

## Generated texture assets

- `public/textures/asphalt-gpt.jpg` - seamless coastal-city asphalt generated for this project with OpenAI GPT Image, then resized and JPEG-optimized locally.
- `public/textures/concrete-gpt.jpg` - seamless weathered concrete pavement generated for this project with OpenAI GPT Image, then resized and JPEG-optimized locally.
- `public/textures/character/teal-jacket-gpt.jpg` - seamless dark-teal technical jacket fabric generated with OpenAI GPT Image for the player character.
- `public/textures/character/charcoal-denim-gpt.jpg` - seamless charcoal denim generated with OpenAI GPT Image for the player character.

No Grand Theft Auto maps, logos, characters, dialogue, music, sound effects, or other copyrighted assets are included.
