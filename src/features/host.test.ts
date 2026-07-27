import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureHost, type FeatureHostContext } from './host';
import type { FeatureDescriptor, FeatureGameApi, FeatureSystem, InteractionDescriptor } from './types';

/** A minimal stand-in for the Game surface. Only what the host itself touches has to be real. */
function stubApi(overrides: Partial<FeatureGameApi> = {}): FeatureGameApi {
  const position = { x: 0, y: 0, z: 0 } as ReturnType<FeatureGameApi['playerPosition']>;
  return {
    scene: {} as FeatureGameApi['scene'],
    surfaceHeightAt: () => 0, districtAt: () => 'CBD', isPark: () => false,
    nearestRoadPose: () => ({ position, heading: 0 }),
    playerPosition: () => position, playerHeading: () => 0, drivenVehicle: () => undefined,
    hour: () => 12, blackout: () => 0,
    balance: () => 750, earn: () => undefined, spend: () => true,
    notify: () => undefined, showMenu: () => undefined, closeMenu: () => undefined,
    persist: () => undefined, analytics: () => undefined,
    spawnFixture: () => undefined, removeFixture: () => undefined,
    ...overrides,
  };
}

interface Harness {
  host: FeatureHost;
  context: FeatureHostContext;
  events: Array<{ id: string; event: string }>;
  errors: Array<{ asset: string }>;
  online: { value: boolean };
}

function harness(descriptors: FeatureDescriptor[], api = stubApi()): Harness {
  const events: Array<{ id: string; event: string }> = [];
  const errors: Array<{ asset: string }> = [];
  const online = { value: false };
  const context: FeatureHostContext = {
    api,
    suspended: () => online.value,
    emit: (id, event) => { events.push({ id, event }); },
    reportError: (_error, asset) => { errors.push({ asset }); },
  };
  return { host: new FeatureHost(context, descriptors), context, events, errors, online };
}

function feature(overrides: Partial<FeatureDescriptor> & { system?: Partial<FeatureSystem> } = {}): FeatureDescriptor {
  const { system, ...rest } = overrides;
  const built: FeatureSystem = { dispose: vi.fn(), ...system };
  return {
    id: 'golf', saveKey: 'golf', label: 'Golf',
    load: () => Promise.resolve({ createFeature: () => built }),
    ...rest,
  };
}

describe('FeatureHost loading', () => {
  it('loads a feature exactly once, however many presses land on it', async () => {
    const load = vi.fn(() => Promise.resolve({ createFeature: () => ({ dispose: vi.fn() }) }));
    const { host } = harness([feature({ load })]);
    await Promise.all([host.open('golf'), host.open('golf'), host.open('golf')]);
    await host.open('golf');
    expect(load).toHaveBeenCalledTimes(1);
    expect(host.isLoaded('golf')).toBe(true);
  });

  it('degrades instead of throwing when the chunk fails, and reports it as recoverable', async () => {
    // Boot error traps stay armed until gtb-boot-ready: an unhandled rejection here would replace the
    // screen with the "city failed to start" card.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host, errors } = harness([feature({ load: () => Promise.reject(new Error('network')) })]);
    await expect(host.open('golf')).resolves.toBeUndefined();
    expect(errors).toEqual([{ asset: 'feature-golf' }]);
    expect(host.isLoaded('golf')).toBe(false);
    warn.mockRestore();
  });

  it('disposes a stale arrival instead of leaving orphaned meshes in the scene', async () => {
    const dispose = vi.fn();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { host } = harness([feature({ load: async () => { await gate; return { createFeature: () => ({ dispose }) }; } })]);
    const pending = host.open('golf');
    host.reset({}); // a new game landed while the chunk was still in flight
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(host.isLoaded('golf')).toBe(false);
  });

  it('emits one analytics event per load, tagged with the feature id', async () => {
    const { host, events } = harness([feature()]);
    await host.open('golf');
    expect(events).toEqual([{ id: 'golf', event: 'loaded' }]);
  });

  it('binds the feature id into the api it hands the feature, so an event cannot be spoofed', async () => {
    let seen: FeatureGameApi | undefined;
    const { host, events } = harness([feature({ load: () => Promise.resolve({ createFeature: (api) => { seen = api; return { dispose: vi.fn() }; } }) })]);
    await host.open('golf');
    seen?.analytics('round_banked', { value: 3 });
    expect(events).toEqual([{ id: 'golf', event: 'loaded' }, { id: 'golf', event: 'round_banked' }]);
  });
});

describe('FeatureHost save merge', () => {
  it('serializes ONLY loaded features, so an unloaded slice survives the autosave', async () => {
    const { host } = harness([
      feature({ id: 'golf', saveKey: 'golf', system: { serialize: () => ({ holes: 3 }) } }),
      feature({ id: 'fuel', saveKey: 'fuel', system: { serialize: () => ({ litres: 12 }) } }),
    ]);
    host.restore({ golf: { holes: 1 }, fuel: { litres: 50 } });
    await host.open('golf');
    expect(host.serialize()).toEqual({ golf: { holes: 3 } });
    // This is exactly what Game.persist() does; a wholesale replace would wipe `fuel` here.
    expect({ ...{ golf: { holes: 1 }, fuel: { litres: 50 } }, ...host.serialize() }).toEqual({ golf: { holes: 3 }, fuel: { litres: 50 } });
  });

  it('hands a loading feature its own stored slice', async () => {
    let seen: unknown;
    const { host } = harness([feature({ load: () => Promise.resolve({ createFeature: (_api, state) => { seen = state; return { dispose: vi.fn() }; } }) })]);
    host.restore({ golf: { holes: 2 } });
    await host.open('golf');
    expect(seen).toEqual({ holes: 2 });
  });

  it('pushes a checkpoint restore into an already-loaded feature', async () => {
    const restore = vi.fn();
    const { host } = harness([feature({ system: { restore } })]);
    await host.open('golf');
    host.restore({ golf: { holes: 9 } });
    expect(restore).toHaveBeenCalledWith({ holes: 9 });
  });

  it('reset() disposes live features so a new game does not leave stale state in the world', async () => {
    const dispose = vi.fn();
    const { host } = harness([feature({ system: { dispose } })]);
    await host.open('golf');
    host.reset({});
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(host.isLoaded('golf')).toBe(false);
    expect(host.serialize()).toEqual({});
  });
});

describe('FeatureHost interactions', () => {
  const rung = (prompt: string, act: () => void, order = 10): InteractionDescriptor =>
    ({ id: 'golf:tee', order, context: 'foot', test: () => ({ prompt, act }) });

  it('act() runs exactly what offer() promised — prompt and key cannot disagree', async () => {
    const acted: string[] = [];
    const { host } = harness([feature({ system: { interactions: () => [rung('E  Tee off', () => acted.push('tee'))] } })]);
    await host.open('golf');
    expect(host.offer('foot')?.prompt).toBe('E  Tee off');
    expect(host.act('foot')).toBe(true);
    expect(acted).toEqual(['tee']);
  });

  it('returns false when nothing matches, so the caller falls through to vehicle entry', () => {
    const { host } = harness([feature()]);
    expect(host.act('foot')).toBe(false);
    expect(host.offer('foot')).toBeUndefined();
  });

  it('shows an eager approach prompt before the body has loaded', () => {
    const { host } = harness([feature({ approach: { context: 'foot', order: 50, prompt: 'E  Enter the pro shop', near: () => true } })]);
    expect(host.offer('foot')?.prompt).toBe('E  Enter the pro shop');
  });

  it('acting on the approach loads the feature and then runs its own rung — no second press, no load loop', async () => {
    const acted: string[] = [];
    const built: FeatureSystem = { dispose: vi.fn(), interactions: () => [rung('E  Tee off', () => acted.push('tee'))] };
    const { host } = harness([feature({
      approach: { context: 'foot', order: 50, prompt: 'E  Enter the pro shop', near: () => true },
      load: () => Promise.resolve({ createFeature: () => built }),
    })]);
    expect(host.act('foot')).toBe(true);
    await vi.waitFor(() => expect(acted).toEqual(['tee']));
    expect(host.offer('foot')?.prompt).toBe('E  Tee off'); // the stand-in is gone once loaded
  });

  it('keeps the two contexts apart', async () => {
    const { host } = harness([feature({
      system: { interactions: () => [{ id: 'fuel:pump', order: 10, context: 'vehicle', test: () => ({ prompt: 'E  Fill up', act: () => undefined }) }] },
    })]);
    await host.open('golf');
    expect(host.offer('foot')).toBeUndefined();
    expect(host.offer('vehicle')?.prompt).toBe('E  Fill up');
  });
});

describe('FeatureHost online suspension', () => {
  let live: Harness;
  beforeEach(async () => {
    live = harness([feature({
      approach: { context: 'foot', order: 50, prompt: 'E  Enter the pro shop', near: () => true },
      system: { update: vi.fn(), hud: () => [{ id: 'golf', label: 'GOLF' }] },
    })]);
    await live.host.open('golf');
    live.online.value = true;
  });

  it('does not tick, prompt, or HUD while the player is in PvP', () => {
    live.host.update(0.1);
    expect(live.host.loaded('golf')?.update).not.toHaveBeenCalled();
    expect(live.host.offer('foot')).toBeUndefined();
    expect(live.host.act('foot')).toBe(false);
    expect(live.host.hud()).toBeUndefined();
  });

  it('refuses to load a feature into an online session', async () => {
    live.online.value = true;
    const fresh = harness([feature()]);
    fresh.online.value = true;
    await expect(fresh.host.open('golf')).resolves.toBeUndefined();
    expect(fresh.host.isLoaded('golf')).toBe(false);
  });
});

describe('FeatureHost console + QA', () => {
  it('lists the registry when given no id', () => {
    const { host } = harness([feature(), feature({ id: 'fuel', saveKey: 'fuel', label: 'Petrol' })]);
    expect(host.command([])).toEqual(['golf — Golf', 'fuel — Petrol']);
  });

  it('kicks off a load and says so, rather than pretending the command ran', () => {
    const { host } = harness([feature()]);
    expect(host.command(['golf'])[0]).toContain('Loading Golf');
  });

  it('dispatches to a loaded feature and rejects an unknown one', async () => {
    const { host } = harness([feature({ system: { command: (args) => [`golf:${args.join(',')}`] } })]);
    await host.open('golf');
    expect(host.command(['golf', 'tee', '1'])).toEqual(['golf:tee,1']);
    expect(host.command(['nope'])[0]).toContain('unknown feature');
  });

  it('reports a missing QA driver rather than silently passing a machine playthrough', async () => {
    const { host } = harness([feature()]);
    await expect(host.qa('golf')).resolves.toBe('stuck:feature-no-driver:golf');
    await expect(host.qa('nope')).resolves.toBe('stuck:feature-missing:nope');
  });

  it('loads on demand for the QA driver', async () => {
    const { host } = harness([feature({ system: { qa: (action) => `ok:${action}` } })]);
    await expect(host.qa('golf', 'play')).resolves.toBe('ok:play');
  });
});

describe('FeatureHost HUD and menu', () => {
  it('merges every loaded feature’s chips into the one host-owned strip', async () => {
    const { host } = harness([
      feature({ system: { hud: () => [{ id: 'golf:card', label: 'GOLF', value: '+2' }] } }),
      feature({ id: 'fuel', saveKey: 'fuel', system: { hud: () => [{ id: 'fuel:tank', label: 'FUEL', value: '12 L', warn: true }] } }),
    ]);
    await host.open('golf'); await host.open('fuel');
    expect(host.hud()).toEqual([
      { id: 'golf:card', label: 'GOLF', value: '+2' },
      { id: 'fuel:tank', label: 'FUEL', value: '12 L', warn: true },
    ]);
  });

  it('returns undefined when nothing is loaded, so the HUD strip stays hidden', () => {
    expect(harness([feature()]).host.hud()).toBeUndefined();
  });

  it('routes a menu row to the feature that opened the menu', async () => {
    const menu = vi.fn();
    const { host } = harness([feature({ system: { menu } })]);
    await host.open('golf');
    host.menuAction('golf', 'buy-clubs');
    host.menuAction('nosuch', 'buy-clubs'); // must not throw
    expect(menu).toHaveBeenCalledWith('buy-clubs');
  });
});

/**
 * WALKING INTO THE RING LOADS THE FEATURE.
 *
 * The regression these pin is a design failure, not a crash: before this, pressing E on an eager
 * stand-in was the only thing in the whole build that could bring a feature's world into existence.
 * The owner's playtest of the street economy is what that costs — the people were not on the corners
 * because the corners were never loaded, and he reasonably concluded the content did not work.
 */
describe('FeatureHost proximity loading', () => {
  /** open() awaits the dynamic import AND createFeature, then settles a .finally and a .then, so a
   *  single microtask turn is not enough to see the result. */
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
  const ring = (near: () => boolean): FeatureDescriptor['approach'] => ({
    context: 'foot', order: 50, prompt: 'E  Ask around', near,
  });

  it('loads a feature when the player walks into its ring, with no press at all', async () => {
    const load = vi.fn(() => Promise.resolve({ createFeature: () => ({ dispose: vi.fn() }) }));
    const inside = { value: false };
    const { host } = harness([feature({ load, approach: ring(() => inside.value) })]);
    host.update(1);
    expect(host.isLoaded('golf'), 'nothing loads while the player is elsewhere').toBe(false);
    inside.value = true;
    host.update(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(host.isLoaded('golf')).toBe(true);
  });

  it('does not re-fetch on every tick while the player stands in the ring', async () => {
    const load = vi.fn(() => Promise.resolve({ createFeature: () => ({ dispose: vi.fn() }) }));
    const { host } = harness([feature({ load, approach: ring(() => true) })]);
    for (let tick = 0; tick < 20; tick++) host.update(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the eager stand-in OFF the ladder while the load is in flight', () => {
    // The on-foot stand-in sits above `E Enter vehicle`. Leaving it up during the fetch would take
    // the car away from the player for a whole city block, to advertise a door that is opening anyway.
    const { host } = harness([feature({ approach: ring(() => true) })]);
    expect(host.descriptors('foot')).toHaveLength(1);
    host.update(1);
    expect(host.descriptors('foot'), 'the stand-in must stand down once the load starts').toHaveLength(0);
  });

  it('puts the stand-in back when the fetch fails, and never auto-retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = vi.fn(() => Promise.reject(new Error('network')));
    const { host } = harness([feature({ load, approach: ring(() => true) })]);
    host.update(1);
    await settle();
    expect(host.isLoaded('golf')).toBe(false);
    expect(host.descriptors('foot'), 'a broken chunk must not leave the ring silent').toHaveLength(1);
    for (let tick = 0; tick < 20; tick++) host.update(1);
    await settle();
    expect(load, 'a failed chunk must not be re-fetched every 0.4 s').toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never loads anything while the player is online', async () => {
    const load = vi.fn(() => Promise.resolve({ createFeature: () => ({ dispose: vi.fn() }) }));
    const { host, online } = harness([feature({ load, approach: ring(() => true) })]);
    online.value = true;
    for (let tick = 0; tick < 5; tick++) host.update(1);
    await settle();
    expect(load).not.toHaveBeenCalled();
  });

  it('re-earns the load from scratch after a new game', async () => {
    const load = vi.fn(() => Promise.resolve({ createFeature: () => ({ dispose: vi.fn() }) }));
    const { host } = harness([feature({ load, approach: ring(() => true) })]);
    host.update(1);
    await settle();
    host.reset({});
    expect(host.isLoaded('golf')).toBe(false);
    host.update(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.isLoaded('golf')).toBe(true);
  });
});

describe('FeatureHost map blips', () => {
  it('collects every loaded feature’s blips for the radar and the city map', async () => {
    const { host } = harness([
      feature({ system: { mapIcons: () => [{ x: 5, z: 6, color: '#f0842a' }] } as Partial<FeatureSystem> }),
      feature({ id: 'fuel', saveKey: 'fuel', label: 'Fuel', system: { mapIcons: () => [{ x: 1, z: 2, color: '#f5c542', objective: true }] } as Partial<FeatureSystem> }),
    ]);
    await host.open('golf'); await host.open('fuel');
    expect(host.mapIcons()).toEqual([
      { x: 5, z: 6, color: '#f0842a' },
      { x: 1, z: 2, color: '#f5c542', objective: true },
    ]);
  });

  it('is empty when nothing is loaded and while the player is online', async () => {
    const { host, online } = harness([feature({ system: { mapIcons: () => [{ x: 5, z: 6, color: '#f0842a' }] } as Partial<FeatureSystem> })]);
    expect(host.mapIcons()).toEqual([]);
    await host.open('golf');
    expect(host.mapIcons()).toHaveLength(1);
    online.value = true;
    expect(host.mapIcons(), 'a feature’s world does not exist in someone else’s PvP').toEqual([]);
  });
});
