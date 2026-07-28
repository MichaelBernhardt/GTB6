/**
 * The street economy's arithmetic — pure, deterministic, and unit-tested away from the world.
 *
 * The one structural rule everything else hangs off: **a corner never buys back what it sells.**
 * Each corner is LONG one product (its own supply, sold to you cheap) and SHORT the other two
 * (bought off you at a premium). That kills same-corner arbitrage without a cooldown hack, and it
 * gives the map a readable shape: Hillbrow is long on zol, Yeoville pays for it, so you drive.
 */
import { STREET_MAX_CARRY, type StreetProduct } from '../street.state';

export interface ProductSpec {
  readonly id: StreetProduct;
  readonly name: string;
  /** What one unit is called on the street. Straws, buttons, bankies — never "units" in the fiction. */
  readonly unit: string;
  readonly plural: string;
  /** Wholesale rand for one unit at index 1.0. */
  readonly base: number;
  /** Tier you must reach before a corner will sell it to you at all. */
  readonly tier: number;
  /** The row's subtitle: legally accurate, and the accuracy is the joke. */
  readonly note: string;
}

/** Three products, deliberately. A fourth is another row nobody reads. */
export const PRODUCTS: readonly ProductSpec[] = [
  { id: 'zol', name: 'Zol', unit: 'bankie', plural: 'bankies', base: 60, tier: 0,
    note: 'Private use is lawful since Prince. Selling it is not. Nobody has told the corner.' },
  { id: 'buttons', name: 'Buttons', unit: 'button', plural: 'buttons', base: 150, tier: 1,
    note: 'Mandrax. Smoked in a broken bottleneck with zol. The pipe is the country, honestly.' },
  { id: 'nyaope', name: 'Nyaope', unit: 'straw', plural: 'straws', base: 25, tier: 1,
    note: 'R25 a straw and the cheapest habit in the country. Gauteng word. Say "whoonga" in KZN.' },
];

export function productSpec(id: StreetProduct): ProductSpec {
  return PRODUCTS.find((product) => product.id === id) ?? PRODUCTS[0]!;
}

export interface TierSpec {
  readonly rank: number;
  readonly name: string;
  /** Units you can carry across all three products. */
  readonly carry: number;
  /** Turnover through the books that promotes you. */
  readonly turnover: number;
  /** Multiplier on the ask: the trustees like a member who moves stock. */
  readonly ask: number;
  readonly blurb: string;
}

/** Short ladder, generous steps: two promotions, both inside an hour of ordinary play. */
export const TIERS: readonly TierSpec[] = [
  { rank: 0, name: 'Corner', carry: 12, turnover: 0, ask: 1, blurb: 'You buy retail like everyone else.' },
  { rank: 1, name: 'Runner', carry: 30, turnover: 1200, ask: 0.92, blurb: 'You buy at levy price and the book has your name in it.' },
  { rank: 2, name: 'Trustee', carry: STREET_MAX_CARRY, turnover: 4500, ask: 0.86, blurb: 'You hold a key, a laminated card and an opinion at the AGM.' },
];

export function tierSpec(rank: number): TierSpec {
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, Math.floor(rank)))]!;
}

/** Promotion is a floor, never a demotion: turnover only goes up, and neither does the rank. */
export function tierFor(turnover: number, current = 0): number {
  let rank = Math.max(0, Math.floor(current));
  for (const tier of TIERS) if (turnover >= tier.turnover) rank = Math.max(rank, tier.rank);
  return Math.min(TIERS.length - 1, rank);
}

export function carryCap(rank: number): number { return tierSpec(rank).carry; }

export function carrying(stock: Record<StreetProduct, number>): number {
  return PRODUCTS.reduce((total, product) => total + (stock[product.id] ?? 0), 0);
}

// ---- the price of a block -----------------------------------------------------------------------

/** Stable 32-bit hash of a string — the district's price character, immune to the map reshape. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return (value ^ (value >>> 15)) >>> 0;
}

function unit(text: string): number { return hash(text) / 0x1_0000_0000; }

/**
 * Which product this corner is LONG. The other two it buys off you.
 *
 * `block` is the site's rank in the derived list, and block 0 is pinned to the first product on
 * purpose: the very first corner a new player can reach must sell the one thing a Corner-rank player
 * with R750 is allowed to buy. A beginner meeting a greyed-out row is a beginner who leaves.
 */
export function supplyProduct(siteId: string, block: number): StreetProduct {
  if (block <= 0) return PRODUCTS[0]!.id;
  return PRODUCTS[hash(`${siteId}:long`) % PRODUCTS.length]!.id;
}

/** 0.86–1.06 × base: what the corner asks for the thing it actually has. */
export function supplyIndex(siteId: string, product: StreetProduct): number {
  return 0.86 + unit(`${siteId}:${product}:ask`) * 0.2;
}

/**
 * 1.10–1.55 × base: what a corner short of it will pay. This spread is the whole reason to drive
 * anywhere, and it is deliberately wide enough that knowing WHICH corner is worth paying a worker
 * for — the gap between the best and worst block is several times the price of her information.
 */
export function demandIndex(siteId: string, product: StreetProduct): number {
  return 1.1 + unit(`${siteId}:${product}:bid`) * 0.45;
}

/**
 * Does this corner buy this product at all? A corner is LONG one product and SHORT the other two,
 * and it never buys back its own line. This is the structural rule that makes same-corner arbitrage
 * impossible without a cooldown hack — enforced here, at the one place both the menu and the sale
 * path ask, so a forged menu action cannot slip past it either.
 *
 * This held only because a corner sells EXACTLY its long product and nothing else. An earlier draft
 * had a rank-gated corner fall back to selling the beginner product "as a favour" — and an in-engine
 * playthrough immediately found the money printer: Berea asked R66 for a bankie while bidding R71
 * for the same bankie. A corner that is short of something must never also stock it.
 */
export function buysHere(siteId: string, block: number, product: StreetProduct): boolean {
  return supplyProduct(siteId, block) !== product;
}

export const ARREARS_THRESHOLD = 400;
export const ARREARS_SURCHARGE = 1.2;
export const LEVY_RATE = 0.08;

/** The trustees' cut of a sale. They will describe it as a service charge. */
export function levyOn(amount: number): number { return Math.round(amount * LEVY_RATE); }

/** Load-shedding is a pricing fact: a dark corner is a dangerous corner and it is priced accordingly. */
export function blackoutPremium(blackout: number): number {
  return 1 + Math.min(1, Math.max(0, blackout)) * 0.15;
}

export interface AskContext {
  readonly siteId: string;
  readonly tier: number;
  readonly levy: number;
  readonly blackout: number;
}

/** What one unit costs you here, rounded to rand. */
export function askPrice(product: StreetProduct, context: AskContext): number {
  const arrears = context.levy > ARREARS_THRESHOLD ? ARREARS_SURCHARGE : 1;
  const price = productSpec(product).base * supplyIndex(context.siteId, product)
    * tierSpec(context.tier).ask * arrears * blackoutPremium(context.blackout);
  return Math.max(1, Math.round(price));
}

/**
 * Will this corner sell you its line right now? A corner above your rank is not a dead end — it
 * still BUYS what you are carrying, which is the half of the trade that pays — but it stocks
 * nothing else, so there is never a corner that both sells and buys the same thing.
 */
export function sellsToYou(siteId: string, block: number, tier: number): boolean {
  return tier >= productSpec(supplyProduct(siteId, block)).tier;
}

/** What one unit fetches here, after however much you have already dumped on this block. */
export function bidPrice(product: StreetProduct, siteId: string, demand = 1): number {
  const price = productSpec(product).base * demandIndex(siteId, product) * clampDemand(demand);
  return Math.max(1, Math.round(price));
}

export const DEMAND_FLOOR = 0.62;
export const DEMAND_PER_UNIT = 0.968;
/** Seconds of play for a flooded corner to come all the way back. About two laps of the inner city. */
export const DEMAND_RECOVERY_SECONDS = 260;

export function clampDemand(demand: number): number {
  if (!Number.isFinite(demand)) return 1;
  return Math.min(1, Math.max(DEMAND_FLOOR, demand));
}

/** Dumping stock on one corner soaks it. Come back later, or drive one block further. */
export function demandAfterSale(demand: number, units: number): number {
  return clampDemand(clampDemand(demand) * DEMAND_PER_UNIT ** Math.max(0, units));
}

export function recoverDemand(demand: number, seconds: number): number {
  const gap = 1 - clampDemand(demand);
  return clampDemand(1 - gap * Math.max(0, 1 - seconds / DEMAND_RECOVERY_SECONDS));
}

// ---- what a trade actually does -----------------------------------------------------------------

export interface BuyQuote {
  readonly units: number;
  readonly unitPrice: number;
  readonly total: number;
  /** Why you can't have more: the menu prints this instead of greying a row out silently. */
  readonly limit?: 'tier' | 'carry' | 'money' | 'stock';
}

export interface BuyLimits {
  readonly want: number;
  readonly held: number;
  readonly cap: number;
  readonly balance: number;
  readonly supply: number;
}

/** Buys as many as the player can actually take, and says which wall it hit. */
export function quoteBuy(product: StreetProduct, context: AskContext, limits: BuyLimits): BuyQuote {
  const unitPrice = askPrice(product, context);
  if (context.tier < productSpec(product).tier) return { units: 0, unitPrice, total: 0, limit: 'tier' };
  let units = Math.max(0, Math.floor(limits.want));
  let limit: BuyQuote['limit'];
  const room = Math.max(0, limits.cap - limits.held);
  if (units > limits.supply) { units = limits.supply; limit = 'stock'; }
  if (units > room) { units = room; limit = 'carry'; }
  const affordable = Math.floor(limits.balance / unitPrice);
  if (units > affordable) { units = affordable; limit = 'money'; }
  return { units: Math.max(0, units), unitPrice, total: Math.max(0, units) * unitPrice, limit: units > 0 ? limit : limit ?? 'stock' };
}

/**
 * The corner paying most for a product right now — the thing a worker sells you for R60 and the
 * reason her information is worth more than the fare. A corner long on the product is never the
 * answer: it has its own.
 */
export function bestDemand(corners: readonly { id: string; cast: number }[], product: StreetProduct): string | undefined {
  let best: string | undefined; let bestIndex = 0;
  for (const corner of corners) {
    if (supplyProduct(corner.id, corner.cast) === product) continue;
    const index = demandIndex(corner.id, product);
    if (index > bestIndex) { bestIndex = index; best = corner.id; }
  }
  return best;
}

export interface SellQuote {
  readonly units: number;
  readonly unitPrice: number;
  readonly total: number;
  readonly levy: number;
  readonly demandAfter: number;
}

/** Sells into a corner one unit at a time, so a big drop walks the price down honestly. */
export function quoteSell(product: StreetProduct, siteId: string, held: number, want: number, demand: number): SellQuote {
  const units = Math.min(Math.max(0, Math.floor(want)), Math.max(0, Math.floor(held)));
  let running = clampDemand(demand);
  let total = 0;
  for (let index = 0; index < units; index++) {
    total += bidPrice(product, siteId, running);
    running = demandAfterSale(running, 1);
  }
  return { units, unitPrice: units > 0 ? Math.round(total / units) : bidPrice(product, siteId, running), total, levy: levyOn(total), demandAfter: running };
}
