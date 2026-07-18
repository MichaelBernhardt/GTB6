import { describe, expect, it } from 'vitest';
import { hotBakkieObjective, rankOnlinePlayers } from './presentation';
import type { HotBakkieState, NetPlayer, NetVehicle } from './protocol';

const netPlayer = (overrides: Partial<NetPlayer> = {}): NetPlayer => ({
  id: 'p1', name: 'Mika', appearance: 'maboneng-courier', runs: 2, x: 1, y: 0, z: 2, heading: 0, health: 100,
  kills: 3, deaths: 1, ammo: 7, reserve: 42, reloading: false, locomotion: 'walk', aiming: false, dead: false, protected: false, ...overrides,
});
const netVehicle = (overrides: Partial<NetVehicle> = {}): NetVehicle => ({ id: 'hot-bakkie', kind: 'bakkie', x: 10, y: 0, z: 20, heading: 0, speed: 4, health: 145, isHot: true, ...overrides });
const hotState = (overrides: Partial<HotBakkieState> = {}): HotBakkieState => ({ phase: 'active', round: 1, route: 'Commissioner Shuffle', carrier: 'p1', currentCheckpoint: { x: 20, z: 30, label: 'Portia', delivery: false }, progress: 1, total: 4, remainingTime: 90, ...overrides });

describe('Hot Bakkie client presentation', () => {
  it('ranks by runs, then kills, then fewer deaths', () => {
    const players = [
      netPlayer({ id: 'kills', name: 'Kills', runs: 1, kills: 10, deaths: 0 }),
      netPlayer({ id: 'deaths', name: 'Deaths', runs: 2, kills: 4, deaths: 5 }),
      netPlayer({ id: 'winner', name: 'Winner', runs: 2, kills: 4, deaths: 1 }),
    ];
    expect(rankOnlinePlayers(players).map((player) => player.id)).toEqual(['winner', 'deaths', 'kills']);
  });

  it('marks the bakkie when unclaimed or carried by another player', () => {
    const players = [netPlayer({ id: 'self' }), netPlayer({ id: 'rival', name: 'Rival' })]; const vehicle = netVehicle({ x: 11, z: 22 });
    expect(hotBakkieObjective(hotState({ carrier: undefined, progress: 0 }), players, [vehicle], 'self')).toMatchObject({ text: 'Claim the marked bakkie and run the route.', target: { x: 11, z: 22 } });
    expect(hotBakkieObjective(hotState({ carrier: 'rival' }), players, [vehicle], 'self')).toMatchObject({ text: 'Chase Rival, take the bakkie, finish the route.', target: { color: '#ef5548' } });
  });

  it('switches a local carrier to ordered checkpoint and delivery objectives', () => {
    const players = [netPlayer({ id: 'self' })];
    expect(hotBakkieObjective(hotState({ carrier: 'self', progress: 1 }), players, [netVehicle()], 'self')).toMatchObject({ progress: 1, required: 4, target: { label: 'Portia', color: '#f5c451' } });
    const delivery = hotBakkieObjective(hotState({ carrier: 'self', progress: 3, currentCheckpoint: { x: 30, z: 40, label: 'Lock-up', delivery: true } }), players, [netVehicle()], 'self');
    expect(delivery).toMatchObject({ text: 'Stop inside Lock-up below 29 km/h.', target: { x: 30, z: 40, color: '#66e39b' } });
  });

  it('shows countdown and winner cooldown without stale route targets', () => {
    const winner = netPlayer({ id: 'winner', name: 'Lerato' });
    expect(hotBakkieObjective(hotState({ phase: 'countdown', carrier: undefined, remainingTime: 12 }), [winner], [netVehicle()], 'self')).toMatchObject({ remainingSeconds: 12, target: { label: 'Hot Bakkie' } });
    expect(hotBakkieObjective(hotState({ phase: 'cooldown', winner: 'winner', carrier: undefined, currentCheckpoint: undefined, remainingTime: 15 }), [winner], [netVehicle()], 'self')).toEqual({ missionName: 'HOT BAKKIE RUN', text: 'Lerato delivered it. Next bakkie is being found.', remainingSeconds: 15 });
  });
});
