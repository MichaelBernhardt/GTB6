export interface EngineState { gear: number; rpm: number; }

export const GEAR_STEPS = [0, 0.2, 0.42, 0.68, 1.0001];
export const IDLE_RPM = 0.22;

export function engineState(speed: number, maxSpeed: number): EngineState {
  const norm = Math.min(Math.max(Math.abs(speed) / Math.max(maxSpeed, 1), 0), 1);
  let gear = 0;
  while (gear < GEAR_STEPS.length - 2 && norm >= GEAR_STEPS[gear + 1]) gear += 1;
  const low = GEAR_STEPS[gear]; const high = GEAR_STEPS[gear + 1];
  const rpm = IDLE_RPM + (1 - IDLE_RPM) * Math.pow((norm - low) / (high - low), 0.85);
  return { gear, rpm: Math.min(rpm, 1) };
}

export interface EngineProfile { basePitch: number; brightness: number; throbRate: number; growl: number; level: number; }

export const ENGINE_PROFILES: Record<string, EngineProfile> = {
  compact: { basePitch: 1, brightness: 1, throbRate: 1, growl: 0.35, level: 1 },
  sport: { basePitch: 1.22, brightness: 1.3, throbRate: 1.3, growl: 0.9, level: 1.1 },
  van: { basePitch: 0.78, brightness: 0.82, throbRate: 0.75, growl: 0.3, level: 1.05 },
  police: { basePitch: 1.1, brightness: 1.12, throbRate: 1.1, growl: 0.55, level: 1 },
  taxi: { basePitch: 0.86, brightness: 0.9, throbRate: 0.85, growl: 0.45, level: 1.05 },
  // two-wheelers rev high and thin; the superbike out-sports even the GTI. Bicycles have NO profile — they never reach the engine voice.
  motorbike: { basePitch: 1.5, brightness: 1.35, throbRate: 1.75, growl: 0.75, level: 0.95 },
  superbike: { basePitch: 1.85, brightness: 1.6, throbRate: 2.2, growl: 1, level: 1.05 },
  plane: { basePitch: 1.35, brightness: 0.85, throbRate: 2.6, growl: 0.5, level: 1.05 }, // air-cooled prop drone: fast even throb, little snarl
};

export function engineProfile(kind?: string): EngineProfile { return ENGINE_PROFILES[kind ?? ''] ?? ENGINE_PROFILES.compact; }

/** Fundamental (firing-order) frequency in Hz for a normalized rpm. */
export function engineFrequency(rpm: number, basePitch = 1): number { return (34 + rpm * 92) * basePitch; }

/** Lowpass cutoff: tracks rpm, opens modestly under throttle, hard-capped low to avoid buzz. */
export function engineCutoff(rpm: number, throttle: number, brightness = 1): number {
  return Math.min(160 + (rpm * 300 + throttle * 280) * brightness, 950 * brightness);
}

/** Firing-order amplitude throb: rate follows rpm; depth is lumpy at idle, smooth at redline. */
export function engineThrob(rpm: number, throbRate = 1): { rate: number; depth: number } {
  return { rate: engineFrequency(rpm) * 0.25 * throbRate, depth: Math.max(0.07, 0.3 - rpm * 0.24) };
}

/** Engine loop gain: a quiet bed; coasting reads clearly quieter than throttle-on. */
export function engineLevel(rpm: number, throttle: number, level = 1): number {
  return (0.012 + rpm * 0.014 + throttle * 0.016) * level;
}

/** Pitch glide time constant: longer on a gear change so shifts sweep instead of jumping. */
export function shiftGlide(sameGear: boolean): number { return sameGear ? 0.06 : 0.16; }

/** Aggressive falloff for other vehicles' engines: tighter radius and steeper curve than distanceGain. */
export function trafficEngineGain(distance: number, ref = 8, max = 60): number {
  if (distance <= ref) return 1;
  if (distance >= max) return 0;
  return Math.pow((max - distance) / (max - ref), 2.2);
}

export function distanceGain(distance: number, ref = 12, max = 150): number {
  if (distance <= ref) return 1;
  if (distance >= max) return 0;
  return Math.pow((max - distance) / (max - ref), 1.6);
}

export function stereoPan(listenerX: number, listenerZ: number, yaw: number, sourceX: number, sourceZ: number): number {
  const dx = sourceX - listenerX; const dz = sourceZ - listenerZ;
  const length = Math.hypot(dx, dz);
  if (length < 1e-4) return 0;
  return Math.max(-1, Math.min(1, (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / length));
}
