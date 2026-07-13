/** Tops-ish Bottle Store: a stock of tacky Mzansi dop, an inebriation meter, and the rules that govern
 *  both. Everything here is pure and side-effect free so the maths is testable; the state (the player's
 *  current inebriation) lives on the Player and the per-frame plumbing lives in Game. */

export type DrinkId = 'zamalek' | 'savanna' | 'klippies' | 'springbokkie' | 'amarula' | 'papsak' | 'mampoer' | 'stoney';

export interface Drink {
  id: DrinkId;
  name: string;
  /** Tacky flavour text for the shelf. */
  note: string;
  price: number;
  /** Inebriation points a single serving adds. Negative for the ginger-beer sober-up. */
  potency: number;
}

/** The shelf, cheapest buzz first, moonshine last, ginger beer as the escape hatch. */
export const DRINKS: Drink[] = [
  { id: 'zamalek', name: 'Zamalek Quart', note: 'Carling Black Label. Oupa’s dop — cheap, cheerful, warm.', price: 25, potency: 10 },
  { id: 'savanna', name: 'Savanna Dry', note: '“It’s dry… but you can drink it.” Cider with an axe.', price: 30, potency: 13 },
  { id: 'springbokkie', name: 'Springbokkie', note: 'Amarula + peppermint shooter. Green means go.', price: 20, potency: 15 },
  { id: 'klippies', name: 'Klippies & Coke', note: 'Brandy & Coke — the national steering fluid.', price: 45, potency: 18 },
  { id: 'amarula', name: 'Amarula Dom Pedro', note: 'Marula cream over ice. Smooth like a backhander.', price: 55, potency: 21 },
  { id: 'papsak', name: 'Papsak', note: 'Boxed wine in a foil bag. No dignity, no refunds.', price: 60, potency: 32 },
  { id: 'mampoer', name: 'Mampoer', note: 'Witblits moonshine. Strips paint and regrets alike.', price: 95, potency: 48 },
  { id: 'stoney', name: 'Stoney Ginger Beer', note: 'Fierce ginger, zero booze — sobers you right up.', price: 15, potency: -40 },
];

export const DRINK_BY_ID: Record<DrinkId, Drink> = Object.fromEntries(DRINKS.map((drink) => [drink.id, drink])) as Record<DrinkId, Drink>;

export const INEBRIATION_MAX = 100;
/** Below this you are stone-cold sober: no wobble, no advantage. */
export const BUZZ_MIN = 6;
/** Above this you are really, really drunk — the healing advantage is gone and the dop starts to cost you. */
export const BLACKOUT = 80;

/** Sober up over time: a full skinful drains in roughly two and a half minutes of walking it off. */
export const SOBER_RATE = 0.7; // inebriation points per second
/** The pleasant-buzz advantage: a slow trickle of health while you are merry but not legless. */
export const DRUNK_HEAL_RATE = 2.4; // hp per second
/** Past blackout the room spins and the dop bites back — a mild drain, floored so booze alone can’t kill you. */
export const BOOZE_POISON_RATE = 1.6; // hp per second
export const POISON_HEALTH_FLOOR = 15;

export type DrinkDenial = 'funds' | 'sober-already';
export interface DrinkPurchase { ok: boolean; price: number; reason?: DrinkDenial; }

/** Resolves a bottle-store sale without applying it: you need the cash, and the ginger-beer only sells while
 *  there is a buzz left to cut. */
export function resolveDrinkPurchase(drink: Drink, balance: number, inebriation: number): DrinkPurchase {
  if (drink.potency < 0 && inebriation <= 0) return { ok: false, price: drink.price, reason: 'sober-already' };
  if (balance < drink.price) return { ok: false, price: drink.price, reason: 'funds' };
  return { ok: true, price: drink.price };
}

/** Down the hatch: fold a serving into the meter, clamped to the sober..blackout-plus range. */
export function applyDrink(inebriation: number, drink: Drink): number {
  return Math.max(0, Math.min(INEBRIATION_MAX, inebriation + drink.potency));
}

/** Walk it off: inebriation bleeds away with elapsed time. */
export function decayInebriation(inebriation: number, dt: number): number {
  return Math.max(0, inebriation - SOBER_RATE * dt);
}

/** Smoothstep-eased 0..1 that ramps in from the first buzz to fully legless — drives the stagger and the sway. */
export function inebriationFraction(inebriation: number): number {
  const t = (inebriation - BUZZ_MIN) / (INEBRIATION_MAX - BUZZ_MIN);
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/** Health delta for this frame: a healing trickle through the merry band, a poisoning drain past blackout
 *  (floored so the dop leaves you on your knees, not dead), and nothing at all while sober. Health clamping
 *  against the maximum is the caller’s job. */
export function drunkHealthDelta(inebriation: number, health: number, dt: number): number {
  if (inebriation < BUZZ_MIN) return 0;
  if (inebriation > BLACKOUT) {
    if (health <= POISON_HEALTH_FLOOR) return 0;
    return -Math.min(BOOZE_POISON_RATE * dt, health - POISON_HEALTH_FLOOR);
  }
  return DRUNK_HEAL_RATE * dt;
}

/** HUD tag for the current state, or undefined while sober. `warn` flags the blackout band. */
export function inebriationLabel(inebriation: number): { text: string; warn: boolean } | undefined {
  if (inebriation < BUZZ_MIN) return undefined;
  if (inebriation >= BLACKOUT) return { text: 'BABALAS', warn: true };
  if (inebriation >= 55) return { text: 'DRONK', warn: false };
  if (inebriation >= 30) return { text: 'LEKKER', warn: false };
  return { text: 'TIPSY', warn: false };
}
