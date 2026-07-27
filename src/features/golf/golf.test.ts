import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { FeatureGameApi, FeatureMenuView } from '../types';
import { sanitizeGolfState, type GolfState } from '../golf.state';
import { createFeature } from './golf';
import { disc, ribbon } from './build';
import { chooseCourse, routeCourse } from './layout';
import { analyticTerrainHeightAt } from '../../world/City';
import { CADDIE_FEE, GREEN_FEE, SHIRT_LEVY, SLEEVE_PRICE, gearItem } from './shop';
import { parsePromptActions } from '../../ui/TouchModels';
import { promptKey } from '../interactions';

/**
 * The whole feature, driven through a stub FeatureGameApi. This is not a substitute for the in-engine
 * playthrough (the terrain here is a gentle analytic slope, not the real Braamfontein Spruit valley),
 * but it exercises createFeature, the interaction ladder, the menu, money, the save round-trip and
 * dispose() — the parts a screenshot cannot prove.
 */
interface Harness {
  api: FeatureGameApi;
  balance: () => number;
  menus: FeatureMenuView[];
  notes: Array<{ title: string; detail?: string }>;
  events: Array<{ event: string; value?: number; detail?: string }>;
  player: THREE.Vector3;
  heading: { value: number };
  fixtures: { live: number };
  scene: THREE.Scene;
}

/** A rolling, golf-shaped surface: enough relief that slope and lie code actually runs. */
const ground = (x: number, z: number): number => Math.sin(x / 130) * 7 + Math.cos(z / 170) * 5;

/** The REAL relief under the real course. City's drawn-grid sampler needs a built ground mesh; the
 *  analytic one it falls back to before then is the same field to within a triangle's twist. */
const realGround = (x: number, z: number): number => analyticTerrainHeightAt(x, z);

function harness(money = 5000, surface: (x: number, z: number) => number = ground): Harness {
  const scene = new THREE.Scene();
  const player = new THREE.Vector3(0, 0, 0);
  const heading = { value: 0 };
  const menus: FeatureMenuView[] = [];
  const notes: Array<{ title: string; detail?: string }> = [];
  const events: Array<{ event: string; value?: number; detail?: string }> = [];
  const fixtures = { live: 0 };
  let wallet = money;
  const api: FeatureGameApi = {
    scene,
    surfaceHeightAt: surface,
    districtAt: () => 'Parkview',
    isPark: () => true,
    nearestRoadPose: (at) => ({ position: at.clone(), heading: 0 }),
    playerPosition: () => player,
    playerHeading: () => heading.value,
    drivenVehicle: () => undefined,
    hour: () => 14,
    blackout: () => 0,
    balance: () => wallet,
    earn: (amount) => { wallet += amount; },
    spend: (amount) => { if (amount > wallet) return false; wallet -= amount; return true; },
    notify: (title, detail) => { notes.push({ title, detail }); },
    showMenu: (view) => { menus.push(view); },
    closeMenu: () => undefined,
    persist: () => undefined,
    analytics: (event, props) => { events.push({ event, ...props }); },
    spawnFixture: (_x, _z, name) => {
      fixtures.live += 1;
      return { group: new THREE.Group(), scripted: true, name } as never;
    },
    removeFixture: () => { fixtures.live -= 1; },
  };
  return { api, balance: () => wallet, menus, notes, events, player, heading, fixtures, scene };
}

function standOnCourse(h: Harness, surface: (x: number, z: number) => number = ground): void {
  const course = chooseCourse();
  if (!course) throw new Error('no playable course in the committed map');
  h.player.set(course.cx, surface(course.cx, course.cz), course.cz);
}

const promptFor = (system: ReturnType<typeof createFeature>, h: Harness): string | undefined => {
  for (const rung of (system.interactions?.() ?? []).slice().sort((a, b) => a.order - b.order)) {
    const offer = rung.test({ context: 'foot', position: h.api.playerPosition(), vehicle: undefined, hour: 14 });
    if (offer) return offer.prompt;
  }
  return undefined;
};

/** Every triangle's geometric normal, so a flipped patch cannot ship again. */
function normalsUp(geometry: THREE.BufferGeometry): boolean {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i));
    b.fromBufferAttribute(pos, index.getX(i + 1));
    c.fromBufferAttribute(pos, index.getX(i + 2));
    if (b.sub(a).cross(c.sub(a)).y <= 0) return false;
  }
  return true;
}

describe('prompt grammar', () => {
  it('every prompt golf can put on screen turns into a mobile context pill', () => {
    // interactions.test.ts only checks the eager approach; these are the prompts the LOADED feature
    // produces, and prompt/key disagreement is this repo's known shipped bug class.
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    const seen = new Set<string>();
    const sweep = (): void => {
      for (const rung of system.interactions?.() ?? []) {
        const offer = rung.test({ context: 'foot', position: h.api.playerPosition(), vehicle: undefined, hour: 14 });
        if (offer) seen.add(offer.prompt);
      }
    };
    sweep();                                   // the desk rung, standing on the course
    system.menu?.('play');
    sweep();                                   // ready
    promptOffer(system, h)!.act(); sweep();    // power
    promptOffer(system, h)!.act(); sweep();    // tempo
    promptOffer(system, h)!.act(); sweep();    // flight
    promptOffer(system, h)!.act();             // skip the flight
    for (let i = 0; i < 60; i++) { sweep(); system.update!(1 / 30); }
    system.qa!('run', {});
    sweep();
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const prompt of seen) {
      expect(promptKey(prompt), prompt).toBe('E');
      expect(parsePromptActions(prompt)[0]?.key, prompt).toBe('E');
      expect(parsePromptActions(prompt)[0]?.code, prompt).toBe('KeyE');
    }
    system.dispose();
  });
});

describe('course geometry', () => {
  it('winds every fairway, green, tee and bunker face UPWARDS', () => {
    // A down-facing ground patch is invisible under a FrontSide material and shaded from below when
    // it is not. Both the fairway strip and the ellipse shipped inverted until this test existed.
    const rolling = (x: number, z: number): number => Math.sin(x / 40) * 3 + Math.cos(z / 55) * 2;
    expect(normalsUp(ribbon({ x: 0, z: 0 }, { x: 120, z: 60 }, 14, rolling, 0.12))).toBe(true);
    expect(normalsUp(ribbon({ x: 0, z: 0 }, { x: -80, z: 200 }, 9, rolling, 0.12))).toBe(true);
    expect(normalsUp(disc(10, -20, 13, 13, 0, rolling, 0.24))).toBe(true);
    expect(normalsUp(disc(10, -20, 8, 4.5, 1.1, rolling, 0.18))).toBe(true);
  });
});

describe('golf, end to end', () => {
  it('builds the course on first entry and tears every bit of it down again', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    expect(h.scene.children.length).toBe(1);
    const group = h.scene.children[0]!;
    expect(group.name).toBe('golf-course');
    expect(group.children.length).toBeGreaterThan(20); // fairways, greens, tees, bunkers, flags, shop
    expect(h.fixtures.live).toBe(2); // the pro and Tebogo

    system.dispose();
    expect(h.scene.children.length).toBe(0);
    expect(h.fixtures.live).toBe(0);
    system.dispose(); // idempotent
    expect(h.scene.children.length).toBe(0);
    expect(h.fixtures.live).toBe(0);
  });

  it('builds nothing at all until the player is anywhere near golf', () => {
    const h = harness();
    h.player.set(9000, 0, 9000);
    const system = createFeature(h.api, undefined);
    expect(h.scene.children.length).toBe(0);
    expect(h.fixtures.live).toBe(0);
    system.update?.(0.1); // still miles away
    expect(h.scene.children.length).toBe(0);
    system.dispose();
  });

  it('offers the course from the fairway and the pro shop at the counter', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    expect(promptFor(system, h)).toMatch(/^E {2}Parkview Golf Club · R\d+$/);
    const layout = routeCourse(chooseCourse()!, ground);
    h.player.set(layout.clubhouse.x, 0, layout.clubhouse.z);
    expect(promptFor(system, h)).toBe('E  Browse the pro shop');
    system.dispose();
  });

  it('prices the round with the hire-shirt levy until you own a collar', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.command?.(['shop']);
    const before = h.menus.at(-1)!;
    expect(before.rows.find((row) => row.id === 'play')?.price).toBe(GREEN_FEE + SHIRT_LEVY);
    system.menu?.('buy:shirt');
    expect(h.balance()).toBe(5000 - gearItem('shirt')!.price);
    system.command?.(['shop']);
    expect(h.menus.at(-1)!.rows.find((row) => row.id === 'play')?.price).toBe(GREEN_FEE);
    system.dispose();
  });

  it('plays a full three-hole round through the real swing, flight and scoring path', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    const opening = h.balance();
    const verdict = system.qa!('run', {});
    console.log('machine round:', verdict, 'wallet', opening, '->', h.balance());
    expect(verdict).toMatch(/^ok:strokes=\d+/);
    const strokes = Number(/strokes=(\d+)/.exec(verdict)![1]);
    const par = Number(/par=(\d+)/.exec(verdict)![1]);
    const roundSeconds = Number(/roundSeconds=(\d+)/.exec(verdict)![1]);
    // A three-hole loop, played competently, in well under four minutes of world time.
    expect(strokes).toBeGreaterThanOrEqual(3);          // three holes, one shot each, is the floor
    expect(strokes).toBeLessThanOrEqual(par);           // a clean driver should at least make par
    expect(roundSeconds).toBeLessThan(240);
    // Generous by design: a competent round pays for itself.
    expect(h.balance()).toBeGreaterThan(opening);
    expect(h.events.map((event) => event.event)).toContain('round_banked');
    expect(h.notes.some((note) => /Card signed|COURSE RECORD/.test(note.title))).toBe(true);
    system.dispose();
  });

  it('finishes and pays out even when every single swing is a duck hook', () => {
    // The reward test, as a regression: the worst player in Johannesburg still walks off with money.
    for (const tempo of [0.26, -0.5, 0.6]) {
      const h = harness(5000, realGround);
      standOnCourse(h, realGround);
      const system = createFeature(h.api, undefined);
      const opening = h.balance();
      const verdict = system.qa!('run', { tempo });
      expect(verdict).toMatch(/^ok:strokes=\d+/);
      const strokes = Number(/strokes=(\d+)/.exec(verdict)![1]);
      const par = Number(/par=(\d+)/.exec(verdict)![1]);
      const roundSeconds = Number(/roundSeconds=(\d+)/.exec(verdict)![1]);
      expect(strokes).toBeLessThanOrEqual(par + 3);
      expect(roundSeconds).toBeLessThan(240);
      expect(h.balance()).toBeGreaterThan(opening);   // never punished for being bad at golf
      system.dispose();
    }
  });

  it('gives a lay-up merchant a slower, worse, still-profitable round than a flusher', () => {
    // The skill gradient has to be real or the swing meter is decoration.
    const play = (args: Record<string, unknown>) => {
      const h = harness(5000, realGround);
      standOnCourse(h, realGround);
      const system = createFeature(h.api, undefined);
      const opening = h.balance();
      const verdict = system.qa!('run', args);
      system.dispose();
      return { strokes: Number(/strokes=(\d+)/.exec(verdict)![1]), net: h.balance() - opening };
    };
    const flush = play({});
    const timid = play({ power: 0.45 });
    expect(flush.strokes).toBeLessThan(timid.strokes);
    expect(flush.net).toBeGreaterThan(timid.net);
    expect(timid.net).toBeGreaterThan(0);
  });

  it('plays the REAL course, on the REAL relief, inside the four-minute budget', () => {
    // Parkview sits in the Braamfontein Spruit valley — the opening hole drops 27 m and the closer
    // climbs 54 m. Clubbing off the flat number left hole 3 short over and over until the in-engine
    // playthrough hit the eight-stroke cap; this is that round, offline, as a regression.
    const h = harness(5000, realGround);
    standOnCourse(h, realGround);
    const system = createFeature(h.api, undefined);
    const layout = routeCourse(chooseCourse()!, realGround);
    const rises = layout.holes.map((hole) => realGround(hole.pin.x, hole.pin.z) - realGround(hole.tee.x, hole.tee.z));
    expect(Math.max(...rises.map(Math.abs))).toBeGreaterThan(15); // this really is hill golf
    const verdict = system.qa!('run', {});
    const strokes = Number(/strokes=(\d+)/.exec(verdict)![1]);
    const holes = /holes=([\d/]+)/.exec(verdict)![1]!.split('/').map(Number);
    const roundSeconds = Number(/roundSeconds=(\d+)/.exec(verdict)![1]);
    expect(verdict).toMatch(/^ok:/);
    expect(holes).toHaveLength(3);
    expect(Math.max(...holes)).toBeLessThan(8);      // nothing hits the pick-it-up cap
    expect(strokes).toBeLessThanOrEqual(layout.parTotal + 1);
    expect(roundSeconds).toBeLessThan(240);
    system.dispose();
  });

  it('reads the card right the moment the last putt drops', () => {
    const h = harness(5000, realGround);
    standOnCourse(h, realGround);
    const system = createFeature(h.api, undefined);
    const verdict = system.qa!('run', {});
    const strokes = Number(/strokes=(\d+)/.exec(verdict)![1]);
    const card = system.hud!()!.find((chip) => chip.id === 'golf:card')!;
    // A holed-out hole is already in `scores`; the live counter must not be added on top of it.
    expect(card.value!.startsWith(`${strokes} `)).toBe(true);
    system.dispose();
  });

  it('banks the card into the save slice and survives the sanitizer', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.qa!('run', {});
    const saved = system.serialize!() as GolfState;
    expect(saved.rounds).toBe(1);
    expect(saved.best).toBeGreaterThan(0);
    expect(sanitizeGolfState(saved)).toEqual(saved);
    system.dispose();

    // A reload hands the slice to a fresh feature, which must show it in the shop title.
    const again = harness();
    standOnCourse(again);
    const reloaded = createFeature(again.api, saved);
    reloaded.command?.(['shop']);
    expect(again.menus.at(-1)!.title).toContain(`Best card ${saved.best}`);
    reloaded.dispose();
  });

  it('only improves the best card, never worsens it', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, { best: 4, rounds: 9, owned: [], balls: 0, layby: null });
    system.qa!('run', {});
    const saved = system.serialize!() as GolfState;
    expect(saved.best).toBe(4);
    expect(saved.rounds).toBe(10);
    system.dispose();
  });

  it('sells the bag, and the bag actually changes the golf', () => {
    const h = harness(60000);
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.command?.(['shop']);
    const before = h.balance();
    system.menu?.('buy:glove');
    system.menu?.('buy:driver');
    system.menu?.('sleeve');
    expect(before - h.balance()).toBe(gearItem('glove')!.price + gearItem('driver')!.price + SLEEVE_PRICE);
    const saved = system.serialize!() as GolfState;
    expect(saved.owned).toEqual(['glove', 'driver']);
    expect(saved.balls).toBe(3);
    // The shop marks what you already own instead of selling it twice.
    system.command?.(['shop']);
    expect(h.menus.at(-1)!.rows.find((row) => row.id === 'buy:glove')).toMatchObject({ disabled: true, note: 'IN THE BAG' });
    system.dispose();
  });

  it('refuses a purchase you cannot afford without taking the money', () => {
    const h = harness(300);
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.menu?.('buy:irons');
    expect(h.balance()).toBe(300);
    expect((system.serialize!() as GolfState).owned).toEqual([]);
    expect(h.notes.at(-1)!.title).toBe('Short');
    system.dispose();
  });

  it('puts an iron set in the bag on lay-by and works the debt off the winnings', () => {
    const h = harness(6000);
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.menu?.('layby:irons');
    const irons = gearItem('irons')!;
    expect(h.balance()).toBe(6000 - Math.round(irons.price * 0.3));
    const opened = system.serialize!() as GolfState;
    expect(opened.owned).toContain('irons');
    expect(opened.layby).toEqual({ item: 'irons', owing: irons.price - Math.round(irons.price * 0.3) });
    system.qa!('run', {});
    const after = system.serialize!() as GolfState;
    expect(after.layby!.owing).toBeLessThan(opened.layby!.owing);
    system.dispose();
  });

  it('lets a broke player onto the course and takes the fee out of the winnings', () => {
    const h = harness(0);
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.menu?.('play');
    expect(h.notes.some((note) => note.title === 'Settle at the turn')).toBe(true);
    expect(promptFor(system, h)).toMatch(/^E {2}Swing · /);
    system.dispose();
  });

  it('hires the caddie before the round and carries him onto the first tee', () => {
    const h = harness(5000);
    standOnCourse(h);
    const system = createFeature(h.api, { best: null, rounds: 0, owned: ['shirt'], balls: 0, layby: null });
    system.menu?.('caddie');
    expect(h.balance()).toBe(5000 - CADDIE_FEE);
    system.menu?.('play');
    expect(system.hud!()!.some((chip) => chip.id === 'golf:caddie')).toBe(true);
    system.dispose();
  });

  it('walks the three-click swing one press at a time, in real frames', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.menu?.('play');
    const act = (): void => {
      const offer = promptOffer(system, h);
      expect(offer).toBeDefined();
      offer!.act();
    };
    expect(promptFor(system, h)).toMatch(/^E {2}Swing · /);
    act();                                                  // start the backswing
    for (let i = 0; i < 12; i++) system.update!(1 / 60);
    expect(promptFor(system, h)).toBe('E  Stop the ring on the flag');
    expect(system.hud!()!.find((chip) => chip.id === 'golf:meter')?.label).toBe('POWER');
    act();                                                  // set the power
    for (let i = 0; i < 12; i++) system.update!(1 / 60);
    expect(promptFor(system, h)).toBe('E  Stop the bar on empty');
    expect(system.hud!()!.find((chip) => chip.id === 'golf:meter')?.label).toBe('TEMPO');
    act();                                                  // strike
    expect(promptFor(system, h)).toBe(`E  Skip the flight${' · STEP BACK TO QUIT'}`);
    // Let the ball run out in real frames rather than skipping.
    for (let i = 0; i < 700 && /Skip the flight/.test(promptFor(system, h) ?? ''); i++) system.update!(1 / 60);
    expect(promptFor(system, h)).not.toMatch(/Skip the flight/);
    system.dispose();
  });

  it('never leaves the bar spinning: a swing nobody finishes fires itself', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    system.menu?.('play');
    promptOffer(system, h)!.act();  // backswing
    promptOffer(system, h)!.act();  // power
    for (let i = 0; i < 400; i++) system.update!(1 / 60);
    expect(promptFor(system, h)).not.toBe('E  Stop the bar on empty');
    system.dispose();
  });

  it('can be played to a good card off the HUD and the prompt alone', () => {
    // No qa driver, no internals: press E on the prompt, stop the ring on the flag by reading the
    // metres under the POWER bar, stop the tempo bar on empty by reading its fill. If the aids on
    // screen are not enough to play the game, this test posts a bad card.
    const h = harness(5000, realGround);
    standOnCourse(h, realGround);
    h.heading.value = 2.1; // facing the wrong way entirely, which must no longer matter
    const system = createFeature(h.api, undefined);
    const opening = h.balance();
    promptOffer(system, h)!.act();   // the desk rung opens the pro shop
    system.menu?.('play');           // …and the row pays the green fee
    playByTheHud(system, h, (prompt) => prompt === 'E  Back to the pro shop');
    const card = system.hud!()!.find((chip) => chip.id === 'golf:card')!.value!;
    const layout = routeCourse(chooseCourse()!, realGround);
    const strokes = Number(card.split(' ')[0]);
    console.log('played off the HUD alone:', card, '| wallet', opening, '->', h.balance());
    expect(strokes).toBeLessThanOrEqual(layout.parTotal);
    expect(h.balance()).toBeGreaterThan(opening);
    system.dispose();
  });

  it('aims itself at the flag no matter which way the player is facing', () => {
    // THE PLAYTEST BUG. Aim used to be api.playerHeading(), which on foot only moves when you WALK
    // or hold the aim verb with a weapon out — so a player standing still with his fists up could
    // not turn the shot at all, and the in-engine round teed off 30° off line and scored the worst
    // card the cap allows. Facing must now make no difference whatsoever to the card.
    const cards = [0, 1.2, Math.PI, -2.4].map((facing) => {
      const h = harness(5000, realGround);
      standOnCourse(h, realGround);
      h.heading.value = facing;
      const system = createFeature(h.api, undefined);
      const verdict = system.qa!('human', { seed: 7 });
      system.dispose();
      expect(verdict).toMatch(/^ok:/);
      return /holes=([\d/]+)/.exec(verdict)![1];
    });
    expect(new Set(cards).size).toBe(1);
  });

  it('plays a HUMAN round — the profile every number in here is tuned against', () => {
    // The old tuning authority was a driver with PERFECT aim and frame-exact bars, which is why the
    // shipped numbers survived a playtest that scored 24 (+13). This is the honest yardstick: a
    // person who stops each bar within ~70 ms of where they meant to, is ~40 ms late on average,
    // and blows one shot in twenty completely. Aim error is zero because golf now aims itself.
    const rounds = [];
    for (let seed = 1; seed <= 12; seed++) {
      const h = harness(5000, realGround);
      standOnCourse(h, realGround);
      const system = createFeature(h.api, undefined);
      const opening = h.balance();
      const verdict = system.qa!('human', { seed });
      expect(verdict).toMatch(/^ok:strokes=\d+/);
      rounds.push({
        strokes: Number(/strokes=(\d+)/.exec(verdict)![1]),
        par: Number(/par=(\d+)/.exec(verdict)![1]),
        holes: /holes=([\d/]+)/.exec(verdict)![1]!.split('/').map(Number),
        seconds: Number(/roundSeconds=(\d+)/.exec(verdict)![1]),
        net: h.balance() - opening,
      });
      system.dispose();
    }
    const par = rounds[0]!.par;
    const mean = rounds.reduce((sum, round) => sum + round.strokes, 0) / rounds.length;
    console.log('human rounds:', rounds.map((round) => round.holes.join('/')).join('  '), '| mean', mean.toFixed(1), 'v par', par);
    expect(mean).toBeLessThanOrEqual(par);                                   // generous, on purpose
    expect(Math.max(...rounds.map((round) => round.strokes))).toBeLessThanOrEqual(par + 2);
    expect(Math.max(...rounds.flatMap((round) => round.holes))).toBeLessThan(8); // nothing hits the cap
    expect(Math.max(...rounds.map((round) => round.seconds))).toBeLessThan(240);
    expect(Math.min(...rounds.map((round) => round.net))).toBeGreaterThan(0); // every round pays
  });

  it('still pays a first-timer who has no idea what the bars are for', () => {
    // The reward test at its floor: bars stopped essentially at random, and 15° of aim error on top
    // of an aim that cannot actually be wrong. Nobody walks off this course poorer than they came.
    for (const seed of [3, 11, 29]) {
      const h = harness(5000, realGround);
      standOnCourse(h, realGround);
      const system = createFeature(h.api, undefined);
      const opening = h.balance();
      const verdict = system.qa!('human', { seed, aim: 15, powerSigma: 0.3, tempoSigma: 0.3, fluff: 0.25 });
      expect(verdict).toMatch(/^ok:/);
      expect(Number(/roundSeconds=(\d+)/.exec(verdict)![1])).toBeLessThan(240);
      expect(h.balance()).toBeGreaterThan(opening);
      system.dispose();
    }
  });

  it('tells you a private club is a private club', () => {
    const h = harness();
    const houghton = { x: 4300, z: -1499 }; // derived name check below, not a routing coordinate
    h.player.set(houghton.x, 0, houghton.z);
    const system = createFeature(h.api, undefined);
    const prompt = promptFor(system, h);
    if (prompt === 'E  Try the gate') {
      promptOffer(system, h)!.act();
      expect(h.notes.at(-1)!.title).toMatch(/members only/);
    }
    system.dispose();
  });

  it('reports the derived course through the console, with no typed coordinates', () => {
    const h = harness();
    standOnCourse(h);
    const system = createFeature(h.api, undefined);
    const lines = system.command!([]);
    expect(lines[0]).toMatch(/par \d+, clubhouse \(-?\d+, -?\d+\) off /);
    expect(lines.filter((line) => /^ {2}H\d/.test(line))).toHaveLength(3);
    expect(system.command!(['rank']).length).toBeGreaterThanOrEqual(4);
    system.dispose();
  });
});

/**
 * THE OTHER PLAYTEST BUG: "no way to quit". Every rung of the golf ladder used to be the swing, so
 * once a round started E could only ever be the next click of a swing and the round owned the
 * player until the card was signed. These are the states he could get stuck in, each one checked
 * for a way out that returns control and prices itself on screen.
 */
describe('walking in', () => {
  /** Walk the player off their ball, in units, the way a second of holding W does. */
  const stepAway = (h: Harness, system: ReturnType<typeof createFeature>, units = 14): void => {
    const at = h.api.playerPosition();
    h.player.set(at.x + units, at.y, at.z);
    system.update!(1 / 60);
  };

  const start = (money = 5000) => {
    const h = harness(money, realGround);
    standOnCourse(h, realGround);
    const system = createFeature(h.api, undefined);
    system.menu?.('play');
    return { h, system };
  };

  it('turns E into the way out the moment you step off your ball, in every phase', () => {
    const { h, system } = start();
    const phases: string[] = [];
    // Presses 0..3 walk the round through ready → power → tempo → flight. The fifth modal state,
    // between holes, is covered by the skins test below; the sixth, a signed card, is not a trap.
    for (const advance of [0, 1, 2, 3]) {
      for (let press = 0; press < advance; press++) { promptOffer(system, h)!.act(); system.update!(1 / 60); }
      stepAway(h, system);
      const prompt = promptFor(system, h);
      phases.push(`${advance}:${prompt}`);
      expect(prompt, `after ${advance} presses`).toBe('E  Walk in · quit the round');
      expect(promptKey(prompt!)).toBe('E');
      expect(parsePromptActions(prompt!)[0]).toEqual({ key: 'E', code: 'KeyE', label: 'Walk in' });
      expect(system.hud!()!.find((chip) => chip.id === 'golf:quit')?.value).toBe('PRESS E');
      // …and back at the ball it is the swing again, with the way out still written on the prompt.
      system.menu?.('resume');
      system.update!(1 / 60);
      expect(promptFor(system, h)).toMatch(/STEP BACK TO QUIT$/);
    }
    console.log('walk-in reachable from:', phases.join(' | '));
    system.dispose();
  });

  it('opens a two-row menu that says what walking in costs before it costs it', () => {
    const { h, system } = start();
    stepAway(h, system);
    promptOffer(system, h)!.act();
    const view = h.menus.at(-1)!;
    expect(view.rows.map((row) => row.id)).toEqual(['resume', 'walkin']);
    expect(view.rows[1]!.detail).toMatch(/green fee|no card|No card/);
    // The menu is REVERSIBLE: stepping off the ball must not be able to end a round by accident.
    system.menu?.('resume');
    expect(promptFor(system, h)).toMatch(/^E {2}Swing · /);
    system.dispose();
  });

  it('hands the green fee straight back when you walk in before hitting a shot', () => {
    const { h, system } = start();
    const fee = GREEN_FEE + SHIRT_LEVY;
    expect(h.balance()).toBe(5000 - fee);
    stepAway(h, system);
    promptOffer(system, h)!.act();
    system.menu?.('walkin');
    expect(h.balance()).toBe(5000);                      // not a cent for a round you never played
    expect(h.notes.at(-1)!.title).toBe('Walked in');
    expect(h.notes.at(-1)!.detail).toMatch(/comes straight back/);
    expect(promptFor(system, h)).toMatch(/^E {2}Parkview Golf Club/); // control returned, tee it up again
    expect((system.serialize!() as GolfState).rounds).toBe(0);        // an abandoned round is not a round
    system.dispose();
  });

  it('keeps the skins you already won, and never takes money without saying so', () => {
    const { h, system } = start();
    const fee = GREEN_FEE + SHIRT_LEVY;
    // Play the first hole out reading ONLY what is on screen — the prompt for the distance, the
    // meter chip for where the ring is. If a hole cannot be played competently off the HUD alone,
    // the aids are not doing their job.
    playByTheHud(system, h, (prompt) => /next tee/.test(prompt));
    expect(promptFor(system, h)).toMatch(/next tee/);
    const afterHole = h.balance();
    expect(afterHole).toBeGreaterThan(5000 - fee);        // the skin was paid at the green
    stepAway(h, system);
    promptOffer(system, h)!.act();
    system.menu?.('walkin');
    expect(h.balance()).toBe(afterHole);                  // walking in takes nothing back off you
    const told = h.notes.at(-1)!;
    expect(told.title).toBe('Walked in');
    expect(told.detail).toMatch(/1 hole in the book/);
    expect(told.detail).toMatch(new RegExp(`R${fee} green fee stays with the club`));
    expect((system.serialize!() as GolfState).best).toBeNull(); // no card, so no course record either
    system.dispose();
  });

  it('keeps a caddie you already paid for instead of pocketing him with the round', () => {
    const h = harness(5000, realGround);
    standOnCourse(h, realGround);
    const system = createFeature(h.api, undefined);
    system.menu?.('caddie');                             // R235, hired before the round
    system.menu?.('play');
    const spent = 5000 - h.balance();
    stepAway(h, system);
    promptOffer(system, h)!.act();
    system.menu?.('walkin');
    expect(h.notes.at(-1)!.detail).toMatch(/Tebogo waits at the gate/);
    system.menu?.('play');                               // the next round, without paying twice
    expect(system.hud!()!.some((chip) => chip.id === 'golf:caddie')).toBe(true);
    expect(5000 - h.balance()).toBe(spent);              // one green fee refunded, one charged again
    system.dispose();
  });

  it('backs off a half-played swing instead of leaving the bar spinning', () => {
    const { h, system } = start();
    promptOffer(system, h)!.act();                        // backswing: the power bar is now sweeping
    expect(promptFor(system, h)).toBe('E  Stop the ring on the flag');
    stepAway(h, system);
    expect(h.notes.at(-1)!.title).toBe('Backed off the ball');
    system.menu?.('resume');
    system.update!(1 / 60);
    expect(promptFor(system, h)).toMatch(/^E {2}Swing · /);            // back to a fresh address
    expect(system.hud!()!.find((chip) => chip.id === 'golf:card')?.value).toBe('E'); // and no stroke
    system.dispose();
  });

  it('never drags a player who has walked away back to the ball', () => {
    const { h, system } = start();
    promptOffer(system, h)!.act();                        // power
    promptOffer(system, h)!.act();                        // tempo
    promptOffer(system, h)!.act();                        // strike — the ball is in the air
    stepAway(h, system, 40);
    const stood = h.player.clone();
    for (let frame = 0; frame < 600; frame++) system.update!(1 / 60); // let the shot settle
    expect(h.player.distanceTo(stood)).toBeLessThan(0.001);
    expect(promptFor(system, h)).toBe('E  Walk in · quit the round');
    system.dispose();
  });

  it('carries the way out on the HUD for every frame of every phase', () => {
    const { h, system } = start();
    for (let step = 0; step < 40; step++) {
      const chips = system.hud!()!;
      expect(chips.find((chip) => chip.id === 'golf:quit'), `step ${step}`).toBeDefined();
      expect(chips.length).toBeLessThanOrEqual(5);        // the strip is 220px wide on a phone
      promptOffer(system, h)?.act();
      for (let frame = 0; frame < 4; frame++) system.update!(1 / 60);
    }
    system.dispose();
  });

  it('lets a signed card go without an E press, instead of following you home', () => {
    const { h, system } = start();
    system.qa!('human', { seed: 5 });
    expect(promptFor(system, h)).toBe('E  Back to the pro shop');
    h.player.set(h.player.x + 120, h.player.y, h.player.z);
    system.update!(1 / 60);
    expect(promptFor(system, h)).not.toBe('E  Back to the pro shop');
    system.dispose();
  });
});

/**
 * Plays golf off the HUD and the prompt, and nothing else — no internals, no qa driver. Stops the
 * power ring on the flag by watching the metres under the POWER bar, and the tempo bar on empty by
 * watching its fill. This is the loop a person runs, and it is the proof that the on-screen aids
 * are sufficient to play the game: aim never enters into it.
 */
function playByTheHud(system: ReturnType<typeof createFeature>, h: Harness, done: (prompt: string) => boolean): void {
  let wanted = 0;
  for (let step = 0; step < 1400; step++) {
    const prompt = promptFor(system, h) ?? '';
    if (done(prompt)) return;
    const chips = system.hud!() ?? [];
    const meter = chips.find((chip) => chip.id === 'golf:meter');
    if (/^E {2}Swing/.test(prompt)) {
      wanted = Number(/plays (\d+)/.exec(prompt)?.[1] ?? /· (\d+) m/.exec(prompt)?.[1] ?? 0);
      promptOffer(system, h)!.act();
    } else if (meter?.label === 'POWER') {
      // The ring is out at `value` metres; press when it reaches the flag (or at the top of the bar).
      if (Number(meter.value?.replace('m', '') ?? 0) >= wanted || (meter.fill ?? 0) >= 98) promptOffer(system, h)!.act();
    } else if (meter?.label === 'TEMPO') {
      if ((meter.fill ?? 100) <= 8) promptOffer(system, h)!.act();
    } else {
      promptOffer(system, h)?.act();
    }
    system.update!(1 / 60);
  }
}

function promptOffer(system: ReturnType<typeof createFeature>, h: Harness) {
  for (const rung of (system.interactions?.() ?? []).slice().sort((a, b) => a.order - b.order)) {
    const offer = rung.test({ context: 'foot', position: h.api.playerPosition(), vehicle: undefined, hour: 14 });
    if (offer) return offer;
  }
  return undefined;
}
