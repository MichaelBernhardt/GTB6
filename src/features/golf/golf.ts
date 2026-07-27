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
 *
 * TWO THINGS THE FIRST PLAYTEST BROKE, and how they are answered here:
 *
 *  1. THERE WAS NO WAY OUT. Once a round started every rung of the golf ladder was the swing, so E
 *     could only ever be the next click of a swing — the player was held by the feature until the
 *     card was signed. Now: step off your ball (WALK_IN_RADIUS) and E stops meaning "swing" and
 *     starts meaning "walk in", which opens a two-row menu — back to your ball, or end the round
 *     here — that says on screen exactly what walking in costs. Backing off mid-meter cancels the
 *     swing instead of leaving the bar spinning, and nothing ever drags you back to a ball you
 *     deliberately walked away from. The prompt and the HUD both carry it; it is not a secret key.
 *
 *  2. AIMING WAS INHERITED FROM THE GAME'S AIM VERB and it did not work. See aimHeading(): the
 *     shot now goes straight at the flag, always, and the only aim aid left is a ring on the grass
 *     showing where THIS shot finishes. Aim stopped being a thing you do.
 *
 * A FEATURE ONLY GETS ONE KEY. FeatureGameApi hands a feature the E ladder, a menu and the player's
 * position — no second binding, no input seam — so "walk off the ball" is the only quit gesture
 * that works on a keyboard and a phone at once. See honestGaps: the foundation wants either a
 * second key on InteractionDescriptor or an api.openMenu() a feature can raise on its own.
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
  /** What the boom charged for this round, kept so walking in can price itself on screen. */
  fee: number;
  /** Green fee the marshal let you walk in on. Comes off the winnings. */
  feeOwing: number;
  elapsed: number;
  /** The player has walked off their ball and means it: nothing may drag them back. */
  walkedOff: boolean;
}

const SUB_STEP = 1 / 120;
/** Game units → metres. South African cards are metred; the code is unit-denominated. */
const metres = (units: number): number => units * METRES_PER_UNIT;
/** Seconds of human input a stroke costs: settle, aim, three taps. Used to cost a machine round. */
const SWING_SECONDS = 4;
/** The cup itself, in units (~0.75 m). Generous against a real 108 mm hole, tight enough that an
 *  approach shot holing out stays the once-a-week story it should be. */
const HOLE_RADIUS = 0.55;
/**
 * Step this far off your ball (~9.5 m) and E stops meaning "swing" and starts meaning "walk in".
 * Further than a shuffle round the ball, close enough that one second of walking reaches it. This
 * is the ONLY quit gesture a feature can offer that works identically on a keyboard and a phone:
 * a feature owns exactly one key and the touch pills are built from the prompt string.
 */
const WALK_IN_RADIUS = 7;
/** Tail every in-round prompt carries, so the way out is on screen at the moment of being stuck. */
const QUIT_TAIL = ' · STEP BACK TO QUIT';

export function createFeature(api: FeatureGameApi, saved: unknown): FeatureSystem {
  const state: GolfState = normalise(saved);
  const polygon = chooseCourse();
  let layout: CourseLayout | undefined;
  let scene: CourseScene | undefined;
  const fixtures: Array<() => void> = [];
  let round: Round | undefined;
  let pendingCaddie = false;
  let disposed = false;
  /** QA only: radians of aim error a machine driver injects to model a human who is NOT dead on the
   *  flag. Zero in the shipped game — see aimHeading — and non-zero only in the sensitivity runs. */
  let aimError = 0;

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

  /**
   * Where the shot goes: STRAIGHT AT THE FLAG, always.
   *
   * This used to be `api.playerHeading()` — the game's own aim verb, "hold right mouse and look".
   * The owner could not work out what to do with it, and the in-engine trace says why: Player.update
   * only turns the body when `input.aiming && weapon !== 'fists'`, so anyone who walked onto the
   * course bare-handed could not turn the shot AT ALL, and mouse-look alone never moves the body.
   * Every ball left the club at whatever bearing the body happened to be frozen at — the verifier's
   * keyboard-only round teed off 30° off line, reached 111° off, and posted the worst card the
   * eight-stroke cap allows. Aim was never a decision, only a tax.
   *
   * So golf aims itself. The meters are the game; the ring on the grass is the only aid left.
   */
  function aimHeading(): number {
    const current = hole();
    if (!round || !current) return api.playerHeading();
    return Math.atan2(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z) + aimError;
  }

  /** How far the player has wandered from their ball — with E and the menu, the whole of the input
   *  vocabulary a feature is given. */
  function distanceFromBall(): number {
    const active = round; if (!active) return 0;
    const at = api.playerPosition();
    return Math.hypot(at.x - active.ballAt.x, at.z - active.ballAt.z);
  }

  /** True while the player is standing off their ball: E means "walk in", not "swing". */
  function steppedBack(): boolean {
    const active = round;
    return Boolean(active) && active!.phase !== 'signed' && distanceFromBall() > WALK_IN_RADIUS;
  }

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
      gross: 0, fee, feeOwing: paid ? 0 : fee, elapsed: 0, walkedOff: false,
    };
    pendingCaddie = false;
    placeForShot();   // stands you BEHIND the ball on the line to the flag, not on top of it
    api.closeMenu();
    api.analytics('round_started', { value: fee });
    if (!paid) api.notify('Settle at the turn', `Short at the boom, so the marshal waves you through. R${fee} comes off your winnings.`);
    api.notify(
      `${built.name} · ${built.holes.length} holes`,
      `Par ${built.parTotal}. It aims itself at the flag: E starts the swing, E stops the ring on the pin, E stops the tempo bar on empty. Step off your ball any time and E walks you in.`,
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
    // Walking you to your own drive is the whole reason golf teleports at all — but never against
    // your will: a player who has deliberately stepped off the ball is on their way to the gate.
    if (!round.walkedOff) walkToBall();
    round.phase = 'ready'; round.meter = 0; round.meterDir = 1;
    if (scene) { scene.ball.visible = true; scene.ball.position.set(round.ballAt.x, round.ballAt.y + 0.22, round.ballAt.z); }
  }

  /** Stand the player behind their ball, on the line to the pin, close enough that E swings again. */
  function walkToBall(): void {
    const current = hole(); if (!round || !current) return;
    const at = api.playerPosition();
    if (Math.hypot(at.x - round.ballAt.x, at.z - round.ballAt.z) <= 5.5) return;
    const bearing = Math.atan2(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z);
    movePlayerTo(round.ballAt.x - Math.sin(bearing) * 3.4, round.ballAt.z - Math.cos(bearing) * 3.4);
    round.walkedOff = false;
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
    // Walk up to the cup with the ball. Without this the player is left standing back at their last
    // shot while the hole is 130 m away, which reads to the walk-in rung as having left the round.
    round.ballAt.set(current.pin.x, api.surfaceHeightAt(current.pin.x, current.pin.z), current.pin.z);
    if (!round.walkedOff) {
      const bearing = Math.atan2(current.pin.x - current.tee.x, current.pin.z - current.tee.z);
      movePlayerTo(current.pin.x - Math.sin(bearing) * 2.6, current.pin.z - Math.cos(bearing) * 2.6);
    }
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

  /**
   * The way out, and the only one there is. Never silent: what the round cost, what you keep and
   * what happens to the card all go on screen in the same breath as the round ending.
   *
   * The deal, decided here and stated there:
   *  - every skin you already won at a green is YOURS — it was paid at the hole, not at the card;
   *  - no card bonus, no course record, and the round does not go on your record;
   *  - the green fee stays with the club once you have hit a shot, and comes straight back if you
   *    have not — walking off the first tee cannot cost you money;
   *  - a fee you were waved through on is settled if you can cover it, written off if you cannot;
   *  - a caddie you have already paid for stays hired for the next round rather than evaporating.
   */
  function walkIn(headline: string, alarming = false): void {
    const active = round; if (!active) return;
    const played = active.scores.reduce((sum, value) => sum + value, 0) + active.strokes;
    const kept = active.gross;
    let feeLine: string;
    if (played === 0) {
      const back = active.fee - active.feeOwing;
      if (back > 0) api.earn(back);
      feeLine = back > 0 ? `Your R${back} green fee comes straight back — you never hit a shot.` : 'You owe the club nothing.';
    } else if (active.feeOwing > 0) {
      const settled = Math.min(active.feeOwing, api.balance());
      if (settled > 0) api.spend(settled);
      feeLine = settled > 0 ? `R${settled} settles the green fee they waved you through on.` : 'The marshal writes off the green fee you never paid.';
    } else {
      feeLine = `The R${active.fee} green fee stays with the club.`;
    }
    const holesDone = active.scores.length;
    // A caddie you paid R235 for is not spent by a round you did not finish: he waits at the gate
    // and goes back on the bag next time. Losing him to a walk-in is exactly the silent charge the
    // owner told us not to make.
    const caddieHeld = active.caddie;
    if (caddieHeld) pendingCaddie = true;
    round = undefined;
    if (scene) { scene.ball.visible = false; scene.aim.visible = false; scene.targetRing.visible = false; }
    api.analytics('round_walked_in', { value: played, detail: `hole-${Math.min(holesDone + 1, 3)}` });
    api.notify(
      'Walked in',
      `${headline} ${holesDone} hole${holesDone === 1 ? '' : 's'} in the book, no card and no bonus. ${feeLine}${kept > 0 ? ` The R${kept} you won at the greens is yours.` : ''}${caddieHeld ? ' Tebogo waits at the gate — still on your bag next round.' : ''}`,
      !alarming, // choosing to leave is not a failure; being dragged out by the 260 m rule is a warning
    );
  }

  /** The two-row menu the walk-in prompt opens. Reversible on purpose: stepping off your ball must
   *  not be able to end a round by accident, and the row that ends it has to price itself first. */
  function openRoundMenu(): void {
    const active = round; if (!active) { openShop(); return; }
    const played = active.scores.reduce((sum, value) => sum + value, 0) + active.strokes;
    const back = played === 0 ? active.fee - active.feeOwing : 0;
    api.showMenu({
      featureId: 'golf',
      eyebrow: `${(layout?.name ?? 'GOLF').toUpperCase()} · HOLE ${hole()?.number ?? 1}`,
      title: 'Walk in, or play on?',
      blurb: 'Nobody is holding you here. The bakkie is at the gate whenever you want it.',
      balance: api.balance(),
      rows: [
        {
          id: 'resume', label: 'Back to your ball', note: 'PLAY ON',
          detail: `Hole ${hole()?.number ?? 1}, ${played} stroke${played === 1 ? '' : 's'} played${active.gross > 0 ? `, R${active.gross} won so far` : ''}. You get walked back to your ball.`,
        },
        {
          id: 'walkin', label: 'Walk in — end the round here', note: 'QUIT',
          detail: back > 0
            ? `You have not hit a shot, so your R${back} green fee comes straight back. No card, no bonus, nothing on your record.`
            : `${active.gross > 0 ? `The R${active.gross} you won at the greens stays yours. ` : ''}No card, no bonus, nothing on your record${active.feeOwing > 0 ? `, and R${active.feeOwing} of green fee to settle` : `, and the R${active.fee} green fee stays with the club`}.`,
        },
      ],
      leaveLabel: 'Never mind',
    });
  }

  // ---- the pro shop -------------------------------------------------------------------------------

  function openShop(): void {
    const built = ensureCourse();
    const rows: FeatureMenuRow[] = [];
    if (round) {
      rows.push({ id: 'resume', label: 'Back to your ball', detail: `Hole ${hole()?.number ?? 1}, ${round.strokes} strokes played on it`, note: 'PLAY ON' });
      rows.push({ id: 'walkin', label: 'Walk in — end the round here', detail: `Skins already won stay yours. No card, no bonus${round.gross > 0 ? `, R${round.gross} in your pocket` : ''}.`, note: 'QUIT' });
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
      // ABOVE the swing: the moment you step off your ball, E is the way out. This is the rung the
      // first playtest was missing entirely — there was no state in which E meant anything but
      // "next click of this swing", so a round could only end by being finished.
      id: 'golf:walkin', order: 38, context: 'foot',
      test: () => (steppedBack() ? { prompt: 'E  Walk in · quit the round', act: openRoundMenu } : undefined),
    },
    {
      id: 'golf:swing', order: 40, context: 'foot',
      test: () => {
        const current = hole(); if (!round || !current) return undefined;
        if (round.phase === 'flight') return { prompt: `E  Skip the flight${QUIT_TAIL}`, act: press };
        if (round.phase === 'holed') {
          const last = round.holeIndex + 1 >= (layout?.holes.length ?? 3);
          return { prompt: `${last ? 'E  Sign your card' : 'E  Walk to the next tee'}${QUIT_TAIL}`, act: nextHole };
        }
        if (round.phase === 'signed') return { prompt: 'E  Back to the pro shop', act: () => { round = undefined; openShop(); } };
        if (round.phase === 'power') return { prompt: 'E  Stop the ring on the flag', act: press };
        if (round.phase === 'tempo') return { prompt: 'E  Stop the bar on empty', act: press };
        const plays = Math.abs(round.playsM - round.toPinM) > 8 ? ` · plays ${Math.round(round.playsM)}` : '';
        return { prompt: `E  Swing · ${clubById(round.clubId).name} · ${Math.round(round.toPinM)} m${plays}${QUIT_TAIL}`, act: press };
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
    // Walking away mid-meter used to leave the power bar ping-ponging forever with E owned by a
    // swing you had already left. Backing off the ball is what a golfer does; it costs no stroke.
    if ((round.phase === 'power' || round.phase === 'tempo') && steppedBack()) {
      round.phase = 'ready'; round.meter = 0; round.meterDir = 1; round.power = 0;
      api.notify('Backed off the ball', 'No stroke played. Step back up to it, or E walks you in.');
      return;
    }
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

  /** What this club, off this lie, at this much of the bar, PLAYS to — in metres, the same number
   *  the club picker and the machine driver both work in. */
  function shotPlaysM(power: number): number {
    if (!round) return 0;
    const full = round.clubId === 'putter' ? puttReachM(round.playsM) : clubReachM(bag(), round.clubId, round.lie);
    return full * Math.min(1, Math.max(0.12, power));
  }

  /**
   * How far down the aim line that shot actually FINISHES, in units. Inverts playsLikeM against the
   * real ground by fixed point — six height samples, cheap enough to run every frame — so the ring
   * sits where the ball stops on a hole that drops 27 m, not where a flat-earth number would put it.
   */
  function previewDistanceU(playsM: number): number {
    const active = round; if (!active) return 0;
    const dirX = Math.sin(aimHeading()); const dirZ = Math.cos(aimHeading());
    const fromY = api.surfaceHeightAt(active.ballAt.x, active.ballAt.z);
    let guess = playsM / METRES_PER_UNIT;
    for (let i = 0; i < 6; i++) {
      const rise = metres(api.surfaceHeightAt(active.ballAt.x + dirX * guess, active.ballAt.z + dirZ * guess) - fromY);
      guess = guess * 0.35 + (Math.max(playsM * 0.35, playsM - rise) / METRES_PER_UNIT) * 0.65;
    }
    return Math.max(2, guess);
  }

  /**
   * The whole aim aid, and the whole of what replaced "hold right mouse and look": a line along the
   * grass to a ring where THIS shot finishes. During the power sweep the ring slides, so setting the
   * power is visibly "stop the ring on the flag" instead of a percentage nobody can convert into
   * metres. The line follows the ground rather than floating, because a floating line over a valley
   * points at the sky.
   */
  function drawAids(): void {
    const current = hole();
    if (!scene) return;
    const aiming = Boolean(round && current && (round.phase === 'ready' || round.phase === 'power' || round.phase === 'tempo'));
    scene.aim.visible = aiming;
    scene.targetRing.visible = aiming;
    if (!aiming || !round || !current) return;
    const heading = aimHeading();
    // At address the ring sits ON THE FLAG: that is the answer to "where am I aiming". The moment
    // the bar starts it becomes the live distance instead — the same ring, now answering "how far".
    const addressing = round.phase === 'ready';
    const reachU = addressing
      ? Math.hypot(current.pin.x - round.ballAt.x, current.pin.z - round.ballAt.z)
      : previewDistanceU(shotPlaysM(round.phase === 'power' ? round.meter : round.power));
    const points = scene.aim.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < points.count; i++) {
      const along = (i / (points.count - 1)) * reachU;
      const x = round.ballAt.x + Math.sin(heading) * along;
      const z = round.ballAt.z + Math.cos(heading) * along;
      points.setXYZ(i, x, api.surfaceHeightAt(x, z) + 0.5, z);
    }
    points.needsUpdate = true;
    scene.aim.geometry.computeBoundingSphere();
    const ringX = round.ballAt.x + Math.sin(heading) * reachU;
    const ringZ = round.ballAt.z + Math.cos(heading) * reachU;
    scene.targetRing.position.set(ringX, api.surfaceHeightAt(ringX, ringZ) + 0.45, ringZ);
    scene.setAimTone(!addressing && Math.hypot(current.pin.x - ringX, current.pin.z - ringZ) <= current.greenR);
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
      // Metres, not a percentage: the number under the bar is the number on the ring out on the
      // grass, so the two aids teach each other.
      const playing = Math.round(shotPlaysM(round.phase === 'power' ? round.meter : round.power));
      entries.push({
        id: 'golf:meter', label: round.phase === 'power' ? 'POWER' : 'TEMPO',
        value: `${playing}m`,
        fill: Math.round(Math.max(0, Math.min(1, round.meter)) * 100),
        warn: round.meter < 0,
      });
    } else if (round.phase === 'ready') {
      const plays = Math.abs(round.playsM - round.toPinM) > 8 ? ` · PLAYS ${Math.round(round.playsM)}` : '';
      entries.push({ id: 'golf:club', label: clubById(round.clubId).name, value: `${Math.round(round.toPinM)}m${plays} · ${round.lie.toUpperCase()}` });
    }
    // Once a hole is holed out its strokes are already in `scores`; adding the live counter as well
    // showed a finished 7-stroke round as CARD 10 (caught in an end-of-round screenshot).
    const settled = round.phase === 'holed' || round.phase === 'signed';
    const played = done + (settled ? 0 : round.strokes);
    const parSoFar = parDone + (settled ? 0 : current.par);
    entries.push({ id: 'golf:card', label: 'CARD', value: played === 0 ? 'E' : `${played} · ${relativeToPar(played, parSoFar)}` });
    if (round.caddie) entries.push({ id: 'golf:caddie', label: 'CADDIE', value: 'READING IT' });
    // The way out, on screen for every frame of every phase of every round. A player who has already
    // stepped back gets told what E does right now instead of what it would do.
    if (round.phase !== 'signed') entries.push({ id: 'golf:quit', label: 'QUIT', value: steppedBack() ? 'PRESS E' : 'STEP BACK' });
    return entries;
  }

  // ---- machine playthrough -----------------------------------------------------------------------------

  /** Total distance this club covers at full power from this lie, carry plus run, in metres. */
  function fullReach(clubId: ClubId, lie: Lie): number {
    return Math.max(1, clubReachM(bag(), clubId, lie));
  }

  /**
   * How a driver plays. The default is the old PERFECT driver — every number in this feature was
   * tuned against it, which the first playtest exposed as a lie: it stops both bars on the exact
   * frame it wants and it always aimed dead at the flag, and a keyboard round scored the worst card
   * the cap allows. `human()` below is the profile the round is now tuned against.
   */
  interface Driver {
    /** Cap on the power the driver ever asks for. */
    maxPower: number;
    /** Radians of aim error, 1σ. ZERO for the shipped game: golf aims itself now, so the aim error
     *  a player can commit is exactly nil. Non-zero only in the sensitivity runs. */
    aimSigma: number;
    /** Fraction of the power bar this driver misses its intended stop by, 1σ. */
    powerSigma: number;
    /** Where the tempo bar is stopped, 1σ, in bar units — 0.10 is the whole pure window. */
    tempoSigma: number;
    /** Systematic lateness on the tempo bar: eyes see the mark, thumb arrives after it. */
    tempoBias: number;
    /** Chance per shot of a complete mistime — the hadeda screamed, the phone rang. */
    fluffChance: number;
    seed: number;
  }

  const FRAME = 1 / 60;

  /** The old PERFECT driver: dead on the flag, both bars stopped on the frame it wanted. Kept
   *  because several regressions are written against it — never again as the tuning authority. */
  function perfect(maxPower = SMASH_LIMIT, tempoMiss = FRAME / TEMPO_SWEEP): Driver {
    return { maxPower, aimSigma: 0, powerSigma: 0, tempoSigma: 0, tempoBias: tempoMiss, fluffChance: 0, seed: 1 };
  }

  /**
   * A HUMAN-PLAUSIBLE golfer, and the profile every number in this feature is now tuned against.
   *
   * Aim error: 0°, because there is no longer any aiming to be wrong at — the shot goes at the flag
   * and the player's only job is the two bars. (`feature golf human 1 6` re-runs the whole round
   * with 6° of aim error to prove the round survives it anyway.)
   *
   * Timing error: a person stopping a moving bar lands within about 70 ms of where they meant to,
   * with a systematic ~40 ms of lateness on top, and blows it completely about one shot in twenty.
   * Those milliseconds are converted into bar units by each bar's own sweep, so re-timing a bar
   * automatically re-tunes the difficulty instead of silently invalidating it.
   */
  function human(seed: number, aimDegrees = 0): Driver {
    return {
      maxPower: SMASH_LIMIT,
      aimSigma: (aimDegrees * Math.PI) / 180,
      powerSigma: 0.07 / POWER_SWEEP,     // 70 ms of a bar that sweeps 0→1 in POWER_SWEEP seconds
      tempoSigma: 0.07 / TEMPO_SWEEP,
      tempoBias: -0.04 / TEMPO_SWEEP,     // 40 ms late: the bar has already passed empty
      fluffChance: 0.05,
      seed,
    };
  }

  /**
   * Drives the REAL swing, flight, out-of-bounds, scoring and payout path. Only what a human
   * supplies is synthesized: where each bar stops, and (for the sensitivity runs) how far off the
   * flag the shot is pointed.
   */
  function machineRound(profile: Driver): string {
    const built = ensureCourse(); if (!built) return 'stuck:no-course';
    round = undefined;
    let bits = profile.seed >>> 0 || 1;
    /** mulberry32 — a seeded round is a reproducible round, so a tuning number can be re-checked. */
    const random = (): number => {
      bits = (bits + 0x6d2b79f5) >>> 0;
      let t = Math.imul(bits ^ (bits >>> 15), 1 | bits);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = (): number => (random() + random() + random() + random() - 2) * 1.1; // ~N(0,1)
    startRound();
    let guard = 0;
    let ballSeconds = 0;
    let strokes = 0;
    const done = (verdict: string): string => { aimError = 0; return verdict; };
    for (;;) {
      const active = liveRound();
      if (!active) return done('stuck:round-vanished');
      if (active.phase === 'signed') {
        const total = active.scores.reduce((sum, value) => sum + value, 0);
        // Modelled wall clock: every second the ball was live, plus SWING_SECONDS of human input
        // per stroke (settle, then three taps). The four-minute budget is judged on this number.
        const budget = ballSeconds + strokes * SWING_SECONDS;
        return done(`ok:strokes=${total} par=${built.parTotal} holes=${active.scores.join('/')} earned=R${active.gross} ballSeconds=${ballSeconds.toFixed(1)} roundSeconds=${budget.toFixed(0)} best=${state.best}`);
      }
      if (guard++ > 400) return done(`stuck:phase-${active.phase}-after-${guard}-steps`);
      const current = hole(); if (!current) return done('stuck:no-hole');
      if (active.phase === 'holed') { nextHole(); continue; }
      if (active.phase === 'flight') { ballSeconds += runOutShot(); continue; }
      if (active.phase !== 'ready') return done(`stuck:unexpected-phase-${active.phase}`);
      aimError = gauss() * profile.aimSigma;
      const toPin = active.playsM;
      strokes += 1;
      press();                                                    // start the backswing
      const reach = active.clubId === 'putter' ? puttReachM(toPin) : fullReach(active.clubId, active.lie);
      // Quantise to a frame: nobody can stop a bar between two rendered frames.
      const wanted = Math.min(profile.maxPower, Math.max(0.15, toPin / reach)) + gauss() * profile.powerSigma;
      const frame = FRAME / POWER_SWEEP;
      active.meter = Math.max(0.05, Math.min(1, Math.round(wanted / frame) * frame));
      press();                                                    // stop the ring on the flag
      const fluffed = random() < profile.fluffChance;
      active.meter = fluffed
        ? (random() < 0.5 ? -1 : 1) * (0.25 + random() * 0.35)
        : profile.tempoBias + gauss() * profile.tempoSigma;
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
      const gap = distanceFromBall();
      if (round.phase === 'signed') {
        // The card is banked; walking away from a finished round just ends it, rather than leaving
        // "E  Back to the pro shop" following you across the suburb.
        if (gap > 40) round = undefined;
        return;
      }
      // Sticky, so a shot that settles 200 m away cannot silently drag a departing player back to it.
      if (gap > WALK_IN_RADIUS) round.walkedOff = true;
      else if (gap < WALK_IN_RADIUS * 0.7) round.walkedOff = false;
      if (gap > 260) walkIn('You walked off the course.', true);
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
      if (actionId === 'resume') { walkToBall(); api.closeMenu(); return; }
      // 'abandon' is the pro-shop row's old id; both land on the same accounted, announced exit.
      if (actionId === 'walkin' || actionId === 'abandon') { api.closeMenu(); walkIn('You walked in.'); return; }
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
      if (verb === 'qa') return [machineRound(perfect())];
      // `feature golf human [seed] [aim°]` — the round as a person plays it. This is the driver the
      // difficulty is tuned against; `qa` is the old perfect one, kept only as a ceiling.
      if (verb === 'human') return [machineRound(human(Number(value) || 1, Number(args[2]) || 0))];
      return ['feature golf [where|rank|tee|shop|give <gear>|qa|human [seed] [aim°]]'];
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
      if (action === 'human') {
        const base = human(typeof args.seed === 'number' ? args.seed : 1, typeof args.aim === 'number' ? args.aim : 0);
        const number = (key: string, fallback: number): number => (typeof args[key] === 'number' ? args[key] as number : fallback);
        return machineRound({
          ...base,
          powerSigma: number('powerSigma', base.powerSigma),
          tempoSigma: number('tempoSigma', base.tempoSigma),
          fluffChance: number('fluff', base.fluffChance),
        });
      }
      return machineRound(perfect(
        typeof args.power === 'number' ? args.power : SMASH_LIMIT,
        typeof args.tempo === 'number' ? args.tempo : undefined,
      ));
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
