import { beforeEach, describe, expect, it } from 'vitest';
import { advanceBlackout, advanceHour, DAY_CYCLE_SECONDS, nightFactor } from '../world/DayNight';
import { TORCH_HINT_DARKNESS, TORCH_HINT_MAX_SHOWS, TORCH_HINT_SETTLE_SECONDS, TorchHint, torchHintToast, torchHintUseful, type TorchHintWorld } from './TorchHint';

/**
 * The hint has already rotted once (it was taught from the load-shedding event handler, so only the
 * paths that handler knew about ever fired). These tests walk EVERY route a player can take into a
 * dark shedding street and pin that the hint fires on the rising edge of each — and, just as
 * importantly, that the routes where a torch is useless never spend a showing.
 */

const STEP = 1 / 60;

/** A faithful stand-in for the two curves the real condition reads: DayNight's eased blackout ramp
 *  and its night factor. Using the actual functions means "shedding starts at night" and "night falls
 *  during shedding" are proved against the real timing, not against a hand-made number. */
class World implements TorchHintWorld {
  shedding = false;
  torchOn = false;
  exposed = true;
  watching = true;
  hour: number;
  private blackout = 0;

  constructor(hour = 22) { this.hour = hour; }

  get darkness(): number { return this.blackout * nightFactor(this.hour); }

  step(dt: number): void {
    this.blackout = advanceBlackout(this.blackout, this.shedding ? 1 : 0, dt);
    this.hour = advanceHour(this.hour, dt);
  }
}

/** Run the world (and the hint) for `seconds`, returning how many times the hint fired. */
function pump(hint: TorchHint, world: World, seconds: number): number {
  let fired = 0;
  for (let t = 0; t < seconds; t += STEP) {
    world.step(STEP);
    if (hint.update(STEP, world)) fired += 1;
  }
  return fired;
}

describe('the derived condition', () => {
  const base: TorchHintWorld = { shedding: true, darkness: 1, torchOn: false, exposed: true, watching: true };

  it('is true only when it is dark, the grid is down, the torch is off and the player is out in it', () => {
    expect(torchHintUseful(base)).toBe(true);
    expect(torchHintUseful({ ...base, shedding: false })).toBe(false); // a normal night: street lights work
    expect(torchHintUseful({ ...base, darkness: 0 })).toBe(false); // daytime shedding
    expect(torchHintUseful({ ...base, torchOn: true })).toBe(false);
    expect(torchHintUseful({ ...base, exposed: false })).toBe(false);
    expect(torchHintUseful({ ...base, watching: false })).toBe(false);
  });

  it('needs the darkness to be past the threshold, not merely at it', () => {
    expect(torchHintUseful({ ...base, darkness: TORCH_HINT_DARKNESS })).toBe(false);
    expect(torchHintUseful({ ...base, darkness: TORCH_HINT_DARKNESS + 0.01 })).toBe(true);
  });
});

describe('paths into a dark shedding street', () => {
  let hint: TorchHint;
  beforeEach(() => { hint = new TorchHint(); });

  it('1. load shedding begins while it is already night', () => {
    const world = new World(22);
    expect(pump(hint, world, 3)).toBe(0); // grid up: nothing to say
    world.shedding = true;
    expect(pump(hint, world, 10)).toBe(1);
  });

  it('2. night falls while shedding is already active (the path that already worked)', () => {
    const world = new World(16.4); // broad daylight
    world.shedding = true;
    expect(pump(hint, world, 20)).toBe(0); // the blackout is fully faded in, but the sun is up
    expect(world.darkness).toBe(0);
    // Let dusk arrive: an eighth of the day cycle is 3 hours, carrying 16:xx past DUSK_END (19.5).
    expect(pump(hint, world, DAY_CYCLE_SECONDS / 8)).toBe(1);
    expect(world.darkness).toBeGreaterThan(TORCH_HINT_DARKNESS);
  });

  it('3. a session that starts at night gets told when the first outage lands', () => {
    const world = new World(1.5); // a save resumed in the dead of night; outages never persist, so one starts later
    expect(pump(hint, world, 30)).toBe(0);
    world.shedding = true;
    expect(pump(hint, world, 10)).toBe(1);
  });

  it('4. an outage in broad daylight never hints (there is nothing to light)', () => {
    const world = new World(12);
    world.shedding = true;
    expect(pump(hint, world, 60)).toBe(0);
    expect(hint.shown).toBe(0);
  });

  it('5. coming out of a lit ride into a dark street: the showing is never spent while inside', () => {
    const world = new World(22);
    world.shedding = true; world.exposed = false; // driving with headlights on
    expect(pump(hint, world, 30)).toBe(0);
    expect(hint.finished).toBe(false); // crucially: NOT consumed — this is how the hint used to disappear
    world.exposed = true; // step out onto the pavement
    expect(pump(hint, world, 5)).toBe(1);
  });

  it('5b. a train ride, a cockpit, a shop or a building interior are all the same "not exposed" case', () => {
    const world = new World(22);
    world.shedding = true;
    // Game.torchWouldHelp() folds all of these into one flag; each is a place a torch lights nothing.
    for (const inside of ['vehicle', 'transition', 'plane', 'parachute', 'train', 'shop', 'interior']) {
      world.exposed = false;
      expect(pump(hint, world, 4), `${inside} must not spend the showing`).toBe(0);
    }
    world.exposed = true;
    expect(pump(hint, world, 5)).toBe(1);
  });

  it('6. the outage escalating the city into darkness is the same rising edge, whichever order', () => {
    // Dusk first, outage second vs outage first, dusk second: both end up taught exactly once.
    const duskFirst = new TorchHint(); const outageFirst = new TorchHint();
    const a = new World(19.6); a.shedding = true; // already night, then the grid goes
    const b = new World(17); b.shedding = true; // grid already gone, night arrives
    expect(pump(duskFirst, a, 10)).toBe(1);
    expect(pump(outageFirst, b, DAY_CYCLE_SECONDS / 8)).toBe(1);
  });

  it('7. putting the torch away in the dark does not re-lecture a player who found the key', () => {
    const world = new World(22);
    world.shedding = true; world.torchOn = true; hint.learned(); // they pressed L themselves
    expect(pump(hint, world, 20)).toBe(0);
    world.torchOn = false; // pocketed again, still pitch dark
    expect(pump(hint, world, 20)).toBe(0);
    expect(hint.finished).toBe(true);
  });

  it('does not hint at a player whose torch is already lit', () => {
    const world = new World(22);
    world.shedding = true; world.torchOn = true;
    expect(pump(hint, world, 30)).toBe(0);
    expect(hint.finished).toBe(false); // still owed a hint if they pocket it before ever seeing one
  });

  it('waits for the map or console to close rather than toasting behind it', () => {
    const world = new World(22);
    world.shedding = true; world.watching = false;
    expect(pump(hint, world, 30)).toBe(0);
    world.watching = true;
    expect(pump(hint, world, 5)).toBe(1);
  });
});

describe('the nag budget', () => {
  it('fires on the rising edge, once, not every frame it is dark', () => {
    const hint = new TorchHint(); const world = new World(22);
    world.shedding = true;
    expect(pump(hint, world, 120)).toBe(1);
  });

  it('gives a second chance on a later outage, then goes quiet for the session', () => {
    const hint = new TorchHint(); const world = new World(1);
    for (let outage = 0; outage < 4; outage++) {
      world.shedding = true; pump(hint, world, 20);
      world.shedding = false; pump(hint, world, 20); // power restored: the condition drops and re-arms
    }
    expect(hint.shown).toBe(TORCH_HINT_MAX_SHOWS);
    expect(hint.finished).toBe(true);
  });

  it('lets the darkness settle before speaking, so it never stamps over the Stage 4 toast', () => {
    const hint = new TorchHint(); const world = new World(22);
    world.shedding = true;
    // Darkness crosses the threshold partway through the blackout fade; the hint waits out the settle
    // on top of that, so nothing is said in the first couple of seconds of the outage.
    expect(pump(hint, world, TORCH_HINT_SETTLE_SECONDS)).toBe(0);
    expect(pump(hint, world, 10)).toBe(1);
  });

  it('spends nothing on a glance out of the car shorter than the settle', () => {
    const hint = new TorchHint(); const world = new World(22);
    world.shedding = true; world.exposed = false;
    pump(hint, world, 10); // fully dark, fully faded, player driving
    world.exposed = true;
    expect(pump(hint, world, TORCH_HINT_SETTLE_SECONDS - 0.5)).toBe(0);
    world.exposed = false; // back in the car before it ever spoke
    expect(pump(hint, world, 5)).toBe(0);
    expect(hint.finished).toBe(false);
    world.exposed = true;
    expect(pump(hint, world, 5)).toBe(1); // the dwell restarts from scratch, and this time it holds
  });

  it('re-arms when the power comes back mid-dwell instead of firing late', () => {
    const hint = new TorchHint(); const world = new World(22);
    world.shedding = true;
    pump(hint, world, 2); // in the dark, part-way through the settle
    world.shedding = false;
    expect(pump(hint, world, 10)).toBe(0);
    expect(hint.shown).toBe(0);
  });
});

describe('toast copy', () => {
  it('names the L key on a keyboard and the torch button on a phone', () => {
    expect(torchHintToast(false).detail).toContain('L for torch');
    expect(torchHintToast(true).detail).toContain('⚡'); // the permanent torch button in the touch utility cluster
    expect(torchHintToast(true).detail).not.toContain('L for torch');
    expect(torchHintToast(false).title).toBe(torchHintToast(true).title);
  });
});
