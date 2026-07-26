import { doorNear, sanitizeInteriorsState } from './interiors.state';
import type { FeatureDescriptor } from './types';

/**
 * The ONE eager module in the feature system. Everything here is loaded at boot, so keep it to
 * descriptors: an id, a save key, a label, an optional sanitizer, an optional proximity stand-in,
 * and a `load()` that dynamic-imports the body. No scene objects, no world geometry, no tables.
 *
 * Adding a feature is ONE entry in this array — see src/features/README.md.
 *
 * BUNDLE RULES (verified against a real build; breaking either one costs boot bytes forever):
 *  - Never import anything from `./<id>/` here except through the `load()` dynamic import. A static
 *    import would pull the whole feature body into the eager graph and defeat the entire design.
 *  - If a sanitizer is too big to write inline, put it in a TOP-LEVEL `src/features/<id>.state.ts`
 *    (one path segment), which vite.config.ts sweeps into the `gameplay-rules` chunk. A state module
 *    inside `src/features/<id>/` imported from BOTH here and the lazy body becomes its own extra
 *    eager chunk — import it with `import type` from the body.
 */
export const FEATURES: readonly FeatureDescriptor[] = [
  {
    id: 'interiors', saveKey: 'interiors', label: 'Building interiors',
    sanitize: sanitizeInteriorsState,
    load: () => import('./interiors/interiors'),
    // Something to walk up to before the chunk lands: the doorsteps are derived from the generated
    // road network, so this ring is the same ring the loaded rung uses.
    approach: { context: 'foot', order: 50, prompt: 'E  Go inside', near: (ctx) => doorNear(ctx.position.x, ctx.position.z) !== undefined },
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
