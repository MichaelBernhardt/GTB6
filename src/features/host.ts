import { resolveInteraction, sortInteractions } from './interactions';
import { FEATURES } from './registry';
import type {
  FeatureDescriptor, FeatureEventProps, FeatureGameApi, FeatureHudEntry, FeatureMenuView,
  FeatureSystem, InteractionContext, InteractionCtx, InteractionDescriptor, InteractionOffer,
} from './types';

/** Everything the host needs from Game that isn't already on FeatureGameApi. Lazy accessors only —
 *  the host is constructed early in the Game constructor, before most systems exist. */
export interface FeatureHostContext {
  api: FeatureGameApi;
  /** True while the player is in online PvP. Features are suspended there: no ticks, no prompts, no
   *  loading. Protest crowds and street fixtures must never spawn into someone else's PvP session. */
  suspended(): boolean;
  /** Routed to analytics.feature(id, event, props) by Game — the one event catalogue for all features. */
  emit(id: string, event: string, props?: FeatureEventProps): void;
  /** Routed to analytics.captureError with severity 'recoverable', mirroring setupComposer. */
  reportError(error: unknown, asset: string): void;
}

/**
 * A blip a loaded feature wants on the radar and the city map, in the minimap's own language.
 *
 * Declared HERE rather than on FeatureSystem so no feature has to widen the shared contract to be
 * findable. `objective: true` is the gold pin that never leaves the minimap — out of range it rides
 * the edge with an arrowhead — and it is reserved for a place the player has actually been SENT.
 * Structurally identical to ui/MinimapView's MapMarker, without dragging a UI import into features.
 */
export interface FeatureMapIcon {
  readonly x: number;
  readonly z: number;
  readonly color: string;
  readonly shape?: 'circle' | 'diamond' | 'house';
  readonly objective?: boolean;
  readonly area?: number;
}

/** Implement this alongside FeatureSystem to put blips on the radar. Optional and structural: a
 *  feature that doesn't want blips changes nothing. */
export interface FeatureMapSource {
  mapIcons?(): readonly FeatureMapIcon[];
}

/** How often the host asks unloaded features "is the player in your ring yet?". Cheap — the
 *  predicates are distance tests over derived data — but there is no reason to run it per frame. */
const PRELOAD_INTERVAL = 0.4;

/**
 * The lazy feature host: Game's entire footprint for every feature that will ever ship.
 *
 * Game gets ONE field, ONE update() line, ONE ui.update() key, ONE persist() key, ONE console
 * command, and the four interaction branches (on-foot E, in-vehicle E, and both prompt bands). A new
 * feature adds a FILE plus one line in an ARRAY. Arrays merge; god-object methods do not.
 *
 * Load discipline follows Game.setupComposer verbatim, because the boot error traps in main.ts stay
 * armed until the `gtb-boot-ready` event: every lazy import is voided with its own `.catch`, or an
 * unhandled rejection replaces the screen with the "city failed to start" card. A generation counter
 * per feature disposes a stale arrival (a load that resolves after a new game, a checkpoint reload or
 * a dispose) instead of leaving orphaned meshes in the scene.
 */
export class FeatureHost {
  private readonly systems = new Map<string, FeatureSystem>();
  private readonly generations = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<FeatureSystem | undefined>>();
  /** Save slices for features that are NOT loaded. Handed over when a feature loads; merged back on
   *  persist so an unloaded feature's progress is never wiped by a session that didn't touch it. */
  private stored: Record<string, unknown> = {};
  /** Features whose body is being fetched because the player walked into the ring, not because they
   *  pressed anything. While an id is in here its eager stand-in is kept OFF the ladder. */
  private readonly preloading = new Set<string>();
  /** Ids whose auto-load threw. Never retried automatically; the manual approach press comes back. */
  private readonly preloadFailed = new Set<string>();
  private preloadTimer = 0;

  constructor(private readonly context: FeatureHostContext, private readonly registry: readonly FeatureDescriptor[] = FEATURES) {}

  /** Ids in the registry, in declaration order. */
  get ids(): string[] { return this.registry.map((feature) => feature.id); }
  get loadedIds(): string[] { return [...this.systems.keys()].sort(); }
  isLoaded(id: string): boolean { return this.systems.has(id); }
  loaded(id: string): FeatureSystem | undefined { return this.systems.get(id); }

  // ---- save ------------------------------------------------------------------------------------

  /** Adopt a freshly deserialized `SavedGame.features`. Loaded features are told; the rest is stashed. */
  restore(blob: Record<string, unknown> | undefined): void {
    this.stored = { ...blob };
    for (const feature of this.registry) {
      const system = this.systems.get(feature.id);
      if (system?.restore) system.restore(this.stored[feature.saveKey]);
    }
  }

  /** ONLY the loaded features' slices. Game merges this over `this.save.features` per key — a
   *  wholesale replace would destroy every unloaded feature's state the moment one feature loads. */
  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const feature of this.registry) {
      const system = this.systems.get(feature.id);
      if (!system?.serialize) continue;
      const value = system.serialize();
      if (value !== undefined) out[feature.saveKey] = value;
    }
    return out;
  }

  /** New game or checkpoint reload: drop every loaded feature and adopt the incoming slices. Without
   *  this, startGame(fresh) and reloadSavedGame() leave stale feature state live in the world. */
  reset(blob: Record<string, unknown> | undefined): void {
    this.disposeAll();
    this.stored = { ...blob };
  }

  // ---- frame -----------------------------------------------------------------------------------

  update(dt: number): void {
    if (this.context.suspended()) return;
    this.preloadTimer -= dt;
    if (this.preloadTimer <= 0) { this.preloadTimer = PRELOAD_INTERVAL; this.preloadNearby(); }
    for (const system of this.systems.values()) system.update?.(dt);
  }

  /**
   * WALKING INTO A FEATURE'S RING LOADS IT. Nobody has to press anything first.
   *
   * This is the fix for a shipped design failure, so it is worth stating plainly. Before this, the
   * ONLY thing in the build that ever loaded a feature body was the player pressing E on its eager
   * stand-in. A feature that puts PEOPLE in the world therefore had nobody in the world until the
   * player guessed that an unremarkable "E Ask around" prompt was a door — and the owner's playtest
   * of the street economy is what that costs: he could not find the content, and concluded it was
   * unusable. Content you have to solve a prompt to make exist is not content.
   *
   * Boot pays nothing for this: the import is still dynamic, still unreferenced by index.html, and
   * still only fetched when the player is standing in the ring. What changes is that the world is
   * already populated by the time they get there, so the first interaction is with a PERSON.
   */
  private preloadNearby(): void {
    for (const feature of this.registry) {
      const approach = feature.approach;
      if (!approach || this.systems.has(feature.id) || this.inflight.has(feature.id) || this.preloadFailed.has(feature.id)) continue;
      if (!approach.near(this.frame(approach.context))) continue;
      this.preloading.add(feature.id);
      void this.open(feature.id).then((system) => {
        // A failed fetch must NOT leave the ring silent forever: put the stand-in back so the press
        // still works, and never auto-retry, or a broken chunk becomes a fetch every 0.4 s.
        if (!system) { this.preloadFailed.add(feature.id); }
        this.preloading.delete(feature.id);
      });
    }
  }

  hud(): FeatureHudEntry[] | undefined {
    if (this.context.suspended() || this.systems.size === 0) return undefined;
    const entries: FeatureHudEntry[] = [];
    for (const system of this.systems.values()) entries.push(...(system.hud?.() ?? []));
    return entries.length > 0 ? entries : undefined;
  }

  /** Every loaded feature's blips, for Game.mapMarkers(). Empty while online (features are suspended
   *  there, so their world does not exist) and empty when nothing is loaded — no allocation either. */
  mapIcons(): FeatureMapIcon[] {
    if (this.context.suspended() || this.systems.size === 0) return [];
    const icons: FeatureMapIcon[] = [];
    for (const system of this.systems.values()) icons.push(...((system as FeatureSystem & FeatureMapSource).mapIcons?.() ?? []));
    return icons;
  }

  // ---- interactions ----------------------------------------------------------------------------

  /** What the registry would do right now — the string the HUD shows. Called once per rendered
   *  frame, so it short-circuits before allocating anything when there is nothing to ask. */
  offer(context: InteractionContext): InteractionOffer | undefined {
    if (this.idle()) return undefined;
    return this.resolve(context, this.descriptors(context))?.offer;
  }

  /** Run whatever `offer()` promised. Returns false when nothing matched, so the caller falls
   *  through to the next rung of its own ladder (vehicle entry on foot, exit while driving). */
  act(context: InteractionContext): boolean {
    if (this.idle()) return false;
    const resolved = this.resolve(context, this.descriptors(context));
    if (!resolved) return false;
    resolved.offer.act();
    return true;
  }

  private idle(): boolean { return this.registry.length === 0 || this.context.suspended(); }

  /** Every rung visible in this context: each loaded feature's own descriptors, plus the eager
   *  approach stand-in for features that are not loaded yet. */
  descriptors(context: InteractionContext): InteractionDescriptor[] {
    const list: InteractionDescriptor[] = [];
    for (const feature of this.registry) {
      const system = this.systems.get(feature.id);
      if (system) { list.push(...(system.interactions?.() ?? [])); continue; }
      // A proximity load is already on the way, so the stand-in has nothing left to do — and leaving
      // it on the ladder would sit above `E Enter vehicle` for a whole block while the chunk lands.
      if (this.preloading.has(feature.id)) continue;
      const approach = feature.approach;
      if (!approach || approach.context !== context) continue;
      list.push({
        id: `${feature.id}:approach`, order: approach.order, context: approach.context,
        test: (ctx) => approach.near(ctx) ? { prompt: approach.prompt, act: () => this.openFromApproach(feature.id, context) } : undefined,
      });
    }
    return sortInteractions(list);
  }

  private resolve(context: InteractionContext, descriptors: readonly InteractionDescriptor[]) {
    if (this.context.suspended()) return undefined;
    return resolveInteraction(descriptors, this.frame(context));
  }

  private frame(context: InteractionContext): InteractionCtx {
    const api = this.context.api;
    const vehicle = api.drivenVehicle();
    return { context, position: context === 'vehicle' && vehicle ? vehicle.group.position : api.playerPosition(), vehicle, hour: api.hour() };
  }

  /** Walking into an unloaded feature's approach ring loads it, then immediately re-resolves against
   *  the LOADED descriptors only — so the first press acts instead of merely fetching, and the eager
   *  stand-in can never re-trigger itself into a load loop. */
  private openFromApproach(id: string, context: InteractionContext): void {
    void this.open(id).then((system) => {
      if (!system) return;
      const loadedOnly = sortInteractions(system.interactions?.() ?? []);
      this.resolve(context, loadedOnly)?.offer.act();
    });
  }

  // ---- loading ---------------------------------------------------------------------------------

  /**
   * Load a feature's body. Idempotent, and safe to call during boot(): the promise is fully handled
   * here, so nothing escapes as an unhandled rejection while the boot traps are armed.
   */
  open(id: string): Promise<FeatureSystem | undefined> {
    if (this.context.suspended()) return Promise.resolve(undefined);
    const existing = this.systems.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.inflight.get(id);
    if (pending) return pending; // one fetch per feature, however many presses land on it
    const feature = this.registry.find((entry) => entry.id === id);
    if (!feature) return Promise.resolve(undefined);
    const promise = this.fetch(feature).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, promise);
    return promise;
  }

  private async fetch(feature: FeatureDescriptor): Promise<FeatureSystem | undefined> {
    const generation = (this.generations.get(feature.id) ?? 0) + 1;
    this.generations.set(feature.id, generation);
    try {
      const module = await feature.load();
      // Each feature gets its own api whose analytics() is pre-bound to its id, so a feature can
      // neither forget nor spoof the `feature` field on an event.
      const api: FeatureGameApi = { ...this.context.api, analytics: (event, props) => this.context.emit(feature.id, event, props) };
      const system = await module.createFeature(api, this.stored[feature.saveKey]);
      if (generation !== this.generations.get(feature.id)) { system.dispose(); return undefined; } // stale arrival: a reset landed while we were fetching
      this.systems.set(feature.id, system);
      this.context.emit(feature.id, 'loaded');
      return system;
    } catch (error) {
      // A feature is optional: keep the city running and surface a recoverable diagnostic, exactly
      // as setupComposer does when the post-processing chunk fails.
      console.warn(`[features] "${feature.id}" failed to load; the rest of the city carries on.`, error);
      this.context.reportError(error, `feature-${feature.id}`);
      return undefined;
    }
  }

  // ---- UI, console, QA -------------------------------------------------------------------------

  /** A row on the host-owned menu screen was clicked. */
  menuAction(featureId: string, actionId: string): void {
    this.systems.get(featureId)?.menu?.(actionId);
  }

  /** The single generic `feature <id> <args>` console command. */
  command(args: readonly string[]): string[] {
    const [id, ...rest] = args;
    if (!id) {
      if (this.registry.length === 0) return ['No features registered in this build.'];
      return this.registry.map((feature) => `${feature.id} — ${feature.label}${this.systems.has(feature.id) ? ' (loaded)' : ''}`);
    }
    const feature = this.registry.find((entry) => entry.id === id);
    if (!feature) return [`Eish, unknown feature: ${id}. Type "feature" for the list.`];
    const system = this.systems.get(id);
    if (!system) { void this.open(id); return [`Loading ${feature.label}… run the command again once it's up.`]; }
    if (!system.command) return [`${feature.label} takes no console commands.`];
    return system.command(rest);
  }

  /** Machine playthrough entry point, reached from tools/qa/harness.js as `needs:feature:<id>`. */
  async qa(id: string, action = 'run', args: Record<string, unknown> = {}): Promise<string> {
    const system = this.systems.get(id) ?? await this.open(id);
    if (!system) return `stuck:feature-missing:${id}`;
    if (!system.qa) return `stuck:feature-no-driver:${id}`;
    return system.qa(action, args);
  }

  // ---- teardown --------------------------------------------------------------------------------

  private disposeAll(): void {
    // Bump EVERY id, not just the loaded ones: a chunk still in flight when a new game starts would
    // otherwise arrive with a matching generation and install itself into the fresh world.
    for (const id of [...this.systems.keys(), ...this.inflight.keys()]) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    // A new game re-earns the proximity load from scratch, and forgives an earlier failed fetch.
    this.preloading.clear(); this.preloadFailed.clear(); this.preloadTimer = 0;
    for (const [id, system] of this.systems) {
      try { system.dispose(); }
      catch (error) { console.warn(`[features] "${id}" threw while disposing.`, error); }
    }
    this.systems.clear();
  }

  dispose(): void { this.disposeAll(); this.stored = {}; }
}

export type { FeatureGameApi, FeatureHudEntry, FeatureMenuView, FeatureSystem };
