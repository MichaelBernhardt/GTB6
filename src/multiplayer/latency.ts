export function onlineCorrectionFactor(error: number, moving: boolean, dead: boolean, inVehicle: boolean): number {
  if (dead || inVehicle || error > 8) return 1;
  if (moving || error < 0.25) return 0;
  return 0.35;
}

export function extrapolateVehicle(x: number, z: number, heading: number, speed: number, seconds: number): [number, number] {
  return [x + Math.sin(heading) * speed * seconds, z + Math.cos(heading) * speed * seconds];
}
