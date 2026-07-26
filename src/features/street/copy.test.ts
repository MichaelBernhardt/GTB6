/**
 * The tone rules, as an enforcement artifact rather than a paragraph in a brief.
 *
 * A stated rule with no test is not a rule. Everything here is a constraint the owner set or the
 * research established, and each one fails CI rather than shipping.
 */
import { describe, expect, it } from 'vitest';
import { DEALERS, FIXER, LEVY_NOTES, PROMOTIONS, RADIO_BLAME, WORKERS, cycle, dealerFor, workerFor } from './cast';
import { onShift, type Refusal } from './rules';
import { PRODUCTS, TIERS } from './trade';
import { STREET_BLOCK_COUNT } from '../street.state';

const everyString = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) everyString(entry, out);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) everyString(entry, out);
  return out;
};

const ALL_COPY = everyString([DEALERS, WORKERS, FIXER, RADIO_BLAME, LEVY_NOTES, PROMOTIONS, PRODUCTS, TIERS]);

describe('terminology — a hard constraint, not a preference', () => {
  it('never uses the words the owner ruled out, anywhere a player can read', () => {
    // "sex worker" in all UI, subtitles, prompts and achievements. Never "prostitute", never "john".
    for (const line of ALL_COPY) {
      expect(line.toLowerCase(), line).not.toMatch(/\bprostitut/);
      expect(line.toLowerCase(), line).not.toMatch(/\bhooker/);
      expect(line.toLowerCase(), line).not.toMatch(/\bwhore/);
      expect(line.toLowerCase(), line).not.toMatch(/\bjohns?\b/);
      expect(line.toLowerCase(), line).not.toMatch(/\bpimp/);
    }
  });

  it('carries no slur in any voice at all — not even the radio host we are mocking', () => {
    // The host's bigotry is expressed as EUPHEMISM, which is both how it actually sounds on air and
    // the version where the joke lands on him. No slur ships in this build in any mouth.
    for (const line of ALL_COPY) {
      expect(line.toLowerCase(), line).not.toMatch(/kwerekwere|magosha|kaffir|coolie/);
    }
  });

  it('keeps nothing sexual in the build, including in unreachable strings', () => {
    for (const line of ALL_COPY) {
      expect(line.toLowerCase(), line).not.toMatch(/\bsex\b|\bnaked|\bbreast|\bgenital|\bblow ?job|\borgasm/);
    }
    // The interlude is a card of conversation. Every worker's `after` line is about what she SAYS.
    for (const worker of WORKERS) expect(worker.after.length).toBeGreaterThan(40);
  });

  it('is safe to drop into the menu card, which sets innerHTML', () => {
    for (const line of ALL_COPY) expect(line, line).not.toMatch(/[<>&]/);
  });
});

describe('the sex workers are characters, not vending machines', () => {
  it('covers every block the derivation can produce', () => {
    expect(WORKERS.length).toBeGreaterThanOrEqual(STREET_BLOCK_COUNT);
    expect(DEALERS.length).toBeGreaterThanOrEqual(STREET_BLOCK_COUNT);
    expect(new Set(WORKERS.map((worker) => worker.name)).size).toBe(WORKERS.length);
    expect(new Set(DEALERS.map((dealer) => dealer.name)).size).toBe(DEALERS.length);
  });

  it('gives each of them a name, a shift, a stated price, and a price for what she knows', () => {
    for (const worker of WORKERS) {
      expect(worker.name.split(' ').length, worker.name).toBeGreaterThanOrEqual(2); // a first name and a surname
      expect(worker.price).toBeGreaterThan(0);
      expect(worker.infoPrice).toBeGreaterThan(0);
      expect(worker.infoPrice, worker.name).toBeLessThan(worker.price); // treating her as a person is always the cheaper option
      expect(worker.shift.start).toBeGreaterThanOrEqual(0);
      expect(worker.shift.start).toBeLessThan(24);
      expect(worker.shift.end).toBeGreaterThanOrEqual(0);
      expect(worker.shift.end).toBeLessThan(24);
      expect(worker.greet.length).toBeGreaterThanOrEqual(3);
      expect(worker.info.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('lets every one of them refuse, for every reason the rules can produce', () => {
    const reasons: Refusal[] = ['banned', 'off-shift', 'moving', 'police-car', 'wreck', 'broke', 'busy'];
    for (const worker of WORKERS) {
      for (const reason of reasons) {
        expect(worker.refuse[reason], `${worker.name} has no line for "${reason}"`).toBeTruthy();
        expect(worker.refuse[reason].length).toBeGreaterThan(12);
      }
    }
  });

  it('staffs the day as well as the night, and closes for no longer than a coffee break of real time', () => {
    // The day cycle is ten real minutes, so one in-game hour is 25 real seconds. A gap of a few
    // hours is texture; a gap of half a day would be a locked door, which the canon forbids.
    const covered: boolean[] = [];
    for (let hour = 0; hour < 24; hour++) covered.push(WORKERS.some((worker) => onShift(hour, worker.shift)));
    expect(covered.filter(Boolean).length, `${covered.filter(Boolean).length}/24 hours staffed`).toBeGreaterThanOrEqual(18);
    let longestGap = 0; let run = 0;
    for (let hour = 0; hour < 48; hour++) {
      run = covered[hour % 24] ? 0 : run + 1;
      longestGap = Math.max(longestGap, run);
    }
    expect(longestGap, `${longestGap} in-game hours with nobody working`).toBeLessThanOrEqual(6);
    expect(WORKERS.some((worker) => onShift(12, worker.shift))).toBe(true); // somebody works middays
  });
});

describe('the Body Corporate', () => {
  it('is a mixed-membership property syndicate, so no nationality carries the crime', () => {
    const names = DEALERS.map((dealer) => dealer.name).join(' ');
    // Igbo, Yoruba, Zulu/Sotho, Mandarin — the org chart is a freight and property business, and the
    // research is explicit that this is also what the real one looks like.
    expect(names).toMatch(/Nwosu|Ofori/);
    expect(names).toMatch(/Radebe|Molefe/);
    expect(names).toMatch(/Fan/);
    expect(DEALERS.length).toBeGreaterThanOrEqual(4);
  });

  it('talks like a body corporate, because that is where the jokes are', () => {
    const copy = everyString(DEALERS).join(' ').toLowerCase();
    expect(copy).toMatch(/levy|levies|subs|trustee/);
    expect(copy).toMatch(/agm|slideshow|book|paperwork|invoice/);
  });

  it('lets each dealer answer every branch the trade can take', () => {
    for (const dealer of DEALERS) {
      for (const key of ['bought', 'sold', 'levyPaid', 'arrears', 'locked', 'banned', 'broke'] as const) {
        expect(dealer[key], `${dealer.name}.${key}`).toBeTruthy();
      }
      expect(dealer.greet.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('points the wholesale trail at the state and the golf estate, not at a foreigner', () => {
    expect(FIXER.reveal.toLowerCase()).toContain('evidence');
    expect(FIXER.reveal.toLowerCase()).toContain('golf estate');
    expect(FIXER.reveal.toLowerCase()).toContain('private sector');
  });

  it('aims the Blame Ticker at the radio host every single time', () => {
    expect(RADIO_BLAME.length).toBeGreaterThanOrEqual(4);
    for (const line of RADIO_BLAME) expect(line).toMatch(/^Highveld Talk:/);
    const joined = RADIO_BLAME.join(' ').toLowerCase();
    expect(joined).toContain('pharmacist');
    expect(joined).toMatch(/commission|thirteen police/);
  });
});

describe('casting', () => {
  it('never runs out of people, whatever the map derivation produces', () => {
    for (let block = 0; block < 40; block++) {
      expect(dealerFor(block).name).toBeTruthy();
      expect(workerFor(block).name).toBeTruthy();
    }
  });

  it('cycles lines instead of repeating one, and never falls off the end', () => {
    const lines = ['a', 'b', 'c'];
    expect([0, 1, 2, 3, 4].map((visit) => cycle(lines, visit))).toEqual(['a', 'b', 'c', 'a', 'b']);
    expect(cycle(lines, -1)).toBe('b');
  });
});
