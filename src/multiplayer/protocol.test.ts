import { describe, expect, it } from 'vitest';
import { MULTIPLAYER_PROTOCOL_VERSION, multiplayerWebSocketUrl, parseServerMessage, type HotBakkieState, type NetPlayer, type NetVehicle, type ServerMessage } from './protocol';

export const netPlayer = (overrides: Partial<NetPlayer> = {}): NetPlayer => ({
  id: 'p1', name: 'Mika', appearance: 'maboneng-courier', runs: 2, x: 1, y: 0, z: 2, heading: 0,
  health: 100, kills: 3, deaths: 1, ammo: 7, reserve: 42, reloading: false, locomotion: 'walk', aiming: false,
  dead: false, protected: false, ...overrides,
});
export const netVehicle = (overrides: Partial<NetVehicle> = {}): NetVehicle => ({
  id: 'hot-bakkie', kind: 'bakkie', x: 10, y: 0, z: 20, heading: 0, speed: 4, health: 145, isHot: true, ...overrides,
});
export const hotState = (overrides: Partial<HotBakkieState> = {}): HotBakkieState => ({
  phase: 'active', round: 1, route: 'Commissioner Shuffle', carrier: 'p1', currentCheckpoint: { x: 20, z: 30, label: 'Portia', delivery: false }, progress: 1, total: 4, remainingTime: 90, ...overrides,
});
describe('multiplayer protocol v2', () => {
  it('parses complete welcome and snapshot messages', () => {
    const welcome: ServerMessage = { type: 'welcome', playerId: 'p1', token: 'token', tickRate: 20, capacity: 16, spawn: { x: 1, y: 0, z: 2, heading: 3 } };
    const snapshot: ServerMessage = { type: 'snapshot', tick: 4, acknowledgedInput: 3, players: [netPlayer()], vehicles: [netVehicle()], hotBakkie: hotState() };
    expect(parseServerMessage(JSON.stringify(welcome))).toEqual(welcome); expect(parseServerMessage(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(MULTIPLAYER_PROTOCOL_VERSION).toBe(2);
  });

  it('rejects malformed and obsolete snapshots instead of trusting a cast', () => {
    expect(parseServerMessage('{bad')).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: 'snapshot', tick: 1, acknowledgedInput: 0, players: [{ id: 'old-v1-player' }], vehicles: [] }))).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: 'welcome', playerId: 'p1', token: 'x', tickRate: 20, capacity: 16 }))).toBeUndefined();
  });

  it('parses reload-related ammo state and Hot Bakkie feed events', () => {
    const player = netPlayer({ ammo: 0, reserve: 12, reloading: true });
    const snapshot = parseServerMessage(JSON.stringify({ type: 'snapshot', tick: 2, acknowledgedInput: 1, players: [player], vehicles: [netVehicle()], hotBakkie: hotState() }));
    expect(snapshot?.type === 'snapshot' ? snapshot.players[0] : undefined).toMatchObject({ ammo: 0, reserve: 12, reloading: true });
    expect(parseServerMessage(JSON.stringify({ type: 'hot-bakkie-event', kind: 'takeover', actorId: 'p2', previousActorId: 'p1' }))).toMatchObject({ kind: 'takeover' });
  });

  it('selects secure websocket URLs on HTTPS', () => {
    expect(multiplayerWebSocketUrl({ protocol: 'https:', host: 'joburg.example' })).toBe('wss://joburg.example/multiplayer');
    expect(multiplayerWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/multiplayer');
  });
});
