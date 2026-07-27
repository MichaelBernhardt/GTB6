import { describe, expect, it } from 'vitest';
import { METRES_PER_UNIT } from '../../world/mapData';
import type { Lie } from './layout';
import {
  ALTITUDE_CARRY, BAG, GRAVITY, HIRE_BAG, MAX_SHOT_SECONDS, cardBonus, clubCarryM, gimmeRadius,
  holeSkin, launchSpeed, pickClub, pureWindow, relativeToPar, resolveSwing, scoreName, stepBall,
  strike, type Ball, type Bag, type BallWorld,
} from './swing';

const owned = (extra: Partial<Bag>): Bag => ({ ...HIRE_BAG, ...extra });
const surface = (lie: Lie): BallWorld => ({ groundAt: () => 0, lieAt: () => lie });
const level = surface('fairway');

/** Run a struck ball to rest over flat ground and report where it stopped, in metres. */
function runOut(ball: Ball, world = level): { carryless: number; seconds: number } {
  let guard = 0;
  while (!ball.atRest && guard++ < 5000) stepBall(ball, 1 / 120, world);
  return { carryless: Math.hypot(ball.x, ball.z) * METRES_PER_UNIT, seconds: ball.age };
}

describe('the bag', () => {
  it('hands you the shortest club that still gets there', () => {
    expect(pickClub(HIRE_BAG, 60, 'fairway')).toBe('wedge');
    expect(pickClub(HIRE_BAG, 300, 'fairway')).toBe('driver');
    expect(pickClub(HIRE_BAG, 10, 'green')).toBe('putter');
  });

  it('never hands you a driver out of a bunker', () => {
    expect(['wedge', 'short']).toContain(pickClub(HIRE_BAG, 250, 'bunker'));
    expect(pickClub(HIRE_BAG, 250, 'rough')).not.toBe('driver');
  });

  it('makes the hire set genuinely worse and the bought clubs genuinely better', () => {
    const hire = clubCarryM(HIRE_BAG, 'driver');
    const bought = clubCarryM(owned({ driver: true }), 'driver');
    expect(bought).toBeGreaterThan(hire);
    expect(bought / hire).toBeCloseTo(1.06 / 0.84, 2);
    expect(clubCarryM(HIRE_BAG, 'driver')).toBeGreaterThan(200); // a hire driver still moves it
    expect(clubCarryM(owned({ irons: true }), 'iron')).toBeGreaterThan(clubCarryM(HIRE_BAG, 'iron'));
  });

  it('gives every club the Highveld ten percent', () => {
    for (const club of BAG) {
      const sea = club.carryM * (club.id === 'putter' ? 1 : club.id === 'driver' || club.id === 'wood' ? 0.84 : 0.86);
      expect(clubCarryM(HIRE_BAG, club.id)).toBeCloseTo(sea * ALTITUDE_CARRY, 4);
    }
    expect(ALTITUDE_CARRY).toBe(1.10);
  });

  it('a sleeve of Pro V1x is worth carry and accuracy', () => {
    expect(clubCarryM(owned({ premiumBall: true }), 'iron')).toBeGreaterThan(clubCarryM(HIRE_BAG, 'iron'));
    const dirty = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.8, tempo: 0.4 });
    const clean = resolveSwing({ bag: owned({ premiumBall: true }), clubId: 'iron', lie: 'fairway', power: 0.8, tempo: 0.4 });
    expect(Math.abs(clean.sideAngle)).toBeLessThan(Math.abs(dirty.sideAngle));
  });
});

describe('the three-click swing', () => {
  it('rewards a dead-on tempo with a dead-straight ball', () => {
    const result = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.9, tempo: 0 });
    expect(result.sideAngle).toBe(0);
    expect(result.pure).toBe(true);
  });

  it('forgives a small miss and punishes a big one', () => {
    const nearly = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.9, tempo: 0.05 });
    const wild = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.9, tempo: 0.6 });
    expect(nearly.sideAngle).toBe(0); // inside the window
    expect(Math.abs(wild.sideAngle)).toBeGreaterThan(0.1);
    expect(wild.pure).toBe(false);
  });

  it('slices early and hooks late', () => {
    const early = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.9, tempo: 0.45 });
    const late = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.9, tempo: -0.45 });
    expect(early.sideAngle).toBeGreaterThan(0);
    expect(late.sideAngle).toBeLessThan(0);
  });

  it('opens the face when you lunge past the smash limit', () => {
    const smooth = resolveSwing({ bag: HIRE_BAG, clubId: 'driver', lie: 'fairway', power: 0.9, tempo: 0 });
    const lunge = resolveSwing({ bag: HIRE_BAG, clubId: 'driver', lie: 'fairway', power: 1, tempo: 0 });
    expect(smooth.sideAngle).toBe(0);
    expect(lunge.sideAngle).toBeGreaterThan(0);
    expect(lunge.carryU).toBeGreaterThan(smooth.carryU); // still longer — it is a real trade
  });

  it('gives the caddie a genuinely bigger window', () => {
    expect(pureWindow(owned({ caddie: true }))).toBeGreaterThan(pureWindow(HIRE_BAG) * 2);
    const bare = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.8, tempo: 0.15 });
    const helped = resolveSwing({ bag: owned({ caddie: true }), clubId: 'iron', lie: 'fairway', power: 0.8, tempo: 0.15 });
    expect(bare.sideAngle).toBeGreaterThan(0);
    expect(helped.sideAngle).toBe(0);
  });

  it('takes carry out of a bad lie', () => {
    const clean = resolveSwing({ bag: HIRE_BAG, clubId: 'short', lie: 'fairway', power: 1, tempo: 0 });
    const rough = resolveSwing({ bag: HIRE_BAG, clubId: 'short', lie: 'rough', power: 1, tempo: 0 });
    const sand = resolveSwing({ bag: HIRE_BAG, clubId: 'short', lie: 'bunker', power: 1, tempo: 0 });
    expect(rough.carryU).toBeLessThan(clean.carryU);
    expect(sand.carryU).toBeLessThan(rough.carryU);
  });

  it('never lets a stab at the meter produce a zero-power shot', () => {
    const result = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0, tempo: 0 });
    expect(result.carryU).toBeGreaterThan(0);
  });
});

describe('ball flight', () => {
  it('carries what the club promised over level ground', () => {
    const result = resolveSwing({ bag: owned({ driver: true }), clubId: 'driver', lie: 'tee', power: 1, tempo: 0 });
    const ball = strike({ x: 0, y: 0, z: 0 }, 0, result);
    // Measure the CARRY: the first time it touches down, before any bounce or run-out.
    let guard = 0;
    while (!(ball.age > 0.05 && ball.y <= 1e-6) && guard++ < 4000) stepBall(ball, 1 / 240, level);
    const carried = Math.hypot(ball.x, ball.z);
    expect(carried).toBeGreaterThan(result.carryU * 0.9);
    expect(carried).toBeLessThan(result.carryU * 1.1);
    expect(ball.apexY).toBeGreaterThan(5); // a real arc, not a daisy-cutter
  });

  it('lands and runs out, and always comes to rest inside the shot cap', () => {
    const result = resolveSwing({ bag: owned({ driver: true }), clubId: 'driver', lie: 'tee', power: 1, tempo: 0 });
    const ball = strike({ x: 0, y: 0, z: 0 }, 0, result);
    const { carryless, seconds } = runOut(ball);
    expect(ball.atRest).toBe(true);
    expect(seconds).toBeLessThanOrEqual(MAX_SHOT_SECONDS + 0.05);
    expect(carryless).toBeGreaterThan(result.carryU * METRES_PER_UNIT); // run-out adds to carry
  });

  it('runs further off a dormant fairway than off a watered green', () => {
    const result = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 1, tempo: 0 });
    const hard = strike({ x: 0, y: 0, z: 0 }, 0, result);
    const soft = strike({ x: 0, y: 0, z: 0 }, 0, result);
    runOut(hard, surface('fairway'));
    runOut(soft, surface('green'));
    expect(Math.hypot(hard.x, hard.z)).toBeGreaterThan(Math.hypot(soft.x, soft.z));
  });

  it('plugs in a bunker instead of skipping out of it', () => {
    const result = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 1, tempo: 0 });
    const ball = strike({ x: 0, y: 0, z: 0 }, 0, result);
    runOut(ball, surface('bunker'));
    expect(Math.hypot(ball.x, ball.z)).toBeLessThan(result.carryU * 1.06);
  });

  it('breaks downhill on a sloped green', () => {
    const slope: BallWorld = { groundAt: (x: number) => -x * 0.08, lieAt: () => 'green' };
    const putt = resolveSwing({ bag: HIRE_BAG, clubId: 'putter', lie: 'green', power: 0.6, tempo: 0 });
    const ball = strike({ x: 0, y: 0, z: 0 }, 0, putt); // aimed straight down +z
    runOut(ball, slope);
    expect(ball.x).toBeGreaterThan(0.5); // pulled down the slope, off the aim line
  });

  it('aims where the player is facing, plus the miss', () => {
    const result = resolveSwing({ bag: HIRE_BAG, clubId: 'iron', lie: 'fairway', power: 0.8, tempo: 0 });
    const east = strike({ x: 0, y: 0, z: 0 }, Math.PI / 2, result);
    expect(east.vx).toBeGreaterThan(0);
    expect(Math.abs(east.vz)).toBeLessThan(1e-6);
  });

  it('launchSpeed inverts the range equation under the arcade gravity', () => {
    const carry = 120; const launch = 0.34;
    const speed = launchSpeed(carry, launch);
    expect((speed * speed * Math.sin(2 * launch)) / GRAVITY).toBeCloseTo(carry, 4);
  });
});

describe('the card', () => {
  it('names every score a golfer would recognise', () => {
    expect(scoreName(1, 3)).toBe('HOLE IN ONE');
    expect(scoreName(2, 4)).toBe('EAGLE');
    expect(scoreName(3, 4)).toBe('BIRDIE');
    expect(scoreName(4, 4)).toBe('PAR');
    expect(scoreName(5, 4)).toBe('BOGEY');
    expect(scoreName(8, 4)).toBe('+4');
  });

  it('pays something at every hole and never nothing for a par', () => {
    expect(holeSkin(1, 3)).toBe(2000);
    expect(holeSkin(3, 4)).toBe(220);
    expect(holeSkin(4, 4)).toBe(90);
    expect(holeSkin(5, 4)).toBe(25);
    expect(holeSkin(9, 4)).toBe(0);
  });

  it('pays a first card and a new record, and stops paying the record twice', () => {
    expect(cardBonus(12, null)).toEqual({ amount: 750, record: true });
    expect(cardBonus(11, 12)).toEqual({ amount: 750, record: true });
    expect(cardBonus(13, 12)).toEqual({ amount: 150, record: false });
    expect(cardBonus(12, 12)).toEqual({ amount: 150, record: false });
  });

  it('a par round beats the green fee', () => {
    // Par 11 played to par: three pars plus the signed card, against a R180 twilight fee.
    const skins = holeSkin(3, 3) + holeSkin(4, 4) + holeSkin(4, 4);
    expect(skins + cardBonus(11, 12).amount).toBeGreaterThan(180);
  });

  it('concedes more generously once you own a putter', () => {
    expect(gimmeRadius(owned({ putter: true }))).toBeGreaterThan(gimmeRadius(HIRE_BAG));
  });

  it('reads the card the way a scoreboard does', () => {
    expect(relativeToPar(11, 11)).toBe('E');
    expect(relativeToPar(13, 11)).toBe('+2');
    expect(relativeToPar(9, 11)).toBe('-2');
  });
});
