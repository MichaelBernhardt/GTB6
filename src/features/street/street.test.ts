/**
 * The street economy as the PLAYER meets it, driven through the real feature surface.
 *
 * This suite exists because of one owner playtest, and every case in it is a sentence from that
 * report turned into a failing test:
 *
 *   "It took a lot of work to find a clue to see someone"        → somebody is standing there already
 *   "the instructions toasted too quickly to follow"             → directions live on a card, not a toast
 *   "then the person stopped telling me, so I can't find it"     → every line repeats, free, for ever
 *   "perhaps a goal indicator (gold pillar of light)"            → a destination is a pillar and a map pin
 *
 * It drives `createFeature` itself — the same entry the FeatureHost uses — against a stub Game, so
 * it tests the shipped path rather than a reimplementation of it.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFeature } from './street';
import { WORKERS } from './cast';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { FeatureGameApi, FeatureMenuView, InteractionContext, InteractionCtx } from '../types';
import { streetSites, type StreetSite } from '../street.state';

interface Toast { title: string; detail?: string }

interface Stub {
  api: FeatureGameApi;
  scene: THREE.Scene;
  peds: Pedestrian[];
  toasts: Toast[];
  menus: FeatureMenuView[];
  position: THREE.Vector3;
  hour: { value: number };
  money: { value: number };
}

function fakePed(x: number, z: number): Pedestrian {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  return {
    group, health: 100, state: 'idle', fear: 0, idleTime: 0, aggressive: false, wallet: 0, enraged: false,
    setHail: () => undefined,
    takeDamage: () => undefined,
  } as unknown as Pedestrian;
}

function stub(): Stub {
  const scene = new THREE.Scene();
  const peds: Pedestrian[] = [];
  const toasts: Toast[] = [];
  const menus: FeatureMenuView[] = [];
  const position = new THREE.Vector3();
  const hour = { value: 12 };
  const money = { value: 5000 };
  const api: FeatureGameApi = {
    scene,
    surfaceHeightAt: () => 0, districtAt: () => 'Joburg CBD', isPark: () => false,
    nearestRoadPose: () => ({ position: position.clone(), heading: 0 }),
    playerPosition: () => position, playerHeading: () => 0, drivenVehicle: () => undefined,
    hour: () => hour.value, blackout: () => 0,
    balance: () => money.value,
    earn: (amount) => { money.value += amount; },
    spend: (amount) => { if (money.value < amount) return false; money.value -= amount; return true; },
    notify: (title, detail) => { toasts.push({ title, detail }); },
    showMenu: (view) => { menus.push(view); },
    closeMenu: () => undefined,
    persist: () => undefined, analytics: () => undefined,
    spawnFixture: (x, z) => { const ped = fakePed(x, z); peds.push(ped); return ped; },
    removeFixture: (ped) => { const at = peds.indexOf(ped); if (at >= 0) peds.splice(at, 1); },
  };
  return { api, scene, peds, toasts, menus, position, hour, money };
}

const frame = (position: THREE.Vector3, context: InteractionContext = 'foot', hour = 12): InteractionCtx =>
  ({ context, position, vehicle: undefined, hour });

/** Everything the ladder would offer at this spot, in the resolved order. */
function promptAt(system: ReturnType<typeof createFeature>, ctx: InteractionCtx): string | undefined {
  for (const rung of [...(system.interactions?.() ?? [])].sort((a, b) => a.order - b.order)) {
    if (rung.context !== ctx.context) continue;
    const offer = rung.test(ctx);
    if (offer) return offer.prompt;
  }
  return undefined;
}

function actAt(system: ReturnType<typeof createFeature>, ctx: InteractionCtx): boolean {
  for (const rung of [...(system.interactions?.() ?? [])].sort((a, b) => a.order - b.order)) {
    if (rung.context !== ctx.context) continue;
    const offer = rung.test(ctx);
    if (offer) { offer.act(); return true; }
  }
  return false;
}

let sites: StreetSite[];
let cbdDealer: StreetSite;
let cbdWorker: StreetSite;

beforeEach(() => {
  sites = streetSites();
  cbdDealer = sites.find((site) => site.kind === 'dealer')!;
  // The daylight relief — the nearest person to the spawn kerb, and the one a noon session meets.
  cbdWorker = sites.find((site) => site.id.endsWith('day-worker'))!;
});

describe('somebody is already standing on the corner', () => {
  it('staffs and lights the nearby corners on the first tick, with no press from the player', () => {
    const { api, scene, peds, position } = stub();
    position.set(cbdDealer.x + 40, 0, cbdDealer.z + 40);
    const system = createFeature(api, undefined);
    system.update?.(1);
    expect(peds.length, 'nobody was put on the corner').toBeGreaterThan(0);
    const beacons = scene.getObjectByName('StreetCorners');
    expect(beacons, 'no lit pads in the scene').toBeDefined();
    expect(beacons!.children.length, 'a worked corner must be lit').toBeGreaterThan(0);
    system.dispose();
  });

  it('offers the trade to a player who simply walks up, with the price already in the prompt', () => {
    const { api, position } = stub();
    position.set(cbdDealer.x + 40, 0, cbdDealer.z + 40);
    const system = createFeature(api, undefined);
    system.update?.(1);
    expect(promptAt(system, frame(position)), 'a prompt 40 m away would block E across the block').toBeUndefined();
    position.set(cbdDealer.x, 0, cbdDealer.z + 1.5);
    const prompt = promptAt(system, frame(position));
    expect(prompt, 'standing next to a visible dealer must offer something').toBeDefined();
    expect(prompt).toMatch(/^E {2}Talk to \S+ · /);
    expect(prompt, 'the prompt must quote the price the card will quote').toMatch(/R\d+|Runner|Trustee/);
    system.dispose();
  });

  it('takes money and hands over stock — a complete trade, standing on the pavement', () => {
    const { api, position, menus, money } = stub();
    position.set(cbdDealer.x, 0, cbdDealer.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    expect(actAt(system, frame(position))).toBe(true);
    const card = menus.at(-1)!;
    const buy = card.rows.find((row) => row.id.startsWith('buy1:'))!;
    expect(buy, `no buyable row on ${card.title}: ${card.rows.map((row) => row.id).join()}`).toBeDefined();
    const before = money.value;
    system.menu?.(buy.id);
    expect(money.value, 'the trade must actually cost money').toBeLessThan(before);
    const holding = (system.hud?.() ?? []).some((chip) => chip.value === '1');
    expect(holding, 'the HUD must show what you are now carrying').toBe(true);
    system.dispose();
  });
});

describe('walking up to somebody is not an assault', () => {
  it('lets a clumsy player barge into their own contact without losing the entire trade', () => {
    // Found in-engine, and it is the nastiest failure mode this feature had: arriving at a run
    // knocks the person over, a knockdown costs 12 health, ANY health drop tripped the citywide
    // bad-date list, and any `down` state was read as a corpse — so the act of walking up to your
    // first contact banned you from every corner in the city and retired the block for minutes.
    const { api, position, peds } = stub();
    position.set(cbdDealer.x, 0, cbdDealer.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    const ped = peds[0]! as Pedestrian & { state: string };
    ped.health -= 12; // BumpSystem.KNOCKDOWN_DAMAGE — a sprint-bump on arrival
    ped.state = 'down';
    system.update?.(1);
    expect(ped.health, 'she dusts herself off and carries on working').toBe(100);
    expect(system.qa?.('status', {}), 'a shove must not put the player on the bad-date list').toContain('banned=0');

    // A wound is bad luck too — a taxi clipping her while you stand there must not ban you.
    ped.health -= 45;
    system.update?.(1);
    expect(system.qa?.('status', {}), 'a car hitting her next to you is not your crime').toContain('banned=0');

    // …but killing somebody who works this street still shuts the road, citywide.
    ped.health = 0;
    system.update?.(1);
    expect(system.qa?.('status', {}), 'killing somebody must still cost you the trade').not.toContain('banned=0');
    system.dispose();
  });

  it('never lets a fixture turn hostile and follow the customer down the road', () => {
    // Pedestrian.applyFear can roll "fight" on a frightened ped, and an enraged one pursues for as
    // long as the fear lasts. In-engine that put the DEALER on the WORKER's kerb, 72 m off his own
    // corner, so walking up to her opened his card. A fixture is furniture with opinions: it argues,
    // it overcharges, it refuses — it does not chase you, and it does not leave the pitch.
    const { api, position, peds } = stub();
    position.set(cbdDealer.x, 0, cbdDealer.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    const ped = peds[0]! as Pedestrian & { state: string; enraged: boolean };
    ped.enraged = true; ped.state = 'hostile'; ped.fear = 100;
    ped.group.position.set(cbdDealer.x + 40, 0, cbdDealer.z + 40);
    system.update?.(1);
    expect(ped.state, 'a hostile dealer is a broken dealer').toBe('idle');
    expect(ped.enraged).toBe(false);
    const strayed = Math.hypot(ped.group.position.x - cbdDealer.x, ped.group.position.z - cbdDealer.z);
    expect(strayed, `left ${strayed.toFixed(0)} m off his corner`).toBeLessThan(1.5);
    system.dispose();
  });
});

describe('nothing the player needs lives in a toast', () => {
  it('sells directions on a readable card and marks the destination in the world and on the map', () => {
    const { api, position, menus, toasts } = stub();
    position.set(cbdWorker.x, 0, cbdWorker.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    expect(actAt(system, frame(position)), 'the worker must be reachable on foot').toBe(true);
    const before = toasts.length;
    system.menu?.('info');
    const card = menus.at(-1)!;
    expect(toasts.length, 'directions must not be delivered as a toast').toBe(before);
    expect(card.rows.some((row) => row.id === 'dir:tip'), 'the destination must be a readable row').toBe(true);
    const marked = card.rows.find((row) => row.id === 'dir:tip')!;
    expect(marked.label, 'the row must name the place and the distance').toMatch(/MARKED — .+, \d+ m /);
    expect(system.mapIcons?.().some((icon) => icon.objective), 'the destination must be a gold pin on the map').toBe(true);
    system.dispose();
  });

  it('repeats the directions for free, for ever — the person never stops telling you', () => {
    const { api, position, menus, money } = stub();
    position.set(cbdWorker.x, 0, cbdWorker.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    actAt(system, frame(position));
    system.menu?.('info');
    const target = menus.at(-1)!.rows.find((row) => row.id === 'dir:tip')!.label;
    const after = money.value;
    for (let again = 0; again < 5; again++) {
      actAt(system, frame(position));
      const card = menus.at(-1)!;
      expect(card.rows.some((row) => row.id === 'tip-again'), 'the repeat must be offered every single time').toBe(true);
      system.menu?.('tip-again');
      expect(menus.at(-1)!.rows.find((row) => row.id === 'dir:tip')!.label).toBe(target);
    }
    expect(money.value, 'repeating herself must never cost anything').toBe(after);
    system.dispose();
  });

  it('will list the whole road from any corner, with distances and shifts', () => {
    const { api, position, menus } = stub();
    position.set(cbdDealer.x, 0, cbdDealer.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    actAt(system, frame(position));
    expect(menus.at(-1)!.rows.some((row) => row.id === 'block'), 'a dealer must be willing to point at the others').toBe(true);
    system.menu?.('block');
    const page = menus.at(-1)!;
    const listed = page.rows.filter((row) => row.id.startsWith('dir:') && row.id !== 'dir:tip');
    expect(listed.length, 'the directory must list every corner').toBe(sites.length);
    for (const row of listed) expect(row.detail, row.label).toMatch(/\d+ m (north|south|east|west)/);
    const shifts = listed.filter((row) => /\d+h–\d+h/.test(row.detail ?? ''));
    expect(shifts.length, 'every worker must publish her hours, open or shut').toBe(sites.filter((site) => site.kind === 'worker').length);
    system.dispose();
  });
});

describe('the goal indicator the owner asked for', () => {
  it('stands a gold pillar over the destination and keeps it there until you have been', () => {
    const { api, scene, position } = stub();
    position.set(cbdWorker.x, 0, cbdWorker.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    const tall = (): number => {
      let count = 0;
      scene.getObjectByName('StreetCorners')?.traverse((node) => {
        const mesh = node as THREE.Mesh<THREE.CylinderGeometry>;
        if (mesh.isMesh && mesh.geometry.type === 'CylinderGeometry' && mesh.geometry.parameters.height > 100) count += 1;
      });
      return count;
    };
    expect(tall(), 'no destination yet, so no gold pillar').toBe(0);
    actAt(system, frame(position));
    system.menu?.('info');
    expect(tall(), 'the pillar must be up the instant she names the place').toBeGreaterThan(0);
    // Drive to the other side of the city: the pillar and the pin both stay.
    position.set(cbdWorker.x + 4000, 0, cbdWorker.z + 4000);
    for (let tick = 0; tick < 5; tick++) system.update?.(1);
    expect(tall(), 'the marker must persist until you get there').toBeGreaterThan(0);
    expect(system.mapIcons?.().some((icon) => icon.objective)).toBe(true);
    system.dispose();
  });

  it('blips every corner so the map answers "where is anybody" without asking a soul', () => {
    const { api, position } = stub();
    position.set(cbdDealer.x, 0, cbdDealer.z);
    const system = createFeature(api, undefined);
    system.update?.(1);
    const icons = system.mapIcons?.() ?? [];
    expect(icons).toHaveLength(sites.length);
    expect(new Set(icons.map((icon) => icon.color)).size, 'dealers and kerbs must be told apart').toBe(2);
    system.dispose();
  });

  it('takes every mesh, collider and fixture with it when it goes', () => {
    const { api, scene, peds, position } = stub();
    position.set(cbdWorker.x, 0, cbdWorker.z + 1.5);
    const system = createFeature(api, undefined);
    system.update?.(1);
    actAt(system, frame(position));
    system.menu?.('info');
    expect(peds.length).toBeGreaterThan(0);
    system.dispose();
    system.dispose(); // idempotent: called on new game, checkpoint reload and a stale lazy arrival
    expect(peds, 'a leaked fixture is a ghost on the pavement').toHaveLength(0);
    expect(scene.getObjectByName('StreetCorners'), 'a leaked marker group is a light with nobody under it').toBeUndefined();
  });
});

describe('the corner is dark when nobody is on it', () => {
  it('does not light a kerb whose worker is off shift, but still lists her hours on the map page', () => {
    const { api, scene, position, menus } = stub();
    const relief = WORKERS[cbdWorker.cast % WORKERS.length]!;
    const asleep = (relief.shift.start + 24 - 2) % 24; // two hours before she starts
    const offShift: FeatureGameApi = { ...api, hour: () => asleep };
    position.set(cbdWorker.x, 0, cbdWorker.z + 1.5);
    const system = createFeature(offShift, undefined);
    system.update?.(1);
    const lit = scene.getObjectByName('StreetCorners')!;
    // Her own kerb must be dark. A lit pad always means a person is standing under it — and the
    // dealer's pad on the same block must still be lit, or this assertion proves nothing.
    const litAt = (site: StreetSite): boolean => lit.children.some((child) => Math.hypot(child.position.x - site.x, child.position.z - site.z) < 1);
    expect(litAt(cbdDealer), 'the always-open corner must be lit, or the negative below is vacuous').toBe(true);
    expect(litAt(cbdWorker), 'an empty kerb must not be advertised as a person').toBe(false);
    // …but the dealer on the same block is always there, and he will read you her hours.
    position.set(cbdDealer.x, 0, cbdDealer.z + 1.5);
    actAt(system, frame(position, 'foot', asleep));
    system.menu?.('block');
    const row = menus.at(-1)!.rows.find((entry) => entry.id === `dir:${cbdWorker.id}`)!;
    expect(row.detail, 'a closed corner with the hours on it is a plan; without them it is the empty pavement').toMatch(/back at \d+h/);
    system.dispose();
  });
});
