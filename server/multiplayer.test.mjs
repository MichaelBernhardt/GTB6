import { describe, expect, it, vi } from 'vitest';
import { MemoryProfileStore } from './profile-store.mjs';
import { cleanChat, cleanName, MultiplayerWorld, PROTOCOL_VERSION } from './multiplayer.mjs';

const socket = () => ({ readyState: 1, send: vi.fn() });

describe('multiplayer input validation', () => {
  it('sanitizes names and bounded chat', () => {
    expect(cleanName('  <b>Jo</b>  ')).toBe('bJo/b');
    expect(cleanName('')).toBe('Player');
    expect(cleanChat(`hello\n${'x'.repeat(220)}`)).toHaveLength(180);
  });
});

describe('authoritative multiplayer world', () => {
  it('moves from inputs, rejects stale sequences, and caps the shard', async () => {
    let now = 10_000;
    const world = new MultiplayerWorld({ capacity: 1, store: new MemoryProfileStore(), now: () => now }); await world.init();
    const player = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'Mika' });
    const startZ = player.z;
    world.input(player, { seq: 2, forward: 1, side: 0, sprint: true, yaw: 0 });
    world.input(player, { seq: 1, forward: -1, side: 0, sprint: false, yaw: 0 });
    world.tick(1);
    expect(player.z).toBeLessThan(startZ); expect(player.input.seq).toBe(2);
    await expect(world.join(socket(), { version: PROTOCOL_VERSION, name: 'Other' })).rejects.toMatchObject({ code: 'SERVER_FULL' });
    now += 100; await world.close();
  });

  it('owns PvP damage, kill statistics, and timed respawn', async () => {
    let now = 20_000;
    const store = new MemoryProfileStore(); const world = new MultiplayerWorld({ capacity: 2, store, now: () => now }); await world.init();
    const attacker = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'Shooter' });
    const target = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'Target' });
    attacker.x = 0; attacker.z = 0; target.x = 0; target.z = -10; now += 3000;
    let event;
    for (let shot = 0; shot < 3; shot += 1) { event = world.fire(attacker, { direction: [0, 0, -1] }); now += 400; }
    expect(event).toMatchObject({ kind: 'kill', targetId: target.id });
    expect(attacker.kills).toBe(1); expect(target.deaths).toBe(1); expect(target.deadUntil).toBeGreaterThan(now);
    now += 3100; expect(world.tick()).toContainEqual({ kind: 'respawn', actorId: target.id }); expect(target.health).toBe(100);
    await world.close();
  });

  it('restores guest statistics by token', async () => {
    const store = new MemoryProfileStore(); const world = new MultiplayerWorld({ store }); await world.init();
    const first = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'First' }); first.kills = 7; const token = first.token; await world.leave(first);
    const returning = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'Renamed', token });
    expect(returning.kills).toBe(7); expect(returning.name).toBe('Renamed'); await world.close();
  });

  it('arbitrates vehicle entry and releases the driver on exit', async () => {
    const world = new MultiplayerWorld({ store: new MemoryProfileStore() }); await world.init();
    const first = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'Driver' });
    const second = await world.join(socket(), { version: PROTOCOL_VERSION, name: 'Passenger' });
    const vehicle = world.vehicles.values().next().value; first.x = vehicle.x; first.z = vehicle.z; second.x = vehicle.x; second.z = vehicle.z;
    expect(world.interact(first)).toBe(true); expect(first.vehicleId).toBe(vehicle.id); expect(world.interact(second)).toBe(false);
    world.input(first, { seq: 1, forward: 1, side: 1, sprint: false, yaw: 0 }); const before = vehicle.z; world.tick(1);
    expect(vehicle.z).not.toBe(before); expect(world.interact(first)).toBe(true); expect(vehicle.driverId).toBeUndefined();
    second.x = vehicle.x; second.z = vehicle.z; expect(world.interact(second)).toBe(true); await world.close();
  });
});
