import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { WEAPON_BY_ID, WEAPONS, type WeaponId } from './config';
import { AudioManager } from './core/AudioManager';
import { CAMERA_VIEW_NAMES, CameraController, cycleView } from './core/CameraController';
import { cycleWeapon, Economy, rollDrops, type PedKind } from './core/GameRules';
import { InputManager } from './core/InputManager';
import { DEFAULT_SAVE, SaveManager } from './core/SaveManager';
import { adjustedShopPrice, ammoPrice, detailerPrice, HOTDOG_PRICE, hotdogHeal, reserveFull, resolvePurchase, weaponPrice } from './core/ShopRules';
import type { Pedestrian } from './entities/Pedestrian';
import { Player } from './entities/Player';
import { Vehicle } from './entities/Vehicle';
import { CombatSystem } from './systems/CombatSystem';
import { FEAR_EVENTS } from './systems/FearSystem';
import { GoreSystem } from './systems/GoreSystem';
import { LoadSheddingSystem } from './systems/LoadSheddingSystem';
import { MISSIONS, MissionSystem, type MissionUpdate } from './systems/MissionSystem';
import { PickupSystem, type Pickup } from './systems/PickupSystem';
import { determineReporter, PoliceKnowledge, REPORT_DELAY, SIGHT_RADIUS, type WitnessCandidate } from './systems/PoliceKnowledge';
import { PoliceSystem } from './systems/PoliceSystem';
import { PopulationSystem } from './systems/PopulationSystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { GARAGE_PARK, ShopSystem } from './systems/ShopSystem';
import { BURN_DPS, OCCUPANT_BURNOUT_DAMAGE, POLICE_WRECK_HEAT, VehicleFireSystem } from './systems/VehicleFireSystem';
import { WantedSystem } from './systems/WantedSystem';
import { CBD, civilianDisposition, LivingCitySystem, policeReinforcementModifier, reputationTier, shopPriceMultiplier, witnessDelayMultiplier, type CityEvent } from './systems/LivingCitySystem';
import type { CheatSettings, GameMode, GameSettings, SavedGame, WorldTarget } from './types';
import { UIManager } from './ui/UIManager';
import { City } from './world/City';
import { DayNightSystem } from './world/DayNight';
import { buildEnvironment, type EnvironmentHandle } from './world/Environment';
import { ETOLL_GANTRIES } from './world/UrbanInfrastructure';
import { setPower } from './world/powerGrid';

interface Transition { vehicle: Vehicle; timer: number; entering: boolean; exitPosition?: THREE.Vector3; }

export class Game {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 950);
  private renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  private composer?: EffectComposer;
  private gtao?: GTAOPass;
  private environment!: EnvironmentHandle;
  private clock = new THREE.Clock();
  private input: InputManager;
  private audio = new AudioManager();
  private saveManager = new SaveManager();
  private saveExists = false;
  private save: SavedGame;
  private settings: GameSettings;
  private cheats: CheatSettings;
  private city: City;
  private dayNight: DayNightSystem;
  private player: Player;
  private cameraController: CameraController;
  private population: PopulationSystem;
  private combat: CombatSystem;
  private gore: GoreSystem;
  private pickups: PickupSystem;
  private projectiles: ProjectileSystem;
  private vehicleFire: VehicleFireSystem;
  private shake = 0;
  private wanted = new WantedSystem();
  private knowledge = new PoliceKnowledge<Pedestrian>();
  private police: PoliceSystem;
  private missions = new MissionSystem();
  private loadShedding = new LoadSheddingSystem();
  private livingCity: LivingCitySystem;
  private economy: Economy;
  private shops: ShopSystem;
  private garageVehicle?: Vehicle;
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
  private potholeCooldown = 0;
  private etollCooldowns: number[] = ETOLL_GANTRIES.map(() => 0);
  private radioIntroShown = false;
  private footstepTimer = 0;
  private prevDrivenSpeed = 0;
  private wallCrashCooldown = 0;
  private fps = 60;
  private weaponWheelOpen = false;
  private wheelVector = new THREE.Vector2();
  private wheelHighlight: WeaponId = 'pistol';
  private previousObjective = '';
  private loggedDrawCalls = false;
  private vehicleCollisionCooldown = new WeakMap<Vehicle, number>();
  private reputationReactionCooldown = 0;
  private helperCooldown = 90;
  private previousWanted = false;
  private hostileGuardActivated = false;

  constructor(private container: HTMLElement) {
    this.saveExists = this.saveManager.hasSave(); this.save = this.saveManager.load(); this.settings = { ...this.save.settings }; this.cheats = { ...this.save.cheats }; this.economy = new Economy(this.save.money); this.livingCity = new LivingCitySystem(this.save.livingCity);
    this.setupRenderer(); this.setupScene();
    this.city = new City(this.scene);
    this.dayNight = new DayNightSystem(this.scene, this.environment, this.city, this.settings.quality, this.save.timeOfDay);
    this.shops = new ShopSystem(this.scene, this.city);
    this.player = new Player(this.scene, new THREE.Vector3(...this.save.spawn));
    this.cameraController = new CameraController(this.camera);
    this.population = new PopulationSystem(this.scene, this.city, this.audio);
    this.combat = new CombatSystem(this.scene, this.audio);
    this.gore = new GoreSystem(this.scene);
    this.pickups = new PickupSystem(this.scene);
    this.projectiles = new ProjectileSystem(this.scene);
    this.vehicleFire = new VehicleFireSystem(this.scene);
    this.combat.onRocket = (origin, direction, spec) => { if (spec.projectile) this.projectiles.spawn(origin, direction, spec.projectile, spec.range); };
    this.police = new PoliceSystem(this.scene, this.city, this.audio);
    this.input = new InputManager(this.renderer.domElement);
    this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current); this.player.cheats = this.cheats;
    this.missions.completed = new Set(this.save.completedMissions);
    this.restoreGarageVehicle();
    this.buildMarker(); this.bindUI(); this.animate();
    if (import.meta.env.DEV) Object.assign(window, { __game: this });
    setTimeout(() => this.ui.showMainMenu(this.mainMenuSummary()), 50);
  }

  private setupRenderer(): void {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low'; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.22;
    this.renderer.shadowMap.autoUpdate = true;
    this.container.append(this.renderer.domElement); window.addEventListener('resize', () => this.resize());
  }

  private setupScene(): void {
    this.environment = buildEnvironment(this.scene, this.settings.quality);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    this.scene.environmentIntensity = 0.32;
    this.setupComposer();
  }

  private setupComposer(): void {
    this.composer?.dispose(); this.composer = undefined; this.gtao = undefined;
    if (this.settings.quality === 'low') return; // low quality: plain renderer.render, no post stack
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(size.width, size.height, { type: THREE.HalfFloatType, samples: 4 }));
    composer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (this.settings.quality === 'high') { // GTAO is the expensive pass — high only
      this.gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
      this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 2, thickness: 1 }); this.gtao.blendIntensity = 0.9;
      composer.addPass(this.gtao);
    }
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.45, 0.85));
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  private bindUI(): void {
    this.ui.onStart = (fresh) => this.startGame(fresh);
    this.ui.onResume = () => { this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); if (this.activeVehicle) this.audio.startRadio(); void this.renderer.domElement.requestPointerLock().catch(() => undefined); };
    this.ui.onRestart = () => { this.respawn(); this.mode = 'playing'; this.ui.hideMenu(); };
    this.ui.onResetSave = () => { this.save = this.saveManager.reset(); location.reload(); };
    this.ui.onSettings = (settings) => {
      const qualityChanged = settings.quality !== undefined && settings.quality !== this.settings.quality;
      Object.assign(this.settings, settings); this.audio.setVolume(this.settings.masterVolume);
      if (qualityChanged) this.applyQuality(); this.persist();
    };
    this.ui.onShowCheats = () => this.ui.showCheats(WEAPONS.filter((spec) => !spec.melee).map((spec) => ({ id: spec.id, name: spec.name, owned: this.combat.owned(spec.id) })), this.cheats);
    this.ui.onGiveWeapon = (id) => { const result = this.combat.grantWeapon(id); this.ui.notify(result === 'new' ? 'Weapon granted' : 'Ammo topped up', WEAPON_BY_ID[id].name); this.persist(); };
    this.ui.onMaxAmmo = () => { const filled = this.combat.maxAmmo(); this.ui.notify('Max ammo', `${filled} weapon${filled === 1 ? '' : 's'} fully stocked.`); this.persist(); };
    this.ui.onCheats = (cheats) => { Object.assign(this.cheats, cheats); this.persist(); };
    this.ui.onBuyWeapon = (id) => this.purchase('weapon', id);
    this.ui.onBuyAmmo = (id) => this.purchase('ammo', id);
    this.ui.onMissionChoice = (id) => {
      const update = this.missions.choose(id); this.mode = 'playing'; this.ui.hideMenu(); void this.renderer.domElement.requestPointerLock().catch(() => undefined);
      this.processMissionUpdate(update);
    };
  }

  private applyQuality(): void {
    const shadows = this.settings.quality !== 'low';
    this.renderer.shadowMap.enabled = shadows; this.environment.sun.castShadow = shadows;
    this.dayNight.setQuality(this.settings.quality);
    this.setupComposer();
  }

  private startGame(fresh: boolean): void {
    if (fresh) { this.removeGarageVehicle(); this.save = structuredClone(DEFAULT_SAVE); this.saveManager.save(this.save); this.saveExists = true; this.economy.balance = this.save.money; this.livingCity = new LivingCitySystem(this.save.livingCity); this.missions.completed.clear(); this.player.group.position.set(...this.save.spawn); this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current); Object.assign(this.cheats, this.save.cheats); this.dayNight.hour = this.save.timeOfDay; }
    this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.audio.resume(); this.audio.setVolume(this.settings.masterVolume); void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    this.ui.notify('Welcome to Joburg', 'Mind the potholes. Mission contacts are marked in gold.');
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const raw = this.clock.getDelta(); const dt = Math.min(raw, 0.05); this.fps = THREE.MathUtils.lerp(this.fps, 1 / Math.max(raw, 0.001), 0.06);
    if (this.mode === 'playing') this.update(dt);
    else if (this.mode === 'dead') { this.deathTimer -= dt; if (this.deathTimer <= 0) this.respawn(); }
    else if (this.input.consume('Escape')) this.ui.back();
    this.updateCamera(dt); this.updateMarker(dt); this.renderHUD();
    this.environment.updateShadowFocus(this.activeVehicle?.group.position ?? this.player.group.position);
    const measure = import.meta.env.DEV && !this.loggedDrawCalls && this.clock.elapsedTime > 1;
    if (measure) { this.renderer.info.autoReset = false; this.renderer.info.reset(); }
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    if (measure) { this.loggedDrawCalls = true; console.info(`[render] calls=${this.renderer.info.render.calls} tris=${this.renderer.info.render.triangles}`); this.renderer.info.autoReset = true; }
    this.input.endFrame();
  };

  private update(dt: number): void {
    if (this.input.consume('Escape')) { this.pause(); return; }
    if (this.input.consume('Backquote')) { this.settings.showFps = !this.settings.showFps; this.persist(); }
    if (this.input.consume('KeyV')) {
      const key = this.activeVehicle ? 'cameraViewVehicle' : 'cameraViewFoot';
      this.settings[key] = cycleView(this.settings[key]);
      this.ui.notify(`Camera: ${CAMERA_VIEW_NAMES[this.settings[key]]}`); this.persist();
    }
    if (this.transition) this.updateTransition(dt);
    else if (this.activeVehicle) this.updateDriving(dt);
    else this.updateOnFoot(dt);
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    this.livingCity.update(dt); this.updateLivingCityRuntime(dt, focus);
    this.audio.updateListener(focus.x, focus.z, this.cameraController.yaw, this.city.isPark(focus.x, focus.z));
    this.population.update(dt, focus, (amount) => this.damagePlayer(amount));
    this.city.update(dt);
    const eskom = this.loadShedding.update(dt);
    if (eskom === 'start') { setPower(false); this.ui.notify('Load shedding: Stage 4', 'Eskom sends regards. The robots are out.', false); }
    else if (eskom === 'end') { setPower(true); this.ui.notify('Power restored', 'For now. Sharp sharp.'); }
    this.dayNight.update(dt, focus, this.population.vehicles, this.police.vehicles, this.activeVehicle ?? this.transition?.vehicle);
    for (const impact of this.population.consumeImpacts()) {
      const intensity = Math.min(1.6, Math.abs(impact.vehicle.speed) / 16);
      this.gore.burst(impact.position, intensity, impact.killed);
      this.audio.splat(intensity, impact.position.x, impact.position.z);
      if (impact.vehicle === this.activeVehicle) this.reportCrime(impact.position, impact.killed ? 24 : 12, { victims: [impact.ped], radius: (impact.killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: impact.killed ? 'civilian-murder' : 'civilian-assault' });
      if (impact.killed) this.spawnDropsAt(impact.position, 'civilian');
    }
    const districtState = this.livingCity.district(this.city.districtAt(focus.x, focus.z));
    const reinforcementModifier = policeReinforcementModifier(districtState);
    this.population.setPolicePatrolCount(reinforcementModifier, focus);
    this.police.update(dt, focus, Boolean(this.activeVehicle), this.wanted, this.knowledge, (amount) => this.damagePlayer(amount), reinforcementModifier);
    for (const report of this.knowledge.update(dt, (reporter) => reporter.state !== 'down')) this.wanted.addCrime(report.heat);
    this.wanted.update(dt);
    if (this.previousWanted && !this.wanted.isWanted) this.recordCityEvent('police-evaded', focus);
    this.previousWanted = this.wanted.isWanted; this.shops.update(dt);
    for (const boom of this.projectiles.update(dt, this.city, this.population, this.police.vehicles, this.player.group.position)) {
      this.audio.explosion(boom.position.x, boom.position.z); this.reportCrime(boom.position, 30, { victims: boom.victims.map((victim) => victim.ped), radius: FEAR_EVENTS.kill.radius }); this.population.broadcastFear(boom.position, FEAR_EVENTS.kill); this.shake = Math.min(0.7, this.shake + 0.5);
      if (boom.policeHit) this.reportCrime(boom.position, 24, { copWitnessed: true });
      for (const victim of boom.victims) {
        this.gore.burst(victim.position, victim.killed ? 1.5 : 0.9, victim.killed);
        if (victim.killed) { this.spawnDrops(victim.ped); if (victim.ped.hostile) this.hostileDefeated += 1; }
      }
      if (boom.playerDamage > 0) this.damagePlayer(boom.playerDamage);
    }
    this.updateVehicleFires(dt, focus);
    for (const item of this.pickups.update(dt, this.player.group.position, !this.activeVehicle && !this.transition)) this.applyPickup(item);
    this.combat.update(dt); this.gore.update(dt); this.handleVehicleCollisions(dt); this.updateMission(dt);
    this.saveTimer += dt; if (this.saveTimer > 8) { this.persist(); this.saveTimer = 0; }
    if (this.player.health <= 0) this.die();
  }

  private updateVehicleFires(dt: number, focus: THREE.Vector3): void {
    const allVehicles = [...this.population.vehicles, ...this.police.vehicles];
    const fire = this.vehicleFire.update(dt, allVehicles, this.population.pedestrians, this.player.group.position);
    for (const vehicle of fire.ignitions) {
      if (vehicle === this.activeVehicle || vehicle === this.transition?.vehicle) this.ui.notify('Vehicle on fire', 'Bail out before it blows.', false);
      else if (vehicle.occupied) { this.population.ejectDriver(vehicle, vehicle.group.position.clone(), vehicle.police); vehicle.occupied = false; }
    }
    for (const boom of fire.burnouts) {
      this.audio.explosion(boom.position.x, boom.position.z);
      this.population.broadcastFear(boom.position, FEAR_EVENTS.kill);
      this.shake = Math.min(0.7, this.shake + 0.4);
      if (boom.vehicle.police) this.reportCrime(boom.position, POLICE_WRECK_HEAT, { copWitnessed: true });
      for (const victim of boom.victims) {
        this.gore.burst(victim.position, victim.killed ? 1.4 : 0.85, victim.killed);
        if (victim.killed) { this.spawnDrops(victim.ped); if (victim.ped.hostile) this.hostileDefeated += 1; }
      }
      if (boom.vehicle === this.activeVehicle || boom.vehicle === this.transition?.vehicle) { this.ejectFromWreck(boom.vehicle); this.damagePlayer(OCCUPANT_BURNOUT_DAMAGE); }
      else if (boom.playerDamage > 0) this.damagePlayer(boom.playerDamage);
    }
    const nearestFire = allVehicles.reduce<Vehicle | undefined>((best, vehicle) => vehicle.onFire && (!best || vehicle.group.position.distanceToSquared(focus) < best.group.position.distanceToSquared(focus)) ? vehicle : best, undefined);
    this.audio.setFire(Boolean(nearestFire), nearestFire?.group.position.x, nearestFire?.group.position.z);
  }

  private updateLivingCityRuntime(dt: number, focus: THREE.Vector3): void {
    if (this.city.districtAt(focus.x, focus.z) !== CBD) return;
    const disposition = civilianDisposition(this.livingCity.district(CBD));
    this.reputationReactionCooldown = Math.max(0, this.reputationReactionCooldown - dt);
    if ((disposition === 'afraid' || disposition === 'hostile') && this.reputationReactionCooldown === 0) {
      const witness = this.population.pedestrians.find((ped) => !ped.contact && !ped.hostile && !ped.police && ped.state !== 'down'
        && this.city.districtAt(ped.group.position.x, ped.group.position.z) === CBD && ped.group.position.distanceTo(focus) < 22);
      if (witness) witness.applyFear(disposition === 'hostile' ? 60 : 38, focus);
      this.reputationReactionCooldown = 6;
    }
    if (disposition === 'hostile' && !this.hostileGuardActivated) {
      const guard = this.population.pedestrians.find((ped) => ped.carGuard && this.city.districtAt(ped.group.position.x, ped.group.position.z) === CBD);
      if (guard) { guard.contact = false; guard.hostile = true; guard.state = 'hostile'; guard.destination.copy(focus); guard.group.name = 'Hostile Car Guard'; this.hostileGuardActivated = true; }
    }
    if (disposition !== 'supportive') { this.helperCooldown = Math.max(this.helperCooldown, 30); return; }
    this.helperCooldown -= dt;
    if (this.helperCooldown > 0) return;
    const helper = this.population.pedestrians.find((ped) => !ped.contact && !ped.hostile && !ped.police && ped.state !== 'down'
      && this.city.districtAt(ped.group.position.x, ped.group.position.z) === CBD && ped.group.position.distanceTo(focus) < 28);
    if (!helper) return;
    this.pickups.spawnAmmo(this.scatter(helper.group.position)); this.ui.notify('A local has your back', 'Someone left an ammo box nearby. The CBD remembers.'); this.helperCooldown = 120;
  }

  private ejectFromWreck(vehicle: Vehicle): void {
    vehicle.playerControlled = false; this.activeVehicle = undefined; this.transition = undefined;
    this.player.inVehicle = false; this.player.setVisible(true);
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(2.2);
    this.player.group.position.copy(vehicle.group.position).add(side).setY(0);
    this.audio.setEngine(false);
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
        this.reportCrime(this.player.group.position, shot.killed ? 24 : 16, { victims: [shot.victim], radius: (shot.killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: !shot.victim.hostile && !shot.victim.police ? (shot.killed ? 'civilian-murder' : 'civilian-assault') : undefined }); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.assault);
        if (shot.hitPoint) { this.gore.burst(shot.hitPoint, shot.killed ? 1.2 : 0.72, Boolean(shot.killed)); this.audio.splat(shot.killed ? 1 : 0.6, shot.hitPoint.x, shot.hitPoint.z); this.audio.scream('pain', shot.hitPoint.x, shot.hitPoint.z); }
        if (shot.policeHit) this.reportCrime(this.player.group.position, 24, { copWitnessed: true });
        if (shot.killed) { this.population.broadcastFear(shot.victim.group.position, FEAR_EVENTS.kill); this.spawnDrops(shot.victim); if (shot.victim.hostile) this.hostileDefeated += 1; }
      }
    } else if (shot.fired) {
      this.reportCrime(this.player.group.position, 7, { victims: shot.victim ? [shot.victim] : [], radius: FEAR_EVENTS.gunshot.radius, cityEvent: shot.victim && !shot.victim.hostile && !shot.victim.police ? (shot.killed ? 'civilian-murder' : 'civilian-assault') : undefined }); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.gunshot);
      if (shot.victim && shot.hitPoint) {
        this.gore.burst(shot.hitPoint, shot.killed ? 1.45 : 0.92, shot.killed);
        this.audio.splat(shot.killed ? 0.9 : 0.5, shot.hitPoint.x, shot.hitPoint.z);
        this.audio.scream('pain', shot.hitPoint.x, shot.hitPoint.z);
        if (shot.killed) this.population.broadcastFear(shot.victim.group.position, FEAR_EVENTS.kill);
      }
      if (shot.policeHit) this.reportCrime(this.player.group.position, 24, { copWitnessed: true });
      if (shot.killed && shot.victim) { this.spawnDrops(shot.victim); if (shot.victim.hostile) this.hostileDefeated += 1; }
    }
    this.player.setWeapon(this.combat.current);
    if (this.input.consume('KeyF')) this.tryMugOrMelee();
    if (this.input.consume('KeyE')) {
      const collectTarget = this.missions.objective?.kind === 'collect' ? this.currentTarget() : undefined;
      if (collectTarget && collectTarget.position.distanceTo(this.player.group.position) < 8) { this.collectedItem = true; return; }
      if (this.tryMissionInteraction()) return;
      const vehicle = this.population.nearestEnterable(this.player.group.position);
      const shop = this.shops.shopNear(this.player.group.position);
      if (shop?.kind === 'weapons') { this.openWeaponShop(); return; }
      if (shop?.kind === 'hotdog') { this.buyHotdog(); return; }
      if (shop?.driveIn && !vehicle) { this.ui.notify(shop.name, shop.kind === 'spray' ? 'They only detail vehicles. Drive one onto the marker.' : 'Drive a vehicle onto the marker to store it.', false); return; }
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
    this.potholeCooldown = Math.max(0, this.potholeCooldown - dt);
    if (this.potholeCooldown === 0 && Math.abs(vehicle.speed) > 9) {
      const position = vehicle.group.position;
      const hit = this.city.potholes.find((hole) => (hole.x - position.x) ** 2 + (hole.z - position.z) ** 2 < hole.r * hole.r);
      if (hit) {
        vehicle.speed *= 0.8; vehicle.bounce = Math.min(0.28, Math.abs(vehicle.speed) * 0.012); vehicle.takeDamage(2);
        this.audio.collision(14); this.potholeCooldown = 0.9;
        if (Math.random() < 0.3) this.ui.notify('Pothole', 'Wheel alignment: R850. Cash only.', false);
      }
    }
    ETOLL_GANTRIES.forEach((gantry, index) => {
      this.etollCooldowns[index] = Math.max(0, (this.etollCooldowns[index] ?? 0) - dt);
      if ((this.etollCooldowns[index] ?? 0) === 0 && (gantry.x - vehicle.group.position.x) ** 2 + (gantry.z - vehicle.group.position.z) ** 2 < 169) {
        this.audio.beep();
        this.ui.notify('e-toll charged: R12.50', 'Outstanding balance since 2013. Nobody pays.', false);
        this.etollCooldowns[index] = 20;
      }
    });
    if (this.input.consume('KeyE')) {
      const shop = this.shops.shopNear(vehicle.group.position);
      if (shop?.kind === 'spray') { this.useSpray(vehicle); return; }
      if (shop?.kind === 'garage') { this.storeVehicle(vehicle); return; }
      this.beginExit(vehicle);
    }
    if (this.input.consume('KeyF')) { const pose = this.city.nearestRoadPose(vehicle.group.position); vehicle.heading = pose.heading; vehicle.reset(pose.position); this.ui.notify('Bakkie recovered', vehicle.spec.name); }
    if (vehicle.onFire) this.damagePlayer(dt * BURN_DPS);
  }

  private beginEnter(vehicle: Vehicle): void {
    this.transition = { vehicle, timer: 0.5, entering: true }; vehicle.playerControlled = true; this.prevDrivenSpeed = 0;
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(1.6); this.player.group.position.copy(vehicle.group.position).add(side);
    if (vehicle.occupied) {
      const driver = this.population.ejectDriver(vehicle, this.player.group.position); this.reportCrime(this.player.group.position, 18, { victims: [driver], radius: FEAR_EVENTS.assault.radius, cityEvent: 'civilian-assault' });
      this.ui.notify('Hijacking witnessed', 'The driver is fleeing. Expect a call to the JMPD.', false); vehicle.occupied = false;
    }
    if (this.missions.active?.id === 'hot-property' && vehicle.spec.kind === 'sport' && vehicle.spec.color === 0xd83a40) this.forceWanted(2);
    if (!vehicle.occupied) {
      const guard = this.population.pedestrians.find((ped) => ped.carGuard && ped.group.position.distanceTo(vehicle.group.position) < 14);
      if (guard) this.ui.notify('Car guard', '"Sharp sharp boss, I watched it like my own!"');
    }
  }

  private beginExit(vehicle: Vehicle): void {
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const left = vehicle.group.position.clone().addScaledVector(side, 2.4); const right = vehicle.group.position.clone().addScaledVector(side, -2.4);
    const exit = !this.city.collides(left.x, left.z, 0.7) ? left : !this.city.collides(right.x, right.z, 0.7) ? right : undefined;
    if (!exit) { this.ui.notify('Exit blocked', 'Move the vehicle into open space.', false); return; }
    this.transition = { vehicle, timer: 0.42, entering: false, exitPosition: exit }; this.audio.setEngine(false); this.audio.stopRadio();
  }

  private updateTransition(dt: number): void {
    const transition = this.transition; if (!transition) return; transition.timer -= dt;
    if (transition.entering) this.player.group.position.lerp(transition.vehicle.group.position, Math.min(1, dt * 8));
    if (transition.timer > 0) return;
    if (transition.entering) {
      this.activeVehicle = transition.vehicle; this.player.inVehicle = true; this.player.setVisible(false);
      this.audio.startRadio();
      if (!this.radioIntroShown) { this.radioIntroShown = true; this.ui.notify('Jozi FM 94.7', 'Amapiano o\'clock. It is always amapiano o\'clock.'); }
    }
    else {
      transition.vehicle.playerControlled = false; transition.vehicle.setFirstPerson(false); this.activeVehicle = undefined; this.player.inVehicle = false; this.player.setVisible(true); this.player.group.position.copy(transition.exitPosition ?? transition.vehicle.group.position);
      const guard = this.population.pedestrians.find((ped) => ped.carGuard && ped.group.position.distanceTo(transition.vehicle.group.position) < 14);
      if (guard) {
        const tipped = this.economy.spend(2);
        this.ui.notify('Car guard', tipped ? '"No stress my boss, I watch it like my own." You tipped R2. The ancestors smile upon you.' : '"Eish, no tip? I watch it anyway, boss. Probably."');
      }
    }
    this.transition = undefined;
  }

  private updateMission(dt: number): void {
    const objective = this.missions.objective;
    if (this.missions.state === 'active' && objective?.vehicleColor) {
      const requiredVehicle = this.population.vehicles.find((vehicle) => vehicle.spec.color === objective.vehicleColor);
      if (requiredVehicle?.disabled) { this.processMissionUpdate(this.missions.fail(`${requiredVehicle.spec.name} was destroyed`)); return; }
    }
    if (objective?.kind === 'defeat') this.population.spawnHostiles();
    if (this.missions.active?.id === 'hot-property' && objective?.kind === 'enter-kind' && this.activeVehicle?.spec.kind === 'sport' && this.activeVehicle.spec.color === 0xd83a40) this.forceWanted(2);
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
    if (this.missions.objective?.kind === 'choice') {
      this.mode = 'paused'; document.exitPointerLock(); this.ui.showMissionChoice(this.missions.active?.name ?? 'Choose', this.missions.objective.choices ?? []); return true;
    }
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
      this.reportCrime(this.player.group.position, 14, { victims: [victim], radius: FEAR_EVENTS.assault.radius, cityEvent: 'mugging' }); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.assault); this.audio.melee();
      this.ui.notify('Street robbery', `They dropped R${cash}. Witnesses are calling the JMPD.`, false); return;
    }
    const killed = victim.takeDamage(34); this.reportCrime(this.player.group.position, killed ? 24 : 16, { victims: [victim], radius: (killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: !victim.hostile && !victim.police ? (killed ? 'civilian-murder' : 'civilian-assault') : undefined }); this.population.broadcastFear(this.player.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault);
    this.gore.burst(victim.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)), killed ? 1.2 : 0.72, killed); this.audio.melee();
    this.audio.splat(killed ? 1 : 0.6, victim.group.position.x, victim.group.position.z); this.audio.scream('pain', victim.group.position.x, victim.group.position.z);
    if (killed) this.spawnDrops(victim);
  }

  /** Files a crime with JMPD using only what the world could actually see: a cop nearby means immediate heat
   *  and a sighting; otherwise a surviving victim or a living bystander within radius phones it in after
   *  REPORT_DELAY (stars land when the report matures); nobody left alive means no report at all. */
  private reportCrime(position: THREE.Vector3, heat: number, options: { victims?: Pedestrian[]; radius?: number; copWitnessed?: boolean; cityEvent?: CityEvent['kind'] } = {}): void {
    if (options.cityEvent) this.recordCityEvent(options.cityEvent, position);
    const copSaw = options.copWitnessed
      || this.police.vehicles.some((unit) => !unit.wrecked && unit.group.position.distanceTo(position) < SIGHT_RADIUS)
      || this.population.pedestrians.some((ped) => ped.police && ped.state !== 'down' && ped.group.position.distanceTo(position) < SIGHT_RADIUS);
    if (copSaw) { this.wanted.addCrime(heat); this.wanted.reportSeen(); this.knowledge.copWitness(position.x, position.z); return; }
    const victims = options.victims ?? [];
    const candidates: WitnessCandidate<Pedestrian>[] = this.population.pedestrians.map((ped) => ({ ref: ped, x: ped.group.position.x, z: ped.group.position.z, alive: ped.state !== 'down', victim: victims.includes(ped) }));
    const reporter = determineReporter(position.x, position.z, candidates, options.radius);
    if (reporter) {
      const state = this.livingCity.district(this.city.districtAt(position.x, position.z));
      this.knowledge.fileReport(position.x, position.z, heat, reporter, REPORT_DELAY * witnessDelayMultiplier(state));
    }
  }

  private recordCityEvent(kind: CityEvent['kind'], position: THREE.Vector3): void {
    const district = this.city.districtAt(position.x, position.z); const transition = this.livingCity.apply({ kind, district } as CityEvent);
    if (transition) this.ui.notify(`CBD reputation: ${transition.current}`, 'People are changing how they treat you.', transition.state.communityStanding >= 0, 'reputation');
  }

  /** Mission-forced heat behaves as a cop-witnessed report at the player's position, so pursuit still works. */
  private forceWanted(level: number): void {
    this.wanted.setMinimumLevel(level); this.wanted.reportSeen();
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    this.knowledge.copWitness(focus.x, focus.z);
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
    if (item.kind === 'cash') { this.economy.earn(item.amount); this.ui.notify('Cash grabbed', `+R${item.amount}`); return; }
    if (item.kind === 'weapon' && item.weapon) {
      const spec = WEAPON_BY_ID[item.weapon];
      if (this.combat.grantWeapon(item.weapon) === 'new') { this.combat.select(item.weapon); this.player.setWeapon(this.combat.current); this.ui.notify('Weapon acquired', spec.name); }
      else this.ui.notify('Ammo added', spec.name);
      return;
    }
    this.ui.notify('Ammo box', WEAPON_BY_ID[this.combat.addAmmo()].name);
  }

  private openWeaponShop(): void {
    this.mode = 'paused'; this.closeWeaponWheel(); this.audio.setEngine(false); document.exitPointerLock();
    this.renderShop();
  }

  private renderShop(): void {
    const multiplier = shopPriceMultiplier(this.livingCity.district(CBD));
    const entries = WEAPONS.filter((spec) => !spec.melee).map((spec) => {
      const state = this.combat.loadout[spec.id]; const full = reserveFull(spec.id, state.reserve);
      return {
        id: spec.id, name: spec.name, owned: state.owned, price: adjustedShopPrice(weaponPrice(spec.id), multiplier), ammoPrice: adjustedShopPrice(ammoPrice(spec.id), multiplier), reserve: state.reserve, ammoFull: full,
        canBuy: resolvePurchase('weapon', spec.id, state.owned, this.economy.balance, false, multiplier).ok,
        canRefill: resolvePurchase('ammo', spec.id, state.owned, this.economy.balance, full, multiplier).ok,
      };
    });
    this.ui.showShop(entries, this.economy.balance);
  }

  private purchase(kind: 'weapon' | 'ammo', id: WeaponId): void {
    const state = this.combat.loadout[id];
    const multiplier = shopPriceMultiplier(this.livingCity.district(CBD));
    const result = resolvePurchase(kind, id, state.owned, this.economy.balance, reserveFull(id, state.reserve), multiplier);
    if (!result.ok || !this.economy.spend(result.price)) { this.audio.ui(false); this.renderShop(); return; }
    this.combat.grantWeapon(id); this.livingCity.apply({ kind: 'shop-purchase', district: CBD }); this.audio.ui(true);
    this.ui.notify(kind === 'weapon' ? 'Weapon purchased' : 'Ammo refilled', `${WEAPON_BY_ID[id].name} · -R${result.price.toLocaleString()}`);
    this.persist(); this.renderShop();
  }

  private buyHotdog(): void {
    if (this.player.health >= this.player.maxHealth) { this.ui.notify('Sizzlin’ Dogs', 'You are stuffed already. Come back hungry.', false); return; }
    if (!this.economy.spend(HOTDOG_PRICE)) { this.ui.notify('Boerie Stand', `No cash, no boerie. It costs R${HOTDOG_PRICE}.`, false); return; }
    this.player.health = hotdogHeal(this.player.health, this.player.maxHealth);
    this.audio.pickup(); this.ui.notify('Boerewors roll', `Lekker. Tastes like victory. -R${HOTDOG_PRICE}`); this.persist();
  }

  private useSpray(vehicle: Vehicle): void {
    if (vehicle.onFire) { this.ui.notify('Pik-’n’-Spray', 'They wave you off — put the fire out first.', false); return; }
    const watching = this.police.vehicles.some((unit) => !unit.wrecked && unit.group.position.distanceTo(vehicle.group.position) < 25);
    if (watching) { this.ui.notify('Pik-’n’-Spray', 'The JMPD is watching — lose them first.', false); return; }
    const price = detailerPrice(this.wanted.level);
    if (!this.economy.spend(price)) { this.ui.notify('Pik-’n’-Spray', `Detailing costs R${price}. Come back with cash, boss.`, false); return; }
    vehicle.restore(); vehicle.speed = 0; this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.police.reset();
    this.ui.screenFade(); this.audio.ui(true);
    this.ui.notify('Pik-’n’-Spray', `Fresh coat, clean record. Sharp sharp. -R${price}`); this.persist();
  }

  private storeVehicle(vehicle: Vehicle): void {
    if (vehicle.onFire || vehicle.wrecked || vehicle.disabled) { this.ui.notify('Avenida Garage', 'They refuse the wreck. Bring something roadworthy.', false); return; }
    if (this.garageVehicle && this.garageVehicle !== vehicle) this.removeGarageVehicle();
    vehicle.playerControlled = false; vehicle.setFirstPerson(false); vehicle.occupied = false;
    vehicle.heading = GARAGE_PARK.heading; vehicle.reset(new THREE.Vector3(GARAGE_PARK.x, 0, GARAGE_PARK.z));
    const trafficIndex = this.population.traffic.indexOf(vehicle); if (trafficIndex >= 0) this.population.traffic.splice(trafficIndex, 1);
    this.garageVehicle = vehicle;
    this.activeVehicle = undefined; this.transition = undefined; this.player.inVehicle = false; this.player.setVisible(true);
    this.player.group.position.set(GARAGE_PARK.x + 8.5, 0, GARAGE_PARK.z + 4); this.audio.setEngine(false); this.audio.ui(true);
    this.save.garage = { kind: vehicle.spec.kind, color: vehicle.spec.color, health: Math.round(vehicle.health) };
    this.persist();
    this.ui.notify('Vehicle stored', `${vehicle.spec.name} is tucked away in the garage.`);
  }

  private restoreGarageVehicle(): void {
    const saved = this.save.garage; if (!saved) return;
    const vehicle = new Vehicle(this.scene, saved.kind, new THREE.Vector3(GARAGE_PARK.x, 0, GARAGE_PARK.z), saved.color);
    vehicle.heading = GARAGE_PARK.heading; vehicle.group.rotation.y = vehicle.heading; vehicle.health = saved.health;
    this.population.vehicles.push(vehicle); this.garageVehicle = vehicle;
  }

  private removeGarageVehicle(): void {
    const vehicle = this.garageVehicle; if (!vehicle) return;
    this.scene.remove(vehicle.group);
    const index = this.population.vehicles.indexOf(vehicle); if (index >= 0) this.population.vehicles.splice(index, 1);
    const trafficIndex = this.population.traffic.indexOf(vehicle); if (trafficIndex >= 0) this.population.traffic.splice(trafficIndex, 1);
    this.garageVehicle = undefined;
  }

  private processMissionUpdate(update: MissionUpdate): void {
    if (update.failed) { this.audio.ui(false); this.ui.notify('Mission failed', `${update.failed}. Press E to restart.`, false); }
    if (update.choice) {
      const protectedShop = update.choice.choice.id === 'protect';
      this.livingCity.apply({ kind: protectedShop ? 'mission-protected' : 'mission-robbed', district: CBD });
      this.economy.earn(update.choice.choice.reward);
      if (!protectedShop) { this.combat.addAmmo(); this.combat.addAmmo(); this.forceWanted(2); }
      this.audio.ui(true); this.ui.notify('The CBD will remember', protectedShop
        ? `Jozi Arms is safe · trusted status · 20% discount · +R${update.choice.choice.reward.toLocaleString()}`
        : `Shipment taken · notorious status · ammo secured · +R${update.choice.choice.reward.toLocaleString()}`, protectedShop);
    } else if (update.completed) { this.economy.earn(update.completed.reward); this.audio.ui(true); this.ui.notify('Mission complete', `+R${update.completed.reward.toLocaleString()} ${update.completed.name}`); }
    if (update.completed) this.persist();
  }

  private resetMissionRuntime(): void {
    this.deliveryIndex = 0; this.collectedItem = false; this.hostileDefeated = 0; this.previousObjective = '';
    const missionId = this.missions.active?.id;
    const vehicle = this.population.vehicles.find((item) => missionId === 'delivery-run' ? item.spec.color === 0xf1c232 : missionId === 'hot-property' ? item.spec.color === 0xd83a40 : false);
    if (vehicle) {
      vehicle.restore();
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
    const view = this.activeVehicle ? this.settings.cameraViewVehicle : this.settings.cameraViewFoot;
    const firstPerson = view === 0;
    this.player.setVisible(!this.player.inVehicle && !(firstPerson && !this.activeVehicle && !this.transition));
    this.activeVehicle?.setFirstPerson(firstPerson);
    this.cameraController.update(dt, this.input, target, this.city, Boolean(this.activeVehicle), this.settings.mouseSensitivity, view, this.activeVehicle?.heading ?? 0);
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
      const shop = this.shops.shopNear(focus);
      if (this.activeVehicle) {
        if (shop?.kind === 'spray') prompt = `E  Pay-'n'-Spray · R${detailerPrice(this.wanted.level)}`;
        else if (shop?.kind === 'garage') prompt = 'E  Store vehicle';
        else prompt = 'E  Exit vehicle  ·  F  Recover';
      }
      else if (this.missions.objective?.kind === 'collect' && nearbyTarget && nearbyTarget.position.distanceTo(focus) < 8) prompt = 'E  Grab the route permit';
      else if (this.missions.state === 'failed') prompt = 'E  Restart mission';
      else if (this.missions.objective?.kind === 'choice') prompt = 'E  Decide the fate of Jozi Arms';
      else if (MISSIONS.some((mission) => !this.missions.completed.has(mission.id) && mission.start.position.distanceTo(focus) < 7)) prompt = 'E  Speak to contact';
      else if (shop?.kind === 'weapons') prompt = 'E  Browse Jozi Arms';
      else if (shop?.kind === 'hotdog') prompt = `E  Boerewors roll · R${HOTDOG_PRICE}`;
      else if (shop?.driveIn && !this.population.nearestEnterable(focus)) prompt = shop.kind === 'spray' ? 'Drive a vehicle onto the marker to detail' : 'Drive a vehicle onto the marker to store';
      else if (this.population.nearestPedestrian(focus)) prompt = 'F  Mug / melee';
      else if (this.population.nearestEnterable(focus)) prompt = 'E  Enter vehicle';
    }
    const spec = this.combat.spec; const ammoState = this.combat.state;
    const district = this.city.districtAt(focus.x, focus.z);
    const objective = this.missions.objective ? {
      missionName: this.missions.active?.name ?? '', text: this.missions.objective.text, progress: this.missions.objective.required ? this.missions.progress : undefined,
      required: this.missions.objective.required, remainingSeconds: this.missions.remainingTime > 0 ? this.missions.remainingTime : undefined,
    } : undefined;
    const vehicle = this.activeVehicle ? { name: this.activeVehicle.spec.name, speedKph: Math.abs(this.activeVehicle.speed) * 3.6, health: this.activeVehicle.health } : undefined;
    this.ui.update({ health: this.player.health, money: this.economy.balance, weaponName: spec.name, melee: spec.melee, ammo: ammoState.ammo, reserve: ammoState.reserve, reloading: this.combat.reloading > 0, wanted: this.wanted.level, district, clock: this.dayNight.clockText, reputation: district === CBD ? reputationTier(this.livingCity.district(CBD).communityStanding) : undefined, prompt, vehicle, objective, fps: this.fps, settings: this.settings, cheatsOn: this.cheats.fastRun || this.cheats.bigJump || this.cheats.invulnerable });
    const markers = [...this.shops.mapIcons(), ...(this.markerTarget ? [{ x: this.markerTarget.position.x, z: this.markerTarget.position.z, color: this.markerTarget.color ?? '#f5c451' }] : [])];
    const hostiles = this.population.pedestrians.filter((ped) => ped.state === 'hostile' && !ped.contact).map((ped) => ({ x: ped.group.position.x, z: ped.group.position.z }));
    this.ui.drawMap(focus.x, focus.z, this.activeVehicle?.heading ?? this.player.heading, this.city.roadPaths, markers, this.police.vehicles.filter((unit) => !unit.wrecked).map((unit) => ({ x: unit.group.position.x, z: unit.group.position.z })), hostiles);
  }

  private damagePlayer(amount: number): void { if (this.cheats.invulnerable) return; if (amount > 0) this.ui.damageFlash(); this.player.takeDamage(amount); }
  private mainMenuSummary() {
    return { hasSave: this.saveExists, money: this.economy.balance, completedMissions: this.missions.completed.size, totalMissions: MISSIONS.length, reputation: reputationTier(this.livingCity.district(CBD).communityStanding) };
  }
  private die(): void {
    if (this.mode === 'dead') return;
    if (this.missions.state === 'active') this.missions.fail('You were incapacitated');
    this.mode = 'dead'; this.deathTimer = 3; this.audio.setEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio(); this.closeWeaponWheel(); this.ui.notify('EISH', 'You got klapped. An ambulance is coming just now. Press E after respawning to restart the job.', false); document.exitPointerLock();
  }
  private respawn(): void {
    if (this.activeVehicle) { this.activeVehicle.playerControlled = false; this.activeVehicle.setFirstPerson(false); this.activeVehicle = undefined; }
    this.transition = undefined; this.player.inVehicle = false; this.player.setVisible(true); this.player.heal(); this.player.group.position.set(...this.save.spawn); this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.police.reset(); this.mode = 'playing';
  }
  private pause(): void { this.mode = 'paused'; this.audio.setEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio(); this.closeWeaponWheel(); document.exitPointerLock(); this.ui.showPause(this.settings); }
  private persist(): void { this.save = { version: 2, money: this.economy.balance, completedMissions: [...this.missions.completed], spawn: this.save.spawn, settings: this.settings, weapons: this.combat.serialize(), cheats: { ...this.cheats }, garage: this.save.garage, livingCity: this.livingCity.state, timeOfDay: this.dayNight.hour }; this.saveManager.save(this.save); }
  private resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); this.composer?.setSize(innerWidth, innerHeight); }
}
