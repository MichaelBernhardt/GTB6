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
    expect(promptFor(system, h)).toBe('E  Set the power');
    expect(system.hud!()!.find((chip) => chip.id === 'golf:meter')?.label).toBe('POWER');
    act();                                                  // set the power
    for (let i = 0; i < 12; i++) system.update!(1 / 60);
    expect(promptFor(system, h)).toBe('E  Stop the bar on empty');
    expect(system.hud!()!.find((chip) => chip.id === 'golf:meter')?.label).toBe('TEMPO');
    act();                                                  // strike
    expect(promptFor(system, h)).toBe('E  Skip the flight');
    // Let the ball run out in real frames rather than skipping.
    for (let i = 0; i < 700 && promptFor(system, h) === 'E  Skip the flight'; i++) system.update!(1 / 60);
    expect(promptFor(system, h)).not.toBe('E  Skip the flight');
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

function promptOffer(system: ReturnType<typeof createFeature>, h: Harness) {
  for (const rung of (system.interactions?.() ?? []).slice().sort((a, b) => a.order - b.order)) {
    const offer = rung.test({ context: 'foot', position: h.api.playerPosition(), vehicle: undefined, hour: 14 });
    if (offer) return offer;
  }
  return undefined;
}
