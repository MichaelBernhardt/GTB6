import { approachNear, fuelHud, fuelTick, sanitizeFuelSave } from './fuel.state';
import { nearGolfCourse, sanitizeGolfState } from './golf.state';
import { sanitizeInteriorsState, streetsHere } from './interiors.state';
import { sanitizeProtestState, shutdownPending } from './protest.state';
import { nearestStreetSite, sanitizeStreetState, STREET_LOAD_RADIUS } from './street.state';
import type { FeatureApproach, FeatureDescriptor } from './types';

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

/** See host.preloadNearby(). Nearly every feature rides the proximity ring on `approach.near` — the
 *  same predicate that offers the prompt. A feature whose prompt belongs to something only the
 *  loaded body can find (interiors: real doors on real buildings) has no such predicate, so it
 *  declares `preload(x, z)` instead: a coarse "there is work for this feature around here" test that
 *  fetches the body without ever offering a rung or stealing a press. Deliberately NOT on
 *  FeatureApproach — one feature needs it, the host duck-types it, and nothing else in the registry
 *  has to know it exists. */
type PreloadingApproach = FeatureApproach & { preload(x: number, z: number): boolean };

export const FEATURES: readonly FeatureDescriptor[] = [
  {
    id: 'golf', saveKey: 'golf', label: 'Golf', sanitize: sanitizeGolfState,
    load: () => import('./golf/golf'),
    // Standing on ANY golf polygon is enough to make E mean something; which of the ten is actually
    // playable is decided inside the lazy body, so no site derivation is duplicated out here.
    approach: { context: 'foot', order: 55, prompt: 'E  Walk onto the golf course', near: (ctx) => nearGolfCourse(ctx.position.x, ctx.position.z) },
  },
  {
    id: 'fuel', saveKey: 'fuel', label: 'Petrol',
    sanitize: sanitizeFuelSave,
    load: () => import('./fuel/fuel'),
    // Petrol is the one feature that has to be TRUE before the player opts in — a tank that only
    // starts draining once you have pulled into a garage is a mechanic you can decline, and a gauge
    // that only appears once the chunk lands is a gauge nobody ever sees. Both live in the eager
    // slice; the body takes over the moment it loads. See FeatureEagerSlice in types.ts.
    eager: {
      tick: (dt, ctx) => fuelTick(dt, ctx),
      hud: (ctx) => fuelHud(ctx),
    },
    approach: {
      context: 'vehicle', order: 12, prompt: 'E  Pull in for petrol',
      near: (ctx) => approachNear(ctx.vehicle, ctx.position.x, ctx.position.z),
    },
  },
  {
    id: 'protest', saveKey: 'protest', label: 'Protests + burning tyres',
    sanitize: sanitizeProtestState,
    load: () => import('./protest/protest'),
    // A PURE predicate — one read, no side effect, and that is load-bearing.
    //
    // This used to tick the grievance clock here, on the grounds that `near()` is the only per-frame
    // hook an unloaded feature gets. It is, and it is also not reliable: `resolveInteraction` returns
    // on the FIRST descriptor that offers something, and `order: 60` puts this one below every other
    // feature. On a registry with only protest in it the clock ran; with anything else registered
    // above it the clock stopped dead wherever the player was standing — the cross-feature verifier
    // measured 3.90 outage-hours out in the open street and 0.00 on a street corner or a doorstep.
    // Since the ledger is this feature's ONLY unlock gate, that would have shipped a feature that can
    // never trigger. The clock now runs off powerGrid's own transition hook; see protest.state.ts.
    approach: {
      context: 'foot', order: 60, prompt: 'E  Follow the smoke',
      near: () => shutdownPending(false),
    },
  },
  {
    id: 'street', saveKey: 'street', label: 'Street economy',
    sanitize: sanitizeStreetState,
    load: () => import('./street/street'),
    // The proximity ring. FeatureHost.preloadNearby() watches this every 0.4 s and loads the body
    // the moment the player is inside it, so the corners are staffed, lit and blipped BEFORE the
    // player is close enough to see anybody — which is the whole difference between "there are
    // people on the street" and the owner's playtest, where pressing E on this prompt was the only
    // thing in the entire build that could make them exist.
    //
    // The prompt below is now a fallback that a player should never see: it only rejoins the ladder
    // if the chunk fetch itself fails. It stays because a failed fetch must not mean a dead street.
    approach: {
      context: 'foot', order: 58, prompt: 'E  Ask around · somebody works this block',
      near: (ctx) => {
        const near = nearestStreetSite(ctx.position.x, ctx.position.z);
        return near !== undefined && near.distanceSq < STREET_LOAD_RADIUS * STREET_LOAD_RADIUS;
      },
    },
  },
  {
    id: 'interiors', saveKey: 'interiors', label: 'Building interiors',
    sanitize: sanitizeInteriorsState,
    load: () => import('./interiors/interiors'),
    // `near` stays false on purpose: this feature's prompt belongs to real doors on real buildings,
    // and only the body knows where those are — CityGen cannot be reached from an eager chunk
    // without making gameplay-rules and simulation mutually uninitialisable (see interiors.state.ts).
    // `preload` is what makes the doorways EXIST to be walked up to: standing in a street is enough.
    //
    // `order: 64` is therefore the order of a rung that can never resolve — `near` is constant false.
    // It is the last number in the on-foot ladder anyway, so if the duck-typed preload hook is ever
    // promoted onto FeatureApproach and this stand-in starts offering, it queues behind every other
    // feature instead of jumping the queue with a prompt about a door it cannot point at.
    approach: {
      context: 'foot', order: 64, prompt: 'E  Go inside',
      near: () => false,
      preload: (x, z) => streetsHere(x, z),
    } as PreloadingApproach,
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
