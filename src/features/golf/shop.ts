/**
 * The pro shop. Prices are real 2026 South African retail, which is the joke and the economy at the
 * same time: a forged iron set costs more than five story missions, so it is a genuine long-term
 * sink, and lay-by (30% down, the club goes in your bag today) is how anyone actually buys one.
 *
 * Pure data + pure functions. `golf.ts` turns these into FeatureMenuRows and spends the money.
 */
import type { GolfGearId, GolfState } from '../golf.state';
import type { Bag } from './swing';

/** Municipal twilight rate for three holes. The board behind the counter still says R960. */
export const GREEN_FEE = 180;
/** Non-affiliated visitor rate, printed on the board and never charged. AFFILIATED members pay R595. */
export const BOARD_RATE_VISITOR = 960;
export const BOARD_RATE_AFFILIATED = 595;
/** No collared shirt, no course — unless you rent one at the boom. */
export const SHIRT_LEVY = 150;
/** Tebogo, twenty-two years on this course, reads a putt better than you ever will. */
export const CADDIE_FEE = 235;
/** A sleeve of three. About R85 a ball, which is why the fence line is full of ball-hunters. */
export const SLEEVE_PRICE = 255;
export const SLEEVE_BALLS = 3;
/** The ball-hunters will hand your ball back over the fence for a tip. Cheaper than a penalty stroke. */
export const HUNTER_TIP = 20;

export interface GearItem {
  id: GolfGearId;
  label: string;
  price: number;
  detail: string;
  /** Anything this dear is sold on lay-by in South Africa, and so it is here. */
  layby: boolean;
}

export const GEAR: readonly GearItem[] = [
  { id: 'shirt', label: 'Collared golf shirt', price: 199, detail: 'Dress code at the boom. No takkies, no slip-slops, no jeans. Saves the R150 hire-shirt levy every round.', layby: false },
  { id: 'glove', label: 'Kudu-leather glove', price: 449, detail: 'Grip you can trust in a Highveld thunderstorm. 15% tighter dispersion.', layby: false },
  { id: 'shoes', label: 'Spikeless golf shoes', price: 1299, detail: 'Stops the slide on a dormant lie. 10% tighter dispersion.', layby: false },
  { id: 'putter', label: 'Blade putter', price: 2199, detail: 'Steadier stroke and a far more generous concede on the green.', layby: false },
  { id: 'driver', label: 'Bafana Bomber driver', price: 7999, detail: 'Twenty-six percent more off the tee than the hire stick, and it stays in play.', layby: true },
  { id: 'irons', label: 'Forged iron set, 4–PW', price: 15999, detail: 'The whole approach game, transformed. 25% more carry than hire irons and half the spread.', layby: true },
];

export const LAYBY_DEPOSIT = 0.30;

export function gearItem(id: GolfGearId): GearItem | undefined { return GEAR.find((entry) => entry.id === id); }
export function laybyDeposit(item: GearItem): number { return Math.round(item.price * LAYBY_DEPOSIT); }
export function laybyBalance(item: GearItem): number { return item.price - laybyDeposit(item); }

/** Fraction of a round's winnings the pro takes off your lay-by before you see a cent. */
export const LAYBY_CUT = 0.4;

/** What the boom gate charges you today. */
export function greenFee(state: GolfState): number {
  return GREEN_FEE + (state.owned.includes('shirt') ? 0 : SHIRT_LEVY);
}

/** Fold the save slice plus this round's extras into the two numbers the swing rules care about. */
export function toBag(state: GolfState, caddie: boolean): Bag {
  return {
    driver: state.owned.includes('driver'),
    irons: state.owned.includes('irons'),
    putter: state.owned.includes('putter'),
    glove: state.owned.includes('glove'),
    shoes: state.owned.includes('shoes'),
    premiumBall: state.balls > 0,
    caddie,
  };
}

/** Apply a payout against an open lay-by. Returns what the player actually pockets. */
export function settleLayby(state: GolfState, gross: number): { pocketed: number; paid: number; cleared: boolean } {
  if (!state.layby || gross <= 0) return { pocketed: gross, paid: 0, cleared: false };
  const paid = Math.min(state.layby.owing, Math.round(gross * LAYBY_CUT));
  state.layby.owing -= paid;
  const cleared = state.layby.owing <= 0;
  if (cleared) state.layby = null;
  return { pocketed: gross - paid, paid, cleared };
}
