import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createProfileStore } from './profile-store.mjs';

export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 20;
export const SNAPSHOT_RATE = 10;
export const CAPACITY = 16;
const WORLD_LIMIT = 8800;
const PLAYER_RADIUS = 0.65;
const FIRE_RANGE = 120;
const FIRE_DAMAGE = 34;
const FIRE_COOLDOWN_MS = 330;
const RESPAWN_MS = 3000;
const SPAWN_PROTECTION_MS = 2500;
const SPAWNS = [[2050, 3850], [2200, 4020], [1850, 4200], [2450, 3900]];
const VEHICLE_SPAWNS = [[2053, 3850, 0], [2203, 4020, Math.PI / 2], [1853, 4200, Math.PI], [2453, 3900, -Math.PI / 2], [2130, 4100, Math.PI], [1980, 3950, 0]];

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
export function cleanName(value) {
  return [...String(value ?? '')].filter((character) => character.charCodeAt(0) >= 32 && character !== '<' && character !== '>').join('').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player';
}
export function cleanChat(value) {
  return [...String(value ?? '')].filter((character) => character.charCodeAt(0) >= 32).join('').replace(/\s+/g, ' ').trim().slice(0, 180);
}
export function parseClientMessage(raw) {
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' && typeof value.type === 'string' ? value : undefined;
  } catch { return undefined; }
}

export class MultiplayerWorld {
  constructor({ capacity = CAPACITY, store = createProfileStore(), now = () => Date.now() } = {}) {
    this.capacity = capacity; this.store = store; this.now = now; this.players = new Map(); this.tickNumber = 0;
    this.vehicles = new Map(VEHICLE_SPAWNS.map(([x, z, heading], index) => { const id = `vehicle-${index + 1}`; return [id, { id, kind: ['compact', 'sport', 'bakkie'][index % 3], x, y: 0, z, heading, speed: 0, health: 100, driverId: undefined }]; }));
  }
  async init() { await this.store.init(); }
  async join(socket, hello) {
    if (this.players.size >= this.capacity) throw Object.assign(new Error('The world is full.'), { code: 'SERVER_FULL' });
    if (hello.version !== PROTOCOL_VERSION) throw Object.assign(new Error('Refresh the game to use the current multiplayer version.'), { code: 'VERSION_MISMATCH' });
    const name = cleanName(hello.name);
    const loaded = await this.store.load(typeof hello.token === 'string' ? hello.token : undefined, name);
    const spawn = SPAWNS[this.players.size % SPAWNS.length]; const now = this.now();
    const player = { id: randomUUID(), socket, token: loaded.token, name, kills: loaded.profile.kills, deaths: loaded.profile.deaths,
      x: spawn[0], y: 0, z: spawn[1], heading: Math.PI, health: 100, deadUntil: 0, protectedUntil: now + SPAWN_PROTECTION_MS,
      input: { seq: 0, forward: 0, side: 0, sprint: false, yaw: Math.PI }, lastFire: 0, ammo: 12, reserve: 120, reloadingUntil: 0, chatTimes: [] };
    this.players.set(player.id, player);
    return player;
  }
  async leave(player) {
    if (!player || !this.players.delete(player.id)) return;
    if (player.vehicleId) { const vehicle = this.vehicles.get(player.vehicleId); if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; } }
    await this.store.save(player.token, { name: player.name, kills: player.kills, deaths: player.deaths });
  }
  interact(player) {
    if (!player || player.deadUntil) return false;
    if (player.vehicleId) {
      const vehicle = this.vehicles.get(player.vehicleId); if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; player.x += Math.cos(vehicle.heading) * 2.2; player.z -= Math.sin(vehicle.heading) * 2.2; }
      player.vehicleId = undefined; return true;
    }
    let nearest; let distance = 4;
    for (const vehicle of this.vehicles.values()) { const candidate = Math.hypot(vehicle.x - player.x, vehicle.z - player.z); if (!vehicle.driverId && candidate < distance) { nearest = vehicle; distance = candidate; } }
    if (!nearest) return false; nearest.driverId = player.id; player.vehicleId = nearest.id; player.x = nearest.x; player.z = nearest.z; player.heading = nearest.heading; return true;
  }
  input(player, message) {
    if (!player || !Number.isInteger(message.seq) || message.seq <= player.input.seq) return;
    player.input = { seq: message.seq, forward: clamp(message.forward, -1, 1), side: clamp(message.side, -1, 1), sprint: Boolean(message.sprint), yaw: clamp(message.yaw, -Math.PI * 8, Math.PI * 8) };
  }
  fire(player, message) {
    const now = this.now();
    if (!player || player.deadUntil || now - player.lastFire < FIRE_COOLDOWN_MS || now < player.protectedUntil || now < player.reloadingUntil) return undefined;
    const direction = Array.isArray(message.direction) ? message.direction.map(Number) : [];
    const length = Math.hypot(direction[0] || 0, direction[1] || 0, direction[2] || 0);
    if (length < 0.9 || length > 1.1) return undefined;
    if (player.ammo <= 0) { if (player.reserve > 0) player.reloadingUntil = now + 1200; return undefined; }
    player.lastFire = now; player.ammo -= 1;
    const [dx, dy, dz] = direction.map((value) => value / length); let best; let bestT = FIRE_RANGE;
    for (const target of this.players.values()) {
      if (target === player || target.deadUntil || now < target.protectedUntil) continue;
      const ox = target.x - player.x; const oy = (target.y + 1) - (player.y + 1.4); const oz = target.z - player.z;
      const t = ox * dx + oy * dy + oz * dz;
      if (t <= 0 || t >= bestT) continue;
      const miss = Math.hypot(ox - dx * t, oy - dy * t, oz - dz * t);
      if (miss <= PLAYER_RADIUS) { best = target; bestT = t; }
    }
    if (!best) return { kind: 'shot', actorId: player.id };
    best.health = Math.max(0, best.health - FIRE_DAMAGE);
    if (best.health > 0) return { kind: 'hit', actorId: player.id, targetId: best.id };
    best.deaths += 1; player.kills += 1; best.deadUntil = now + RESPAWN_MS;
    if (best.vehicleId) { const vehicle = this.vehicles.get(best.vehicleId); if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; } best.vehicleId = undefined; }
    void this.store.save(best.token, { name: best.name, kills: best.kills, deaths: best.deaths });
    void this.store.save(player.token, { name: player.name, kills: player.kills, deaths: player.deaths });
    return { kind: 'kill', actorId: player.id, targetId: best.id };
  }
  chat(player, text) {
    const cleaned = cleanChat(text); const now = this.now();
    player.chatTimes = player.chatTimes.filter((time) => now - time < 5000);
    if (!cleaned || player.chatTimes.length >= 4) return undefined;
    player.chatTimes.push(now); return cleaned;
  }
  tick(dt = 1 / TICK_RATE) {
    const now = this.now(); this.tickNumber += 1; const events = [];
    for (const player of this.players.values()) {
      if (player.reloadingUntil && now >= player.reloadingUntil) { const loaded = Math.min(12, player.reserve); player.ammo = loaded; player.reserve -= loaded; player.reloadingUntil = 0; }
      if (player.deadUntil) {
        if (now < player.deadUntil) continue;
        const spawn = SPAWNS[this.tickNumber % SPAWNS.length]; player.x = spawn[0]; player.z = spawn[1]; player.health = 100; player.ammo = 12; player.reserve = 120; player.reloadingUntil = 0; player.deadUntil = 0; player.protectedUntil = now + SPAWN_PROTECTION_MS;
        events.push({ kind: 'respawn', actorId: player.id });
      }
      const input = player.input;
      if (player.vehicleId) {
        const vehicle = this.vehicles.get(player.vehicleId);
        if (!vehicle || vehicle.driverId !== player.id) { player.vehicleId = undefined; continue; }
        const throttle = input.forward; const targetSpeed = throttle >= 0 ? throttle * 32 : throttle * 12;
        vehicle.speed += (targetSpeed - vehicle.speed) * (1 - Math.exp(-dt * (throttle ? 3.2 : 1.7)));
        const steerScale = Math.min(1, Math.abs(vehicle.speed) / 5); vehicle.heading += input.side * steerScale * dt * 1.65 * (vehicle.speed < 0 ? -1 : 1);
        vehicle.x = clamp(vehicle.x + Math.sin(vehicle.heading) * vehicle.speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
        vehicle.z = clamp(vehicle.z + Math.cos(vehicle.heading) * vehicle.speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
        player.x = vehicle.x; player.z = vehicle.z; player.heading = vehicle.heading; continue;
      }
      const length = Math.hypot(input.side, input.forward); player.heading = input.yaw + Math.PI;
      if (length > 0) {
        const side = input.side / Math.max(1, length); const forward = input.forward / Math.max(1, length); const speed = input.sprint ? 11 : 6;
        const sin = Math.sin(input.yaw); const cos = Math.cos(input.yaw);
        player.x = clamp(player.x + (side * cos - forward * sin) * speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
        player.z = clamp(player.z + (-side * sin - forward * cos) * speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
      }
    }
    return events;
  }
  snapshot() {
    const now = this.now();
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, heading: p.heading, health: p.health, kills: p.kills, deaths: p.deaths, dead: Boolean(p.deadUntil), protected: now < p.protectedUntil, vehicleId: p.vehicleId }));
  }
  vehicleSnapshot() { return [...this.vehicles.values()].map((vehicle) => ({ ...vehicle })); }
  async close() { for (const player of this.players.values()) await this.store.save(player.token, { name: player.name, kills: player.kills, deaths: player.deaths }); await this.store.close(); }
}

const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
export async function attachMultiplayer(server, options = {}) {
  const world = new MultiplayerWorld(options); await world.init();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/multiplayer') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  const broadcast = (message) => { const encoded = JSON.stringify(message); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(encoded); };
  wss.on('connection', (socket) => {
    let player; const helloTimer = setTimeout(() => socket.close(4001, 'Handshake timeout'), 5000);
    socket.on('message', async (raw) => {
      const message = parseClientMessage(raw); if (!message) { socket.close(4002, 'Malformed message'); return; }
      if (!player) {
        if (message.type !== 'hello') { socket.close(4002, 'Hello required'); return; }
        try {
          player = await world.join(socket, message); clearTimeout(helloTimer);
          send(socket, { type: 'welcome', playerId: player.id, token: player.token, tickRate: TICK_RATE, capacity: world.capacity });
          broadcast({ type: 'chat', name: 'World', text: `${player.name} joined Johannesburg.`, system: true });
        } catch (error) { send(socket, { type: 'error', code: error.code ?? 'JOIN_FAILED', message: error.message }); socket.close(4003, error.code ?? 'Join failed'); }
        return;
      }
      if (message.type === 'input') world.input(player, message);
      else if (message.type === 'interact') world.interact(player);
      else if (message.type === 'fire') { const event = world.fire(player, message); if (event) broadcast({ type: 'combat', ...event }); }
      else if (message.type === 'chat') { const text = world.chat(player, message.text); if (text) broadcast({ type: 'chat', playerId: player.id, name: player.name, text }); }
      else if (message.type === 'ping') send(socket, { type: 'pong', sentAt: message.sentAt });
    });
    socket.on('close', () => { clearTimeout(helloTimer); if (player) { void world.leave(player); broadcast({ type: 'chat', name: 'World', text: `${player.name} left Johannesburg.`, system: true }); } });
  });
  const tickTimer = setInterval(() => { for (const event of world.tick()) broadcast({ type: 'combat', ...event }); }, 1000 / TICK_RATE);
  const snapshotTimer = setInterval(() => { const players = world.snapshot(); const vehicles = world.vehicleSnapshot(); for (const player of world.players.values()) send(player.socket, { type: 'snapshot', tick: world.tickNumber, acknowledgedInput: player.input.seq, players, vehicles }); }, 1000 / SNAPSHOT_RATE);
  return { world, wss, async close() { clearInterval(tickTimer); clearInterval(snapshotTimer); for (const client of wss.clients) client.close(1012, 'Server restarting'); await new Promise((resolve) => wss.close(resolve)); await world.close(); } };
}
