/**
 * The feature contract — types only, so this module is erased at build time and costs zero bytes.
 *
 * A feature is a self-contained slice of gameplay that lives in `src/features/<id>/` and is loaded
 * on demand. Its body is NEVER imported statically: `src/features/<id>/` matches no `manualChunk`
 * rule in vite.config.ts, so rollup emits it as an independent async chunk that boot never touches.
 * See src/features/README.md for the step-by-step.
 *
 * Everything a feature needs from the game arrives through FeatureGameApi. Nothing here imports
 * Game, City or any system at runtime — only `import type`, which the compiler erases.
 */
import type { Scene, Vector3 } from 'three';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';

// ---- interactions ------------------------------------------------------------------------------

/** Which E ladder a descriptor belongs to: on foot, or behind the wheel. */
export type InteractionContext = 'foot' | 'vehicle';

/** What the world looks like at the moment E is pressed (or the prompt is drawn — same resolver). */
export interface InteractionCtx {
  readonly context: InteractionContext;
  /** The HUD focus: the driven vehicle's position while driving, the player's on foot. */
  readonly position: Vector3;
  /** The vehicle the player is driving, or undefined on foot. */
  readonly vehicle: Vehicle | undefined;
  /** Hour of day, 0..24 (fractional). */
  readonly hour: number;
}

/** A thing E would do right now. `prompt` is shown verbatim in the HUD and parsed into a mobile pill,
 *  so it MUST start with the key token followed by two spaces: `E  Fill up · R200`. */
export interface InteractionOffer {
  readonly prompt: string;
  act(): void;
}

/** One rung of the shared interaction ladder. Both the key handler and the prompt band resolve the
 *  SAME descriptor through the same call, so prompt and key can never disagree. */
export interface InteractionDescriptor {
  readonly id: string;
  /** Lower wins. Ties break on id, so the order is stable across builds. */
  readonly order: number;
  readonly context: InteractionContext;
  /** Return undefined when there is nothing to offer — that hands the rung to the next descriptor
   *  and, in a vehicle, keeps `E  Exit vehicle` reachable. */
  test(ctx: InteractionCtx): InteractionOffer | undefined;
}

/** The eager stand-in a feature declares in registry.ts so there is something to walk up to BEFORE
 *  its body loads. Keep `near` to a cheap distance test over data derived at runtime — never typed
 *  world coordinates, which the map rework invalidates. It must be PURE: it is the prompt resolver,
 *  it runs from the render loop, and it may be skipped entirely when a lower rung answers first — so
 *  a simulation side effect hidden in here is both frame-rate coupled and conditional. Put that in
 *  `FeatureEagerSlice.tick`. Acting on it loads the feature, then immediately re-resolves against the
 *  loaded descriptors. */
export interface FeatureApproach {
  readonly context: InteractionContext;
  readonly order: number;
  readonly prompt: string;
  near(ctx: InteractionCtx): boolean;
}

/**
 * The part of a feature that has to be TRUE before the player opts in.
 *
 * Almost no feature needs this and the default answer is "you don't". A feature body loads on
 * approach, which is exactly right for a golf course or a protest — nothing about them exists until
 * you walk up. It is wrong for anything the player is entitled to see or feel WITHOUT having found
 * the feature first: petrol is the case that forced it, because a fuel tank that only starts draining
 * once you have pulled into a garage is a mechanic you can decline, and a gauge that only appears
 * once the chunk lands is a gauge the player never sees. (They didn't: the owner drove a whole
 * session and reported "I don't see a gauge".)
 *
 * Both hooks are called ONLY while the body is not loaded. The moment it is, the loaded system's own
 * `update`/`hud` take over, so nothing can ever run twice. Keep both in the eager `<id>.state.ts` —
 * whatever they touch is boot payload for every player, forever.
 */
export interface FeatureEagerSlice {
  /** Per SIMULATION step — the same fixed sub-step the world runs on, never a render frame. Use this
   *  and not `approach.near` for anything that advances state, or the rate depends on frame rate. */
  tick?(dt: number, ctx: InteractionCtx): void;
  /** HUD chips to show before the body exists. Build them with the same function the body uses so
   *  the strip does not change shape at the moment the chunk lands. */
  hud?(ctx: InteractionCtx): readonly FeatureHudEntry[] | undefined;
}

// ---- what the game hands a feature -------------------------------------------------------------

/** Analytics payload: flat, small, and bounded server-side (see server/analytics.mjs). */
export interface FeatureEventProps { detail?: string; value?: number }

/**
 * Everything a feature may touch. Deliberately FLAT and all-callable: every volatile value is a
 * method, so there is no way to accidentally cache a stale player position or a stale balance. The
 * only property is `scene`, which never changes.
 */
export interface FeatureGameApi {
  /** The world scene. Add your groups here; remove them again in dispose(). */
  readonly scene: Scene;
  /** Ground height under a world point. */
  surfaceHeightAt(x: number, z: number): number;
  districtAt(x: number, z: number): string;
  isPark(x: number, z: number): boolean;
  nearestRoadPose(at: Vector3): { position: Vector3; heading: number };
  /** Live player position — call per frame, never retain the returned reference across frames. */
  playerPosition(): Vector3;
  playerHeading(): number;
  /** The vehicle the player is driving, or undefined on foot. */
  drivenVehicle(): Vehicle | undefined;
  /** Hour of day, 0..24 (fractional). */
  hour(): number;
  /** Eased 0..1 load-shedding darkness (1 = full blackout). */
  blackout(): number;
  balance(): number;
  earn(amount: number): void;
  /** Spends nothing and returns false when the player cannot cover it. */
  spend(amount: number): boolean;
  notify(title: string, detail?: string, success?: boolean): void;
  /** Opens the host-owned menu screen and pauses the world. Rows come back through `menu(actionId)`. */
  showMenu(view: FeatureMenuView): void;
  /** Closes the menu and resumes play. */
  closeMenu(): void;
  /** Writes the save. Call after a state change worth keeping — the autosave also runs every 8s. */
  persist(): void;
  /** One event catalogue for every feature: emitted as `feature_event { feature: <id>, event }`.
   *  The host binds your feature id for you — you pass only the event name. */
  analytics(event: string, props?: FeatureEventProps): void;
  /** A placed fixture ped: excluded from the ambient census, from despawn recycling, and from taxi
   *  hailing. NEVER use the `contact` flag for this — it makes the ped invulnerable AND
   *  Game.updateContactPresence hides any contact ped that is not a live mission giver. */
  spawnFixture(x: number, z: number, name?: string): Pedestrian | undefined;
  /** Removes a fixture from the scene and the population roster. Also call this from dispose(). */
  removeFixture(ped: Pedestrian): void;
}

// ---- HUD + menu ---------------------------------------------------------------------------------

/** One chip in the host-owned HUD strip. Keep `label` to a few characters — it sits beside STIM/CHUTE. */
export interface FeatureHudEntry {
  /** Unique within the frame (prefix it with your feature id). */
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  /** 0..100 — draws a thin fill bar under the label. */
  readonly fill?: number;
  /** Paints the chip in the warning colour (low fuel, expiring lay-by). */
  readonly warn?: boolean;
}

export interface FeatureMenuRow {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** Rand price, rendered on the right. */
  readonly price?: number;
  /** Right-hand text when there is no price ('FULL', 'SOLD OUT'). Ignored when `price` is set. */
  readonly note?: string;
  readonly disabled?: boolean;
}

/** The one generic menu screen every feature shares. It reuses the existing shop card styling, so no
 *  feature adds a MenuScreen member, a MenuView method, a UIManager.show*, a back() entry or a bindUI
 *  callback — those all landed once, here. */
export interface FeatureMenuView {
  readonly featureId: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly blurb?: string;
  /** Shows the ON HAND stamp when present. */
  readonly balance?: number;
  readonly rows: readonly FeatureMenuRow[];
  readonly leaveLabel?: string;
}

// ---- the feature itself -------------------------------------------------------------------------

/** Everything a loaded feature may implement. Only `dispose` is required. */
export interface FeatureSystem {
  /** Per sim step. Never called while the player is in online PvP — features are suspended there. */
  update?(dt: number): void;
  /** HUD chips for this frame. Return undefined or [] for nothing. */
  hud?(): readonly FeatureHudEntry[] | undefined;
  /** Full-fidelity interaction rungs. These replace the eager `approach` entry once loaded. */
  interactions?(): readonly InteractionDescriptor[];
  /** The slice stored under `SavedGame.features[saveKey]`. Must be JSON-safe. */
  serialize?(): unknown;
  /** A checkpoint reload handed this feature a new slice while it was already loaded. */
  restore?(state: unknown): void;
  /** A row on the host-owned menu was clicked. */
  menu?(actionId: string): void;
  /** `feature <id> <args>` from the developer console. Return the lines to print. */
  command?(args: readonly string[]): string[];
  /** Machine playthrough driver, reached as `window.__qa.feature('<id>', action, args)`. Return a
   *  status string in the harness vocabulary: 'ok', 'stuck:<why>', 'failed:<why>'. */
  qa?(action: string, args: Record<string, unknown>): string;
  /** Remove every scene object, collider, fixture ped and timer this feature added. Called on new
   *  game, checkpoint reload and a stale lazy arrival — it must be safe to call more than once. */
  dispose(): void;
}

/** The shape of the lazily imported module: `src/features/<id>/<id>.ts` must export this exact name. */
export interface FeatureModule {
  createFeature(api: FeatureGameApi, state: unknown): FeatureSystem | Promise<FeatureSystem>;
}

/** The whole eager cost of a feature: one entry in the registry array. Arrays merge; god objects don't. */
export interface FeatureDescriptor {
  /** Lowercase slug. Also the console name, the QA name and the analytics `feature` field. */
  readonly id: string;
  /** Key inside `SavedGame.features`. Conventionally the same as `id`. */
  readonly saveKey: string;
  /** Human name for console listings. */
  readonly label: string;
  /** Refines the generic JSON-safe blob into this feature's own shape. Runs during SaveManager's
   *  synchronous deserialize, so it must not import anything from the feature body. */
  sanitize?(raw: unknown): unknown;
  /** Optional eager proximity stand-in — see FeatureApproach. */
  readonly approach?: FeatureApproach;
  /** Optional always-on half: a per-sim tick and/or a HUD chip that exist before the body does.
   *  See FeatureEagerSlice, and read the "you probably don't need this" paragraph on it first. */
  readonly eager?: FeatureEagerSlice;
  /** The ONLY runtime reference to the feature body. `() => import('./golf/golf')`. */
  load(): Promise<FeatureModule>;
}
