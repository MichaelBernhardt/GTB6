/// <reference types="vite/client" />

declare module '*.css';

// The generated OSM map is imported as a plain parsed value and narrowed by src/world/mapData.ts.
// (A structural declaration keeps tsc from type-inferring the entire ~1 MB JSON literal.)
declare module '*joburg-map.json' {
  const map: unknown;
  export default map;
}
