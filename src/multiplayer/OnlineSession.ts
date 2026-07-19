import * as THREE from 'three';
import { Vehicle } from '../entities/Vehicle';
import { RiggedPedestrianVisual, type RiggedPedestrianState } from '../entities/RiggedPedestrianVisual';
import { MultiplayerOverlay } from './MultiplayerOverlay';
import { extrapolateVehicle } from './latency';
import { hotBakkieObjective, type OnlineObjective } from './presentation';
import { MULTIPLAYER_PROTOCOL_VERSION, multiplayerWebSocketUrl, parseServerMessage, type ClientMessage, type HotBakkieState, type NetPlayer, type NetVehicle } from './protocol';

export interface OnlineInput { forward: number; side: number; sprint: boolean; aiming: boolean; yaw: number }

const TOKEN_KEY = 'groot-theft-bakkie-multiplayer-token';
const INPUT_RATE = 20;
const INPUT_KEEPALIVE_SECONDS = 0.5;
const INPUT_BACKPRESSURE_BYTES = 16 * 1024;

const normalizedInput = (input: OnlineInput): OnlineInput => ({
  forward: Math.round(input.forward * 100) / 100,
  side: Math.round(input.side * 100) / 100,
  sprint: input.sprint,
  aiming: input.aiming,
  yaw: Math.round(input.yaw * 10_000) / 10_000,
});

const sameInput = (left: OnlineInput | undefined, right: OnlineInput): boolean => Boolean(left && left.forward === right.forward && left.side === right.side && left.sprint === right.sprint && left.aiming === right.aiming && left.yaw === right.yaw);
const angleDelta = (from: number, to: number): number => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export class RemoteAvatar {
  readonly group = new THREE.Group();
  private target = new THREE.Vector3();
  private targetHeading = 0;
  private label: THREE.Sprite;
  private visual: RiggedPedestrianVisual;

  constructor(scene: THREE.Scene, readonly id: string, name: string, appearance: NetPlayer['appearance']) {
    this.group.name = `RemotePlayer:${id}`; scene.add(this.group);
    this.visual = new RiggedPedestrianVisual(this.group, appearance);
    void this.visual.load().catch(() => undefined);
    this.label = this.makeLabel(name); this.label.position.y = 2.55; this.group.add(this.label);
  }

  private makeLabel(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96; const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(8,15,16,.82)'; context.roundRect(8, 8, 496, 80, 18); context.fill(); context.fillStyle = '#f7f0d0'; context.font = '700 38px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(name, 256, 49, 470);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })); sprite.scale.set(3.5, 0.66, 1); return sprite;
  }

  setState(state: NetPlayer): void {
    this.target.set(state.x, state.y, state.z); this.targetHeading = state.heading;
    this.group.visible = !state.vehicleId; this.label.visible = !state.dead;
    const visualState: RiggedPedestrianState = {
      state: state.dead ? 'down' : state.locomotion === 'sprint' ? 'flee' : state.locomotion === 'walk' ? 'walk' : 'idle',
      dead: state.dead, knockdown: false, punching: false, punchElapsed: 0, braced: false, hailing: false, covering: state.aiming, stumbling: false, stumbleAmount: 0,
    };
    this.visual.setState(visualState);
  }

  update(dt: number): void {
    this.group.position.lerp(this.target, 1 - Math.exp(-dt * 14));
    this.group.rotation.y += angleDelta(this.group.rotation.y, this.targetHeading) * (1 - Math.exp(-dt * 14));
    this.visual.update(dt);
  }

  dispose(scene: THREE.Scene): void {
    this.visual.dispose(); scene.remove(this.group);
    const material = this.label.material; material.map?.dispose(); material.dispose();
  }
}

export class RemoteVehicle {
  readonly vehicle: Vehicle;
  private target = new THREE.Vector3();
  private targetHeading = 0;
  private targetSpeed = 0;
  private targetSteering = 0;
  private braking = false;
  private extrapolationSeconds = 0;

  constructor(scene: THREE.Scene, state: NetVehicle) {
    this.vehicle = new Vehicle(scene, state.kind === 'bakkie' ? 'van' : state.kind, new THREE.Vector3(state.x, state.y, state.z), state.isHot ? 0xef8d32 : undefined);
    this.vehicle.group.name = `OnlineVehicle:${state.id}`; this.setState(state);
  }

  get group(): THREE.Group { return this.vehicle.group; }

  setState(state: NetVehicle): void {
    const headingChange = angleDelta(this.targetHeading, state.heading);
    this.targetSteering = THREE.MathUtils.clamp(headingChange * 3.2, -0.48, 0.48);
    this.braking = Math.abs(state.speed) + 0.35 < Math.abs(this.targetSpeed);
    this.target.set(state.x, state.y, state.z); this.targetHeading = state.heading; this.targetSpeed = state.speed; this.extrapolationSeconds = 0;
    this.vehicle.health = state.health;
  }

  update(dt: number): void {
    const extrapolate = Math.min(dt, Math.max(0, 0.25 - this.extrapolationSeconds)); this.extrapolationSeconds += extrapolate;
    [this.target.x, this.target.z] = extrapolateVehicle(this.target.x, this.target.z, this.targetHeading, this.targetSpeed, extrapolate);
    this.group.position.lerp(this.target, 1 - Math.exp(-dt * 14));
    this.group.rotation.y += angleDelta(this.group.rotation.y, this.targetHeading) * (1 - Math.exp(-dt * 14));
    this.vehicle.speed = this.targetSpeed; this.vehicle.heading = this.group.rotation.y;
    this.vehicle.steeringVisual = THREE.MathUtils.lerp(this.vehicle.steeringVisual, this.targetSteering, 1 - Math.exp(-dt * 10));
    this.vehicle.updatePresentation(dt, this.braking);
  }

  dispose(scene: THREE.Scene): void { scene.remove(this.group); this.vehicle.dispose(); }
}

export class OnlineSession {
  private socket?: WebSocket;
  private avatars = new Map<string, RemoteAvatar>();
  private vehicleVisuals = new Map<string, RemoteVehicle>();
  private inputSeq = 0;
  private fireSeq = 0;
  private sendAccumulator = 0;
  private inputKeepalive = INPUT_KEEPALIVE_SECONDS;
  private lastSentInput?: OnlineInput;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionallyClosed = false;
  private players: NetPlayer[] = [];
  private vehicles: NetVehicle[] = [];
  private playerNames = new Map<string, string>();
  private localCorrection?: NetPlayer;
  private hotBakkie?: HotBakkieState;
  selfId?: string;
  connected = false;
  localState?: NetPlayer;

  constructor(private scene: THREE.Scene, private overlay: MultiplayerOverlay, private name: string, private surfaceHeight: (x: number, z: number) => number) {
    this.overlay.onChat = (text) => this.send({ type: 'chat', text }); this.overlay.show(); this.connect();
  }

  private connect(): void {
    this.overlay.setStatus('Connecting to the global world…');
    const socket = new WebSocket(multiplayerWebSocketUrl()); this.socket = socket;
    socket.addEventListener('open', () => { this.lastSentInput = undefined; this.inputKeepalive = INPUT_KEEPALIVE_SECONDS; this.send({ type: 'hello', version: MULTIPLAYER_PROTOCOL_VERSION, name: this.name, token: localStorage.getItem(TOKEN_KEY) ?? undefined }); });
    socket.addEventListener('message', (event) => this.message(String(event.data)));
    socket.addEventListener('close', () => { this.connected = false; this.overlay.setStatus('Connection lost · reconnecting…', true); if (!this.intentionallyClosed) this.reconnectTimer = setTimeout(() => this.connect(), 2000); });
    socket.addEventListener('error', () => this.overlay.setStatus('Could not reach the multiplayer server.', true));
  }

  private message(raw: string): void {
    const message = parseServerMessage(raw); if (!message) return;
    if (message.type === 'welcome') {
      this.selfId = message.playerId; localStorage.setItem(TOKEN_KEY, message.token); this.connected = true; this.overlay.setStatus(`GLOBAL WORLD · ${message.capacity} PLAYER CAP`);
      this.localState = {
        id: message.playerId, name: this.name, appearance: 'braamfontein-creative', runs: 0, ...message.spawn,
        health: 100, kills: 0, deaths: 0, ammo: 12, reserve: 84, reloading: false, locomotion: 'idle', aiming: false, dead: false, protected: true,
      };
      this.localCorrection = this.localState;
    }
    else if (message.type === 'snapshot') this.snapshot(message.players, message.vehicles, message.hotBakkie);
    else if (message.type === 'chat') this.overlay.chat(message.name, message.text, message.system);
    else if (message.type === 'combat') {
      const actor = this.playerNames.get(message.actorId) ?? 'Player'; const target = message.targetId ? this.playerNames.get(message.targetId) ?? 'Player' : undefined;
      if (message.kind === 'kill') this.overlay.event(`${actor} eliminated ${target}`);
      else if (message.kind === 'hit' && message.targetId === this.selfId) this.overlay.event(`${actor} hit you`);
      else if (message.kind === 'respawn' && message.actorId === this.selfId) this.overlay.event('Back on the streets');
    }
    else if (message.type === 'hot-bakkie-event') {
      const actor = message.actorId ? this.playerNames.get(message.actorId) ?? 'A runner' : undefined;
      const previous = message.previousActorId ? this.playerNames.get(message.previousActorId) ?? 'the last carrier' : undefined;
      if (message.kind === 'start') this.overlay.event('HOT BAKKIE RUN IS LIVE');
      else if (message.kind === 'claim') this.overlay.event(`${actor} claimed the Hot Bakkie`);
      else if (message.kind === 'takeover') this.overlay.event(`${actor} took the Hot Bakkie from ${previous}`);
      else if (message.kind === 'checkpoint') this.overlay.event(`${actor} cleared checkpoint ${message.progress}`);
      else if (message.kind === 'delivery') this.overlay.event(`${actor} delivered the Hot Bakkie`);
      else if (message.kind === 'timeout') this.overlay.event('Hot Bakkie timed out — nobody delivered');
    }
    else if (message.type === 'error') this.overlay.setStatus(message.message, true);
  }

  private snapshot(players: NetPlayer[], vehicles: NetVehicle[], hotBakkie: HotBakkieState): void {
    this.players = players; this.vehicles = vehicles; this.hotBakkie = hotBakkie;
    this.playerNames = new Map(players.map((player) => [player.id, player.name])); this.localState = players.find((player) => player.id === this.selfId); this.localCorrection = this.localState;
    this.overlay.setPlayers(players, this.selfId, hotBakkie.carrier);
    const live = new Set(players.map((player) => player.id));
    for (const state of players) {
      if (state.id === this.selfId) continue;
      let avatar = this.avatars.get(state.id); if (!avatar) { avatar = new RemoteAvatar(this.scene, state.id, state.name, state.appearance); this.avatars.set(state.id, avatar); }
      avatar.setState({ ...state, y: this.surfaceHeight(state.x, state.z) });
    }
    for (const [id, avatar] of this.avatars) if (!live.has(id)) { avatar.dispose(this.scene); this.avatars.delete(id); }
    const liveVehicles = new Set(vehicles.map((vehicle) => vehicle.id));
    for (const state of vehicles) {
      const grounded = { ...state, y: this.surfaceHeight(state.x, state.z) }; let vehicle = this.vehicleVisuals.get(state.id);
      if (!vehicle) { vehicle = new RemoteVehicle(this.scene, grounded); this.vehicleVisuals.set(state.id, vehicle); } else vehicle.setState(grounded);
    }
    for (const [id, vehicle] of this.vehicleVisuals) if (!liveVehicles.has(id)) { vehicle.dispose(this.scene); this.vehicleVisuals.delete(id); }
  }

  update(dt: number, input: OnlineInput): NetPlayer | undefined {
    for (const avatar of this.avatars.values()) avatar.update(dt);
    for (const vehicle of this.vehicleVisuals.values()) vehicle.update(dt);
    this.sendAccumulator += dt; this.inputKeepalive += dt;
    if (this.sendAccumulator >= 1 / INPUT_RATE) {
      this.sendAccumulator %= 1 / INPUT_RATE;
      const latest = normalizedInput(input);
      if ((!sameInput(this.lastSentInput, latest) || this.inputKeepalive >= INPUT_KEEPALIVE_SECONDS) && this.sendInput(latest)) {
        this.lastSentInput = latest; this.inputKeepalive = 0;
      }
    }
    return this.localState;
  }

  fire(direction: THREE.Vector3): void { this.send({ type: 'fire', seq: ++this.fireSeq, direction: [direction.x, direction.y, direction.z] }); }
  reload(): void { this.send({ type: 'reload' }); }
  interact(): void { this.send({ type: 'interact' }); }

  private sendInput(input: OnlineInput): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > INPUT_BACKPRESSURE_BYTES) return false;
    this.socket.send(JSON.stringify({ type: 'input', seq: ++this.inputSeq, ...input } satisfies ClientMessage)); return true;
  }

  private send(message: ClientMessage): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  consumeLocalCorrection(): NetPlayer | undefined { const state = this.localCorrection; this.localCorrection = undefined; return state; }

  close(): void {
    this.intentionallyClosed = true; clearTimeout(this.reconnectTimer); this.socket?.close();
    for (const avatar of this.avatars.values()) avatar.dispose(this.scene); for (const vehicle of this.vehicleVisuals.values()) vehicle.dispose(this.scene);
    this.avatars.clear(); this.vehicleVisuals.clear(); this.players = []; this.vehicles = []; this.hotBakkie = undefined; this.overlay.hide();
  }

  get playerCount(): number { return this.players.length; }
  get playerStates(): readonly NetPlayer[] { return this.players; }
  get vehicleStates(): readonly NetVehicle[] { return this.vehicles; }
  get hotBakkieState(): HotBakkieState | undefined { return this.hotBakkie; }
  get objective(): OnlineObjective | undefined { return hotBakkieObjective(this.hotBakkie, this.players, this.vehicles, this.selfId); }
}
