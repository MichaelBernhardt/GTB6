export type FearResponse = 'calm' | 'fight' | 'flee' | 'cower';
export interface FearEvent { base: number; radius: number; }

export const FEAR_EVENTS = {
  gunshot: { base: 34, radius: 48 },
  kill: { base: 62, radius: 58 },
  assault: { base: 42, radius: 24 },
  body: { base: 22, radius: 10 },
} as const satisfies Record<string, FearEvent>;

export const FEAR_MAX = 100;
export const FLEE_THRESHOLD = 35;
export const COWER_THRESHOLD = 85;
export const CALM_THRESHOLD = 12;
export const FEAR_DECAY_RATE = 5;
export const BRAVE_FIGHT = 0.85;
export const TIMID_COWER = 0.25;

export function fearContribution(event: FearEvent, distance: number): number {
  if (distance >= event.radius) return 0;
  return event.base * (1 - distance / event.radius);
}

export function accumulateFear(current: number, amount: number): number {
  return Math.min(FEAR_MAX, Math.max(0, current + Math.max(0, amount)));
}

export function decayFear(current: number, dt: number): number {
  return Math.max(0, current - FEAR_DECAY_RATE * dt);
}

export function fearResponse(fear: number, aggressive: boolean, bravery: number, fleeing = false): FearResponse {
  if (fear < FLEE_THRESHOLD) return 'calm';
  if (aggressive || bravery >= BRAVE_FIGHT) return 'fight';
  if (!fleeing && fear >= COWER_THRESHOLD && bravery <= TIMID_COWER) return 'cower';
  return 'flee';
}
