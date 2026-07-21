import type { NpcCharacterId } from '../entities/NpcCatalog';

export const MULTIPLAYER_PROTOCOL_VERSION = 3;
const ONLINE_APPEARANCE_IDS = ['braamfontein-creative', 'sandton-professional', 'rosebank-athlete', 'melville-creative', 'newtown-producer', 'fordsburg-restaurateur', 'maboneng-courier', 'parkhurst-architect'] as const;

export type NetLocomotion = 'idle' | 'walk' | 'sprint' | 'death';

export interface NetPlayer {
  id: string;
  name: string;
  appearance: NpcCharacterId;
  runs: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  health: number;
  kills: number;
  deaths: number;
  ammo: number;
  reserve: number;
  reloading: boolean;
  locomotion: NetLocomotion;
  aiming: boolean;
  dead: boolean;
  protected: boolean;
  vehicleId?: string;
}

export interface NetVehicle {
  id: string;
  kind: 'compact' | 'sport' | 'bakkie';
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  health: number;
  driverId?: string;
  isHot: boolean;
}

export interface NetPoint { x: number; y: number; z: number; heading: number }
export interface HotBakkieCheckpoint { x: number; z: number; label: string; delivery: boolean }
export interface HotBakkieState {
  phase: 'waiting' | 'countdown' | 'active' | 'cooldown';
  round: number;
  route: string;
  carrier?: string;
  currentCheckpoint?: HotBakkieCheckpoint;
  progress: number;
  total: number;
  remainingTime: number;
  winner?: string;
}

export interface NetVehicleReport { x: number; y: number; z: number; heading: number; speed: number }

export type ClientMessage =
  | { type: 'hello'; version: number; name: string; token?: string }
  | { type: 'state'; seq: number; epoch: number; x: number; y: number; z: number; heading: number; locomotion: 'idle' | 'walk' | 'sprint'; aiming: boolean; vehicle?: NetVehicleReport }
  | { type: 'fire'; seq: number; direction: [number, number, number]; tick: number }
  | { type: 'reload' }
  | { type: 'interact' }
  | { type: 'chat'; text: string }
  | { type: 'ping'; sentAt: number };

export type ServerMessage =
  | { type: 'welcome'; playerId: string; token: string; tickRate: number; capacity: number; spawn: NetPoint }
  | { type: 'snapshot'; tick: number; players: NetPlayer[]; vehicles: NetVehicle[]; hotBakkie: HotBakkieState }
  | { type: 'teleport'; epoch: number; x: number; y: number; z: number; heading: number }
  | { type: 'chat'; playerId?: string; name: string; text: string; system?: boolean }
  | { type: 'combat'; kind: 'shot' | 'hit' | 'kill' | 'respawn'; actorId: string; targetId?: string }
  | { type: 'hot-bakkie-event'; kind: 'start' | 'claim' | 'takeover' | 'checkpoint' | 'delivery' | 'timeout'; actorId?: string; previousActorId?: string; progress?: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; sentAt: number };

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const string = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalString = (value: unknown): value is string | undefined => value === undefined || string(value);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T => string(value) && choices.includes(value as T);

const isPoint = (value: unknown): value is NetPoint => record(value) && number(value.x) && number(value.y) && number(value.z) && number(value.heading);
const isCheckpoint = (value: unknown): value is HotBakkieCheckpoint => record(value) && number(value.x) && number(value.z) && string(value.label) && typeof value.delivery === 'boolean';
const isHotBakkie = (value: unknown): value is HotBakkieState => record(value)
  && oneOf(value.phase, ['waiting', 'countdown', 'active', 'cooldown']) && number(value.round) && string(value.route)
  && optionalString(value.carrier) && (value.currentCheckpoint === undefined || isCheckpoint(value.currentCheckpoint))
  && number(value.progress) && number(value.total) && number(value.remainingTime) && optionalString(value.winner);
const isPlayer = (value: unknown): value is NetPlayer => record(value)
  && string(value.id) && string(value.name) && oneOf(value.appearance, ONLINE_APPEARANCE_IDS) && number(value.runs)
  && number(value.x) && number(value.y) && number(value.z) && number(value.heading) && number(value.health)
  && number(value.kills) && number(value.deaths) && number(value.ammo) && number(value.reserve)
  && typeof value.reloading === 'boolean' && oneOf(value.locomotion, ['idle', 'walk', 'sprint', 'death'])
  && typeof value.aiming === 'boolean' && typeof value.dead === 'boolean' && typeof value.protected === 'boolean' && optionalString(value.vehicleId);
const isVehicle = (value: unknown): value is NetVehicle => record(value)
  && string(value.id) && oneOf(value.kind, ['compact', 'sport', 'bakkie'])
  && number(value.x) && number(value.y) && number(value.z) && number(value.heading) && number(value.speed) && number(value.health)
  && optionalString(value.driverId) && typeof value.isHot === 'boolean';

export function parseServerMessage(raw: string): ServerMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw); if (!record(value) || !string(value.type)) return undefined;
    if (value.type === 'welcome' && string(value.playerId) && string(value.token) && number(value.tickRate) && number(value.capacity) && isPoint(value.spawn)) return value as unknown as ServerMessage;
    if (value.type === 'snapshot' && number(value.tick) && Array.isArray(value.players) && value.players.every(isPlayer) && Array.isArray(value.vehicles) && value.vehicles.every(isVehicle) && isHotBakkie(value.hotBakkie)) return value as unknown as ServerMessage;
    if (value.type === 'teleport' && number(value.epoch) && number(value.x) && number(value.y) && number(value.z) && number(value.heading)) return value as unknown as ServerMessage;
    if (value.type === 'chat' && optionalString(value.playerId) && string(value.name) && string(value.text) && (value.system === undefined || typeof value.system === 'boolean')) return value as unknown as ServerMessage;
    if (value.type === 'combat' && oneOf(value.kind, ['shot', 'hit', 'kill', 'respawn']) && string(value.actorId) && optionalString(value.targetId)) return value as unknown as ServerMessage;
    if (value.type === 'hot-bakkie-event' && oneOf(value.kind, ['start', 'claim', 'takeover', 'checkpoint', 'delivery', 'timeout']) && optionalString(value.actorId) && optionalString(value.previousActorId) && (value.progress === undefined || number(value.progress))) return value as unknown as ServerMessage;
    if (value.type === 'error' && string(value.code) && string(value.message)) return value as unknown as ServerMessage;
    if (value.type === 'pong' && number(value.sentAt)) return value as unknown as ServerMessage;
    return undefined;
  } catch {
    return undefined;
  }
}

export function multiplayerWebSocketUrl(locationLike: Pick<Location, 'protocol' | 'host'> = location): string {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/multiplayer`;
}
