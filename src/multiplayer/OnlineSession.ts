import * as THREE from 'three';
import { MultiplayerOverlay } from './MultiplayerOverlay';
import { MULTIPLAYER_PROTOCOL_VERSION, multiplayerWebSocketUrl, parseServerMessage, type ClientMessage, type NetPlayer, type NetVehicle } from './protocol';

const TOKEN_KEY = 'groot-theft-bakkie-multiplayer-token';

class RemoteAvatar {
  group = new THREE.Group();
  private target = new THREE.Vector3();
  private targetHeading = 0;
  private label: THREE.Sprite;

  constructor(scene: THREE.Scene, readonly id: string, name: string) {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.9, 5, 10), new THREE.MeshStandardMaterial({ color: 0x36c2a0, roughness: 0.75 })); body.position.y = 0.95; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshStandardMaterial({ color: 0x8b5a3c, roughness: 0.9 })); head.position.y = 1.85; head.castShadow = true;
    this.label = this.makeLabel(name); this.label.position.y = 2.55; this.group.add(body, head, this.label); this.group.name = `RemotePlayer:${id}`; scene.add(this.group);
  }
  private makeLabel(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96; const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(8,15,16,.82)'; context.roundRect(8, 8, 496, 80, 18); context.fill(); context.fillStyle = '#f7f0d0'; context.font = '700 38px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(name, 256, 49, 470);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })); sprite.scale.set(3.5, 0.66, 1); return sprite;
  }
  setState(state: NetPlayer): void { this.target.set(state.x, state.y, state.z); this.targetHeading = state.heading; this.group.visible = !state.dead; }
  update(dt: number): void { this.group.position.lerp(this.target, 1 - Math.exp(-dt * 14)); this.group.rotation.y += Math.atan2(Math.sin(this.targetHeading - this.group.rotation.y), Math.cos(this.targetHeading - this.group.rotation.y)) * (1 - Math.exp(-dt * 14)); }
  dispose(scene: THREE.Scene): void { scene.remove(this.group); this.group.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) { object.geometry?.dispose(); const material = object.material; if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material.dispose(); } }); }
}

class RemoteVehicle {
  group = new THREE.Group();
  private target = new THREE.Vector3();
  private targetHeading = 0;
  constructor(scene: THREE.Scene, state: NetVehicle) {
    const colors = { compact: 0xd8b23d, sport: 0xd84b3d, bakkie: 0x4d83a8 };
    const body = new THREE.Mesh(new THREE.BoxGeometry(state.kind === 'bakkie' ? 2.1 : 1.8, 0.75, state.kind === 'sport' ? 3.8 : 4.2), new THREE.MeshStandardMaterial({ color: colors[state.kind], roughness: 0.55, metalness: 0.18 })); body.position.y = 0.72; body.castShadow = true;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.65, 1.75), new THREE.MeshStandardMaterial({ color: 0x26383c, roughness: 0.3, metalness: 0.4 })); cabin.position.set(0, 1.34, state.kind === 'bakkie' ? 0.55 : 0); cabin.castShadow = true;
    this.group.add(body, cabin); this.group.name = `OnlineVehicle:${state.id}`; scene.add(this.group); this.setState(state);
  }
  setState(state: NetVehicle): void { this.target.set(state.x, state.y, state.z); this.targetHeading = state.heading; }
  update(dt: number): void { this.group.position.lerp(this.target, 1 - Math.exp(-dt * 14)); this.group.rotation.y += Math.atan2(Math.sin(this.targetHeading - this.group.rotation.y), Math.cos(this.targetHeading - this.group.rotation.y)) * (1 - Math.exp(-dt * 14)); }
  dispose(scene: THREE.Scene): void { scene.remove(this.group); this.group.traverse((object) => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); const material = object.material; if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material.dispose(); } }); }
}

export interface OnlineInput { forward: number; side: number; sprint: boolean; yaw: number }

export class OnlineSession {
  private socket?: WebSocket;
  private avatars = new Map<string, RemoteAvatar>();
  private vehicles = new Map<string, RemoteVehicle>();
  private inputSeq = 0;
  private fireSeq = 0;
  private sendAccumulator = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionallyClosed = false;
  private players: NetPlayer[] = [];
  private playerNames = new Map<string, string>();
  selfId?: string;
  connected = false;
  localState?: NetPlayer;

  constructor(private scene: THREE.Scene, private overlay: MultiplayerOverlay, private name: string, private surfaceHeight: (x: number, z: number) => number) {
    this.overlay.onChat = (text) => this.send({ type: 'chat', text }); this.overlay.show(); this.connect();
  }
  private connect(): void {
    this.overlay.setStatus('Connecting to the global world…');
    const socket = new WebSocket(multiplayerWebSocketUrl()); this.socket = socket;
    socket.addEventListener('open', () => this.send({ type: 'hello', version: MULTIPLAYER_PROTOCOL_VERSION, name: this.name, token: localStorage.getItem(TOKEN_KEY) ?? undefined }));
    socket.addEventListener('message', (event) => this.message(String(event.data)));
    socket.addEventListener('close', () => { this.connected = false; this.overlay.setStatus('Connection lost · reconnecting…', true); if (!this.intentionallyClosed) this.reconnectTimer = setTimeout(() => this.connect(), 2000); });
    socket.addEventListener('error', () => this.overlay.setStatus('Could not reach the multiplayer server.', true));
  }
  private message(raw: string): void {
    const message = parseServerMessage(raw); if (!message) return;
    if (message.type === 'welcome') { this.selfId = message.playerId; localStorage.setItem(TOKEN_KEY, message.token); this.connected = true; this.overlay.setStatus(`GLOBAL WORLD · ${message.capacity} PLAYER CAP`); }
    else if (message.type === 'snapshot') this.snapshot(message.players, message.vehicles);
    else if (message.type === 'chat') this.overlay.chat(message.name, message.text, message.system);
    else if (message.type === 'combat') {
      const actor = this.playerNames.get(message.actorId) ?? 'Player'; const target = message.targetId ? this.playerNames.get(message.targetId) ?? 'Player' : undefined;
      if (message.kind === 'kill') this.overlay.event(`${actor} eliminated ${target}`);
      else if (message.kind === 'hit' && message.targetId === this.selfId) this.overlay.event(`${actor} hit you`);
      else if (message.kind === 'respawn' && message.actorId === this.selfId) this.overlay.event('Back on the streets');
    } else if (message.type === 'error') this.overlay.setStatus(message.message, true);
  }
  private snapshot(players: NetPlayer[], vehicles: NetVehicle[]): void {
    this.players = players; this.playerNames = new Map(players.map((player) => [player.id, player.name])); this.localState = players.find((player) => player.id === this.selfId); this.overlay.setPlayers(players, this.selfId);
    const live = new Set(players.map((player) => player.id));
    for (const state of players) {
      if (state.id === this.selfId) continue;
      let avatar = this.avatars.get(state.id); if (!avatar) { avatar = new RemoteAvatar(this.scene, state.id, state.name); this.avatars.set(state.id, avatar); }
      avatar.setState({ ...state, y: this.surfaceHeight(state.x, state.z), dead: state.dead || Boolean(state.vehicleId) });
    }
    for (const [id, avatar] of this.avatars) if (!live.has(id)) { avatar.dispose(this.scene); this.avatars.delete(id); }
    const liveVehicles = new Set(vehicles.map((vehicle) => vehicle.id));
    for (const state of vehicles) {
      const grounded = { ...state, y: this.surfaceHeight(state.x, state.z) }; let vehicle = this.vehicles.get(state.id);
      if (!vehicle) { vehicle = new RemoteVehicle(this.scene, grounded); this.vehicles.set(state.id, vehicle); } else vehicle.setState(grounded);
    }
    for (const [id, vehicle] of this.vehicles) if (!liveVehicles.has(id)) { vehicle.dispose(this.scene); this.vehicles.delete(id); }
  }
  update(dt: number, input: OnlineInput): NetPlayer | undefined {
    for (const avatar of this.avatars.values()) avatar.update(dt);
    for (const vehicle of this.vehicles.values()) vehicle.update(dt);
    this.sendAccumulator += dt;
    if (this.sendAccumulator >= 1 / 30) { this.sendAccumulator %= 1 / 30; this.send({ type: 'input', seq: ++this.inputSeq, ...input }); }
    return this.localState;
  }
  fire(direction: THREE.Vector3): void { this.send({ type: 'fire', seq: ++this.fireSeq, direction: [direction.x, direction.y, direction.z] }); }
  interact(): void { this.send({ type: 'interact' }); }
  private send(message: ClientMessage): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  close(): void { this.intentionallyClosed = true; clearTimeout(this.reconnectTimer); this.socket?.close(); for (const avatar of this.avatars.values()) avatar.dispose(this.scene); for (const vehicle of this.vehicles.values()) vehicle.dispose(this.scene); this.avatars.clear(); this.vehicles.clear(); this.overlay.hide(); }
  get playerCount(): number { return this.players.length; }
  get playerStates(): readonly NetPlayer[] { return this.players; }
}
