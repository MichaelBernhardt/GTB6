/**
 * Three holes of municipal golf and a container pro shop, at whichever course the landuse layer
 * says is closest to the CBD without a freeway through it.
 *
 * LAZY BY CONSTRUCTION. Nothing in this directory is imported statically from anywhere: the only
 * reference is registry.ts's `load()`. The eager half of golf is src/features/golf.state.ts — the
 * save slice, its sanitizer and a bbox test — imported here with `import type` ONLY.
 *
 * The round is deliberately three holes and under four minutes. Owner canon: patience is a resource
 * to spend carefully; short, easy, generous, celebrated. So every hole pays a skin the moment the
 * putt drops, eight strokes is the most a hole can ever cost you, and the ball-hunters hand your
 * ball back over the fence for twenty rand instead of a penalty stroke.
 */
import * as THREE from 'three';
import type { FeatureGameApi, FeatureHudEntry, FeatureMenuRow, FeatureSystem, InteractionDescriptor } from '../types';
import type { GolfGearId, GolfState } from '../golf.state';
import { CourseScene } from './build';
import {
  chooseCourse, courseName, dropZone, lieAt, pointInPolygon, rankCourses, routeCourse,
  type CourseLayout, type Hole, type Lie,
} from './layout';
import {
  CADDIE_FEE, GEAR, HUNTER_TIP, SLEEVE_BALLS, SLEEVE_PRICE, gearItem, greenFee, laybyBalance,
  laybyDeposit, settleLayby, toBag,
} from './shop';
import {
  MAX_SHOT_SECONDS, POWER_SWEEP, SMASH_LIMIT, TEMPO_FLOOR, TEMPO_SWEEP, cardBonus, clubReachM, gimmeRadius,
  holeSkin, pickClub, playsLikeM, puttReachM, relativeToPar, resolveSwing, scoreName, stepBall, strike,
  club as clubById, type Ball, type Bag, type ClubId,
} from './swing';
import { METRES_PER_UNIT } from '../../world/mapData';

type Phase = 'ready' | 'power' | 'tempo' | 'flight' | 'holed' | 'signed';

interface Round {
  holeIndex: number;
  strokes: number;
  scores: number[];
  phase: Phase;
  meter: number;
  meterDir: 1 | -1;
  power: number;
  caddie: boolean;
  clubId: ClubId;
  lie: Lie;
  /** Straight-line metres to the pin. */
  toPinM: number;
  /** What it PLAYS at, once the climb or the drop is priced in. */
  playsM: number;
  ballAt: THREE.Vector3;
  flight?: Ball;
  /** Rand won this round, before the lay-by cut. */
  gross: number;
  /** Green fee the marshal let you walk in on. Comes off the winnings. */
  feeOwing: number;
  elapsed: number;
}

const SUB_STEP = 1 / 120;
/** Game units → metres. South African cards are metred; the code is unit-denominated. */
const metres = (units: number): number => units * METRES_PER_UNIT;
/** Seconds of human input a stroke costs: settle, aim, three taps. Used to cost a machine round. */
const SWING_SECONDS = 4;
/** The cup itself, in units (~0.75 m). Generous against a real 108 mm hole, tight enough that an
 *  approach shot holing out stays the once-a-week story it should be. */
const HOLE_RADIUS = 0.55;

export function createFeature(api: FeatureGameApi, saved: unknown): FeatureSystem {
  const state: GolfState = normalise(saved);
  const polygon = chooseCourse();
  let layout: CourseLayout | undefined;
  let scene: CourseScene | undefined;
  const fixtures: Array<() => void> = [];
  let round: Round | undefined;
  let pendingCaddie = false;
  let disposed = false;
  /** QA only: overrides the player's facing so a machine playthrough can aim at the flag. */
  let aimOverride: number | undefined;

  // ---- setup ------------------------------------------------------------------------------------

  function ensureCourse(): CourseLayout | undefined {
    if (!polygon || disposed) return undefined;
    if (!layout) layout = routeCourse(polygon, (x, z) => api.surfaceHeightAt(x, z));
    if (!scene) {
      scene = new CourseScene(layout, (x, z) => api.surfaceHeightAt(x, z));
      api.scene.add(scene.group);
      spawnStaff(layout);
    }
    return layout;
  }

  function spawnStaff(built: CourseLayout): void {
    const behindCounter = {
      x: built.clubhouse.x - Math.sin(built.clubhouseHeading) * 1.5,
      z: built.clubhouse.z - Math.cos(built.clubhouseHeading) * 1.5,
    };
    const pro = api.spawnFixture(behindCounter.x, behindCounter.z, 'Club pro');
    if (pro) fixtures.push(() => api.removeFixture(pro));
    const firstTee = built.holes[0]?.tee;
    if (firstTee) {
      const caddie = api.spawnFixture(firstTee.x + 3.4, firstTee.z + 2.6, 'Caddie');
      if (caddie) fixtures.push(() => api.removeFixture(caddie));
    }
  }

  function distanceToCourse(): number {
    if (!polygon) return Infinity;
    const at = api.playerPosition();
    return Math.hypot(at.x - polygon.cx, at.z - polygon.cz);
  }

  function onChosenCourse(margin = 26): boolean {
    if (!polygon) return false;
    const at = api.playerPosition();
    if (at.x < polygon.minX - margin || at.x > polygon.maxX + margin) return false;
    if (at.z < polygon.minZ - margin || at.z > polygon.maxZ + margin) return false;
    return pointInPolygon(polygon, at.x, at.z) || (layout !== undefined && Math.hypot(at.x - layout.clubhouse.x, at.z - layout.clubhouse.z) < 30);
  }

  /** A golf polygon that is NOT the playable one. Every one of these is a private club. */
  function privateClubHere(): string | undefined {
    const at = api.playerPosition();
    for (const candidate of rankCourses()) {
      const ring = candidate.polygon;
      if (ring === polygon) continue;
      if (at.x < ring.minX || at.x > ring.maxX || at.z < ring.minZ || at.z > ring.maxZ) continue;
      if (pointInPolygon(ring, at.x, at.z)) return courseName(ring);
    }
    return undefined;
  }

  function bag(): Bag { return toBag(state, round?.caddie ?? pendingCaddie); }
  function hole(): Hole | undefined { return round && layout ? layout.holes[round.holeIndex] : undefined; }
  /** Reads `round` through a call so control-flow narrowing cannot go stale across press()/fire(). */
  function liveRound(): Round | undefined { return round; }
  function aimHeading(): number { return aimOverride ?? api.playerHeading(); }

  /**
   * The only way a feature can reposition the player. Game.featureApi hands back the LIVE vector
   * (`playerPosition: () => this.player.group.position`), and golf needs it: making you walk 300 m
   * to your own drive is exactly the patience the owner told us not to spend. See honestGaps —
   * `api.placePlayer(x, z, heading)` is the seam that should exist.
   */
  function movePlayerTo(x: number, z: number): void {
    api.playerPosition().set(x, api.surfaceHeightAt(x, z) + 0.05, z);
  }

  // ---- the round ----------------------------------------------------------------------------------

  function startRound(): void {
    const built = ensureCourse();
    const first = built?.holes[0];
    if (!built || !first) { api.notify('Course closed', 'Nothing in the landuse layer is big enough to route three holes on.', false); return; }
    const fee = greenFee(state);
    const paid = api.spend(fee);
    round = {
      holeIndex: 0, strokes: 0, scores: [], phase: 'ready', meter: 0, meterDir: 1, power: 0,
      caddie: pendingCaddie, clubId: 'driver', lie: 'tee', toPinM: 0, playsM: 0,
      ballAt: new THREE.Vector3(first.tee.x, api.surfaceHeightAt(first.tee.x, first.tee.z), first.tee.z),
      gross: 0, feeOwing: paid ? 0 : fee, elapsed: 0,
    };
    pendingCaddie = false;
    movePlayerTo(first.tee.x, first.tee.z);
    placeForShot();
    api.closeMenu();
    api.analytics('round_started', { value: fee });
    if (!paid) api.notify('Settle at the turn', `Short at the boom, so the marshal waves you through. R${fee} comes off your winnings.`);
    api.notify(
      `${built.name} · ${built.holes.length} holes`,
      `Par ${built.parTotal}. Hold RIGHT MOUSE to aim at the flag, then E three times: start, power, tempo.`,
      true,
    );
  }

  /** Anything this close to the pin is the putting surface, green collar included. Without the
   *  collar the picker hands you a wedge from a metre off the fringe, which is nonsense golf. */
  function puttableFrom(current: Hole, x: number, z: number): boolean {
    return Math.hypot(current.pin.x - x, current.pin.z - z) <= current.greenR + 3.5;
  }

  /** Read the lie, hand over a club, and stand the player behind the ball on the line to the pin. */
  function placeForShot(): void {
    const current = hole(); if (!round || !current || !layout) return;
    const toPin = Math.hypot(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z);
    const rise = api.surfaceHeightAt(current.pin.x, current.pin.z) - api.surfaceHeightAt(round.ballAt.x, round.ballAt.z);
    round.toPinM = metres(toPin);
    round.playsM = playsLikeM(round.toPinM, metres(rise));
    round.lie = puttableFrom(current, round.ballAt.x, round.ballAt.z) ? 'green' : lieAt(layout, current, round.ballAt.x, round.ballAt.z);
    round.clubId = pickClub(bag(), round.playsM, round.lie);
    const at = api.playerPosition();
    if (Math.hypot(at.x - round.ballAt.x, at.z - round.ballAt.z) > 5.5) {
      const bearing = Math.atan2(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z);
      movePlayerTo(round.ballAt.x - Math.sin(bearing) * 3.4, round.ballAt.z - Math.cos(bearing) * 3.4);
    }
    round.phase = 'ready'; round.meter = 0; round.meterDir = 1;
    if (scene) { scene.ball.visible = true; scene.ball.position.set(round.ballAt.x, round.ballAt.y + 0.22, round.ballAt.z); }
  }

  /** One press of E. The whole swing is this function three times — it has to work on a phone. */
  function press(): void {
    if (!round) return;
    if (round.phase === 'ready') { round.phase = 'power'; round.meter = 0; round.meterDir = 1; return; }
    if (round.phase === 'power') { round.power = Math.min(1, Math.max(0.12, round.meter)); round.phase = 'tempo'; round.meter = 1; return; }
    if (round.phase === 'tempo') { fire(round.meter); return; }
    if (round.phase === 'flight') { runOutShot(); }
  }

  function fire(tempo: number): void {
    const current = hole(); if (!round || !current || !layout) return;
    round.strokes += 1;
    const result = resolveSwing({
      bag: bag(), clubId: round.clubId, lie: round.lie, power: round.power, tempo,
      reachM: round.clubId === 'putter' ? puttReachM(round.playsM) : undefined,
    });
    round.flight = strike(
      { x: round.ballAt.x, y: api.surfaceHeightAt(round.ballAt.x, round.ballAt.z), z: round.ballAt.z },
      aimHeading(), result,
    );
    round.phase = 'flight';
    if (scene) { scene.ball.visible = true; scene.aim.visible = false; scene.targetRing.visible = false; }
    if (result.pure) api.notify('Flushed it', `${clubById(round.clubId).name} · ${Math.round(metres(result.carryU))} m of carry at 1,753 m above the sea.`, true);
    else if (result.missFraction > 0.6) api.notify('Vier!', result.sideAngle > 0 ? 'Blocked right. Someone on the next fairway is ducking.' : 'Snap hook into the blue gums.', false);
  }

  function ballWorld(current: Hole): { groundAt: (x: number, z: number) => number; lieAt: (x: number, z: number) => Lie } {
    const built = layout!;
    return { groundAt: (x, z) => api.surfaceHeightAt(x, z), lieAt: (x, z) => lieAt(built, current, x, z) };
  }

  /** Fast-forward the rest of the shot — the `E  Skip the flight` rung and the QA driver both use
   *  it. Returns the seconds the ball WOULD have been live, so the driver can cost the round. */
  function runOutShot(): number {
    const current = hole(); if (!round?.flight || !current) return 0;
    const world = ballWorld(current);
    const already = round.flight.age;
    let guard = 0;
    while (!round.flight.atRest && guard++ < 4000) stepBall(round.flight, SUB_STEP, world);
    round.flight.atRest = true;
    const seconds = round.flight.age;
    round.elapsed += seconds - already; // the world clock still spent the shot, skipped or watched
    settleShot();
    return seconds;
  }

  /** The ball has stopped. Work out where that leaves you. */
  function settleShot(): void {
    const current = hole(); if (!round?.flight || !current || !layout) return;
    const ball = round.flight;
    round.flight = undefined;
    round.ballAt.set(ball.x, api.surfaceHeightAt(ball.x, ball.z), ball.z);
    scene?.flush(ball.x, ball.z, 16);

    if (!pointInPolygon(layout.polygon, round.ballAt.x, round.ballAt.z)) {
      const drop = dropZone(layout.polygon, current, round.ballAt.x, round.ballAt.z);
      round.ballAt.set(drop.x, api.surfaceHeightAt(drop.x, drop.z), drop.z);
      if (api.spend(HUNTER_TIP)) api.notify('Over the fence', `A ball-hunter walks it back for R${HUNTER_TIP}. No penalty — play on.`);
      else { round.strokes += 1; api.notify('Lost ball', 'Nobody found it and you had nothing to tip with. One stroke.', false); }
    }

    const toPin = Math.hypot(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z);
    // The concede only reaches on the putting surface: it saves you the three-footers without
    // holing your approach shots for you. Everything else has to actually go in.
    const conceded = round.strokes > 1 && puttableFrom(current, round.ballAt.x, round.ballAt.z);
    if (toPin <= (conceded ? gimmeRadius(bag()) : HOLE_RADIUS)) { holeOut(); return; }
    if (round.strokes >= 8) { api.notify('Pick it up', 'Your caddie has seen enough. Take an eight and walk to the next tee.', false); holeOut(8); return; }
    placeForShot();
  }

  function holeOut(forced?: number): void {
    const current = hole(); if (!round || !current) return;
    const strokes = forced ?? round.strokes;
    round.scores.push(strokes);
    const skin = holeSkin(strokes, current.par);
    round.gross += skin;
    if (skin > 0) api.earn(skin);
    round.phase = 'holed';
    if (scene) { scene.ball.visible = false; scene.aim.visible = false; scene.targetRing.visible = false; }
    api.analytics('hole_out', { detail: scoreName(strokes, current.par).toLowerCase(), value: strokes });
    api.notify(
      scoreName(strokes, current.par),
      skin > 0 ? `Hole ${current.number} in ${strokes}. R${skin} in your pocket.` : `Hole ${current.number} in ${strokes}. No skin — but no damage either.`,
      strokes <= current.par,
    );
  }

  function nextHole(): void {
    if (!round || !layout) return;
    if (round.holeIndex + 1 >= layout.holes.length) { signCard(); return; }
    round.holeIndex += 1;
    round.strokes = 0;
    const next = layout.holes[round.holeIndex]!;
    round.ballAt.set(next.tee.x, api.surfaceHeightAt(next.tee.x, next.tee.z), next.tee.z);
    placeForShot();
    api.notify(
      `Hole ${next.number} · Par ${next.par}`,
      `${Math.round(next.lengthM)} m${next.dropU > 6 ? ', straight downhill' : next.dropU < -6 ? ', all uphill to the clubhouse' : ''}.`,
    );
  }

  function signCard(): void {
    if (!round || !layout) return;
    const total = round.scores.reduce((sum, value) => sum + value, 0);
    const bonus = cardBonus(total, state.best);
    round.gross += bonus.amount;
    api.earn(bonus.amount);
    if (round.feeOwing > 0) { api.spend(Math.min(round.feeOwing, api.balance())); }
    const settled = settleLayby(state, round.gross);
    if (settled.paid > 0) api.spend(Math.min(settled.paid, api.balance()));
    if (state.balls > 0) state.balls -= 1;
    state.rounds += 1;
    if (bonus.record) state.best = total;
    round.phase = 'signed';
    if (scene) { scene.ball.visible = false; scene.aim.visible = false; scene.targetRing.visible = false; }
    api.analytics('round_banked', { value: total, detail: relativeToPar(total, layout.parTotal) });
    const minutes = Math.floor(round.elapsed / 60);
    const seconds = Math.round(round.elapsed % 60);
    api.notify(
      bonus.record ? 'NEW COURSE RECORD' : 'Card signed',
      `${total} strokes, ${relativeToPar(total, layout.parTotal)} against par ${layout.parTotal}. R${round.gross} for the round in ${minutes}:${String(seconds).padStart(2, '0')}.`,
      true,
    );
    if (settled.cleared) api.notify('Lay-by settled', 'The pro tears up the card. It is yours outright.', true);
    else if (settled.paid > 0) api.notify('Lay-by', `R${settled.paid} off the book, R${state.layby?.owing ?? 0} still owing.`);
    api.persist();
  }

  function abandon(reason: string): void {
    if (!round) return;
    round = undefined;
    if (scene) { scene.ball.visible = false; scene.aim.visible = false; scene.targetRing.visible = false; }
    api.notify('Round abandoned', reason, false);
  }

  // ---- the pro shop -------------------------------------------------------------------------------

  function openShop(): void {
    const built = ensureCourse();
    const rows: FeatureMenuRow[] = [];
    if (round) {
      rows.push({ id: 'resume', label: 'Back out to the round', detail: `Hole ${hole()?.number ?? 1}, ${round.strokes} strokes played`, note: 'PLAY' });
      rows.push({ id: 'abandon', label: 'Walk in', detail: 'Give it up. The green fee stays with the club.', note: 'QUIT' });
    } else {
      rows.push({
        id: 'play', label: `Play ${built?.holes.length ?? 3} holes`, price: greenFee(state),
        detail: `Municipal twilight rate, par ${built?.parTotal ?? 11}. The board says visitors R960 and affiliated R595; nobody here pays that.${state.owned.includes('shirt') ? '' : ' Includes the R150 hire-shirt levy.'}`,
      });
    }
    const caddieOn = round?.caddie ?? pendingCaddie;
    rows.push({
      id: 'caddie', label: 'A caddie for the round', price: caddieOn ? undefined : CADDIE_FEE,
      note: caddieOn ? 'ON THE BAG' : undefined, disabled: caddieOn,
      detail: 'Twenty-two years on this course. Reads the break, calls the club, and doubles the size of your tempo window.',
    });
    rows.push({
      id: 'sleeve', label: 'Sleeve of 3 Pro V1x', price: SLEEVE_PRICE,
      detail: `About R85 a ball, which is why the fence line is full of ball-hunters. +6 m of carry and a tighter spread while they last. You have ${state.balls}.`,
    });
    for (const item of GEAR) {
      const owned = state.owned.includes(item.id);
      rows.push({ id: `buy:${item.id}`, label: item.label, price: owned ? undefined : item.price, note: owned ? 'IN THE BAG' : undefined, disabled: owned, detail: item.detail });
      if (!owned && item.layby && !state.layby) {
        rows.push({
          id: `layby:${item.id}`, label: '↳ Lay-by, 30% down', price: laybyDeposit(item),
          detail: `In your bag today. R${laybyBalance(item)} comes off your winnings at 40% a round, no interest, no clock.`,
        });
      }
    }
    if (state.layby) {
      const item = gearItem(state.layby.item);
      rows.push({ id: 'layby-status', label: `Lay-by: ${item?.label ?? state.layby.item}`, note: `R${state.layby.owing} OWING`, disabled: true, detail: 'Forty percent of every round goes here until it clears.' });
    }
    api.showMenu({
      featureId: 'golf',
      eyebrow: `${(built?.name ?? 'GOLF').toUpperCase()} · PRO SHOP`,
      title: state.best === null ? 'First time out?' : `Best card ${state.best} · ${state.rounds} round${state.rounds === 1 ? '' : 's'}`,
      blurb: 'The council leases this ground for two rand a year and the water restrictions mean they water the greens and nothing else. The fairways run like a runway.',
      balance: api.balance(), rows, leaveLabel: 'Back to the course',
    });
  }

  function buy(id: GolfGearId): void {
    const item = gearItem(id);
    if (!item || state.owned.includes(id)) { openShop(); return; }
    if (!api.spend(item.price)) { api.notify('Short', `The ${item.label.toLowerCase()} is R${item.price}. Come back with it.`, false); openShop(); return; }
    state.owned.push(id);
    api.analytics('gear_bought', { detail: id, value: item.price });
    api.notify('In the bag', `${item.label}. ${item.detail}`, true);
    api.persist();
    openShop();
  }

  function takeLayby(id: GolfGearId): void {
    const item = gearItem(id);
    if (!item || !item.layby || state.layby || state.owned.includes(id)) { openShop(); return; }
    const deposit = laybyDeposit(item);
    if (!api.spend(deposit)) { api.notify('Short', `Even the deposit is R${deposit}.`, false); openShop(); return; }
    state.owned.push(id);
    state.layby = { item: id, owing: laybyBalance(item) };
    api.analytics('layby_opened', { detail: id, value: laybyBalance(item) });
    api.notify('Lay-by opened', `${item.label} goes in the bag today. R${laybyBalance(item)} owing, 40% off every round.`, true);
    api.persist();
    openShop();
  }

  // ---- interactions ---------------------------------------------------------------------------------

  const rungs: InteractionDescriptor[] = [
    {
      id: 'golf:swing', order: 40, context: 'foot',
      test: () => {
        const current = hole(); if (!round || !current) return undefined;
        if (round.phase === 'flight') return { prompt: 'E  Skip the flight', act: press };
        if (round.phase === 'holed') {
          const last = round.holeIndex + 1 >= (layout?.holes.length ?? 3);
          return { prompt: last ? 'E  Sign your card' : 'E  Walk to the next tee', act: nextHole };
        }
        if (round.phase === 'signed') return { prompt: 'E  Back to the pro shop', act: () => { round = undefined; openShop(); } };
        if (round.phase === 'power') return { prompt: 'E  Set the power', act: press };
        if (round.phase === 'tempo') return { prompt: 'E  Stop the bar on empty', act: press };
        const plays = Math.abs(round.playsM - round.toPinM) > 8 ? ` · plays ${Math.round(round.playsM)}` : '';
        return { prompt: `E  Swing · ${clubById(round.clubId).name} · ${Math.round(round.toPinM)} m${plays}`, act: press };
      },
    },
    {
      id: 'golf:shop', order: 50, context: 'foot',
      test: () => {
        if (!layout || round) return undefined;
        const at = api.playerPosition();
        return Math.hypot(at.x - layout.clubhouse.x, at.z - layout.clubhouse.z) < 8
          ? { prompt: 'E  Browse the pro shop', act: openShop } : undefined;
      },
    },
    {
      id: 'golf:desk', order: 54, context: 'foot',
      test: () => (round || !polygon || !onChosenCourse() ? undefined
        : { prompt: `E  ${courseName(polygon)} · R${greenFee(state)}`, act: openShop }),
    },
    {
      id: 'golf:private', order: 56, context: 'foot',
      test: () => {
        if (round) return undefined;
        const club = privateClubHere(); if (!club) return undefined;
        return {
          prompt: 'E  Try the gate',
          act: () => api.notify(`${club}: members only`, polygon
            ? `The boom stays down. ${courseName(polygon)} takes walk-ins — it is the one the council still owns.`
            : 'The boom stays down and the marshal does not look up.', false),
        };
      },
    },
  ];

  // ---- frame -----------------------------------------------------------------------------------------

  function tickSwing(dt: number): void {
    const current = hole(); if (!round || !current) return;
    round.elapsed += dt;
    if (round.phase === 'power') {
      round.meter += round.meterDir * (dt / POWER_SWEEP);
      if (round.meter >= 1) { round.meter = 1; round.meterDir = -1; }
      else if (round.meter <= 0) { round.meter = 0; round.meterDir = 1; }
      return;
    }
    if (round.phase === 'tempo') {
      round.meter -= dt / TEMPO_SWEEP;
      if (round.meter <= TEMPO_FLOOR) fire(TEMPO_FLOOR);
      return;
    }
    if (round.phase === 'flight' && round.flight) {
      const world = ballWorld(current);
      let remaining = dt;
      while (remaining > 0 && !round.flight.atRest) { stepBall(round.flight, Math.min(SUB_STEP, remaining), world); remaining -= SUB_STEP; }
      if (scene && round.flight) scene.ball.position.set(round.flight.x, round.flight.y + 0.2, round.flight.z);
      if (round.flight.atRest || round.flight.age > MAX_SHOT_SECONDS) settleShot();
    }
  }

  function drawAids(): void {
    const current = hole();
    if (!scene) return;
    const aiming = Boolean(round && current && (round.phase === 'ready' || round.phase === 'power' || round.phase === 'tempo'));
    scene.aim.visible = aiming;
    scene.targetRing.visible = aiming;
    if (!aiming || !round || !current) return;
    const heading = aimHeading();
    const y = round.ballAt.y + 0.4;
    const reach = Math.min(70, Math.max(18, Math.hypot(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z) * 0.8));
    const points = scene.aim.geometry.getAttribute('position') as THREE.BufferAttribute;
    points.setXYZ(0, round.ballAt.x, y, round.ballAt.z);
    points.setXYZ(1, round.ballAt.x + Math.sin(heading) * reach, y + reach * 0.05, round.ballAt.z + Math.cos(heading) * reach);
    points.needsUpdate = true;
    scene.aim.geometry.computeBoundingSphere();
    scene.targetRing.position.set(current.pin.x, api.surfaceHeightAt(current.pin.x, current.pin.z) + 0.45, current.pin.z);
  }

  // ---- HUD ------------------------------------------------------------------------------------------

  function hud(): FeatureHudEntry[] {
    const current = hole();
    if (!round || !current || !layout) {
      return layout && onChosenCourse(140) ? [{ id: 'golf:here', label: 'GOLF', value: `3 HOLES · R${greenFee(state)}` }] : [];
    }
    const done = round.scores.reduce((sum, value) => sum + value, 0);
    const parDone = layout.holes.slice(0, round.scores.length).reduce((sum, entry) => sum + entry.par, 0);
    const entries: FeatureHudEntry[] = [
      { id: 'golf:hole', label: `H${current.number}`, value: `PAR ${current.par} · ${Math.round(current.lengthM)}m` },
    ];
    if (round.phase === 'power' || round.phase === 'tempo') {
      entries.push({
        id: 'golf:meter', label: round.phase === 'power' ? 'POWER' : 'TEMPO',
        value: round.phase === 'tempo' ? `${Math.round(round.power * 100)}%` : undefined,
        fill: Math.round(Math.max(0, Math.min(1, round.meter)) * 100),
        warn: round.meter < 0,
      });
    } else if (round.phase === 'ready') {
      const bearing = Math.atan2(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z);
      const off = Math.abs(Math.atan2(Math.sin(aimHeading() - bearing), Math.cos(aimHeading() - bearing))) * (180 / Math.PI);
      const plays = Math.abs(round.playsM - round.toPinM) > 8 ? ` · PLAYS ${Math.round(round.playsM)}` : '';
      entries.push({ id: 'golf:club', label: clubById(round.clubId).name, value: `${Math.round(round.toPinM)}m${plays} · ${round.lie.toUpperCase()}` });
      entries.push({ id: 'golf:aim', label: 'AIM', value: off > 12 ? `${Math.round(off)}° OFF` : 'ON LINE', fill: Math.round(Math.max(0, 100 - off * 2.2)), warn: off > 25 });
    }
    const played = done + round.strokes;
    const parSoFar = parDone + (round.phase === 'holed' || round.phase === 'signed' ? 0 : current.par);
    entries.push({ id: 'golf:card', label: 'CARD', value: played === 0 ? 'E' : `${played} · ${relativeToPar(played, parSoFar)}` });
    if (round.caddie) entries.push({ id: 'golf:caddie', label: 'CADDIE', value: 'READING IT' });
    entries.push({ id: 'golf:alt', label: 'ALT', value: '+10%' });
    return entries;
  }

  // ---- machine playthrough -----------------------------------------------------------------------------

  /** Total distance this club covers at full power from this lie, carry plus run, in metres. */
  function fullReach(clubId: ClubId, lie: Lie): number {
    return Math.max(1, clubReachM(bag(), clubId, lie));
  }

  /**
   * Drives the REAL swing, flight, out-of-bounds, scoring and payout path. Only the two things a
   * human supplies are synthesized: where the meter stops, and where the player is aiming.
   */
  function machineRound(maxPower: number, tempoMiss = 1 / (TEMPO_SWEEP * 60)): string {
    const built = ensureCourse(); if (!built) return 'stuck:no-course';
    round = undefined;
    startRound();
    let guard = 0;
    let ballSeconds = 0;
    let strokes = 0;
    for (;;) {
      const active = liveRound();
      if (!active) return 'stuck:round-vanished';
      if (active.phase === 'signed') {
        aimOverride = undefined;
        const total = active.scores.reduce((sum, value) => sum + value, 0);
        // Modelled wall clock: every second the ball was live, plus SWING_SECONDS of human input
        // per stroke (aim, then three taps). This is the number the four-minute budget is judged on.
        const budget = ballSeconds + strokes * SWING_SECONDS;
        return `ok:strokes=${total} par=${built.parTotal} holes=${active.scores.join('/')} earned=R${active.gross} ballSeconds=${ballSeconds.toFixed(1)} roundSeconds=${budget.toFixed(0)} best=${state.best}`;
      }
      if (guard++ > 400) { aimOverride = undefined; return `stuck:phase-${active.phase}-after-${guard}-steps`; }
      const current = hole(); if (!current) { aimOverride = undefined; return 'stuck:no-hole'; }
      if (active.phase === 'holed') { nextHole(); continue; }
      if (active.phase === 'flight') { ballSeconds += runOutShot(); continue; }
      if (active.phase !== 'ready') { aimOverride = undefined; return `stuck:unexpected-phase-${active.phase}`; }
      aimOverride = Math.atan2(current.pin.x - active.ballAt.x, current.pin.z - active.ballAt.z);
      const toPin = active.playsM;
      strokes += 1;
      press();                                                    // start the backswing
      const reach = active.clubId === 'putter' ? puttReachM(toPin) : fullReach(active.clubId, active.lie);
      // Quantise to a frame: a human can only stop the bar on a rendered frame, so a driver is
      // always a couple of metres out. Without this the machine plays a perfection nobody can.
      const frame = 1 / (POWER_SWEEP * 60);
      const wanted = Math.min(maxPower, Math.max(0.15, toPin / reach));
      active.meter = Math.round(wanted / frame) * frame;
      press();                                                    // set the power
      active.meter = tempoMiss;                                   // where this driver stops the tempo bar
      press();                                                    // strike
    }
  }

  // ---- assembly ------------------------------------------------------------------------------------------

  if (!polygon) api.notify('No course', 'Nothing in the landuse layer is big enough for three holes.', false);
  else if (onChosenCourse(400)) {
    ensureCourse();
    api.notify(courseName(polygon), `Three holes for R${greenFee(state)}. The pro shop is the green container by the boom.`, true);
  }

  return {
    update: (dt) => {
      if (disposed) return;
      if (!layout && distanceToCourse() < 900) ensureCourse();
      scene?.update(dt);
      if (!round) return;
      tickSwing(dt);
      drawAids();
      if (round.phase === 'signed') return; // the card is already banked; wander off if you like
      const at = api.playerPosition();
      if (Math.hypot(at.x - round.ballAt.x, at.z - round.ballAt.z) > 260) abandon('You walked off the course. The card does not count.');
    },
    hud,
    interactions: () => rungs,
    serialize: () => ({
      best: state.best, rounds: state.rounds, owned: [...state.owned], balls: state.balls,
      layby: state.layby ? { ...state.layby } : null,
    }),
    restore: (next) => {
      const fresh = normalise(next);
      state.best = fresh.best; state.rounds = fresh.rounds; state.balls = fresh.balls;
      state.owned = fresh.owned; state.layby = fresh.layby;
      round = undefined; pendingCaddie = false;
    },
    menu: (actionId) => {
      if (actionId === 'play') { startRound(); return; }
      if (actionId === 'resume') { api.closeMenu(); return; }
      if (actionId === 'abandon') { api.closeMenu(); abandon('You walked in at the turn.'); return; }
      if (actionId === 'caddie') {
        if (!api.spend(CADDIE_FEE)) { api.notify('Short', `A caddie is R${CADDIE_FEE} for the round.`, false); openShop(); return; }
        if (round) round.caddie = true; else pendingCaddie = true;
        api.analytics('caddie_hired', { value: CADDIE_FEE });
        api.notify('On the bag', 'They take the driver out of your hands and hand you the 3-wood. They are right.', true);
        openShop(); return;
      }
      if (actionId === 'sleeve') {
        if (!api.spend(SLEEVE_PRICE)) { api.notify('Short', `A sleeve is R${SLEEVE_PRICE}.`, false); openShop(); return; }
        state.balls += SLEEVE_BALLS;
        api.persist();
        api.notify('Pro V1x', 'Three in the sleeve. Try not to donate them to the fence line.', true);
        openShop(); return;
      }
      if (actionId.startsWith('buy:')) { buy(actionId.slice(4) as GolfGearId); return; }
      if (actionId.startsWith('layby:')) { takeLayby(actionId.slice(6) as GolfGearId); return; }
    },
    command: (args) => {
      const [verb, value] = args;
      if (!verb || verb === 'where') {
        const built = ensureCourse();
        if (!built) return ['No playable golf course in this map.'];
        return [
          `${built.name} — par ${built.parTotal}, clubhouse (${Math.round(built.clubhouse.x)}, ${Math.round(built.clubhouse.z)}) off ${built.gateRoad}.`,
          ...built.holes.map((entry) => `  H${entry.number} par ${entry.par} · ${Math.round(entry.lengthM)} m · drop ${entry.dropU.toFixed(1)}u · tee (${Math.round(entry.tee.x)}, ${Math.round(entry.tee.z)}) → pin (${Math.round(entry.pin.x)}, ${Math.round(entry.pin.z)})`),
          `Bag: ${state.owned.length ? state.owned.join(', ') : 'hire set'} · balls ${state.balls} · best ${state.best ?? '—'} · rounds ${state.rounds}`,
        ];
      }
      if (verb === 'rank') return rankCourses().map((entry) => `${entry.blocked ? 'BLOCKED' : 'playable'} ${entry.score.toFixed(1).padStart(6)} ${Math.round(entry.polygon.area)}u² d${Math.round(entry.distanceToCbd)} ${entry.polygon.name}`);
      if (verb === 'tee') { startRound(); return [round ? 'Teed off.' : 'Could not start a round.']; }
      if (verb === 'shop') { openShop(); return ['Pro shop open.']; }
      if (verb === 'give' && value) {
        const item = gearItem(value as GolfGearId);
        if (!item) return [`Unknown gear: ${value}. Try ${GEAR.map((entry) => entry.id).join(', ')}.`];
        if (!state.owned.includes(item.id)) state.owned.push(item.id);
        return [`${item.label} in the bag.`];
      }
      if (verb === 'qa') return [machineRound(SMASH_LIMIT)];
      return ['feature golf [where|rank|tee|shop|give <gear>|qa]'];
    },
    qa: (action, args) => {
      if (action === 'course') {
        const built = ensureCourse();
        return built
          ? `ok:course=${built.name} par=${built.parTotal} holes=${built.holes.map((entry) => Math.round(entry.lengthM)).join('/')}m clubhouse=${Math.round(built.clubhouse.x)},${Math.round(built.clubhouse.z)}`
          : 'stuck:no-course';
      }
      if (action === 'shop') {
        const before = api.balance();
        buy('glove');
        api.closeMenu();
        return state.owned.includes('glove') ? `ok:glove spent=${before - api.balance()} balance=${api.balance()}` : `stuck:glove-not-bought balance=${before}`;
      }
      return machineRound(
        typeof args.power === 'number' ? args.power : SMASH_LIMIT,
        typeof args.tempo === 'number' ? args.tempo : undefined,
      );
    },
    dispose: () => {
      disposed = true;
      round = undefined;
      for (const remove of fixtures) { try { remove(); } catch { /* already recycled */ } }
      fixtures.length = 0;
      if (scene) { api.scene.remove(scene.group); scene.dispose(); scene = undefined; }
      layout = undefined;
    },
  };
}

function normalise(raw: unknown): GolfState {
  const source = (raw ?? {}) as Partial<GolfState>;
  return {
    best: typeof source.best === 'number' ? source.best : null,
    rounds: typeof source.rounds === 'number' ? source.rounds : 0,
    owned: Array.isArray(source.owned) ? [...source.owned] : [],
    balls: typeof source.balls === 'number' ? source.balls : 0,
    layby: source.layby ? { ...source.layby } : null,
  };
}
