import { describe, expect, it, vi } from 'vitest';
import { MemoryProfileStore } from './profile-store.mjs';
import {
  appearanceForToken, cleanChat, cleanName, HOT_BAKKIE_ACTIVE_MS, HOT_BAKKIE_COOLDOWN_MS,
  HOT_BAKKIE_COUNTDOWN_MS, HOT_BAKKIE_DROP_MAX_SPEED, HOT_BAKKIE_ROUTES, MultiplayerWorld,
  ONLINE_APPEARANCES, PROTOCOL_VERSION,
} from './multiplayer.mjs';

const socket = () => ({ readyState: 1, send: vi.fn() });
const makeWorld = async (options = {}) => {
  const clock = { value: 10_000 };
  const world = new MultiplayerWorld({ store: new MemoryProfileStore(), now: () => clock.value, ...options });
  await world.init();
  return { world, clock };
};
const join = (world, name = 'Mika', token) => world.join(socket(), { version: PROTOCOL_VERSION, name, token });
const activate = (world, clock) => { clock.value += HOT_BAKKIE_COUNTDOWN_MS; world.tick(0); };
const claimHotBakkie = (world, player) => {
  const vehicle = world.vehicles.get('hot-bakkie'); player.x = vehicle.x; player.z = vehicle.z;
  expect(world.interact(player)).toBe(true); world.consumeEvents(); return vehicle;
};

describe('multiplayer input validation', () => {
  it('sanitizes names and bounded chat', () => {
    expect(cleanName('  <b>Jo</b>  ')).toBe('bJo/b');
    expect(cleanName('')).toBe('Player');
    expect(cleanChat(`hello\n${'x'.repeat(220)}`)).toHaveLength(180);
  });

  it('rejects obsolete protocol clients', async () => {
    const { world } = await makeWorld();
    await expect(world.join(socket(), { version: 1, name: 'Old build' })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    await world.close();
  });
});

describe('authoritative multiplayer world', () => {
  it('moves from inputs, rejects stale sequences, and caps the shard', async () => {
    const { world } = await makeWorld({ capacity: 1 }); const player = await join(world); const startZ = player.z;
    world.input(player, { seq: 2, forward: 1, side: 0, sprint: true, yaw: 0 });
    world.input(player, { seq: 1, forward: -1, side: 0, sprint: false, yaw: 0 }); world.tick(1);
    expect(startZ - player.z).toBeCloseTo(13); expect(player.input.seq).toBe(2);
    world.input(player, { seq: 3, forward: 1, side: 0, sprint: true, aiming: true, yaw: 0 }); const aimedStart = player.z; world.tick(1);
    expect(aimedStart - player.z).toBeCloseTo(6.5);
    await expect(join(world, 'Other')).rejects.toMatchObject({ code: 'SERVER_FULL' }); await world.close();
  });

  it('owns PvP damage, carrier death, kill statistics, and timed respawn', async () => {
    const analyticsEvent = vi.fn(); const { world, clock } = await makeWorld({ capacity: 2, analyticsEvent }); const attacker = await join(world, 'Shooter'); const target = await join(world, 'Target');
    activate(world, clock); const hot = claimHotBakkie(world, target);
    attacker.x = 0; attacker.z = 0; target.x = 0; target.z = -10; hot.x = target.x; hot.z = target.z; clock.value += 3000;
    let event;
    for (let shot = 0; shot < 3; shot += 1) { event = world.fire(attacker, { direction: [0, 0, -1] }); clock.value += 400; }
    expect(event).toMatchObject({ kind: 'kill', targetId: target.id }); expect(world.hot.carrier).toBeUndefined(); expect(hot.driverId).toBeUndefined();
    expect(analyticsEvent).toHaveBeenCalledWith('multiplayer_kill', {});
    expect(attacker.kills).toBe(1); expect(target.deaths).toBe(1); expect(target.deadUntil).toBeGreaterThan(clock.value);
    clock.value += 3100; expect(world.tick()).toContainEqual({ type: 'combat', kind: 'respawn', actorId: target.id }); expect(target.health).toBe(100); await world.close();
  });

  it('restores persistent guest runs and stable appearance by token', async () => {
    const { world } = await makeWorld(); const first = await join(world, 'First'); first.kills = 7; first.runs = 3; const token = first.token; const appearance = first.appearance; await world.leave(first);
    const returning = await join(world, 'Renamed', token);
    expect(returning).toMatchObject({ kills: 7, runs: 3, name: 'Renamed', appearance });
    expect(appearanceForToken(token)).toBe(appearance); expect(ONLINE_APPEARANCES).toContain(appearance); await world.close();
  });

  it('arbitrates ordinary vehicle entry and releases the driver on exit', async () => {
    const { world } = await makeWorld(); const first = await join(world, 'Driver'); const second = await join(world, 'Passenger');
    const vehicle = world.vehicles.get('vehicle-2'); first.x = vehicle.x; first.z = vehicle.z; second.x = vehicle.x; second.z = vehicle.z;
    expect(world.interact(first)).toBe(true); expect(first.vehicleId).toBe(vehicle.id); expect(world.interact(second)).toBe(false);
    world.input(first, { seq: 1, forward: 1, side: 0, sprint: false, yaw: 0 }); const before = { x: vehicle.x, z: vehicle.z };
    for (let step = 0; step < 20; step += 1) world.tick(1 / 20);
    expect(Math.hypot(vehicle.x - before.x, vehicle.z - before.z)).toBeGreaterThan(1); expect(world.interact(first)).toBe(true); expect(vehicle.driverId).toBeUndefined();
    second.x = vehicle.x; second.z = vehicle.z; expect(world.interact(second)).toBe(true); await world.close();
  });

  it('rejects off-road vehicle movement and stops the vehicle', async () => {
    const { world } = await makeWorld(); const player = await join(world, 'Shortcut'); const vehicle = world.vehicles.get('vehicle-1');
    vehicle.x = 8750; vehicle.z = 8750; vehicle.heading = 0; player.x = vehicle.x; player.z = vehicle.z;
    expect(world.interact(player)).toBe(true); world.input(player, { seq: 1, forward: 1, side: 0, sprint: false, yaw: 0 }); world.tick(1 / 20);
    expect(vehicle).toMatchObject({ x: 8750, z: 8750, speed: 0 }); await world.close();
  });

  it('quantizes complete protocol-v2 snapshots', async () => {
    const { world } = await makeWorld(); const player = await join(world, 'Data Saver');
    player.x = 12.34567; player.z = -98.76543; player.heading = Math.PI; player.input.sprint = true; player.input.forward = 1;
    const vehicle = world.vehicles.get('vehicle-1'); vehicle.speed = 12.34567; vehicle.heading = Math.PI / 3;
    expect(world.snapshot()[0]).toMatchObject({ x: 12.35, z: -98.77, heading: 3.142, runs: 0, ammo: 12, reserve: 84, reloading: false, locomotion: 'sprint', aiming: false });
    expect(world.vehicleSnapshot()[0]).toMatchObject({ speed: 12.35, heading: 1.047, isHot: false });
    expect(world.vehicleSnapshot().find((entry) => entry.id === 'hot-bakkie')).toMatchObject({ kind: 'bakkie', isHot: true }); await world.close();
  });

  it('validates reloads and exposes authoritative ammo state', async () => {
    const { world, clock } = await makeWorld(); const player = await join(world, 'Reload'); player.ammo = 5; player.reserve = 9;
    expect(world.reload(player)).toBe(true); expect(world.reload(player)).toBe(false); expect(world.snapshot()[0].reloading).toBe(true);
    clock.value += 1050; world.tick(0); expect(world.snapshot()[0]).toMatchObject({ ammo: 12, reserve: 2, reloading: false });
    expect(world.reload(player)).toBe(false); player.ammo = 0; player.reserve = 0; expect(world.reload(player)).toBe(false); await world.close();
  });
});

describe('Hot Bakkie event cycle', () => {
  it('counts down after the first join and preserves the active round for mid-round joins', async () => {
    const { world, clock } = await makeWorld(); await join(world, 'First');
    expect(world.hotBakkieSnapshot()).toMatchObject({ phase: 'countdown', round: 1, remainingTime: 12 });
    clock.value += HOT_BAKKIE_COUNTDOWN_MS - 1; world.tick(0); expect(world.hot.phase).toBe('countdown');
    clock.value += 1; world.tick(0); const deadline = world.hot.phaseEndsAt; expect(world.hot.phase).toBe('active');
    await join(world, 'Late'); expect(world.hot).toMatchObject({ phase: 'active', round: 1, phaseEndsAt: deadline }); await world.close();
  });

  it('rotates all four CBD routes deterministically', async () => {
    const { world, clock } = await makeWorld(); await join(world);
    const observed = [];
    for (let round = 0; round < HOT_BAKKIE_ROUTES.length; round += 1) {
      observed.push(world.hotBakkieSnapshot().route); activate(world, clock); clock.value += HOT_BAKKIE_ACTIVE_MS; world.tick(0); clock.value += HOT_BAKKIE_COOLDOWN_MS; world.tick(0);
    }
    expect(observed).toEqual(HOT_BAKKIE_ROUTES.map((route) => route.name)); await world.close();
  });

  it('requires ordered checkpoints before delivery', async () => {
    const { world, clock } = await makeWorld(); const player = await join(world); activate(world, clock); const hot = claimHotBakkie(world, player); const route = HOT_BAKKIE_ROUTES[world.hot.routeIndex];
    Object.assign(hot, route.checkpoints[1]); world.tick(0); expect(world.hot.progress).toBe(0);
    Object.assign(hot, route.checkpoints[0]); world.tick(0); expect(world.hot.progress).toBe(1);
    Object.assign(hot, route.checkpoints[1]); world.tick(0); expect(world.hot.progress).toBe(2);
    Object.assign(hot, route.checkpoints[2]); world.tick(0); expect(world.hot.progress).toBe(3); await world.close();
  });

  it('requires the delivery radius and low speed, then persists one run', async () => {
    const { world, clock } = await makeWorld(); const player = await join(world); const token = player.token; activate(world, clock); const hot = claimHotBakkie(world, player); const drop = HOT_BAKKIE_ROUTES[world.hot.routeIndex].checkpoints[3]; world.hot.progress = 3;
    Object.assign(hot, { x: drop.x + 17, z: drop.z, speed: 0 }); world.tick(0); expect(world.hot.phase).toBe('active');
    Object.assign(hot, { x: drop.x, z: drop.z, speed: HOT_BAKKIE_DROP_MAX_SPEED }); world.tick(0); expect(world.hot.phase).toBe('active');
    hot.speed = HOT_BAKKIE_DROP_MAX_SPEED - 0.01; expect(world.tick(0)).toContainEqual({ type: 'hot-bakkie-event', kind: 'delivery', actorId: player.id });
    expect(world.hot).toMatchObject({ phase: 'cooldown', winner: player }); expect(player.runs).toBe(1);
    await world.leave(player); const returning = await join(world, 'Winner', token); expect(returning.runs).toBe(1); await world.close();
  });

  it('broadcasts timeout and starts a fresh round after cooldown', async () => {
    const analyticsEvent = vi.fn(); const { world, clock } = await makeWorld({ analyticsEvent }); const player = await join(world); activate(world, clock); claimHotBakkie(world, player); clock.value += HOT_BAKKIE_ACTIVE_MS;
    expect(world.tick(0)).toContainEqual({ type: 'hot-bakkie-event', kind: 'timeout' }); expect(world.hot.phase).toBe('cooldown'); expect(player.vehicleId).toBeUndefined();
    expect(analyticsEvent.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['multiplayer_join', 'hot_bakkie_start', 'hot_bakkie_timeout']));
    clock.value += HOT_BAKKIE_COOLDOWN_MS; world.tick(0); expect(world.hot).toMatchObject({ phase: 'countdown', round: 2, routeIndex: 1 }); await world.close();
  });

  it('reports a takeover after the carrier exits', async () => {
    const { world, clock } = await makeWorld(); const first = await join(world, 'First'); const second = await join(world, 'Second'); activate(world, clock); const hot = claimHotBakkie(world, first);
    expect(world.interact(first)).toBe(true); second.x = hot.x; second.z = hot.z; expect(world.interact(second)).toBe(true);
    expect(world.consumeEvents()).toContainEqual({ type: 'hot-bakkie-event', kind: 'takeover', actorId: second.id, previousActorId: first.id }); expect(world.hot.carrier).toBe(second.id); await world.close();
  });

  it('resets to waiting when the shard becomes empty', async () => {
    const { world, clock } = await makeWorld(); const player = await join(world); activate(world, clock); claimHotBakkie(world, player); await world.leave(player);
    expect(world.hotBakkieSnapshot()).toMatchObject({ phase: 'waiting', round: 0, progress: 0, remainingTime: 0 }); expect(world.vehicles.get('hot-bakkie').driverId).toBeUndefined(); await world.close();
  });
});
