import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createProfileStore, tokenHash } from './profile-store.mjs';
import { ROAD_INDEX } from './road-network.mjs';

export const PROTOCOL_VERSION = 2;
export const TICK_RATE = 20;
export const SNAPSHOT_RATE = 10;
export const CAPACITY = 16;
export const SNAPSHOT_BACKPRESSURE_BYTES = 16 * 1024;
export const HOT_BAKKIE_COUNTDOWN_MS = 12_000;
export const HOT_BAKKIE_ACTIVE_MS = 180_000;
export const HOT_BAKKIE_COOLDOWN_MS = 15_000;
export const HOT_BAKKIE_CHECKPOINT_RADIUS = 14;
export const HOT_BAKKIE_DROP_RADIUS = 16;
export const HOT_BAKKIE_DROP_MAX_SPEED = 8;
const WORLD_LIMIT = 8800;
const PLAYER_RADIUS = 0.65;
const FIRE_RANGE = 120;
const FIRE_DAMAGE = 34;
const FIRE_COOLDOWN_MS = 330;
const RELOAD_MS = 1050;
const PISTOL_MAGAZINE = 12;
const PISTOL_RESERVE = 84;
const RESPAWN_MS = 3000;
const SPAWN_PROTECTION_MS = 2500;
const WALK_SPEED = 8;
const SPRINT_SPEED = 13;
const AIM_SPEED_MULTIPLIER = 0.5;

export const ONLINE_APPEARANCES = [
  'braamfontein-creative', 'sandton-professional', 'rosebank-athlete', 'melville-creative',
  'newtown-producer', 'fordsburg-restaurateur', 'maboneng-courier', 'parkhurst-architect',
];

// Authored against src/world/placements.ts. Pedestrian spawns remain on the pavement while route and
// vehicle points below are snapped to the actual committed road segments at module load.
export const ONLINE_SPAWNS = [
  { x: 2908.520609556788, z: 5319.355453015495, heading: Math.PI },
  { x: 2790.9037863490075, z: 5128.913773836396, heading: Math.PI / 2 },
  { x: 3022.6820274177016, z: 5406.92275983807, heading: 0 },
  { x: 2741.1572774468827, z: 5136.03018107958, heading: -Math.PI / 2 },
];

const ANCHORS = {
  portia: { x: 3022.6820274177016, z: 5406.92275983807, label: 'Portia on You-Bet Street' },
  gti: { x: 3064.998846076018, z: 5094.102261759049, label: 'the GTI on Commissioner' },
  candice: { x: 2741.1572774468827, z: 5136.03018107958, label: 'Candice at the rank' },
  tanker: { x: 3064.6480377231046, z: 5803.253539757389, label: 'the tanker on Wemmer' },
  kelvin: { x: 3114.1893072379708, z: 5818.029211349522, label: 'Kelvin Yard' },
  padstal: { x: 3114.585754008286, z: 5539.058282415662, label: 'Ouma se Padstal' },
  lockup: { x: 2752.494320310464, z: 5428.054705168942, label: 'the Anderson Street lock-up' },
};

const routePoint = (key, delivery = false) => {
  const anchor = ANCHORS[key]; const pose = ROAD_INDEX.nearestPose(anchor.x, anchor.z);
  return { x: pose.x, z: pose.z, heading: pose.heading, label: anchor.label, delivery };
};

export const HOT_BAKKIE_ROUTES = [
  { name: 'Commissioner Shuffle', spawn: routePoint('gti'), checkpoints: [routePoint('portia'), routePoint('candice'), routePoint('padstal'), routePoint('lockup', true)] },
  { name: 'Wemmer Yard Dash', spawn: routePoint('tanker'), checkpoints: [routePoint('kelvin'), routePoint('padstal'), routePoint('gti'), routePoint('portia', true)] },
  { name: 'Rank to Yard', spawn: routePoint('candice'), checkpoints: [routePoint('lockup'), routePoint('portia'), routePoint('gti'), routePoint('kelvin', true)] },
  { name: 'Padstal Lock-up', spawn: routePoint('padstal'), checkpoints: [routePoint('tanker'), routePoint('kelvin'), routePoint('candice'), routePoint('lockup', true)] },
];

const VEHICLE_ANCHORS = ['portia', 'gti', 'candice', 'tanker', 'padstal', 'lockup'];
const VEHICLE_SPAWNS = VEHICLE_ANCHORS.map((key, index) => {
  const point = routePoint(key); const offset = 10 + (index % 2) * 4;
  return ROAD_INDEX.nearestPose(point.x + Math.sin(point.heading) * offset, point.z + Math.cos(point.heading) * offset);
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const quantize = (value, places = 2) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const profileOf = (player) => ({ name: player.name, kills: player.kills, deaths: player.deaths, runs: player.runs });

export function appearanceForToken(token) {
  return ONLINE_APPEARANCES[Number.parseInt(tokenHash(token).slice(0, 8), 16) % ONLINE_APPEARANCES.length];
}
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
  constructor({ capacity = CAPACITY, store = createProfileStore(), now = () => Date.now(), roadIndex = ROAD_INDEX, analyticsEvent = () => undefined } = {}) {
    this.capacity = capacity; this.store = store; this.now = now; this.roadIndex = roadIndex; this.players = new Map(); this.tickNumber = 0; this.pendingEvents = [];
    this.analyticsEvent = analyticsEvent;
    this.hot = { phase: 'waiting', round: 0, routeIndex: 0, progress: 0, phaseEndsAt: 0, carrier: undefined, lastCarrier: undefined, winner: undefined };
    this.vehicles = new Map(VEHICLE_SPAWNS.map((spawn, index) => {
      const id = `vehicle-${index + 1}`;
      return [id, { id, kind: ['compact', 'sport', 'bakkie'][index % 3], x: spawn.x, y: 0, z: spawn.z, heading: spawn.heading, speed: 0, health: 100, driverId: undefined, isHot: false }];
    }));
    const spawn = HOT_BAKKIE_ROUTES[0].spawn;
    this.vehicles.set('hot-bakkie', { id: 'hot-bakkie', kind: 'bakkie', x: spawn.x, y: 0, z: spawn.z, heading: spawn.heading, speed: 0, health: 145, driverId: undefined, isHot: true });
  }

  async init() { await this.store.init(); }
  track(type, payload = {}) { Promise.resolve(this.analyticsEvent(type, payload)).catch((error) => console.error('[analytics] Multiplayer event failed.', error)); }

  async join(socket, hello) {
    if (this.players.size >= this.capacity) throw Object.assign(new Error('The world is full.'), { code: 'SERVER_FULL' });
    if (hello.version !== PROTOCOL_VERSION) throw Object.assign(new Error('Refresh the game to use the current multiplayer version.'), { code: 'VERSION_MISMATCH' });
    const name = cleanName(hello.name);
    const loaded = await this.store.load(typeof hello.token === 'string' ? hello.token : undefined, name);
    const spawn = ONLINE_SPAWNS[this.players.size % ONLINE_SPAWNS.length]; const now = this.now();
    const player = {
      id: randomUUID(), socket, token: loaded.token, name, appearance: appearanceForToken(loaded.token),
      kills: loaded.profile.kills ?? 0, deaths: loaded.profile.deaths ?? 0, runs: loaded.profile.runs ?? 0,
      x: spawn.x, y: 0, z: spawn.z, heading: spawn.heading, health: 100, deadUntil: 0, protectedUntil: now + SPAWN_PROTECTION_MS,
      input: { seq: 0, forward: 0, side: 0, sprint: false, aiming: false, yaw: spawn.heading - Math.PI },
      lastFire: 0, ammo: PISTOL_MAGAZINE, reserve: PISTOL_RESERVE, reloadingUntil: 0, chatTimes: [],
    };
    this.players.set(player.id, player);
    this.track('multiplayer_join', { concurrency: this.players.size });
    if (this.hot.phase === 'waiting') this.beginCountdown(now, false);
    return player;
  }

  welcomeSpawn(player) { return { x: quantize(player.x), y: quantize(player.y), z: quantize(player.z), heading: quantize(player.heading, 3) }; }

  async leave(player) {
    if (!player || !this.players.delete(player.id)) return;
    this.track('multiplayer_leave', { concurrency: this.players.size });
    this.releaseVehicle(player);
    await this.store.save(player.token, profileOf(player));
    if (this.players.size === 0) this.resetEmptyShard();
  }

  releaseVehicle(player) {
    if (!player?.vehicleId) return;
    const vehicle = this.vehicles.get(player.vehicleId);
    if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; }
    if (vehicle?.isHot && this.hot.carrier === player.id) this.hot.carrier = undefined;
    player.vehicleId = undefined;
  }

  interact(player) {
    if (!player || player.deadUntil) return false;
    if (player.vehicleId) {
      const vehicle = this.vehicles.get(player.vehicleId);
      if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; player.x += Math.cos(vehicle.heading) * 2.2; player.z -= Math.sin(vehicle.heading) * 2.2; }
      if (vehicle?.isHot && this.hot.carrier === player.id) this.hot.carrier = undefined;
      player.vehicleId = undefined; return true;
    }
    let nearest; let distance = 4;
    const candidates = [...this.vehicles.values()].sort((left, right) => Number(right.isHot) - Number(left.isHot));
    for (const vehicle of candidates) {
      if (vehicle.isHot && this.hot.phase !== 'active') continue;
      const candidate = Math.hypot(vehicle.x - player.x, vehicle.z - player.z);
      if (!vehicle.driverId && candidate < distance) { nearest = vehicle; distance = candidate; }
    }
    if (!nearest) return false;
    nearest.driverId = player.id; player.vehicleId = nearest.id; player.x = nearest.x; player.z = nearest.z; player.heading = nearest.heading;
    if (nearest.isHot) {
      const previousActorId = this.hot.lastCarrier;
      this.hot.carrier = player.id; this.hot.lastCarrier = player.id;
      this.pendingEvents.push({ type: 'hot-bakkie-event', kind: previousActorId && previousActorId !== player.id ? 'takeover' : 'claim', actorId: player.id, previousActorId });
    }
    return true;
  }

  input(player, message) {
    if (!player || !Number.isInteger(message.seq) || message.seq <= player.input.seq) return;
    player.input = { seq: message.seq, forward: clamp(message.forward, -1, 1), side: clamp(message.side, -1, 1), sprint: Boolean(message.sprint), aiming: Boolean(message.aiming), yaw: clamp(message.yaw, -Math.PI * 8, Math.PI * 8) };
  }

  reload(player) {
    const now = this.now();
    if (!player || player.deadUntil || player.vehicleId || player.reloadingUntil || player.ammo >= PISTOL_MAGAZINE || player.reserve <= 0) return false;
    player.reloadingUntil = now + RELOAD_MS; return true;
  }

  fire(player, message) {
    const now = this.now();
    if (!player || player.deadUntil || player.vehicleId || now - player.lastFire < FIRE_COOLDOWN_MS || now < player.protectedUntil || now < player.reloadingUntil) return undefined;
    const direction = Array.isArray(message.direction) ? message.direction.map(Number) : [];
    const length = Math.hypot(direction[0] || 0, direction[1] || 0, direction[2] || 0);
    if (length < 0.9 || length > 1.1) return undefined;
    if (player.ammo <= 0) return undefined;
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
    best.deaths += 1; player.kills += 1; best.deadUntil = now + RESPAWN_MS; this.releaseVehicle(best);
    this.track('multiplayer_kill');
    void this.store.save(best.token, profileOf(best)); void this.store.save(player.token, profileOf(player));
    return { kind: 'kill', actorId: player.id, targetId: best.id };
  }

  chat(player, text) {
    const cleaned = cleanChat(text); const now = this.now();
    player.chatTimes = player.chatTimes.filter((time) => now - time < 5000);
    if (!cleaned || player.chatTimes.length >= 4) return undefined;
    player.chatTimes.push(now); return cleaned;
  }

  beginCountdown(now = this.now(), nextRound = true) {
    if (nextRound || this.hot.round === 0) this.hot.round += 1;
    this.hot.phase = 'countdown'; this.hot.routeIndex = (this.hot.round - 1) % HOT_BAKKIE_ROUTES.length;
    this.hot.progress = 0; this.hot.carrier = undefined; this.hot.lastCarrier = undefined; this.hot.winner = undefined; this.hot.phaseEndsAt = now + HOT_BAKKIE_COUNTDOWN_MS;
    const spawn = HOT_BAKKIE_ROUTES[this.hot.routeIndex].spawn; const vehicle = this.vehicles.get('hot-bakkie');
    if (vehicle) Object.assign(vehicle, { x: spawn.x, z: spawn.z, heading: spawn.heading, speed: 0, health: 145, driverId: undefined });
  }

  beginCooldown(winner) {
    const previousCarrier = this.hot.carrier ? this.players.get(this.hot.carrier) : undefined;
    this.hot.phase = 'cooldown'; this.hot.phaseEndsAt = this.now() + HOT_BAKKIE_COOLDOWN_MS; this.hot.winner = winner; this.hot.carrier = undefined;
    const vehicle = this.vehicles.get('hot-bakkie'); if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; }
    if (previousCarrier) previousCarrier.vehicleId = undefined;
    if (winner) { winner.vehicleId = undefined; winner.runs += 1; void this.store.save(winner.token, profileOf(winner)); this.pendingEvents.push({ type: 'hot-bakkie-event', kind: 'delivery', actorId: winner.id }); this.track('hot_bakkie_delivery'); }
    else { this.pendingEvents.push({ type: 'hot-bakkie-event', kind: 'timeout' }); this.track('hot_bakkie_timeout'); }
  }

  resetEmptyShard() {
    this.hot = { phase: 'waiting', round: 0, routeIndex: 0, progress: 0, phaseEndsAt: 0, carrier: undefined, lastCarrier: undefined, winner: undefined };
    const vehicle = this.vehicles.get('hot-bakkie'); if (vehicle) { vehicle.driverId = undefined; vehicle.speed = 0; }
    this.pendingEvents.length = 0;
  }

  updateHotBakkie(now) {
    if (this.hot.phase === 'countdown' && now >= this.hot.phaseEndsAt) {
      this.hot.phase = 'active'; this.hot.phaseEndsAt = now + HOT_BAKKIE_ACTIVE_MS;
      this.pendingEvents.push({ type: 'hot-bakkie-event', kind: 'start' });
      this.track('hot_bakkie_start');
    }
    if (this.hot.phase === 'active' && now >= this.hot.phaseEndsAt) this.beginCooldown(undefined);
    if (this.hot.phase === 'cooldown' && now >= this.hot.phaseEndsAt && this.players.size > 0) this.beginCountdown(now);
    if (this.hot.phase !== 'active' || !this.hot.carrier) return;
    const carrier = this.players.get(this.hot.carrier); const vehicle = this.vehicles.get('hot-bakkie');
    if (!carrier || carrier.deadUntil || carrier.vehicleId !== vehicle?.id || vehicle.driverId !== carrier.id) { this.hot.carrier = undefined; return; }
    const route = HOT_BAKKIE_ROUTES[this.hot.routeIndex]; const checkpoint = route.checkpoints[this.hot.progress];
    if (!checkpoint) return;
    const radius = checkpoint.delivery ? HOT_BAKKIE_DROP_RADIUS : HOT_BAKKIE_CHECKPOINT_RADIUS;
    if (Math.hypot(vehicle.x - checkpoint.x, vehicle.z - checkpoint.z) > radius) return;
    if (checkpoint.delivery) {
      if (Math.abs(vehicle.speed) < HOT_BAKKIE_DROP_MAX_SPEED) this.beginCooldown(carrier);
      return;
    }
    this.hot.progress += 1;
    this.pendingEvents.push({ type: 'hot-bakkie-event', kind: 'checkpoint', actorId: carrier.id, progress: this.hot.progress });
  }

  tick(dt = 1 / TICK_RATE) {
    const now = this.now(); this.tickNumber += 1;
    for (const player of this.players.values()) {
      if (player.reloadingUntil && now >= player.reloadingUntil) {
        const loaded = Math.min(PISTOL_MAGAZINE - player.ammo, player.reserve); player.ammo += loaded; player.reserve -= loaded; player.reloadingUntil = 0;
      }
      if (player.deadUntil) {
        if (now < player.deadUntil) continue;
        const spawn = ONLINE_SPAWNS[this.tickNumber % ONLINE_SPAWNS.length];
        Object.assign(player, { x: spawn.x, y: 0, z: spawn.z, heading: spawn.heading, health: 100, ammo: PISTOL_MAGAZINE, reserve: PISTOL_RESERVE, reloadingUntil: 0, deadUntil: 0, protectedUntil: now + SPAWN_PROTECTION_MS });
        this.pendingEvents.push({ type: 'combat', kind: 'respawn', actorId: player.id });
      }
      const input = player.input;
      if (player.vehicleId) {
        const vehicle = this.vehicles.get(player.vehicleId);
        if (!vehicle || vehicle.driverId !== player.id) { player.vehicleId = undefined; continue; }
        const throttle = input.forward; const targetSpeed = throttle >= 0 ? throttle * 32 : throttle * 12;
        vehicle.speed += (targetSpeed - vehicle.speed) * (1 - Math.exp(-dt * (throttle ? 3.2 : 1.7)));
        const steerScale = Math.min(1, Math.abs(vehicle.speed) / 5); vehicle.heading += input.side * steerScale * dt * 1.65 * (vehicle.speed < 0 ? -1 : 1);
        const nextX = clamp(vehicle.x + Math.sin(vehicle.heading) * vehicle.speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
        const nextZ = clamp(vehicle.z + Math.cos(vehicle.heading) * vehicle.speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
        if (this.roadIndex.acceptsMove(vehicle.x, vehicle.z, nextX, nextZ)) { vehicle.x = nextX; vehicle.z = nextZ; }
        else vehicle.speed = 0;
        player.x = vehicle.x; player.z = vehicle.z; player.heading = vehicle.heading; continue;
      }
      const length = Math.hypot(input.side, input.forward); player.heading = input.yaw + Math.PI;
      if (length > 0) {
        const side = input.side / Math.max(1, length); const forward = input.forward / Math.max(1, length); const speed = (input.sprint ? SPRINT_SPEED : WALK_SPEED) * (input.aiming ? AIM_SPEED_MULTIPLIER : 1);
        const sin = Math.sin(input.yaw); const cos = Math.cos(input.yaw);
        player.x = clamp(player.x + (side * cos - forward * sin) * speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
        player.z = clamp(player.z + (-side * sin - forward * cos) * speed * dt, -WORLD_LIMIT, WORLD_LIMIT);
      }
    }
    this.updateHotBakkie(now);
    return this.consumeEvents();
  }

  consumeEvents() { const events = this.pendingEvents; this.pendingEvents = []; return events; }

  snapshot() {
    const now = this.now();
    return [...this.players.values()].map((player) => {
      const moving = Math.hypot(player.input.forward, player.input.side) > 0.05;
      const locomotion = player.deadUntil ? 'death' : moving ? player.input.sprint ? 'sprint' : 'walk' : 'idle';
      return {
        id: player.id, name: player.name, appearance: player.appearance, runs: player.runs,
        x: quantize(player.x), y: quantize(player.y), z: quantize(player.z), heading: quantize(player.heading, 3), health: player.health,
        kills: player.kills, deaths: player.deaths, ammo: player.ammo, reserve: player.reserve, reloading: Boolean(player.reloadingUntil),
        locomotion, aiming: player.input.aiming, dead: Boolean(player.deadUntil), protected: now < player.protectedUntil, vehicleId: player.vehicleId,
      };
    });
  }

  vehicleSnapshot() {
    return [...this.vehicles.values()].map((vehicle) => ({ ...vehicle, x: quantize(vehicle.x), y: quantize(vehicle.y), z: quantize(vehicle.z), heading: quantize(vehicle.heading, 3), speed: quantize(vehicle.speed) }));
  }

  hotBakkieSnapshot() {
    const route = HOT_BAKKIE_ROUTES[this.hot.routeIndex]; const checkpoint = route?.checkpoints[this.hot.progress];
    return {
      phase: this.hot.phase, round: this.hot.round, route: route?.name ?? '', carrier: this.hot.carrier,
      currentCheckpoint: checkpoint ? { x: quantize(checkpoint.x), z: quantize(checkpoint.z), label: checkpoint.label, delivery: checkpoint.delivery } : undefined,
      progress: this.hot.progress, total: 4, remainingTime: this.hot.phaseEndsAt ? Math.max(0, (this.hot.phaseEndsAt - this.now()) / 1000) : 0, winner: this.hot.winner?.id,
    };
  }

  async close() {
    for (const player of this.players.values()) await this.store.save(player.token, profileOf(player));
    await this.store.close();
  }
}

const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const sendSnapshot = (socket, message) => {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > SNAPSHOT_BACKPRESSURE_BYTES) return false;
  socket.send(JSON.stringify(message)); return true;
};

export async function attachMultiplayer(server, options = {}) {
  const world = new MultiplayerWorld(options); await world.init();
  const wss = new WebSocketServer({
    noServer: true, maxPayload: 4096,
    perMessageDeflate: { threshold: 512, concurrencyLimit: 4, zlibDeflateOptions: { level: 3 } },
  });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/multiplayer') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  const broadcast = (message) => { const encoded = JSON.stringify(message); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(encoded); };
  const broadcastEvents = (events) => { for (const event of events) broadcast(event); };
  wss.on('connection', (socket) => {
    let player; const helloTimer = setTimeout(() => socket.close(4001, 'Handshake timeout'), 5000);
    socket.on('message', async (raw) => {
      const message = parseClientMessage(raw); if (!message) { socket.close(4002, 'Malformed message'); return; }
      if (!player) {
        if (message.type !== 'hello') { socket.close(4002, 'Hello required'); return; }
        try {
          player = await world.join(socket, message); clearTimeout(helloTimer);
          send(socket, { type: 'welcome', playerId: player.id, token: player.token, tickRate: TICK_RATE, capacity: world.capacity, spawn: world.welcomeSpawn(player) });
          broadcast({ type: 'chat', name: 'World', text: `${player.name} joined Johannesburg.`, system: true });
        } catch (error) { send(socket, { type: 'error', code: error.code ?? 'JOIN_FAILED', message: error.message }); socket.close(4003, error.code ?? 'Join failed'); }
        return;
      }
      if (message.type === 'input') world.input(player, message);
      else if (message.type === 'interact') { world.interact(player); broadcastEvents(world.consumeEvents()); }
      else if (message.type === 'reload') world.reload(player);
      else if (message.type === 'fire') { const event = world.fire(player, message); if (event) broadcast({ type: 'combat', ...event }); }
      else if (message.type === 'chat') { const text = world.chat(player, message.text); if (text) broadcast({ type: 'chat', playerId: player.id, name: player.name, text }); }
      else if (message.type === 'ping') send(socket, { type: 'pong', sentAt: message.sentAt });
    });
    socket.on('close', () => { clearTimeout(helloTimer); if (player) { void world.leave(player); broadcast({ type: 'chat', name: 'World', text: `${player.name} left Johannesburg.`, system: true }); } });
  });
  const tickTimer = setInterval(() => broadcastEvents(world.tick()), 1000 / TICK_RATE);
  const snapshotTimer = setInterval(() => {
    const players = world.snapshot(); const vehicles = world.vehicleSnapshot(); const hotBakkie = world.hotBakkieSnapshot();
    for (const player of world.players.values()) sendSnapshot(player.socket, { type: 'snapshot', tick: world.tickNumber, acknowledgedInput: player.input.seq, players, vehicles, hotBakkie });
  }, 1000 / SNAPSHOT_RATE);
  return { world, wss, async close() { clearInterval(tickTimer); clearInterval(snapshotTimer); for (const client of wss.clients) client.close(1012, 'Server restarting'); await new Promise((resolve) => wss.close(resolve)); await world.close(); } };
}
