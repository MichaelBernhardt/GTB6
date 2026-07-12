export const MULTIPLAYER_PROTOCOL_VERSION = 1;

export interface NetPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  health: number;
  kills: number;
  deaths: number;
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
}

export type ClientMessage =
  | { type: 'hello'; version: number; name: string; token?: string }
  | { type: 'input'; seq: number; forward: number; side: number; sprint: boolean; aiming: boolean; yaw: number }
  | { type: 'fire'; seq: number; direction: [number, number, number] }
  | { type: 'interact' }
  | { type: 'chat'; text: string }
  | { type: 'ping'; sentAt: number };

export type ServerMessage =
  | { type: 'welcome'; playerId: string; token: string; tickRate: number; capacity: number }
  | { type: 'snapshot'; tick: number; acknowledgedInput: number; players: NetPlayer[]; vehicles: NetVehicle[] }
  | { type: 'chat'; playerId?: string; name: string; text: string; system?: boolean }
  | { type: 'combat'; kind: 'shot' | 'hit' | 'kill' | 'respawn'; actorId: string; targetId?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; sentAt: number };

export function parseServerMessage(raw: string): ServerMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return undefined;
    return value as ServerMessage;
  } catch {
    return undefined;
  }
}

export function multiplayerWebSocketUrl(locationLike: Pick<Location, 'protocol' | 'host'> = location): string {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/multiplayer`;
}
