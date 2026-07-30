import { approachNear, fuelHud, fuelTick, sanitizeFuelSave } from './fuel.state';
import { nearGolfCourse, sanitizeGolfState } from './golf.state';
import { sanitizeInteriorsState, streetsHere } from './interiors.state';
import { grievanceHud, grievanceWarming, sanitizeProtestState, tickGrievance } from './protest.state';
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
    // The grievance is a SIMULATION — outage hours the player personally stood in — so it belongs on
    // the sim sub-step like every other one, and the chip that shows it belongs beside the fuel gauge.
    // Both hooks are one call each into the eager `protest.state.ts`, and the loaded body calls the
    // very same two functions, so the rate and the strip cannot change when the chunk lands.
    //
    // It has been in the two wrong places already. It ticked inside `approach.near()` (skipped the
    // moment any feature ordered above offered first: 3.90 outage-hours in the open street against
    // 0.00 on a doorstep), and then off `powerGrid.onPowerChange` against `performance.now()` (a wall
    // clock that ran while the game was paused and carried no position, so there was never an anchor
    // and every protest went up on the road under the player's own feet). See protest.state.ts.
    eager: {
      tick: (_dt, ctx) => tickGrievance(ctx),
      hud: () => grievanceHud(),
    },
    // `near` is constant FALSE, and there is no prompt for starting a protest at all.
    //
    // It used to be `near: () => ripe`, which is a predicate with no position in it — so the rung it
    // fed offered `E  Follow the smoke` from anywhere in the city, above `E  Enter vehicle` in
    // Game.updateOnFoot, for as long as the grievance stayed ripe. The owner could not get into a car.
    // A protest is not a thing you walk up to and press a key on; it is a thing that happens, and the
    // body raises it out of its own `update()`.
    //
    // What is left is `preload`, the interiors seam: a coarse "there is work for this feature around
    // here" test that fetches the body while offering nothing and stealing no press. It fires early —
    // at HUD_FROM_FRACTION, not at ripeness — because the body is what says "this district has had
    // enough" and what closes the road, so it has to be running BEFORE the grievance ripens.
    approach: {
      context: 'foot', order: 60, prompt: 'E  Join the picket',
      near: () => false,
      preload: () => grievanceWarming(),
    } as PreloadingApproach,
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
