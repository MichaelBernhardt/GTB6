export type CourierPhase = 'off-duty' | 'collecting' | 'delivering';

export const COURIER_STOP_SPEED = 1.2;
export const COURIER_STOP_RADIUS = 9;
export const COURIER_MIN_TRIP_DISTANCE = 120;
export const COURIER_BASE_PAY = 24;
export const COURIER_PAY_PER_100U = 10;
export const COURIER_CARE_RATIO = 0.35;
export const COURIER_TIME_BONUS_PER_SECOND = 0.8;
export const COURIER_TIME_BONUS_CAP = 35;
export const COURIER_STREAK_BONUS = 6;

export interface CourierOrder {
  basket: string;
  note: string;
}

export const COURIER_ORDERS: readonly CourierOrder[] = [
  { basket: 'two avos, ice and a single emergency onion', note: 'Customer note: "Gate is broken. Hoot like a hadeda."' },
  { basket: 'cat litter, oat milk and one suspicious cucumber', note: 'Customer note: "Please don\'t substitute the cat."' },
  { basket: 'a rotisserie chicken marked DO NOT SAMPLE', note: 'Customer note: "Flat 6. The lift is on lunch."' },
  { basket: 'braai charcoal, vegan wors and emotional support rusks', note: 'Customer note: "Now now please, not just now."' },
  { basket: 'six eggs and a birthday cake with somebody else\'s name', note: 'Customer note: "If security asks, you are my cousin."' },
];

export function courierOrder(index: number): CourierOrder {
  return COURIER_ORDERS[((Math.floor(index) % COURIER_ORDERS.length) + COURIER_ORDERS.length) % COURIER_ORDERS.length]!;
}

export function courierBasePay(distance: number): number {
  return Math.round(COURIER_BASE_PAY + Math.max(0, distance) / 100 * COURIER_PAY_PER_100U);
}

/** Enough for brisk city riding, but not enough for sightseeing in Midrand. */
export function courierTimeLimit(distance: number): number {
  return Math.max(38, Math.round(Math.max(0, distance) / 17 + 24));
}

export function courierHudText(job: CourierJob): string {
  if (job.phase === 'collecting') return `SIXTY-SEKONDS · ORDER ${job.completed + 1} PENDING`;
  if (job.phase === 'delivering') return `${Math.max(0, Math.ceil(job.timeLeft))} SEC · GROCERIES ${Math.round(job.condition)}%`;
  return 'SIXTY-SEKONDS · UNEMPLOYED';
}

export interface CourierPayout {
  base: number;
  careBonus: number;
  timeBonus: number;
  streakBonus: number;
  total: number;
  late: boolean;
  condition: number;
  streak: number;
}

/** Repeating shift loop: depot -> timed customer drop -> depot. Crashes bruise the basket and clean,
 *  on-time drops grow a streak, so the quick route is not automatically the profitable route. */
export class CourierJob {
  phase: CourierPhase = 'off-duty';
  completed = 0;
  streak = 0;
  distance = 0;
  basePay = 0;
  timeLeft = 0;
  condition = 100;
  late = false;

  get active(): boolean { return this.phase !== 'off-duty'; }
  get order(): CourierOrder { return courierOrder(this.completed); }

  clockIn(): boolean {
    if (this.active) return false;
    this.phase = 'collecting'; this.streak = 0;
    return true;
  }

  clockOut(): void {
    this.phase = 'off-duty'; this.distance = 0; this.basePay = 0; this.timeLeft = 0; this.condition = 100; this.late = false; this.streak = 0;
  }

  collect(distance: number): boolean {
    if (this.phase !== 'collecting') return false;
    this.phase = 'delivering'; this.distance = Math.max(0, distance); this.basePay = courierBasePay(distance);
    this.timeLeft = courierTimeLimit(distance); this.condition = 100; this.late = false;
    return true;
  }

  /** Returns true once, on the frame this order becomes officially "just now". */
  update(dt: number): boolean {
    if (this.phase !== 'delivering' || dt <= 0 || this.late) return false;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft > 0) return false;
    this.late = true; this.streak = 0;
    return true;
  }

  /** Impact maps to crushed-grocery percentage. Tiny kerb taps still cost 1%; chaos costs considerably more. */
  recordCrash(impact: number): number {
    if (this.phase !== 'delivering' || impact <= 0) return 0;
    const damage = Math.max(1, Math.round(impact * 1.35));
    this.condition = Math.max(0, this.condition - damage);
    return damage;
  }

  deliver(): CourierPayout | undefined {
    if (this.phase !== 'delivering') return undefined;
    const clean = !this.late && this.condition >= 70;
    this.streak = clean ? this.streak + 1 : 0;
    const careBonus = Math.round(this.basePay * (this.condition / 100) * COURIER_CARE_RATIO);
    const timeBonus = this.late ? 0 : Math.min(COURIER_TIME_BONUS_CAP, Math.round(this.timeLeft * COURIER_TIME_BONUS_PER_SECOND));
    const streakBonus = clean ? this.streak * COURIER_STREAK_BONUS : 0;
    const payout = { base: this.basePay, careBonus, timeBonus, streakBonus, total: this.basePay + careBonus + timeBonus + streakBonus, late: this.late, condition: this.condition, streak: this.streak };
    this.completed += 1; this.phase = 'collecting'; this.distance = 0; this.basePay = 0; this.timeLeft = 0; this.condition = 100; this.late = false;
    return payout;
  }
}
