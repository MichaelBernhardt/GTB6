export const WORLD_SIZE = 760;
export const ROAD_WIDTH = 24;
export const BLOCK_SIZE = 76;
export const PLAYER = {
  walkSpeed: 8,
  sprintSpeed: 13,
  jumpSpeed: 10,
  gravity: 27,
  radius: 0.65,
  height: 1.8,
  maxHealth: 100,
};

export type VehicleKind = 'compact' | 'sport' | 'van' | 'police';
export interface VehicleSpec {
  kind: VehicleKind;
  name: string;
  color: number;
  maxSpeed: number;
  acceleration: number;
  brake: number;
  steering: number;
  drag: number;
  health: number;
  size: [number, number, number];
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  compact: { kind: 'compact', name: 'Cielo Compact', color: 0xe7b23b, maxSpeed: 34, acceleration: 22, brake: 34, steering: 2.2, drag: 0.7, health: 100, size: [1.8, 1.35, 3.7] },
  sport: { kind: 'sport', name: 'Veloce R', color: 0xd83a40, maxSpeed: 48, acceleration: 31, brake: 42, steering: 2.45, drag: 0.55, health: 80, size: [1.9, 1.15, 4.15] },
  van: { kind: 'van', name: 'Porto Utility', color: 0x58a596, maxSpeed: 27, acceleration: 16, brake: 28, steering: 1.75, drag: 0.85, health: 145, size: [2.15, 2.15, 4.9] },
  police: { kind: 'police', name: 'SCPD Interceptor', color: 0x202b38, maxSpeed: 42, acceleration: 28, brake: 40, steering: 2.35, drag: 0.6, health: 130, size: [1.95, 1.4, 4.35] },
};

export const COLORS = {
  sky: 0x9fcbd5,
  fog: 0x9fcbd5,
  road: 0x30363b,
  sidewalk: 0xa9aaa0,
  grass: 0x698b5b,
  water: 0x2e8193,
};
