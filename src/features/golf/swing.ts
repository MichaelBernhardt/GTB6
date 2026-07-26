/**
 * The rules of golf, as pure functions: the bag, the three-click swing, ball flight and the card.
 * No three.js, no scene, no api — so every number below is unit-testable and stays honest.
 *
 * Two deliberate distortions, both for feel:
 *  - GRAVITY is 24 u/s², about 3.3x real at this map's 1.359 m/unit. A real 230 m drive hangs for
 *    six seconds; at 24 it arcs properly and lands in two. The plan's Neo Turf Masters lesson is
 *    "delete the waiting", and a three-hole round has to fit inside four minutes.
 *  - Distances are authored in METRES because South African courses are measured in metres, and
 *    converted to units at the boundary.
 */
import { METRES_PER_UNIT } from '../../world/mapData';
import type { Lie } from './layout';

/** Johannesburg sits at ~1,753 m. Thin air, ~10% more carry, and far less spin so it runs out. */
export const ALTITUDE_CARRY = 1.10;
export const ALTITUDE_ROLL = 1.22;

export const GRAVITY = 24;

export type ClubId = 'driver' | 'wood' | 'iron' | 'short' | 'wedge' | 'putter';

export interface Club {
  id: ClubId;
  /** Short label for the HUD chip. */
  name: string;
  /** Sea-level carry at full power, in metres. */
  carryM: number;
  /** Launch angle, radians. Zero means it never leaves the deck (the putter). */
  launch: number;
  /** Dispersion at a full miss on the accuracy meter, radians. */
  side: number;
}

/** Longest first is wrong for selection; keep the bag ordered short → long so pickClub can walk up. */
export const BAG: readonly Club[] = [
  { id: 'putter', name: 'PUTTER', carryM: 34, launch: 0, side: 0.05 },
  { id: 'wedge', name: 'WEDGE', carryM: 88, launch: 0.62, side: 0.10 },
  { id: 'short', name: '8 IRON', carryM: 126, launch: 0.50, side: 0.13 },
  { id: 'iron', name: '5 IRON', carryM: 158, launch: 0.42, side: 0.15 },
  { id: 'wood', name: '3 WOOD', carryM: 198, launch: 0.34, side: 0.18 },
  { id: 'driver', name: 'DRIVER', carryM: 232, launch: 0.30, side: 0.20 },
];

export function club(id: ClubId): Club { return BAG.find((entry) => entry.id === id) ?? BAG[1]!; }

/** What the player is carrying, folded into the two numbers the swing actually cares about. */
export interface Bag {
  driver: boolean;
  irons: boolean;
  putter: boolean;
  glove: boolean;
  shoes: boolean;
  /** A sleeve of Pro V1x in the bag: a touch more carry, a touch less spread. */
  premiumBall: boolean;
  caddie: boolean;
}

export const HIRE_BAG: Bag = { driver: false, irons: false, putter: false, glove: false, shoes: false, premiumBall: false, caddie: false };

/** Carry multiplier for a club given what the player owns. The hire set is genuinely worse. */
export function carryFactor(bag: Bag, id: ClubId): number {
  let factor = 1;
  if (id === 'driver' || id === 'wood') factor *= bag.driver ? 1.06 : 0.84;
  else if (id !== 'putter') factor *= bag.irons ? 1.08 : 0.86;
  return factor;
}

/** Dispersion multiplier: every purchase in the pro shop tightens this, and the hire set widens it. */
export function sideFactor(bag: Bag, id: ClubId): number {
  let factor = 1;
  if (id === 'putter') factor *= bag.putter ? 0.60 : 1.25;
  else if (id === 'driver' || id === 'wood') factor *= bag.driver ? 0.90 : 1.25;
  else factor *= bag.irons ? 0.75 : 1.25;
  if (bag.glove) factor *= 0.85;
  if (bag.shoes) factor *= 0.90;
  if (bag.premiumBall) factor *= 0.90;
  return factor;
}

/** Full-power carry for one club, in METRES, with the bag, the ball and the Highveld folded in. */
export function clubCarryM(bag: Bag, id: ClubId): number {
  const base = club(id).carryM * carryFactor(bag, id) + (bag.premiumBall && id !== 'putter' ? 6 : 0);
  return base * ALTITUDE_CARRY;
}

/**
 * Total distance a club covers from this lie in METRES — carry PLUS the run it releases. A player
 * who clubs off carry alone flies every green on a course this baked, so the picker and the machine
 * driver both work in reach.
 */
export function clubReachM(bag: Bag, id: ClubId, lie: Lie): number {
  const carry = clubCarryM(bag, id) * lieCarry(lie);
  return id === 'putter' ? carry : carry * (1 + CLUB_RUN[id] * ALTITUDE_ROLL * 0.6);
}

/** The club the caddie hands you: the shortest one that still reaches, driver when nothing does. */
export function pickClub(bag: Bag, distanceM: number, lie: Lie): ClubId {
  if (lie === 'green') return 'putter';
  // Out of a bunker or heavy rough there is no long club — you are wedging back into play.
  const playable: ClubId[] = lie === 'bunker' ? ['wedge', 'short'] : lie === 'rough' ? ['wedge', 'short', 'iron', 'wood'] : ['wedge', 'short', 'iron', 'wood', 'driver'];
  for (const id of playable) if (clubReachM(bag, id, lie) * 0.97 >= distanceM) return id;
  return playable[playable.length - 1]!;
}

/** How much of the club a lie gives you back. */
export function lieCarry(lie: Lie): number {
  return lie === 'rough' ? 0.82 : lie === 'bunker' ? 0.68 : 1;
}

export function lieSide(lie: Lie): number {
  return lie === 'rough' ? 1.35 : lie === 'bunker' ? 1.25 : 1;
}

// ---- the three-click swing ---------------------------------------------------------------------

/** Seconds for the power bar to sweep 0 → 100%. It ping-pongs until you stop it. */
export const POWER_SWEEP = 0.85;
/** Seconds for the tempo bar to fall 100% → 0. The mark is EMPTY: stop it on nothing. */
export const TEMPO_SWEEP = 0.80;
/** How far past empty the tempo bar runs before the shot fires itself as a duck hook. */
export const TEMPO_FLOOR = -0.30;
/** Half-width of the pure-strike window around empty (~160 ms of the sweep). The caddie doubles it. */
export const PURE_WINDOW = 0.10;
/** Above this the swing is a lunge: the club face opens and the ball leaks right. */
export const SMASH_LIMIT = 0.93;
/** How far past the pure window a full miss is. Wide on purpose: a duff must not end the round. */
export const MISS_SPREAD = 0.34;

export function pureWindow(bag: Bag): number { return PURE_WINDOW * (bag.caddie ? 2.1 : 1); }

export interface SwingInput {
  bag: Bag;
  clubId: ClubId;
  lie: Lie;
  /** 0..1, where the power bar was stopped. */
  power: number;
  /** Where the tempo bar was stopped. Zero is pure; positive is early (a push), negative a hook. */
  tempo: number;
  /**
   * Overrides the club's full-power distance, in metres. Putting uses it: a fixed 37 m putter turns
   * a three-metre tap-in into an eight-percent stab at the bar, which is unplayable with ONE button.
   * Scaling the putter to the putt in front of you is what every golf game since Leaderboard does.
   */
  reachM?: number;
}

export interface SwingResult {
  /** Carry in game UNITS, before any roll. */
  carryU: number;
  /** Units of run the ball is carrying into the landing, on a dormant fairway at altitude. */
  runU: number;
  launch: number;
  /** Radians off the aim line. Positive slices right. */
  sideAngle: number;
  /** 'pure' when the tempo landed inside the window — worth a callout. */
  pure: boolean;
  /** Fraction of the dispersion cone actually used, 0..1, for the shot commentary. */
  missFraction: number;
}

/** Resolve one swing. Everything the ball needs, and nothing about where the ball is. */
export function resolveSwing(input: SwingInput): SwingResult {
  const { bag, clubId, lie } = input;
  const power = Math.min(1, Math.max(0.12, input.power));
  const window = pureWindow(bag);
  const miss = Math.abs(input.tempo) <= window ? 0 : (Math.abs(input.tempo) - window) / MISS_SPREAD;
  const signed = Math.sign(input.tempo || 1) * Math.min(1, miss);
  // Lunging past the smash limit opens the face: real, and it gives the one-button swing a top end
  // worth being scared of without needing a second meter.
  const lunge = Math.max(0, power - SMASH_LIMIT) / (1 - SMASH_LIMIT);
  const fraction = Math.max(-1, Math.min(1, signed + lunge * 0.45));
  const carryM = (input.reachM ?? clubCarryM(bag, clubId)) * power * lieCarry(lie);
  const carryU = carryM / METRES_PER_UNIT;
  return {
    carryU,
    runU: clubId === 'putter' ? 0 : carryU * CLUB_RUN[clubId] * ALTITUDE_ROLL,
    launch: club(clubId).launch,
    sideAngle: fraction * club(clubId).side * sideFactor(bag, clubId) * lieSide(lie),
    pure: miss === 0 && lunge === 0,
    missFraction: Math.abs(fraction),
  };
}

// ---- ball flight ---------------------------------------------------------------------------------

/**
 * How much of its own carry a club releases on a dormant fairway. This is where "delete the waiting"
 * meets the Highveld: less spin means more run, but the run is BUDGETED from the carry rather than
 * emerging from a bounce chain, so a drive can never trundle 300 m into the next suburb.
 */
export const CLUB_RUN: Record<ClubId, number> = { driver: 0.17, wood: 0.15, iron: 0.11, short: 0.07, wedge: 0.03, putter: 1 };

/** Fraction of the budgeted run a surface actually gives back. A watered green checks the ball up. */
export const RUN_FRACTION: Record<Lie, number> = { fairway: 1, tee: 1, green: 0.42, rough: 0.22, bunker: 0.02, out: 0.6 };

/** Rolling deceleration by surface, u/s². Scaled to the same compressed clock as GRAVITY. */
export const ROLL_DECEL: Record<Lie, number> = { fairway: 20, tee: 20, green: 20, rough: 44, bunker: 200, out: 30 };

export interface Ball {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** On the deck and slowing down rather than in the air. */
  rolling: boolean;
  atRest: boolean;
  /** Seconds since the strike — the shot is time-capped so it can never hold the round open. */
  age: number;
  /** Highest point reached, for the hole-in-one test and the shot summary. */
  apexY: number;
  /** Units of run this ball has left in it when it lands, before the surface takes its cut. */
  run: number;
}

/** Initial ball speed that carries `carryU` at `launch` over level ground under GRAVITY. */
export function launchSpeed(carryU: number, launch: number): number {
  return Math.sqrt((Math.max(0, carryU) * GRAVITY) / Math.max(0.02, Math.sin(2 * launch)));
}

/** Speed a rolling ball needs to travel `distance` units before friction stops it. */
export function rollSpeed(distance: number, lie: Lie): number {
  return Math.sqrt(2 * ROLL_DECEL[lie] * Math.max(0, distance));
}

export function strike(from: { x: number; y: number; z: number }, heading: number, result: SwingResult): Ball {
  const aim = heading + result.sideAngle;
  const base: Ball = {
    x: from.x, y: from.y + 0.12, z: from.z, vx: 0, vy: 0, vz: 0,
    rolling: false, atRest: false, age: 0, apexY: from.y, run: result.runU,
  };
  if (result.launch < 0.02) {
    // The putter never leaves the deck: the "carry" IS the roll.
    const speed = rollSpeed(result.carryU, 'green');
    return { ...base, y: from.y, rolling: true, vx: Math.sin(aim) * speed, vz: Math.cos(aim) * speed };
  }
  const speed = launchSpeed(result.carryU, result.launch);
  const horizontal = Math.cos(result.launch) * speed;
  return { ...base, vx: Math.sin(aim) * horizontal, vy: Math.sin(result.launch) * speed, vz: Math.cos(aim) * horizontal };
}

export interface BallWorld {
  groundAt(x: number, z: number): number;
  lieAt(x: number, z: number): Lie;
}

/** Hard ceiling on a single shot. Nothing about golf may make the player wait. */
export const MAX_SHOT_SECONDS = 7;

/**
 * One physics substep. Flight is drag-free — arcade, and it makes `launchSpeed` exact. On touchdown
 * the ball converts its budgeted run into a roll on whatever it landed on, and from then on the
 * TERRAIN does the rest: slope is sampled from the ground itself, which is why putts break and why
 * a drive into the Braamfontein Spruit valley keeps going.
 */
export function stepBall(ball: Ball, dt: number, world: BallWorld): void {
  if (ball.atRest) return;
  ball.age += dt;
  if (!ball.rolling) {
    ball.vy -= GRAVITY * dt;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt; ball.z += ball.vz * dt;
    if (ball.y > ball.apexY) ball.apexY = ball.y;
    const under = world.groundAt(ball.x, ball.z);
    if (ball.y <= under) {
      const lie = world.lieAt(ball.x, ball.z);
      ball.y = under; ball.vy = 0; ball.rolling = true;
      const speed = Math.hypot(ball.vx, ball.vz);
      const wanted = rollSpeed(ball.run * RUN_FRACTION[lie], lie);
      const scale = speed > 1e-4 ? wanted / speed : 0;
      ball.vx *= scale; ball.vz *= scale;
      if (wanted < 0.45) { ball.vx = 0; ball.vz = 0; ball.atRest = true; }
    }
    if (ball.age > MAX_SHOT_SECONDS) { ball.y = Math.max(ball.y, world.groundAt(ball.x, ball.z)); ball.atRest = true; }
    return;
  }
  const lie = world.lieAt(ball.x, ball.z);
  const speed = Math.hypot(ball.vx, ball.vz);
  const kept = speed > 1e-4 ? Math.max(0, speed - ROLL_DECEL[lie] * dt) / speed : 0;
  ball.vx *= kept; ball.vz *= kept;
  // Slope, straight off the drawn terrain: gravity down the fall line.
  const slopeX = (world.groundAt(ball.x + 1.5, ball.z) - world.groundAt(ball.x - 1.5, ball.z)) / 3;
  const slopeZ = (world.groundAt(ball.x, ball.z + 1.5) - world.groundAt(ball.x, ball.z - 1.5)) / 3;
  ball.vx -= slopeX * GRAVITY * dt; ball.vz -= slopeZ * GRAVITY * dt;
  ball.x += ball.vx * dt; ball.z += ball.vz * dt;
  ball.y = world.groundAt(ball.x, ball.z);
  if (Math.hypot(ball.vx, ball.vz) < 0.45 || ball.age > MAX_SHOT_SECONDS) { ball.vx = 0; ball.vz = 0; ball.atRest = true; }
}

// ---- the card --------------------------------------------------------------------------------

/** How generous the concede is ON THE GREEN. A three-hole round must never become a putting drill —
 *  but the concede does not reach off the putting surface, or approach shots start holing themselves. */
export function gimmeRadius(bag: Bag): number { return bag.putter ? 2.4 : 1.6; }

/** Full-power roll for a putt of this length. Stop the bar around three-quarters and it drops. */
export const PUTT_SCALE = 1.35;
export function puttReachM(distanceM: number): number { return Math.max(4, distanceM * PUTT_SCALE); }

export function scoreName(strokes: number, par: number): string {
  const delta = strokes - par;
  if (strokes === 1) return 'HOLE IN ONE';
  if (delta <= -3) return 'ALBATROSS';
  if (delta === -2) return 'EAGLE';
  if (delta === -1) return 'BIRDIE';
  if (delta === 0) return 'PAR';
  if (delta === 1) return 'BOGEY';
  if (delta === 2) return 'DOUBLE BOGEY';
  return `+${delta}`;
}

/** Rand paid at the green, immediately, every hole. Never nothing: the reward test applies. */
export function holeSkin(strokes: number, par: number): number {
  const delta = strokes - par;
  if (strokes === 1) return 2000;
  if (delta <= -2) return 500;
  if (delta === -1) return 220;
  if (delta === 0) return 90;
  if (delta === 1) return 25;
  return 0;
}

/** Signing the card. A first-ever round and a new course record both pay. */
export function cardBonus(strokes: number, best: number | null): { amount: number; record: boolean } {
  const record = best === null || strokes < best;
  return { amount: 150 + (record ? 600 : 0), record };
}

export const relativeToPar = (strokes: number, par: number): string =>
  strokes === par ? 'E' : strokes > par ? `+${strokes - par}` : `${strokes - par}`;
