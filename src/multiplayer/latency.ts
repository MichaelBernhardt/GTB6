// The local player is never corrected: each client is authoritative over its own pose (see OnlineSession).
// Latency handling is therefore purely about presenting OTHER players' state smoothly.
export function extrapolateVehicle(x: number, z: number, heading: number, speed: number, seconds: number): [number, number] {
  return [x + Math.sin(heading) * speed * seconds, z + Math.cos(heading) * speed * seconds];
}
