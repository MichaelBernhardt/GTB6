/**
 * THE CUT SCENE, both halves.
 *
 * Half one is the arithmetic in scene.ts — the comic timing, the amplitudes and the framing, which
 * are the only things that decide whether the joke lands, and which are therefore worth asserting
 * rather than eyeballing.
 *
 * Half two is the state machine as the PLAYER meets it, driven through `createFeature` against a
 * stub game exactly like street.test.ts does: pick her up, stop round the corner, press E, and check
 * that the bars go up, the body rocks, the card arrives afterwards, and that every way out of the
 * scene — the full length, a skip, a bullet — lands on the SAME card with the same payoff. That last
 * one is the whole design rule: the scene is presentation in front of the intel, never instead of it.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createFeature } from './street';
import {
  bodyRock, rockEnvelope, ROCK_PITCH, ROCK_ROLL, SCENE_LENGTH, SCENE_PAUSE_AT, SCENE_RESUME_AT,
  SCENE_RESUME_GAIN, SCENE_ROCK_END, SCENE_ROCK_START, SHOT_DISTANCE, shortTimeShot,
} from './scene';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { Vehicle } from '../../entities/Vehicle';
import type { FeatureCinemaShot, FeatureGameApi, FeatureMenuView, InteractionCtx } from '../types';
import { streetSites, type StreetSite } from '../street.state';

describe('the timing is the joke', () => {
  it('holds the car still until the camera has arrived, and settles it before the card', () => {
    expect(rockEnvelope(0), 'a car rocking before the bars are in is a car with a fault').toBe(0);
    expect(rockEnvelope(SCENE_ROCK_START - 0.01)).toBe(0);
    expect(rockEnvelope(SCENE_ROCK_END + 0.01), 'the springs must be still when the card lands').toBe(0);
    expect(SCENE_LENGTH, 'the owner asked for six to eight seconds').toBeGreaterThanOrEqual(6);
    expect(SCENE_LENGTH).toBeLessThanOrEqual(8);
  });

  it('builds slowly, STOPS DEAD for a beat, then comes back harder', () => {
    const build = rockEnvelope(SCENE_ROCK_START + 0.3);
    const settled = rockEnvelope(SCENE_PAUSE_AT - 0.1);
    expect(build, 'the build must start small or it reads as a vibration').toBeLessThan(0.35);
    expect(settled, 'and it must top out before the pause').toBeGreaterThan(0.9);

    // The beat. This is the bit the player laughs at, so it is the bit with a test on it.
    const pause = rockEnvelope((SCENE_PAUSE_AT + SCENE_RESUME_AT) / 2);
    expect(pause, 'the pause has to be a genuine stop, not a lull').toBeLessThan(0.02);

    const resumed = rockEnvelope(SCENE_RESUME_AT + 1);
    expect(resumed, 'the second half must beat the first, or the pause was for nothing').toBeGreaterThan(settled);
    expect(resumed).toBeLessThanOrEqual(SCENE_RESUME_GAIN + 1e-9);
  });

  it('rocks a car on its springs, not a boat in a storm', () => {
    let peakPitch = 0; let peakRoll = 0; let minLift = 1;
    for (let t = 0; t <= SCENE_LENGTH; t += 1 / 120) {
      const rock = bodyRock(t, 0.31);
      peakPitch = Math.max(peakPitch, Math.abs(rock.pitch));
      peakRoll = Math.max(peakRoll, Math.abs(rock.roll));
      minLift = Math.min(minLift, rock.lift);
    }
    expect(peakPitch).toBeLessThanOrEqual(ROCK_PITCH * SCENE_RESUME_GAIN + 1e-9);
    expect(peakPitch, 'too small to see is the same as not shipping it').toBeGreaterThan(ROCK_PITCH * 0.9);
    expect(peakRoll).toBeLessThanOrEqual(ROCK_ROLL * SCENE_RESUME_GAIN + 1e-9);
    expect(minLift, 'a car sinking through the tar is a different film').toBeGreaterThanOrEqual(0);
  });

  it('is deterministic — same kerb, same ride, same seven seconds', () => {
    // No Math.random and no wall clock anywhere in here: a replay, a headless capture and a
    // multiplayer peer must all see the identical scene.
    for (const t of [0.9, 2.2, 5.1]) {
      expect(bodyRock(t, 0.42)).toEqual(bodyRock(t, 0.42));
      expect(bodyRock(t, 0.42)).not.toEqual(bodyRock(t, 0.77));
    }
  });

  it('frames the car from outside, three-quarter, above the tar', () => {
    const car = { x: 100, y: 2, z: -40 };
    const shot = shortTimeShot(car, 0.7, 0.2, 1.5);
    const away = Math.hypot(shot.eye.x - car.x, shot.eye.z - car.z);
    expect(away, 'the lens must be outside the car').toBeCloseTo(SHOT_DISTANCE, 5);
    expect(shot.eye.y, 'and above it, looking down').toBeGreaterThan(car.y + 2);
    expect(shot.focus.x).toBe(car.x);
    expect(shot.focus.z).toBe(car.z);
    // A kerb, a ramp or a koppie under the lens must not put the camera underground.
    expect(shortTimeShot(car, 0.7, 0.2, 9).eye.y).toBeGreaterThan(9);
    // Two rides on the same kerb are not the same shot.
    expect(shortTimeShot(car, 0.7, 0.8, 1.5).eye.x).not.toBeCloseTo(shot.eye.x, 3);
  });
});

// ---- the state machine, through the real feature -------------------------------------------------

interface Harness {
  api: FeatureGameApi;
  menus: FeatureMenuView[];
  shots: (FeatureCinemaShot | undefined)[];
  car: FakeCar;
  position: THREE.Vector3;
  skip: { value: boolean };
  events: { event: string; detail?: string }[];
}

interface FakeCar extends Vehicle { sway: { pitch: number; roll: number; lift: number } }

function fakeCar(): FakeCar {
  const group = new THREE.Group();
  const car = {
    group, heading: 0, speed: 0, health: 100, maxHealth: 100, onFire: false, police: false,
    sway: { pitch: 0, roll: 0, lift: 0 },
    setBodySway(pitch: number, roll: number, lift = 0) { car.sway = { pitch, roll, lift }; },
  };
  return car as unknown as FakeCar;
}

function fakePed(x: number, z: number): Pedestrian {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  return {
    group, health: 100, state: 'idle', fear: 0, idleTime: 0, aggressive: false, wallet: 0, enraged: false,
    setHail: () => undefined, takeDamage: () => undefined,
  } as unknown as Pedestrian;
}

/** `cinema: false` builds a host WITHOUT the optional seam — the source-compatibility case. */
function harness(cinema = true): Harness {
  const scene = new THREE.Scene();
  const menus: FeatureMenuView[] = [];
  const shots: (FeatureCinemaShot | undefined)[] = [];
  const events: { event: string; detail?: string }[] = [];
  const peds: Pedestrian[] = [];
  const position = new THREE.Vector3();
  const car = fakeCar();
  const skip = { value: false };
  const money = { value: 5000 };
  const api: FeatureGameApi = {
    scene,
    surfaceHeightAt: () => 0, districtAt: () => 'Joburg CBD', isPark: () => false,
    nearestRoadPose: () => ({ position: position.clone(), heading: 0 }),
    playerPosition: () => car.group.position, playerHeading: () => 0,
    drivenVehicle: () => car,
    hour: () => 12, blackout: () => 0,
    balance: () => money.value,
    earn: (amount) => { money.value += amount; },
    spend: (amount) => { if (money.value < amount) return false; money.value -= amount; return true; },
    notify: () => undefined,
    showMenu: (view) => { menus.push(view); },
    closeMenu: () => undefined,
    persist: () => undefined,
    analytics: (event, props) => { events.push({ event, detail: props?.detail }); },
    spawnFixture: (x, z) => { const ped = fakePed(x, z); peds.push(ped); return ped; },
    removeFixture: (ped) => { const at = peds.indexOf(ped); if (at >= 0) peds.splice(at, 1); },
    ...(cinema ? { cinema: (shot: FeatureCinemaShot | undefined) => { shots.push(shot); if (!shot) return false; const asked = skip.value; skip.value = false; return asked; } } : {}),
  };
  return { api, menus, shots, car, position, skip, events };
}

const workerSite = (): StreetSite => streetSites().find((site) => site.id.endsWith('day-worker'))!;

const frame = (position: THREE.Vector3, vehicle: Vehicle): InteractionCtx =>
  ({ context: 'vehicle', position, vehicle, hour: 12 });

/** Pick her up and stop round the corner: the real ladder, the real card, the real fare. */
function pickUp(harnessed: Harness): ReturnType<typeof createFeature> {
  const site = workerSite();
  const { api, car } = harnessed;
  car.group.position.set(site.x, 0, site.z + 2);
  const system = createFeature(api, undefined);
  system.update?.(1);
  const offer = [...(system.interactions?.() ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((rung) => (rung.context === 'vehicle' ? rung.test(frame(car.group.position, car)) : undefined))
    .find(Boolean);
  expect(offer, 'nobody offered a deal at a staffed kerb').toBeDefined();
  offer!.act();
  system.menu?.('ride');
  // Round the corner, and stopped: rules.isQuiet's two conditions and nothing else.
  car.group.position.set(site.x + 60, 0, site.z + 60);
  return system;
}

/** Press E at the quiet spot — the one and only trigger. */
function killTheLights(system: ReturnType<typeof createFeature>, harnessed: Harness): void {
  const offer = [...(system.interactions?.() ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((rung) => (rung.context === 'vehicle' ? rung.test(frame(harnessed.car.group.position, harnessed.car)) : undefined))
    .find(Boolean);
  expect(offer?.prompt, 'stopping round the corner must offer the way out of the ride').toBe('E  Kill the lights');
  offer!.act();
}

const tick = (system: ReturnType<typeof createFeature>, seconds: number, step = 1 / 60): void => {
  for (let t = 0; t < seconds; t += step) system.update?.(step);
};

const cardShown = (harnessed: Harness): FeatureMenuView | undefined =>
  harnessed.menus.find((view) => view.eyebrow === 'LATER · ROUND THE CORNER');

describe('the short time plays as a cut scene, and the card still follows', () => {
  it('goes bars → bounce → card, and never shows the card early', () => {
    const harnessed = harness();
    const system = pickUp(harnessed);
    const before = harnessed.menus.length;
    killTheLights(system, harnessed);

    system.update?.(1 / 60);
    expect(harnessed.shots.at(-1), 'the bars and the lens go up on the first tick').toBeDefined();
    expect(harnessed.shots.at(-1)!.hint, 'a cutscene must show its own way out').toMatch(/E {2}Skip/);
    expect(harnessed.menus.length, 'the card must NOT arrive in front of the scene').toBe(before);

    tick(system, 2.4);
    expect(Math.abs(harnessed.car.sway.pitch) + Math.abs(harnessed.car.sway.roll), 'the car has to actually rock').toBeGreaterThan(0.005);
    expect(cardShown(harnessed), 'still filming').toBeUndefined();

    tick(system, SCENE_LENGTH);
    const card = cardShown(harnessed);
    expect(card, 'the intel payoff is the point; the scene is only the way in').toBeDefined();
    expect(card!.rows.some((row) => row.id === 'ride-done'), 'the card is the SAME card as before').toBe(true);
    expect(harnessed.shots.at(-1), 'the bars must come down before the card pauses the world').toBeUndefined();
    expect(harnessed.car.sway, 'and the bodywork goes back where it was').toEqual({ pitch: 0, roll: 0, lift: 0 });
    expect(system.qa?.('status', {}), 'the ride still counts').toContain('rides=1');
    expect(harnessed.events.some((entry) => entry.event === 'scene' && entry.detail === 'played')).toBe(true);
    system.dispose();
  });

  it('skips straight to the card on E, with the payoff intact', () => {
    const harnessed = harness();
    const system = pickUp(harnessed);
    killTheLights(system, harnessed);
    tick(system, 1.2);
    expect(cardShown(harnessed)).toBeUndefined();

    harnessed.skip.value = true; // E or SPACE: Game reads the key, the seam returns the edge
    system.update?.(1 / 60);
    expect(cardShown(harnessed), 'a skip must never cost the player what she knows').toBeDefined();
    expect(harnessed.shots.at(-1), 'bars down on the way out, even mid-slide').toBeUndefined();
    expect(harnessed.car.sway).toEqual({ pitch: 0, roll: 0, lift: 0 });
    expect(system.qa?.('status', {})).toContain('rides=1');
    expect(harnessed.events.some((entry) => entry.event === 'scene' && entry.detail === 'skipped')).toBe(true);
    system.dispose();
  });

  it('cuts instantly when the car is shot at, set alight, or taken away', () => {
    for (const [label, sabotage] of [
      ['a bullet through the door', (harnessed: Harness) => { harnessed.car.health -= 20; }],
      ['a burning car', (harnessed: Harness) => { (harnessed.car as { onFire: boolean }).onFire = true; }],
    ] as const) {
      const harnessed = harness();
      const system = pickUp(harnessed);
      killTheLights(system, harnessed);
      tick(system, 1.5);
      expect(cardShown(harnessed), label).toBeUndefined();
      sabotage(harnessed);
      system.update?.(1 / 60);
      expect(cardShown(harnessed), `${label}: she is gone, and the card lands anyway`).toBeDefined();
      expect(harnessed.shots.at(-1), `${label}: the camera comes straight back`).toBeUndefined();
      expect(harnessed.car.sway).toEqual({ pitch: 0, roll: 0, lift: 0 });
      expect(harnessed.events.some((entry) => entry.event === 'scene' && entry.detail === 'cut')).toBe(true);
      system.dispose();
    }
  });

  it('shows the card immediately on a host with no cinema seam', () => {
    // The seam is optional on FeatureGameApi so older and test hosts stay source compatible. A host
    // without it does not get a broken feature — it gets the feature, which is the card.
    const harnessed = harness(false);
    const system = pickUp(harnessed);
    killTheLights(system, harnessed);
    expect(cardShown(harnessed), 'no seam, no scene, but never no payoff').toBeDefined();
    expect(system.qa?.('status', {})).toContain('rides=1');
    system.dispose();
  });

  it('hands the camera and the bodywork back when the feature is disposed mid-scene', () => {
    const harnessed = harness();
    const system = pickUp(harnessed);
    killTheLights(system, harnessed);
    tick(system, 1.5);
    system.dispose();
    expect(harnessed.shots.at(-1), 'a checkpoint reload must not leave the lens parked in a side street').toBeUndefined();
    expect(harnessed.car.sway).toEqual({ pitch: 0, roll: 0, lift: 0 });
    expect(cardShown(harnessed), 'and it must not show a card nobody asked for').toBeUndefined();
  });
});
