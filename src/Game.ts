import * as THREE from 'three';
import { WEAPON_BY_ID, WEAPONS, type WeaponId } from './config';
import { AudioManager } from './core/AudioManager';
import { CameraController } from './core/CameraController';
import { cycleWeapon, Economy, rollDrops, type PedKind } from './core/GameRules';
import { InputManager } from './core/InputManager';
import { DEFAULT_SAVE, SaveManager } from './core/SaveManager';
import type { Pedestrian } from './entities/Pedestrian';
import { Player } from './entities/Player';
import type { Vehicle } from './entities/Vehicle';
import { CombatSystem } from './systems/CombatSystem';
import { FEAR_EVENTS } from './systems/FearSystem';
import { GoreSystem } from './systems/GoreSystem';
import { MISSIONS, MissionSystem, type MissionUpdate } from './systems/MissionSystem';
import { PickupSystem, type Pickup } from './systems/PickupSystem';
import { PoliceSystem } from './systems/PoliceSystem';
import { PopulationSystem } from './systems/PopulationSystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { WantedSystem } from './systems/WantedSystem';
import type { GameMode, GameSettings, SavedGame, WorldTarget } from './types';
import { UIManager } from './ui/UIManager';
import { City } from './world/City';
import { buildEnvironment } from './world/Environment';

interface Transition { vehicle: Vehicle; timer: number; entering: boolean; exitPosition?: THREE.Vector3; }

export class Game {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 950);
  private renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  private clock = new THREE.Clock();
  private input: InputManager;
  private audio = new AudioManager();
  private saveManager = new SaveManager();
  private save: SavedGame;
  private settings: GameSettings;
  private city: City;
  private player: Player;
  private cameraController: CameraController;
  private population: PopulationSystem;
  private combat: CombatSystem;
  private gore: GoreSystem;
  private pickups: PickupSystem;
  private projectiles: ProjectileSystem;
  private shake = 0;
  private wanted = new WantedSystem();
  private police: PoliceSystem;
  private missions = new MissionSystem();
  private economy: Economy;
  private ui = new UIManager();
  private mode: GameMode = 'menu';
  private activeVehicle?: Vehicle;
  private transition?: Transition;
  private marker = new THREE.Group();
  private markerTarget?: WorldTarget;
  private markerPhase = 0;
  private collectedItem = false;
  private hostileDefeated = 0;
  private deliveryIndex = 0;
  private deathTimer = 0;
  private saveTimer = 0;
  private footstepTimer = 0;
  private prevDrivenSpeed = 0;
  private wallCrashCooldown = 0;
  private fps = 60;
  private weaponWheelOpen = false;
  private wheelVector = new THREE.Vector2();
  private wheelHighlight: WeaponId = 'pistol';
  private previousObjective = '';
  private vehicleCollisionCooldown = new WeakMap<Vehicle, number>();

  constructor(private container: HTMLElement) {
    this.save = this.saveManager.load(); this.settings = { ...this.save.settings }; this.economy = new Economy(this.save.money);
    this.setupRenderer(); this.setupScene();
    this.city = new City(this.scene);
    this.player = new Player(this.scene, new THREE.Vector3(...this.save.spawn));
    this.cameraController = new CameraController(this.camera);
    this.population = new PopulationSystem(this.scene, this.city, this.audio);
    this.combat = new CombatSystem(this.scene, this.audio);
    this.gore = new GoreSystem(this.scene);
    this.pickups = new PickupSystem(this.scene);
    this.projectiles = new ProjectileSystem(this.scene);
    this.combat.onRocket = (origin, direction, spec) => { if (spec.projectile) this.projectiles.spawn(origin, direction, spec.projectile, spec.range); };
    this.police = new PoliceSystem(this.scene, this.city, this.audio);
    this.input = new InputManager(this.renderer.domElement);
    this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current);
    this.missions.completed = new Set(this.save.completedMissions);
    this.buildMarker(); this.bindUI(); this.animate();
    setTimeout(() => this.ui.showMainMenu(), 50);
  }

  private setupRenderer(): void {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = this.settings.quality === 'high'; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.autoUpdate = true;
    this.container.append(this.renderer.domElement); window.addEventListener('resize', () => this.resize());
  }

  private setupScene(): void {
    buildEnvironment(this.scene, this.settings.quality);
  }

  private bindUI(): void {
    this.ui.onStart = (fresh) => this.startGame(fresh);
    this.ui.onResume = () => { this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.renderer.domElement.requestPointerLock().catch(() => undefined); };
    this.ui.onRestart = () => { this.respawn(); this.mode = 'playing'; this.ui.hideMenu(); };
    this.ui.onResetSave = () => { this.save = this.saveManager.reset(); location.reload(); };
    this.ui.onSettings = (settings) => { Object.assign(this.settings, settings); this.audio.setVolume(this.settings.masterVolume); this.renderer.shadowMap.enabled = this.settings.quality === 'high'; this.persist(); };
  }

  private startGame(fresh: boolean): void {
    if (fresh) { this.save = structuredClone(DEFAULT_SAVE); this.saveManager.save(this.save); this.economy.balance = this.save.money; this.missions.completed.clear(); this.player.group.position.set(...this.save.spawn); this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current); }
    this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.audio.resume(); this.audio.setVolume(this.settings.masterVolume); void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    this.ui.notify('Welcome to San Cordova', 'Mission contacts are marked in gold.');
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const raw = this.clock.getDelta(); const dt = Math.min(raw, 0.05); this.fps = THREE.MathUtils.lerp(this.fps, 1 / Math.max(raw, 0.001), 0.06);
    if (this.mode === 'playing') this.update(dt);
    else if (this.mode === 'dead') { this.deathTimer -= dt; if (this.deathTimer <= 0) this.respawn(); }
    else if (this.input.consume('Escape')) this.ui.back();
    this.updateCamera(dt); this.updateMarker(dt); this.renderHUD(); this.renderer.render(this.scene, this.camera); this.input.endFrame();
  };

  private update(dt: number): void {
    if (this.input.consume('Escape')) { this.pause(); return; }
    if (this.input.consume('Backquote')) { this.settings.showFps = !this.settings.showFps; this.persist(); }
    if (this.transition) this.updateTransition(dt);
    else if (this.activeVehicle) this.updateDriving(dt);
    else this.updateOnFoot(dt);
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    this.audio.updateListener(focus.x, focus.z, this.cameraController.yaw, this.city.isPark(focus.x, focus.z));
    this.population.update(dt, focus, (amount) => this.damagePlayer(amount));
    this.city.update(dt);
    for (const impact of this.population.consumeImpacts()) {
      const intensity = Math.min(1.6, Math.abs(impact.vehicle.speed) / 16);
      this.gore.burst(impact.position, intensity, impact.killed);
      this.audio.splat(intensity, impact.position.x, impact.position.z);
      if (impact.vehicle === this.activeVehicle) this.wanted.addCrime(impact.killed ? 24 : 12);
      if (impact.killed) this.spawnDropsAt(impact.position, 'civilian');
    }
    this.police.update(dt, focus, Boolean(this.activeVehicle), this.wanted, (amount) => this.damagePlayer(amount));
    this.wanted.update(dt);
    for (const boom of this.projectiles.update(dt, this.city, this.population, this.police.vehicles, this.player.group.position)) {
      this.audio.explosion(boom.position.x, boom.position.z); this.wanted.addCrime(30); this.population.broadcastFear(boom.position, FEAR_EVENTS.kill); this.shake = Math.min(0.7, this.shake + 0.5);
      if (boom.policeHit) this.wanted.addCrime(24);
      for (const victim of boom.victims) {
        this.gore.burst(victim.position, victim.killed ? 1.5 : 0.9, victim.killed);
        if (victim.killed) { this.spawnDrops(victim.ped); if (victim.ped.hostile) this.hostileDefeated += 1; }
      }
      if (boom.playerDamage > 0) this.damagePlayer(boom.playerDamage);
    }
    for (const item of this.pickups.update(dt, this.player.group.position, !this.activeVehicle && !this.transition)) this.applyPickup(item);
    this.combat.update(dt); this.gore.update(dt); this.handleVehicleCollisions(dt); this.updateMission(dt);
    this.saveTimer += dt; if (this.saveTimer > 8) { this.persist(); this.saveTimer = 0; }
    if (this.player.health <= 0) this.die();
  }

  private updateOnFoot(dt: number): void {
    this.player.update(dt, this.input, this.cameraController.yaw, this.city);
    if (this.updateWeaponWheel()) return;
    this.combat.tryReload(this.input);
    WEAPONS.forEach((spec, index) => { if (this.input.consume(`Digit${index + 1}`)) this.combat.select(spec.id); });
    const scroll = this.input.consumeWheel(); if (scroll) this.combat.cycle(scroll > 0 ? 1 : -1);
    this.footstepTimer -= dt;
    if (this.player.onGround && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((key) => this.input.down(key)) && this.footstepTimer <= 0) { const running = this.input.down('ShiftLeft'); this.audio.footstep(running, this.city.isPark(this.player.group.position.x, this.player.group.position.z)); this.footstepTimer = running ? 0.24 : 0.38; }
    const shot = this.combat.fire(this.input, this.camera, this.player.group.position, this.population, this.police.vehicles);
    if (shot.fired && shot.melee) {
      this.player.punch();
      if (shot.victim) {
        this.wanted.addCrime(shot.killed ? 24 : 16); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.assault);
        if (shot.hitPoint) { this.gore.burst(shot.hitPoint, shot.killed ? 1.2 : 0.72, Boolean(shot.killed)); this.audio.splat(shot.killed ? 1 : 0.6, shot.hitPoint.x, shot.hitPoint.z); this.audio.scream('pain', shot.hitPoint.x, shot.hitPoint.z); }
        if (shot.policeHit) this.wanted.addCrime(24);
        if (shot.killed) { this.population.broadcastFear(shot.victim.group.position, FEAR_EVENTS.kill); this.spawnDrops(shot.victim); if (shot.victim.hostile) this.hostileDefeated += 1; }
      }
    } else if (shot.fired) {
      this.wanted.addCrime(7); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.gunshot);
      if (shot.victim && shot.hitPoint) {
        this.gore.burst(shot.hitPoint, shot.killed ? 1.45 : 0.92, shot.killed);
        this.audio.splat(shot.killed ? 0.9 : 0.5, shot.hitPoint.x, shot.hitPoint.z);
        this.audio.scream('pain', shot.hitPoint.x, shot.hitPoint.z);
        if (shot.killed) this.population.broadcastFear(shot.victim.group.position, FEAR_EVENTS.kill);
      }
      if (shot.policeHit) this.wanted.addCrime(24);
      if (shot.killed && shot.victim) { this.spawnDrops(shot.victim); if (shot.victim.hostile) this.hostileDefeated += 1; }
    }
    this.player.setWeapon(this.combat.current);
    if (this.input.consume('KeyF')) this.tryMugOrMelee();
    if (this.input.consume('KeyE')) {
      const collectTarget = this.missions.objective?.kind === 'collect' ? this.currentTarget() : undefined;
      if (collectTarget && collectTarget.position.distanceTo(this.player.group.position) < 8) { this.collectedItem = true; return; }
      if (this.tryMissionInteraction()) return;
      const vehicle = this.population.nearestEnterable(this.player.group.position);
      if (vehicle) this.beginEnter(vehicle);
    }
  }

  private updateWeaponWheel(): boolean {
    if (this.input.down('Tab')) {
      if (!this.weaponWheelOpen) { this.weaponWheelOpen = true; this.wheelHighlight = this.combat.current; this.wheelVector.set(0, 0); }
      this.wheelVector.x += this.input.mouseDX; this.wheelVector.y += this.input.mouseDY;
      this.input.mouseDX = 0; this.input.mouseDY = 0;
      if (this.wheelVector.length() > 120) this.wheelVector.setLength(120);
      if (this.wheelVector.length() > 26) {
        const step = (Math.PI * 2) / WEAPONS.length;
        const angle = Math.atan2(this.wheelVector.x, -this.wheelVector.y);
        const index = ((Math.round(angle / step) % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
        const target = WEAPONS[index];
        if (target && this.combat.owned(target.id)) this.wheelHighlight = target.id;
      }
      const scroll = this.input.consumeWheel(); if (scroll) this.wheelHighlight = cycleWeapon(this.wheelHighlight, scroll > 0 ? 1 : -1, (id) => this.combat.owned(id));
      this.ui.showWeaponWheel(WEAPONS.map((spec) => {
        const state = this.combat.loadout[spec.id];
        return { name: spec.name, ammo: spec.melee ? '&mdash;' : `${state.ammo} / ${state.reserve}`, highlighted: spec.id === this.wheelHighlight, equipped: spec.id === this.combat.current, locked: !state.owned };
      }));
      return true;
    }
    if (this.weaponWheelOpen) { this.weaponWheelOpen = false; this.ui.hideWeaponWheel(); this.combat.select(this.wheelHighlight); this.player.setWeapon(this.combat.current); }
    return false;
  }

  private closeWeaponWheel(): void { this.weaponWheelOpen = false; this.ui.hideWeaponWheel(); }

  private updateDriving(dt: number): void {
    const vehicle = this.activeVehicle; if (!vehicle) return;
    const speed = vehicle.updatePlayer(dt, this.input, this.city); this.player.group.position.copy(vehicle.group.position);
    const throttle = this.input.down('KeyW') ? 1 : this.input.down('KeyS') ? 0.6 : 0;
    this.audio.setEngine(true, speed, throttle, vehicle.spec.maxSpeed);
    this.wallCrashCooldown = Math.max(0, this.wallCrashCooldown - dt);
    if (this.wallCrashCooldown <= 0 && this.prevDrivenSpeed > 12 && this.prevDrivenSpeed - speed > this.prevDrivenSpeed * 0.6) { this.audio.collision(this.prevDrivenSpeed * 1.1); this.wallCrashCooldown = 0.8; }
    this.prevDrivenSpeed = speed;
    if (this.input.consume('KeyE')) this.beginExit(vehicle);
    if (this.input.consume('KeyF')) { const pose = this.city.nearestRoadPose(vehicle.group.position); vehicle.heading = pose.heading; vehicle.reset(pose.position); this.ui.notify('Vehicle recovered', vehicle.spec.name); }
    if (vehicle.disabled) { this.ui.notify('Vehicle disabled', 'Exit before it catches fire.', false); this.beginExit(vehicle); }
  }

  private beginEnter(vehicle: Vehicle): void {
    this.transition = { vehicle, timer: 0.5, entering: true }; vehicle.playerControlled = true; this.prevDrivenSpeed = 0;
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(1.6); this.player.group.position.copy(vehicle.group.position).add(side);
    if (vehicle.occupied) {
      this.population.ejectDriver(vehicle, this.player.group.position); this.wanted.addCrime(18);
      this.ui.notify('Carjacking reported', 'The driver is fleeing. SCPD dispatch alerted.', false); vehicle.occupied = false;
    }
    if (this.missions.active?.id === 'hot-property' && vehicle.spec.kind === 'sport' && vehicle.spec.color === 0xd83a40) this.wanted.setMinimumLevel(2);
  }

  private beginExit(vehicle: Vehicle): void {
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const left = vehicle.group.position.clone().addScaledVector(side, 2.4); const right = vehicle.group.position.clone().addScaledVector(side, -2.4);
    const exit = !this.city.collides(left.x, left.z, 0.7) ? left : !this.city.collides(right.x, right.z, 0.7) ? right : undefined;
    if (!exit) { this.ui.notify('Exit blocked', 'Move the vehicle into open space.', false); return; }
    this.transition = { vehicle, timer: 0.42, entering: false, exitPosition: exit }; this.audio.setEngine(false);
  }

  private updateTransition(dt: number): void {
    const transition = this.transition; if (!transition) return; transition.timer -= dt;
    if (transition.entering) this.player.group.position.lerp(transition.vehicle.group.position, Math.min(1, dt * 8));
    if (transition.timer > 0) return;
    if (transition.entering) { this.activeVehicle = transition.vehicle; this.player.inVehicle = true; this.player.setVisible(false); }
    else { transition.vehicle.playerControlled = false; this.activeVehicle = undefined; this.player.inVehicle = false; this.player.setVisible(true); this.player.group.position.copy(transition.exitPosition ?? transition.vehicle.group.position); }
    this.transition = undefined;
  }

  private updateMission(dt: number): void {
    const objective = this.missions.objective;
    if (this.missions.state === 'active' && objective?.vehicleColor) {
      const requiredVehicle = this.population.vehicles.find((vehicle) => vehicle.spec.color === objective.vehicleColor);
      if (requiredVehicle?.disabled) { this.processMissionUpdate(this.missions.fail(`${requiredVehicle.spec.name} was destroyed`)); return; }
    }
    if (objective?.kind === 'defeat') this.population.spawnHostiles();
    if (this.missions.active?.id === 'hot-property' && objective?.kind === 'enter-kind' && this.activeVehicle?.spec.kind === 'sport' && this.activeVehicle.spec.color === 0xd83a40) this.wanted.setMinimumLevel(2);
    const target = this.currentTarget(); const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    const reached = Boolean(target && focus.distanceTo(target.position) < (objective?.kind === 'escape' ? 12 : 8));
    if (objective?.kind === 'checkpoints' && reached) { const result = this.missions.registerCheckpoint(); this.deliveryIndex += 1; this.processMissionUpdate(result); }
    const result = this.missions.update(dt, {
      playerPosition: focus, inVehicle: Boolean(this.activeVehicle), vehicleKind: this.activeVehicle?.spec.kind,
      wantedLevel: this.wanted.level, shotsFired: this.combat.shotsFired, hostileDefeated: this.hostileDefeated, collectedItem: this.collectedItem, vehicleColor: this.activeVehicle?.spec.color,
    }, reached);
    this.processMissionUpdate(result);
    const current = `${this.missions.active?.id ?? ''}:${this.missions.objectiveIndex}`;
    if (current !== this.previousObjective) { this.previousObjective = current; if (this.missions.objective) this.ui.notify('Objective updated', this.missions.objective.text); }
  }

  private tryMissionInteraction(): boolean {
    if (this.missions.state === 'failed' && this.missions.active) { this.resetMissionRuntime(); this.missions.restart(); this.ui.notify('Mission restarted', this.missions.active?.name ?? ''); return true; }
    if (this.missions.objective?.kind === 'collect') return false;
    const position = this.player.group.position;
    const mission = MISSIONS.find((item) => !this.missions.completed.has(item.id) && item.start.position.distanceTo(position) < 7);
    if (!mission || this.missions.active) return false;
    this.resetMissionRuntime(); this.missions.start(mission.id); this.ui.notify(mission.name, `${mission.contact}: ${mission.intro}`); return true;
  }

  private tryMugOrMelee(): void {
    const victim = this.population.nearestPedestrian(this.player.group.position);
    if (!victim) return;
    const cash = victim.mug(this.player.group.position);
    if (cash > 0) {
      this.pickups.spawnCash(this.scatter(victim.group.position), cash);
      this.wanted.addCrime(14); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.assault); this.audio.melee();
      this.ui.notify('Street robbery', `They dropped $${cash}. Witnesses are calling SCPD.`, false); return;
    }
    const killed = victim.takeDamage(34); this.wanted.addCrime(killed ? 24 : 16); this.population.broadcastFear(this.player.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault);
    this.gore.burst(victim.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)), killed ? 1.2 : 0.72, killed); this.audio.melee();
    this.audio.splat(killed ? 1 : 0.6, victim.group.position.x, victim.group.position.z); this.audio.scream('pain', victim.group.position.x, victim.group.position.z);
    if (killed) this.spawnDrops(victim);
  }

  private spawnDrops(victim: Pedestrian): void {
    this.spawnDropsAt(victim.group.position, victim.police ? 'police' : victim.hostile ? 'guard' : 'civilian');
  }

  private spawnDropsAt(position: THREE.Vector3, kind: PedKind): void {
    const roll = rollDrops(kind);
    if (roll.cash > 0) this.pickups.spawnCash(this.scatter(position), roll.cash);
    if (roll.weapon) this.pickups.spawnWeapon(this.scatter(position), roll.weapon);
    if (roll.ammo) this.pickups.spawnAmmo(this.scatter(position));
  }

  private scatter(position: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(position.x + (Math.random() - 0.5) * 1.6, 0, position.z + (Math.random() - 0.5) * 1.6);
  }

  private applyPickup(item: Pickup): void {
    this.audio.pickup();
    if (item.kind === 'cash') { this.economy.earn(item.amount); this.ui.notify('Cash grabbed', `+$${item.amount}`); return; }
    if (item.kind === 'weapon' && item.weapon) {
      const spec = WEAPON_BY_ID[item.weapon];
      if (this.combat.grantWeapon(item.weapon) === 'new') { this.combat.select(item.weapon); this.player.setWeapon(this.combat.current); this.ui.notify('Weapon acquired', spec.name); }
      else this.ui.notify('Ammo added', spec.name);
      return;
    }
    this.ui.notify('Ammo box', WEAPON_BY_ID[this.combat.addAmmo()].name);
  }

  private processMissionUpdate(update: MissionUpdate): void {
    if (update.failed) { this.audio.ui(false); this.ui.notify('Mission failed', `${update.failed}. Press E to restart.`, false); }
    if (update.completed) { this.economy.earn(update.completed.reward); this.audio.ui(true); this.ui.notify('Mission complete', `+$${update.completed.reward.toLocaleString()} ${update.completed.name}`); this.persist(); }
  }

  private resetMissionRuntime(): void {
    this.deliveryIndex = 0; this.collectedItem = false; this.hostileDefeated = 0; this.previousObjective = '';
    const missionId = this.missions.active?.id;
    const vehicle = this.population.vehicles.find((item) => missionId === 'delivery-run' ? item.spec.color === 0xf1c232 : missionId === 'hot-property' ? item.spec.color === 0xd83a40 : false);
    if (vehicle) {
      vehicle.health = vehicle.maxHealth; vehicle.disabled = false;
      vehicle.heading = missionId === 'delivery-run' ? 0 : Math.PI / 2;
      vehicle.reset(missionId === 'delivery-run' ? new THREE.Vector3(-105.5, 0, 240) : new THREE.Vector3(30, 0, 205.5));
    }
  }

  private currentTarget(): WorldTarget | undefined {
    const objective = this.missions.objective;
    if (objective?.kind === 'checkpoints') {
      const stops = [new THREE.Vector3(-15, 0, 252), new THREE.Vector3(205, 0, 190), new THREE.Vector3(22, 0, -160)];
      const position = stops[Math.min(this.deliveryIndex, stops.length - 1)]; return position ? { position, label: `Delivery ${this.deliveryIndex + 1}`, color: '#f5c451' } : undefined;
    }
    if (objective?.target) return objective.target;
    if (!this.missions.active) {
      const nearest = MISSIONS.filter((mission) => !this.missions.completed.has(mission.id)).sort((a, b) => a.start.position.distanceToSquared(this.player.group.position) - b.start.position.distanceToSquared(this.player.group.position))[0];
      return nearest?.start;
    }
    if (objective?.kind === 'enter-kind') {
      const vehicle = this.population.vehicles.find((item) => item.spec.kind === objective.vehicleKind && (!objective.vehicleColor || item.spec.color === objective.vehicleColor));
      if (vehicle) return { position: vehicle.group.position, label: vehicle.spec.name, color: '#65d8ff' };
    }
    return undefined;
  }

  private updateCamera(dt: number): void {
    const target = this.activeVehicle?.group.position ?? this.player.group.position;
    this.cameraController.update(dt, this.input, target, this.city, Boolean(this.activeVehicle), this.settings.mouseSensitivity);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.35;
    }
  }

  private buildMarker(): void {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.16, 8, 28), new THREE.MeshBasicMaterial({ color: 0xf5c451 })); ring.rotation.x = Math.PI / 2;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.8, 11, 18, 1, true), new THREE.MeshBasicMaterial({ color: 0xf5c451, transparent: true, opacity: 0.12, side: THREE.DoubleSide })); beam.position.y = 5.5;
    this.marker.add(ring, beam); this.scene.add(this.marker);
  }

  private updateMarker(dt: number): void {
    this.markerTarget = this.currentTarget(); this.marker.visible = Boolean(this.markerTarget);
    if (!this.markerTarget) return;
    this.marker.position.copy(this.markerTarget.position); this.markerPhase += dt; this.marker.rotation.y += dt * 0.7; this.marker.position.y = 0.2 + Math.sin(this.markerPhase * 2) * 0.15;
    const color = new THREE.Color(this.markerTarget.color ?? '#f5c451'); this.marker.children.forEach((child: THREE.Object3D) => { const mesh = child as THREE.Mesh; (mesh.material as THREE.MeshBasicMaterial).color.copy(color); });
  }

  private handleVehicleCollisions(dt: number): void {
    for (const vehicle of this.population.vehicles) this.vehicleCollisionCooldown.set(vehicle, Math.max(0, (this.vehicleCollisionCooldown.get(vehicle) ?? 0) - dt));
    const driven = this.activeVehicle; if (!driven) return;
    for (const other of this.population.vehicles) {
      if (other === driven || driven.group.position.distanceToSquared(other.group.position) > 10) continue;
      const direction = driven.group.position.clone().sub(other.group.position).setY(0).normalize(); driven.group.position.addScaledVector(direction, 0.4); other.group.position.addScaledVector(direction, -0.35);
      if ((this.vehicleCollisionCooldown.get(driven) ?? 0) <= 0) { const impact = Math.abs(driven.speed - other.speed); driven.takeDamage(impact * 0.35); other.takeDamage(impact * 0.25); this.audio.collision(impact); this.vehicleCollisionCooldown.set(driven, 0.8); }
      driven.speed *= 0.6; other.speed *= 0.7;
    }
  }

  private renderHUD(): void {
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    let prompt = '';
    if (this.mode === 'playing' && !this.transition) {
      const nearbyTarget = this.currentTarget();
      if (this.activeVehicle) prompt = 'E  Exit vehicle  ·  F  Recover';
      else if (this.missions.objective?.kind === 'collect' && nearbyTarget && nearbyTarget.position.distanceTo(focus) < 8) prompt = 'E  Recover radio key';
      else if (this.missions.state === 'failed') prompt = 'E  Restart mission';
      else if (MISSIONS.some((mission) => !this.missions.completed.has(mission.id) && mission.start.position.distanceTo(focus) < 7)) prompt = 'E  Speak to contact';
      else if (this.population.nearestPedestrian(focus)) prompt = 'F  Mug / melee';
      else if (this.population.nearestEnterable(focus)) prompt = 'E  Enter vehicle';
    }
    const spec = this.combat.spec; const ammoState = this.combat.state;
    this.ui.update({ health: this.player.health, money: this.economy.balance, weaponName: spec.name, melee: spec.melee, ammo: ammoState.ammo, reserve: ammoState.reserve, reloading: this.combat.reloading > 0, wanted: this.wanted.level, district: this.city.districtAt(focus.x, focus.z), prompt, vehicle: this.activeVehicle, mission: this.missions, fps: this.fps, settings: this.settings });
    const markers = this.markerTarget ? [{ x: this.markerTarget.position.x, z: this.markerTarget.position.z, color: this.markerTarget.color ?? '#f5c451' }] : [];
    const hostiles = this.population.pedestrians.filter((ped) => ped.state === 'hostile' && !ped.contact).map((ped) => ({ x: ped.group.position.x, z: ped.group.position.z }));
    this.ui.drawMap(focus.x, focus.z, this.activeVehicle?.heading ?? this.player.heading, this.city.roadPaths, markers, this.police.vehicles.map((unit) => ({ x: unit.group.position.x, z: unit.group.position.z })), hostiles);
  }

  private damagePlayer(amount: number): void { if (amount > 0) this.ui.damageFlash(); this.player.takeDamage(amount); }
  private die(): void {
    if (this.mode === 'dead') return;
    if (this.missions.state === 'active') this.missions.fail('You were incapacitated');
    this.mode = 'dead'; this.deathTimer = 3; this.audio.setEngine(false); this.audio.setSiren(false); this.closeWeaponWheel(); this.ui.notify('Wasted', 'Emergency services are responding. Press E after respawning to restart the job.', false); document.exitPointerLock();
  }
  private respawn(): void {
    if (this.activeVehicle) { this.activeVehicle.playerControlled = false; this.activeVehicle = undefined; }
    this.transition = undefined; this.player.inVehicle = false; this.player.setVisible(true); this.player.heal(); this.player.group.position.set(...this.save.spawn); this.wanted.clear(); this.police.reset(); this.mode = 'playing';
  }
  private pause(): void { this.mode = 'paused'; this.audio.setEngine(false); this.audio.setSiren(false); this.closeWeaponWheel(); document.exitPointerLock(); this.ui.showPause(this.settings); }
  private persist(): void { this.save = { version: 1, money: this.economy.balance, completedMissions: [...this.missions.completed], spawn: this.save.spawn, settings: this.settings, weapons: this.combat.serialize() }; this.saveManager.save(this.save); }
  private resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); }
}
