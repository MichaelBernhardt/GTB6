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
