/// <reference types="vite/client" />

/** Deployed git release short hash, injected by Vite's define (see vite.config.ts). */
declare const __BUILD_HASH__: string;
/** Build-time fingerprint of the generated map; avoids JSON.stringify allocating ~1 MB during boot. */
declare const __MAP_DATA_HASH__: string;

declare module '*.css';

// The generated OSM map is imported as a plain parsed value and narrowed by src/world/mapData.ts.
// (A structural declaration keeps tsc from type-inferring the entire ~1 MB JSON literal.)
declare module '*joburg-map.json' {
  const map: unknown;
  export default map;
}
