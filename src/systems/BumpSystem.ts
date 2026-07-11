/** Player↔pedestrian bump rules: once is an accident, repeats inside the window read as an attack. */
export const BUMP_WINDOW = 6;
export const ASSAULT_BUMP_COUNT = 2;
export const BUMP_COOLDOWN = 0.9;
export const BUMP_RADIUS = 1.05;
export const BUMP_FEAR = 7;
export const BUMP_PUSH_PED = 0.62;
export const BUMP_PUSH_PLAYER = 0.38;
export const STUMBLE_DURATION = 0.5;
export const KNOCKDOWN_DURATION = 2;
export const KNOCKDOWN_DAMAGE = 12;
export const BUMP_ASSAULT_HEAT = 8;

export interface KnockdownOutcome { health: number; killed: boolean; downTime: number; }

/** Drops stale timestamps, records the new bump, and returns how many landed inside the window. */
export function recordBump(times: number[], now: number, window = BUMP_WINDOW): number {
  let keep = 0;
  for (const time of times) if (now - time < window) times[keep++] = time;
  times.length = keep; times.push(now);
  return times.length;
}

/** A knockdown always escalates; otherwise it takes repeat bumps inside the window. */
export function bumpEscalates(count: number, knockdown = false): boolean {
  return knockdown || count >= ASSAULT_BUMP_COUNT;
}

/** Sprint-bump result: the ped is back up after KNOCKDOWN_DURATION unless health is depleted. */
export function knockdownOutcome(health: number, damage = KNOCKDOWN_DAMAGE): KnockdownOutcome {
  const remaining = Math.max(0, health - damage);
  return { health: remaining, killed: remaining === 0, downTime: remaining === 0 ? 0 : KNOCKDOWN_DURATION };
}

/** Soft radial separation: how far each party slides apart along the contact normal (no hard block). */
export function separationPush(distance: number, radius = BUMP_RADIUS): { ped: number; player: number } {
  const overlap = Math.max(0, radius - distance);
  return { ped: overlap * BUMP_PUSH_PED, player: overlap * BUMP_PUSH_PLAYER };
}
