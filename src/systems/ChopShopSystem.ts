import type { VehicleKind } from '../config';

/** Vusi buys common road vehicles only. Blue lights and bikes carry more admin than profit. */
export const CHOP_SHOP_BASE_VALUES: Partial<Record<VehicleKind, number>> = {
  compact: 650,
  sport: 1700,
  van: 1100,
  taxi: 850,
};

export function chopShopAccepts(kind: VehicleKind): boolean {
  return CHOP_SHOP_BASE_VALUES[kind] !== undefined;
}

/** Condition matters without making a battered getaway worthless: 35% of base is guaranteed.
 * Offers use clean R50 steps so the HUD reads like a cash deal, not an insurance calculation. */
export function chopShopOffer(kind: VehicleKind, health: number, maxHealth: number): number {
  const base = CHOP_SHOP_BASE_VALUES[kind];
  if (base === undefined || !Number.isFinite(health) || !Number.isFinite(maxHealth) || maxHealth <= 0) return 0;
  const condition = Math.max(0, Math.min(1, health / maxHealth));
  return Math.max(50, Math.round((base * (0.35 + condition * 0.65)) / 50) * 50);
}
