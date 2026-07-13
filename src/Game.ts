import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { PLAYER, VEHICLE_SPECS, WEAPON_BY_ID, WEAPONS, type VehicleKind, type WeaponId } from './config';
import { AudioManager } from './core/AudioManager';
import { radioDial } from './core/RadioStations';
import { CAMERA_VIEW_NAMES, CameraController, cycleView } from './core/CameraController';
import { absorbDamage, ARMOUR_MAX, canFireFromVehicle, crosshairVisible, cycleWeapon, DRIVEBY_COOLDOWN_SCALE, Economy, fallDamage, PARACHUTE_MAX, riderImpactDamage, rollDrops, shouldKnockOff, STIM_MAX, stimHeal, type PedKind } from './core/GameRules';
import { scopeActive, scopeFov, scopeSensitivity, scopeWeapon, scopeZoomLabel, SNIPER_RECOIL, stepScopeLevel, wheelAction } from './core/ScopeRules';
import { InputManager } from './core/InputManager';
import { MultiplayerOverlay } from './multiplayer/MultiplayerOverlay';
import { OnlineSession } from './multiplayer/OnlineSession';
import { onlineCorrectionFactor } from './multiplayer/latency';
import { DEFAULT_SAVE, SaveManager } from './core/SaveManager';
import { maxCatchupSteps, simSteps } from './core/Timestep';
import { adjustedShopPrice, ammoPrice, detailerPrice, HOTDOG_PRICE, hotdogHeal, reserveFull, resolveArmourPurchase, resolvePurchase, weaponPrice } from './core/ShopRules';
import type { Pedestrian } from './entities/Pedestrian';
import { Player, type CoverPose } from './entities/Player';
import { Vehicle } from './entities/Vehicle';
import { BulletSystem } from './systems/BulletSystem';
import { CombatSystem, type ShotResult } from './systems/CombatSystem';
import { BUMP_ASSAULT_HEAT } from './systems/BumpSystem';
import { heatAfterStarDrop, runConsoleCommand, type ConsoleHost } from './systems/Console';
import { clampT, cornerSide, COVER_ENTER_RANGE, COVER_EXIT_HOLD, coverHeading, coverPosition, coverT, movingAway, nearestGroundedCoverSpot, PEEK_OUT, PEEK_STEP, SLIDE_SPEED, type CoverSpot } from './systems/CoverSystem';
import { COURIER_MIN_TRIP_DISTANCE, COURIER_STOP_RADIUS, COURIER_STOP_SPEED, CourierJob, courierHudText } from './systems/CourierJobSystem';
import { FEAR_EVENTS, FEAR_MAX } from './systems/FearSystem';
import { GoreSystem } from './systems/GoreSystem';
import { LoadSheddingSystem } from './systems/LoadSheddingSystem';
import { MISSIONS, MissionSystem, type MissionUpdate } from './systems/MissionSystem';
import { CAR_TARGET_CAP, clampBusy, isAmbientPedestrian, LifecycleSystem, PED_TARGET_CAP } from './systems/LifecycleSystem';
import { PickupSystem, type Pickup } from './systems/PickupSystem';
import { determineReporter, PoliceKnowledge, radioCallout, REPORT_DELAY, SIGHT_RADIUS, type CrimeLabel, type WitnessCandidate } from './systems/PoliceKnowledge';
import { PoliceSystem, separationPush, toggleSiren } from './systems/PoliceSystem';
import { PopulationSystem } from './systems/PopulationSystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { PropSystem } from './systems/PropSystem';
import { findPath, nearestNode, type NavPoint } from './systems/NavGraph';
import { canEnterSafehouse, SAFEHOUSES, SafehouseSystem, safehouseSpawn, SLEEP_HOURS, sleepHour, type SafehousePlace } from './systems/SafehouseSystem';
import { GARAGE_PARK, GARAGE_STEP_OUT, SHOPS, ShopSystem } from './systems/ShopSystem';
import { airborneHint, canDeploy, chuteLandingDamage, deployParachute, SKYFALL_ALTITUDE, startAirborne, stepAirborne, type AirborneState } from './systems/SkyfallSystem';
import { buildTeleportTargets, clampToWorld, districtAnchors, resolveTeleport, safePlacement, type TeleportTarget } from './systems/Teleport';
import { ABANDON_RADIUS, ARRIVE_RADIUS, BOARD_RADIUS, canHail, GUNFIRE_FEAR_RADIUS, GUNFIRE_FEAR_SCALE, HAIL_RADIUS, isTaxiKind, MIN_TRIP_DISTANCE, PICKUP_RADIUS, REHAIL_COOLDOWN, routeDistance, STOP_SPEED, TaxiRide, taxiHudText } from './systems/TaxiJobSystem';
import { BURN_DPS, OCCUPANT_BURNOUT_DAMAGE, POLICE_WRECK_HEAT, VehicleFireSystem } from './systems/VehicleFireSystem';
import { WantedSystem } from './systems/WantedSystem';
import { CBD, civilianDisposition, LivingCitySystem, policeReinforcementModifier, reputationTier, shopPriceMultiplier, witnessDelayMultiplier, type CityEvent } from './systems/LivingCitySystem';
import type { CheatSettings, GameMode, GameSettings, Inventory, SavedGame, WorldTarget } from './types';
import { weaponWheelResponds } from './ui/mapRender';
import type { MapViewFrame } from './ui/MapView';
import { type MapMarker, type MapPoint, MINIMAP_ZOOM_NAMES, stepMinimapZoom } from './ui/MinimapView';
import { UIManager } from './ui/UIManager';
import { City } from './world/City';
import { COURIER_DEPOT, DELIVERY_STOPS, GTI_SPOT, PORTIA_CAR_SPOT } from './world/placements';
import { DayNightSystem } from './world/DayNight';
import { buildEnvironment, type EnvironmentHandle } from './world/Environment';
import { ETOLL_GANTRIES } from './world/UrbanInfrastructure';
import { setPower } from './world/powerGrid';

const MOUSE_STEER_GAIN = 0.005; // px of horizontal LMB-drag per unit of steer: ~200px winds the virtual wheel to full lock — tuned light, for small trim adjustments rather than hard cornering

interface Transition { vehicle: Vehicle; timer: number; entering: boolean; exitPosition?: THREE.Vector3; }

export class Game {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 8000); // player-relative far plane: covers the massed CBD skyline with generous margin at the 18000u parity scale; fog (Environment.ts) hides the cut and the bare outskirts
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
  private lifecycle: LifecycleSystem;
  private cameraForward = new THREE.Vector3();
  private combat: CombatSystem;
  private gore: GoreSystem;
  private pickups: PickupSystem;
  private projectiles: ProjectileSystem;
  private bullets: BulletSystem;
  private propFx: PropSystem;
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
  private safehouses: SafehouseSystem;
  private activeSafehouse?: SafehousePlace;
  private garageVehicle?: Vehicle;
  private ui = new UIManager();
  private multiplayerOverlay = new MultiplayerOverlay();
  private online?: OnlineSession;
  private onlineWasDead = false;
  private mode: GameMode = 'menu';
  private activeVehicle?: Vehicle;
  private transition?: Transition;
  private marker = new THREE.Group();
  private markerTarget?: WorldTarget;
  private markerColor = '';
  private markerPhase = 0;
  private collectedItem = false;
  private hostileDefeated = 0;
  private deliveryIndex = 0;
  private deathTimer = 0;
  private saveTimer = 0;
  private potholeCooldown = 0;
  private etollCooldowns: number[] = ETOLL_GANTRIES.map(() => 0);
  private radioIntroShown = false;
  private mouseSteerHintShown = false;
  private driveSteer = 0; // virtual steering-wheel offset [-1,1] wound by LMB-drag mouse steering (only in a vehicle, third person, not aiming)
  private driveSteerActive = false;
  private footstepTimer = 0;
  private prevDrivenSpeed = 0;
  private wallCrashCooldown = 0;
  private fps = 60;
  private simStepCostMs = 0; // EMA of one update()'s wall time; sizes the per-frame catch-up budget (see maxCatchupSteps)
  private navHudCalls = 0; private navHudMs = 0; // A* solves/sec and ms/sec, shown beside the FPS counter
  private navHudTimer = 0; private navHudLastSolves = 0; private navHudLastMs = 0; // rolling 1s sampler state
  private weaponWheelOpen = false;
  private wheelVector = new THREE.Vector2();
  private wheelHighlight: WeaponId = 'pistol';
  private previousObjective = '';
  private loggedDrawCalls = false;
  private vehicleCollisionCooldown = new WeakMap<Vehicle, number>();
  private reputationReactionCooldown = 0;
  private helperCooldown = 90;
  private radioCooldown = 0;
  private previousWanted = false;
  private hostileGuardActivated = false;
  private taxiRide = new TaxiRide();
  private taxiHailPed?: Pedestrian;
  private taxiPassenger?: Pedestrian;
  private taxiDestination?: THREE.Vector3;
  private taxiHailCooldown = 0;
  private courierJob = new CourierJob();
  private courierDestination?: THREE.Vector3;
  private brandishCooldown = 0;
  private scopeLevel = 0;
  private cover?: { spot: CoverSpot; t: number; peek: number; corner: -1 | 0 | 1; exitTimer: number };
  private coverAvailable = false;
  private coverLean = 0;
  private inventory: Inventory;
  private airborne?: AirborneState;
  private districtTargets: TeleportTarget[];

  constructor(private container: HTMLElement) {
    this.saveExists = this.saveManager.hasSave(); this.save = this.saveManager.load(); this.settings = { ...this.save.settings }; this.cheats = { ...this.save.cheats }; this.inventory = { ...this.save.inventory }; this.economy = new Economy(this.save.money); this.livingCity = new LivingCitySystem(this.save.livingCity);
    this.setupRenderer(); this.setupScene();
    this.city = new City(this.scene, this.settings.quality);
    this.districtTargets = districtAnchors((x, z) => this.city.districtAt(x, z));
    this.dayNight = new DayNightSystem(this.scene, this.environment, this.city, this.settings.quality, this.save.timeOfDay);
    this.shops = new ShopSystem(this.scene, this.city);
    this.safehouses = new SafehouseSystem(this.scene, this.city);
    this.player = new Player(this.scene, new THREE.Vector3(...this.save.spawn));
    this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z);
    this.cameraController = new CameraController(this.camera);
    this.population = new PopulationSystem(this.scene, this.city, this.audio);
    this.lifecycle = new LifecycleSystem(this.city, this.population);
    this.combat = new CombatSystem(this.scene, this.audio);
    this.gore = new GoreSystem(this.scene, (x, z) => this.city.surfaceHeightAt(x, z));
    this.pickups = new PickupSystem(this.scene);
    this.projectiles = new ProjectileSystem(this.scene);
    this.bullets = new BulletSystem(this.scene);
    this.vehicleFire = new VehicleFireSystem(this.scene);
    this.propFx = new PropSystem(this.scene, this.city.props, this.audio, (x, z) => this.city.surfaceHeightAt(x, z));
    this.combat.onRocket = (origin, direction, spec) => { if (spec.projectile) this.projectiles.spawn(origin, direction, spec.projectile, spec.range); };
    this.combat.onShot = (position, origin, directions, count, spec, exclude) => this.bullets.spawnShot(position, origin, directions, count, spec, exclude);
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
    this.renderer.setPixelRatio(this.renderPixelRatio()); this.renderer.setSize(innerWidth, innerHeight);
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
    const composer = new EffectComposer(this.renderer);
    // Two samples preserve edge stability while halving the multisample bandwidth/memory of the old 4x
    // full-screen half-float targets. Resolution is already quality-capped by renderPixelRatio().
    composer.renderTarget1.samples = 2; composer.renderTarget2.samples = 2;
    composer.setSize(innerWidth, innerHeight);
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
    this.ui.onOnline = (name) => this.startOnline(name);
    this.ui.onResume = () => { this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); if (this.activeVehicle && !this.activeVehicle.spec.twoWheeler) this.audio.startRadio(); void this.renderer.domElement.requestPointerLock().catch(() => undefined); };
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
    this.ui.onBuyArmour = () => this.purchaseArmour();
    this.ui.onSafehouseSave = () => {
      const place = this.activeSafehouse; if (!place) return;
      this.save.spawn = safehouseSpawn(place); this.persist(); this.audio.ui(true);
      this.ui.notify('Game saved', `Wake-up spot set: ${place.name}.`);
      this.ui.onResume?.();
    };
    this.ui.onSafehouseSleep = () => {
      const place = this.activeSafehouse; if (!place) return;
      this.dayNight.hour = sleepHour(this.dayNight.hour);
      this.player.heal(); this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.police.reset();
      this.save.spawn = safehouseSpawn(place); this.persist();
      this.ui.screenFade(); this.audio.ui(true);
      this.ui.notify(`Slept until ${this.dayNight.clockText}`, 'Rested, healed and saved. Any heat is yesterday’s news.');
      this.ui.onResume?.();
    };
    this.ui.onMissionChoice = (id) => {
      const update = this.missions.choose(id); this.mode = 'playing'; this.ui.hideMenu(); void this.renderer.domElement.requestPointerLock().catch(() => undefined);
      this.processMissionUpdate(update);
    };
    this.ui.onConsoleCommand = (text) => this.ui.consolePrint(runConsoleCommand(text, this.consoleHost));
    this.ui.onConsoleClose = () => this.closeConsole();
    this.ui.onMapClose = () => this.closeMap();
  }

  private openConsole(): void { this.closeWeaponWheel(); this.input.suspend(true); this.ui.openConsole(); }
  private closeConsole(): void { if (!this.ui.consoleOpen) return; this.ui.closeConsole(); this.input.suspend(false); }

  /** City map overlay: like the console, world keeps running but input is suspended and the pointer freed. */
  private openMap(): void {
    if (this.ui.mapOpen) return;
    this.closeWeaponWheel(); this.input.suspend(true); document.exitPointerLock();
    this.ui.openMap(this.mapFrame());
  }
  private closeMap(): void {
    if (!this.ui.mapOpen) return;
    this.ui.closeMap(); this.input.suspend(false);
    if (this.mode === 'playing') void this.renderer.domElement.requestPointerLock().catch(() => undefined); // may hit the browser's relock cooldown: the standing click-to-relock fallback covers that
  }

  /** Live snapshot fed to the map overlay: player pose plus markers in the minimap's language. */
  private mapFrame(): MapViewFrame {
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    return {
      x: focus.x, z: focus.z, heading: this.activeVehicle?.heading ?? this.player.heading,
      markers: this.mapMarkers(), police: this.mapPolice(), hostiles: this.mapHostiles(),
    };
  }
  private mapMarkers(): MapMarker[] {
    if (this.online) return this.online.playerStates.filter((player) => player.id !== this.online?.selfId && !player.dead).map((player) => ({ x: player.x, z: player.z, color: '#55e0bb', shape: 'diamond' as const }));
    return [
      ...this.shops.mapIcons(), ...this.safehouses.mapIcons(),
      ...(this.markerTarget ? [{ x: this.markerTarget.position.x, z: this.markerTarget.position.z, color: this.markerTarget.color ?? '#f5c542' }] : []),
      ...(this.taxiHailPed ? [{ x: this.taxiHailPed.group.position.x, z: this.taxiHailPed.group.position.z, color: '#f2c521' }] : []),
    ];
  }
  private mapPolice(): MapPoint[] {
    if (this.online) return [];
    return this.police.vehicles.filter((unit) => !unit.wrecked).map((unit) => ({ x: unit.group.position.x, z: unit.group.position.z }));
  }
  private mapHostiles(): MapPoint[] {
    if (this.online) return [];
    return this.population.pedestrians.filter((ped) => ped.state === 'hostile' && !ped.contact && !ped.police).map((ped) => ({ x: ped.group.position.x, z: ped.group.position.z }));
  }

  /** Console command handlers: every mutation goes through the same paths the game itself uses. */
  private consoleHost: ConsoleHost = {
    setTime: (hour) => { this.dayNight.hour = hour; this.persist(); return `Clock set to ${this.dayNight.clockText}.`; },
    setTimerate: (rate) => { this.dayNight.timeRate = Math.min(120, Math.max(0, rate)); return this.dayNight.timeRate === 0 ? 'Time frozen.' : `Time runs at ${this.dayNight.timeRate}× normal.`; },
    toggleFps: () => { this.settings.showFps = !this.settings.showFps; this.persist(); return `Performance display ${this.settings.showFps ? 'on' : 'off'}.`; },
    spawn: (kind) => this.spawnConsoleVehicle(kind),
    giveCash: (amount) => {
      this.economy.earn(amount); this.persist();
      this.ui.notify('Tender approved', `+R${amount.toLocaleString()}. Don't ask questions.`);
      return `+R${amount.toLocaleString()} — balance R${this.economy.balance.toLocaleString()}.`;
    },
    dropStar: () => this.consoleDropStar(),
    toggleShedding: () => { const event = this.loadShedding.force(); this.applyEskom(event); return event === 'start' ? 'Load shedding forced. Stage 4 begins.' : 'Load shedding called off. Power restored.'; },
    toggleSirens: () => { this.audio.sirensMuted = !this.audio.sirensMuted; if (this.audio.sirensMuted) this.audio.setSiren(false); return this.audio.sirensMuted ? 'Sirens silenced. Elude in peace.' : 'Sirens back on. The city screams again.'; },
    setBusy: (percent) => { this.lifecycle.tuning = { busy: clampBusy(percent) }; return `Busy level ${this.lifecycle.tuning.busy}%. ${this.describeCrowd()}`; }, // fresh tuning also clears peds/cars pins
    setPedTarget: (count) => {
      this.lifecycle.tuning.peds = count === undefined ? undefined : Math.min(PED_TARGET_CAP, count);
      return count === undefined ? `Pedestrian target back on the clock. ${this.describeCrowd()}` : `Pedestrian target pinned at ${this.lifecycle.tuning.peds}. ${this.describeCrowd()}`;
    },
    setCarTarget: (count) => {
      this.lifecycle.tuning.cars = count === undefined ? undefined : Math.min(CAR_TARGET_CAP, count);
      return count === undefined ? `Traffic target back on the clock. ${this.describeCrowd()}` : `Traffic target pinned at ${this.lifecycle.tuning.cars}. ${this.describeCrowd()}`;
    },
    busyInfo: () => `Busy level ${this.lifecycle.tuning.busy}%. ${this.describeCrowd()}`,
    openMap: () => { this.closeConsole(); this.openMap(); return 'Opening the city map. Press M or ESC to close.'; },
    save: () => { this.persist(); return 'Game saved.'; },
    teleport: (x, z) => this.teleportPlayer(clampToWorld(x), clampToWorld(z), `${Math.round(x)}, ${Math.round(z)}`),
    teleportNamed: (name) => {
      const target = resolveTeleport(name, this.teleportTargets());
      return target ? this.teleportPlayer(target.x, target.z, target.name) : `Eish, unknown place: ${name}. Try "tp list".`;
    },
    teleportList: () => {
      const targets = this.teleportTargets();
      const kinds = ['spawn', 'district', 'shop', 'safehouse', 'mission'] as const;
      return kinds.map((kind) => `${kind}: ${targets.filter((target) => target.kind === kind).map((target) => target.name).join(', ')}`);
    },
    skyfall: (name) => this.beginSkyfall(name),
    giveWeapon: (id) => {
      const result = this.combat.grantWeapon(id); this.player.setWeapon(this.combat.current); this.persist();
      return `${WEAPON_BY_ID[id].name}: ${result === 'new' ? 'granted' : 'ammo topped up'}.`;
    },
    giveAmmo: () => { const filled = this.combat.maxAmmo(); this.persist(); return `${filled} weapon${filled === 1 ? '' : 's'} fully stocked.`; },
    giveArmour: () => { this.inventory.armour = ARMOUR_MAX; this.persist(); return `Body armour strapped on: ${ARMOUR_MAX}/${ARMOUR_MAX}.`; },
    giveItem: (item, count) => {
      if (item === 'stim') { this.inventory.stims = Math.min(STIM_MAX, this.inventory.stims + count); this.persist(); return `Stim packs: ${this.inventory.stims}/${STIM_MAX}. Press H to use one.`; }
      this.inventory.parachutes = Math.min(PARACHUTE_MAX, this.inventory.parachutes + count); this.persist();
      return `Parachutes: ${this.inventory.parachutes}/${PARACHUTE_MAX}. SPACE deploys one mid-air.`;
    },
  };

  /** The gazetteer is rebuilt per query so the `spawn` entry tracks the current wake-up spot; districts are sampled once. */
  private teleportTargets(): TeleportTarget[] {
    return buildTeleportTargets({ spawn: this.save.spawn, districts: this.districtTargets, shops: SHOPS, safehouses: SAFEHOUSES, missions: MISSIONS });
  }

  /** Drops the player safely at (x, z): vehicle, cover and airborne states end cleanly, the spot nudges off any
   *  collider, and the camera snaps behind the new position instead of flying across town. Driving? You arrive
   *  on foot — the vehicle stays where it was. */
  private teleportPlayer(x: number, z: number, label: string): string {
    const vehicle = this.activeVehicle ?? this.transition?.vehicle;
    if (vehicle) {
      this.endTaxiShift(vehicle);
      this.endCourierShift();
      vehicle.playerControlled = false; vehicle.setFirstPerson(false);
      this.activeVehicle = undefined; this.transition = undefined;
      this.audio.setEngine(false); this.audio.stopRadio();
    }
    this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false); this.player.resetAirbornePose();
    this.player.inVehicle = false; this.player.setVisible(true);
    const spot = safePlacement(x, z, (px, pz) => this.city.collides(px, pz, PLAYER.radius));
    this.player.group.position.set(spot.x, this.city.surfaceHeightAt(spot.x, spot.z), spot.z);
    this.player.velocityY = 0; this.player.onGround = true;
    this.cameraController.snapBehind(this.player.group.position);
    this.ui.screenFade();
    return spot.clear ? `Teleported to ${label} (${Math.round(spot.x)}, ${Math.round(spot.z)}).` : `No clear ground near ${label} — dropped on the mark anyway.`;
  }

  /** `skyfall [name]`: safe-teleport to the target (or stay put), then hoist to skydive altitude in freefall. */
  private beginSkyfall(name?: string): string {
    let x = this.player.group.position.x; let z = this.player.group.position.z; let label = 'this very spot';
    if (name) {
      const target = resolveTeleport(name, this.teleportTargets());
      if (!target) return `Eish, unknown place: ${name}. Try "tp list".`;
      x = target.x; z = target.z; label = target.name;
    }
    this.teleportPlayer(x, z, label);
    this.player.group.position.y += SKYFALL_ALTITUDE;
    this.player.onGround = false; this.player.velocityY = 0;
    this.airborne = startAirborne(this.player.heading, this.player.group.position.y);
    this.player.startSkydive(); // snap belly-to-earth on frame one instead of tipping over from standing
    this.cameraController.pitch = 0.62; // start looking down at the city
    this.closeConsole(); // hand WASD straight back — the ground is coming
    this.ui.notify('Geronimo!', this.inventory.parachutes > 0 ? 'SPACE deploys the parachute. W dives, S flattens, A/D steer.' : 'No parachute aboard. W dives, S flattens, A/D steer. Good luck.', this.inventory.parachutes > 0);
    return `Skydiving from ${SKYFALL_ALTITUDE}u above ${label}.`;
  }

  private describeCrowd(): string {
    const target = this.lifecycle.targets(this.dayNight.hour); const tuning = this.lifecycle.tuning;
    const livePeds = this.population.pedestrians.filter(isAmbientPedestrian).length;
    const liveCars = this.population.traffic.filter((vehicle) => !vehicle.wrecked && !vehicle.disabled).length;
    return `Nearby targets: ${target.peds} peds${tuning.peds !== undefined ? ' (pinned)' : ''} / ${target.traffic} cars${tuning.cars !== undefined ? ' (pinned)' : ''} — live ${livePeds} / ${liveCars}.`;
  }

  private spawnConsoleVehicle(kind: VehicleKind): string {
    const spec = VEHICLE_SPECS[kind];
    const origin = this.activeVehicle?.group.position ?? this.player.group.position;
    const yaw = this.activeVehicle?.heading ?? this.player.heading;
    const ahead = new THREE.Vector3(origin.x + Math.sin(yaw) * 8, 0, origin.z + Math.cos(yaw) * 8);
    const pose = this.city.nearestRoadPose(ahead);
    const blocked = pose.position.distanceTo(origin) < 2.5
      || [...this.population.vehicles, ...this.police.vehicles].some((other) => other.group.position.distanceTo(pose.position) < 3.5);
    if (blocked) return 'Eish, no clear kerb for the drop-off. Move along and try again.';
    const vehicle = new Vehicle(this.scene, kind, pose.position.clone());
    vehicle.heading = Math.atan2(pose.position.x - origin.x, pose.position.z - origin.z); // nose away from the player
    vehicle.group.rotation.y = vehicle.heading;
    this.population.vehicles.push(vehicle);
    this.ui.notify('Vehicle delivered', `${spec.name}, parked just ahead.`);
    return `${spec.name} delivered just ahead.`;
  }

  private consoleDropStar(): string {
    if (!this.wanted.isWanted) return 'JMPD already has nothing on you.';
    const before = this.wanted.level;
    this.wanted.heat = heatAfterStarDrop(this.wanted.heat);
    if (!this.wanted.isWanted) { this.knowledge.reset(); this.previousWanted = false; }
    this.ui.notify('Strings pulled', `Wanted level ${before} → ${this.wanted.level}.`);
    return `Wanted level dropped: ${before} → ${this.wanted.level}.`;
  }

  private applyQuality(): void {
    const shadows = this.settings.quality !== 'low';
    this.renderer.setPixelRatio(this.renderPixelRatio()); this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = shadows; this.environment.sun.castShadow = shadows;
    this.dayNight.setQuality(this.settings.quality);
    this.city.setWaterQuality(this.settings.quality); // rebuilds water meshes; disposes the old tier's materials and mirror target
    this.setupComposer();
  }

  /** Keep Retina/HiDPI displays from multiplying every full-screen pass beyond the selected quality tier. */
  private renderPixelRatio(): number {
    const cap: Record<GameSettings['quality'], number> = { low: 1, medium: 1.25, high: 1.5 };
    return Math.min(devicePixelRatio || 1, cap[this.settings.quality]);
  }

  private startGame(fresh: boolean): void {
    this.online?.close(); this.online = undefined; this.multiplayerOverlay.hide();
    if (fresh) { this.endTaxiShift(); this.endCourierShift(); this.removeGarageVehicle(); this.save = structuredClone(DEFAULT_SAVE); this.saveManager.save(this.save); this.saveExists = true; this.economy.balance = this.save.money; this.livingCity = new LivingCitySystem(this.save.livingCity); this.missions.completed.clear(); this.airborne = undefined; this.player.setCanopy(false); this.inventory = { ...this.save.inventory }; this.player.group.position.set(...this.save.spawn); this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z); this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current); Object.assign(this.cheats, this.save.cheats); this.dayNight.hour = this.save.timeOfDay; }
    this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.audio.resume(); this.audio.setVolume(this.settings.masterVolume); void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    this.ui.notify('Welcome to Joburg', 'Mind the potholes. Mission contacts are marked in gold.');
  }

  private startOnline(name: string): void {
    this.endTaxiShift(); this.endCourierShift(); this.online?.close();
    this.player.inVehicle = false; this.player.setVisible(true); this.player.heal(); this.combat.restore(DEFAULT_SAVE.weapons); this.combat.select('pistol'); this.player.setWeapon('pistol');
    this.activeVehicle = undefined; this.transition = undefined; this.cover = undefined; this.airborne = undefined; this.player.resetAirbornePose();
    this.player.group.position.set(2050, 0, 3850); this.player.group.position.y = this.city.surfaceHeightAt(2050, 3850);
    this.onlineWasDead = false; this.online = new OnlineSession(this.scene, this.multiplayerOverlay, name, (x, z) => this.city.surfaceHeightAt(x, z));
    this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.audio.resume();
    void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    this.ui.notify('Global world', 'Open PvP is active. Press Enter to chat.');
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const raw = this.clock.getDelta(); this.fps = THREE.MathUtils.lerp(this.fps, 1 / Math.max(raw, 0.001), 0.06);
    this.navHudTimer += raw; // once a real second, convert the A* solve/ms totals into per-second rates for the HUD
    if (this.navHudTimer >= 1) {
      const solves = this.population.navSolveCount(); const ms = this.population.navSolveMs();
      this.navHudCalls = Math.round((solves - this.navHudLastSolves) / this.navHudTimer);
      this.navHudMs = (ms - this.navHudLastMs) / this.navHudTimer;
      this.navHudLastSolves = solves; this.navHudLastMs = ms; this.navHudTimer = 0;
    }
    const steps = simSteps(raw); let frameDt = steps.reduce((total, step) => total + step, 0); // wall-clock time the world advances this frame — real time under slow frames, capped only at the catch-up ceiling
    if (this.mode === 'playing') {
      // sub-steps: a 15fps frame runs two updates instead of stretching one past the physics-stable step. But
      // never run more than the measured per-step cost can fit in SIM_CATCHUP_BUDGET_MS — otherwise catch-up
      // work keeps every frame slow and the step count spirals to the ceiling, locking idle fps below 10.
      const allowed = maxCatchupSteps(this.simStepCostMs);
      frameDt = 0;
      for (let i = 0; i < steps.length && i < allowed; i++) {
        const stepStart = performance.now();
        if (this.online) this.updateOnline(steps[i]!); else this.update(steps[i]!);
        this.simStepCostMs = this.simStepCostMs === 0 ? performance.now() - stepStart : this.simStepCostMs * 0.9 + (performance.now() - stepStart) * 0.1;
        frameDt += steps[i]!; // camera/marker advance only by the sim time actually run, so the view can't outrun the world under overload
        if (this.mode !== 'playing') break;
      }
    }
    else if (this.mode === 'dead') { this.deathTimer -= frameDt; if (this.deathTimer <= 0) this.respawn(); }
    else if (this.input.consume('Escape')) this.ui.back();
    this.tickMouseSteer(frameDt); this.updateCamera(frameDt); this.updateMarker(frameDt); this.renderHUD();
    this.environment.updateShadowFocus(this.activeVehicle?.group.position ?? this.player.group.position);
    this.city.updateVisibility(this.activeVehicle?.group.position ?? this.player.group.position); // staggered chunk culling — runs in every mode so the menu backdrop is culled too
    const measure = import.meta.env.DEV && !this.loggedDrawCalls && this.clock.elapsedTime > 2; // >2s: the staggered chunk culling needs its first full pass before the number means anything
    if (measure) { this.renderer.info.autoReset = false; this.renderer.info.reset(); }
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    if (measure) { this.loggedDrawCalls = true; console.info(`[render] calls=${this.renderer.info.render.calls} tris=${this.renderer.info.render.triangles}`); this.renderer.info.autoReset = true; }
    this.input.endFrame();
  };

  private update(dt: number): void {
    if (this.input.consume('Escape')) { this.pause(); return; }
    if (this.input.consume('Backquote')) this.openConsole(); // input suspends, world keeps running
    if (this.input.consume('KeyM')) this.openMap(); // Esc/M closes it (handled by the overlay while open)
    if (this.input.consume('KeyV')) {
      const key = this.activeVehicle ? 'cameraViewVehicle' : 'cameraViewFoot';
      this.settings[key] = cycleView(this.settings[key]);
      this.ui.notify(`Camera: ${CAMERA_VIEW_NAMES[this.settings[key]]}`); this.persist();
    }
    const zoomDirection = (this.input.consume('PageUp') ? 1 : 0) - (this.input.consume('PageDown') ? 1 : 0);
    if (zoomDirection) {
      const next = stepMinimapZoom(this.settings.minimapZoom, zoomDirection as 1 | -1);
      if (next !== this.settings.minimapZoom) { this.settings.minimapZoom = next; this.persist(); }
      this.ui.notify(`Minimap: ${MINIMAP_ZOOM_NAMES[this.settings.minimapZoom]}`);
    }
    if (this.input.consume('KeyH')) this.useStim();
    if (this.airborne) this.updateAirborne(dt);
    else if (this.transition) this.updateTransition(dt);
    else if (this.activeVehicle) this.updateDriving(dt);
    else this.updateOnFoot(dt);
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    this.brandishCooldown = Math.max(0, this.brandishCooldown - dt);
    if (this.input.aiming && !this.combat.spec.melee && !this.transition && !this.airborne && this.brandishCooldown === 0) { this.population.broadcastBrandish(focus); this.brandishCooldown = 1.5; } // a raised gun scares witnesses; no police heat for merely aiming
    this.livingCity.update(dt); this.updateLivingCityRuntime(dt, focus);
    this.audio.updateListener(focus.x, focus.z, this.cameraController.yaw, this.city.isPark(focus.x, focus.z));
    this.population.update(dt, focus, (amount) => this.damagePlayer(amount), !this.activeVehicle && !this.transition && !this.airborne);
    for (const hit of this.population.consumePlayerVehicleHits()) { // civilian traffic vs the on-foot player: the driver is AI, the player the victim — no heat, just physics
      if (hit.damage > 0) this.damagePlayer(hit.damage);
      if (hit.knockdown && !this.player.tumbling) { this.player.tumble(); this.shake = Math.min(0.7, this.shake + 0.3); }
    }
    const forward = this.camera.getWorldDirection(this.cameraForward);
    const guarded = new Set<Vehicle>();
    for (const vehicle of [this.activeVehicle, this.transition?.vehicle, this.garageVehicle]) if (vehicle) guarded.add(vehicle);
    this.lifecycle.update(dt, this.dayNight.hour, { x: focus.x, z: focus.z, dirX: forward.x, dirZ: forward.z }, guarded);
    this.city.update(dt);
    this.applyEskom(this.loadShedding.update(dt));
    this.dayNight.update(dt, focus, this.population.vehicles, this.police.vehicles, this.activeVehicle ?? this.transition?.vehicle);
    for (const impact of this.population.consumeImpacts()) {
      const intensity = Math.min(1.6, Math.abs(impact.vehicle.speed) / 16);
      this.gore.burst(impact.position, intensity, impact.killed);
      this.audio.splat(intensity, impact.position.x, impact.position.z);
      if (impact.vehicle === this.activeVehicle) this.reportCrime(impact.position, impact.killed ? 24 : 12, { victims: [impact.ped], radius: (impact.killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: impact.killed ? 'civilian-murder' : 'civilian-assault', label: impact.killed ? 'murder' : 'hit-and-run' });
      if (impact.killed) this.spawnDropsAt(impact.position, 'civilian');
    }
    const districtState = this.livingCity.district(this.city.districtAt(focus.x, focus.z));
    const reinforcementModifier = policeReinforcementModifier(districtState);
    this.population.setPolicePatrolCount(reinforcementModifier, focus);
    // Two-wheelers stay a vehicle pursuit (no standoff/arrest), but they grant no cover: JMPD fire lands on the rider.
    const riddenBike = Boolean(this.activeVehicle?.spec.twoWheeler);
    this.police.update(dt, focus, Boolean(this.activeVehicle), this.wanted, this.knowledge, (amount) => this.damagePlayer(amount), reinforcementModifier,
      (amount) => { if (riddenBike) this.damagePlayer(amount); else this.activeVehicle?.takeDamage(amount); }, Boolean(this.activeVehicle?.police && this.activeVehicle.sirenOn));
    for (const event of this.police.consumeEvents()) {
      if (event.kind === 'freeze') this.ui.notify('JMPD', '"FREEZE! Hands where I can see them!"', false);
      else if (event.kind === 'officers') this.population.pedestrians.push(...event.officers);
      else if (event.kind === 'reboard') for (const officer of event.officers) { const index = this.population.pedestrians.indexOf(officer); if (index >= 0) this.population.pedestrians.splice(index, 1); }
      else this.population.vehicles.push(event.vehicle); // abandoned cruiser joins the civilian pool — enterable like any parked car
    }
    if (this.activeVehicle?.spec.twoWheeler) { // genuine interceptor contact is exactly the kind of hit that unseats a rider
      const bike = this.activeVehicle;
      const rammer = this.police.vehicles.find((unit) => !unit.wrecked && Math.abs(unit.speed) > 8 && unit.group.position.distanceTo(focus) < 5);
      if (rammer && shouldKnockOff(Math.abs(rammer.speed - bike.speed))) this.knockOff(bike);
    }
    this.radioCooldown = Math.max(0, this.radioCooldown - dt);
    for (const report of this.knowledge.update(dt, (reporter) => reporter.state !== 'down')) { this.wanted.addCrime(report.heat); this.radioDispatch(report.label, report.x, report.z); }
    this.wanted.update(dt);
    if (this.previousWanted && !this.wanted.isWanted) this.recordCityEvent('police-evaded', focus);
    this.previousWanted = this.wanted.isWanted; this.shops.update(dt); this.safehouses.update(dt);
    // Rounds in flight land here: the resolution carries the exact hitscan-era ShotResult, delayed by time of flight.
    for (const landed of this.bullets.update(dt, this.city, this.population, this.police.vehicles)) this.handleGunshot(landed.result, landed.position, landed.weapon);
    for (const boom of this.projectiles.update(dt, this.city, this.population, this.police.vehicles, this.player.group.position)) {
      this.audio.explosion(boom.position.x, boom.position.z); this.reportCrime(boom.position, 30, { victims: boom.victims.map((victim) => victim.ped), radius: FEAR_EVENTS.kill.radius, label: 'explosion' }); this.population.broadcastFear(boom.position, FEAR_EVENTS.kill); this.shake = Math.min(0.7, this.shake + 0.5);
      if (boom.policeHit) this.reportCrime(boom.position, 24, { copWitnessed: true, label: 'explosion' });
      for (const victim of boom.victims) {
        this.gore.burst(victim.position, victim.killed ? 1.5 : 0.9, victim.killed);
        if (victim.killed) { this.spawnDrops(victim.ped); if (victim.ped.hostile) this.hostileDefeated += 1; }
      }
      if (boom.playerDamage > 0) this.damagePlayer(boom.playerDamage);
    }
    this.updateVehicleFires(dt, focus);
    for (const item of this.pickups.update(dt, this.player.group.position, !this.activeVehicle && !this.transition && !this.airborne)) this.applyPickup(item);
    this.combat.update(dt); this.gore.update(dt); this.propFx.update(dt); this.handleVehicleCollisions(dt); this.updateMission(dt);
    this.saveTimer += dt; if (this.saveTimer > 8) { this.persist(); this.saveTimer = 0; }
    if (this.player.health <= 0) this.die();
  }

  private updateOnline(dt: number): void {
    const online = this.online; if (!online) return;
    if (this.input.consume('Escape')) { this.pause(); return; }
    const stateBefore = online.localState;
    if (this.input.consume('KeyE')) online.interact();
    if (!stateBefore?.dead && !stateBefore?.vehicleId) {
      this.player.setVisible(true); this.player.update(dt, this.input, this.cameraController.yaw, this.city);
      this.combat.tryReload(this.input); this.combat.update(dt);
      const shot = this.combat.fire(this.input, this.camera, this.player.group.position, this.population, { aim: this.input.aiming, heading: this.player.heading });
      if (shot.fired && !shot.melee) online.fire(this.camera.getWorldDirection(new THREE.Vector3()).normalize());
    }
    const state = online.update(dt, {
      forward: Number(this.input.down('KeyW')) - Number(this.input.down('KeyS')),
      side: Number(this.input.down('KeyD')) - Number(this.input.down('KeyA')),
      sprint: this.input.down('ShiftLeft'), aiming: this.input.aiming, yaw: this.cameraController.yaw,
    });
    if (!state) return;
    const authoritative = online.consumeLocalCorrection();
    if (authoritative) {
      const error = Math.hypot(authoritative.x - this.player.group.position.x, authoritative.z - this.player.group.position.z);
      const moving = this.input.down('KeyW') || this.input.down('KeyS') || this.input.down('KeyA') || this.input.down('KeyD');
      const correction = onlineCorrectionFactor(error, moving, authoritative.dead, Boolean(authoritative.vehicleId));
      this.player.group.position.x = THREE.MathUtils.lerp(this.player.group.position.x, authoritative.x, correction);
      this.player.group.position.z = THREE.MathUtils.lerp(this.player.group.position.z, authoritative.z, correction);
    }
    this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z);
    this.player.health = state.health; this.player.setVisible(!state.dead && !state.vehicleId);
    if (state.dead && !this.onlineWasDead) { this.ui.notify('EISH', 'You were eliminated. Respawning in three seconds.', false); this.audio.setFire(false); }
    this.onlineWasDead = state.dead;
  }

  private applyEskom(event: 'start' | 'end' | undefined): void {
    if (event === 'start') { setPower(false); this.ui.notify('Load shedding: Stage 4', 'Eskom sends regards. The robots are out.', false); }
    else if (event === 'end') { setPower(true); this.ui.notify('Power restored', 'For now. Sharp sharp.'); }
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
      if (boom.vehicle.police) this.reportCrime(boom.position, POLICE_WRECK_HEAT, { copWitnessed: true, label: 'vehicle arson' });
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
    this.endTaxiShift(vehicle);
    this.endCourierShift(vehicle);
    vehicle.playerControlled = false; this.activeVehicle = undefined; this.transition = undefined;
    this.player.inVehicle = false; this.player.setVisible(true);
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(2.2);
    this.player.group.position.copy(vehicle.group.position).add(side); this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z);
    this.player.resetAirbornePose(); // a two-wheeler rider's group carries the bike's orientation; wipe it so a wreck-eject doesn't leave the player inverted
    this.audio.setEngine(false);
  }

  private updateOnFoot(dt: number): void {
    this.player.update(dt, this.input, this.cameraController.yaw, this.city, this.updateCoverState(dt));
    const fall = this.player.consumeFallDamage(); // hard landings billed through the usual damage path
    if (fall > 0) { this.damagePlayer(fall); this.shake = Math.min(0.7, this.shake + 0.25); this.audio.collision(10 + fall * 0.3); }
    for (const bump of this.population.bumpPlayer(dt, this.player.group.position, this.player.moving, this.player.sprinting)) {
      if (!bump.assault) continue;
      this.population.broadcastFear(bump.position, FEAR_EVENTS.assault);
      this.reportCrime(bump.position, bump.killed ? 24 : BUMP_ASSAULT_HEAT, { victims: [bump.ped], radius: FEAR_EVENTS.assault.radius, cityEvent: bump.killed ? 'civilian-murder' : 'civilian-assault', label: bump.killed ? 'murder' : 'assault' });
      if (bump.killed) this.spawnDrops(bump.ped);
    }
    if (this.updateWeaponWheel()) return;
    this.combat.tryReload(this.input);
    WEAPONS.forEach((spec, index) => { if (this.input.consume(`Digit${index + 1}`)) this.combat.select(spec.id); });
    // Wheel precedence: map-open (handled by the map overlay) > scoped zoom ladder > weapon cycling.
    const scroll = this.input.consumeWheel();
    if (scroll && weaponWheelResponds(this.ui.mapOpen)) {
      if (wheelAction(this.scoped) === 'zoom') this.scopeLevel = stepScopeLevel(this.scopeLevel, scroll > 0 ? -1 : 1);
      else this.combat.cycle(scroll > 0 ? 1 : -1);
    }
    this.footstepTimer -= dt;
    if (this.player.onGround && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((key) => this.input.down(key)) && this.footstepTimer <= 0) { const running = this.input.down('ShiftLeft'); this.audio.footstep(running, this.city.isPark(this.player.group.position.x, this.player.group.position.z)); this.footstepTimer = running ? 0.24 : 0.38; }
    const shot = this.combat.fire(this.input, this.camera, this.player.group.position, this.population, { aim: this.input.aiming, heading: this.player.heading });
    if (shot.fired && shot.melee) {
      this.player.punch();
      if (shot.victim) {
        this.reportCrime(this.player.group.position, shot.killed ? 24 : 16, { victims: [shot.victim], radius: (shot.killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: !shot.victim.hostile && !shot.victim.police ? (shot.killed ? 'civilian-murder' : 'civilian-assault') : undefined, label: shot.killed ? 'murder' : 'assault' }); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.assault);
        if (shot.hitPoint) { this.gore.burst(shot.hitPoint, shot.killed ? 1.2 : 0.72, Boolean(shot.killed)); this.audio.splat(shot.killed ? 1 : 0.6, shot.hitPoint.x, shot.hitPoint.z); this.audio.scream('pain', shot.hitPoint.x, shot.hitPoint.z); }
        if (shot.policeHit) this.reportCrime(this.player.group.position, 24, { copWitnessed: true, label: 'assault' });
        if (shot.killed) { this.population.broadcastFear(shot.victim.group.position, FEAR_EVENTS.kill); this.spawnDrops(shot.victim); if (shot.victim.hostile) this.hostileDefeated += 1; }
      }
    } else if (shot.fired) {
      if (!shot.deferred) this.handleGunshot(shot, this.player.group.position); // rockets report at launch; bullets report when they land
      if (scopeWeapon(this.combat.current)) this.cameraController.recoil(SNIPER_RECOIL); // .303 shoulder thump
    }
    this.player.setWeapon(this.combat.current);
    if (this.input.consume('KeyF')) this.tryMugOrMelee();
    if (this.input.consume('KeyE')) {
      const collectTarget = this.missions.objective?.kind === 'collect' ? this.currentTarget() : undefined;
      if (collectTarget && collectTarget.position.distanceTo(this.player.group.position) < 8) { this.collectedItem = true; return; }
      if (this.tryMissionInteraction()) return;
      const vehicle = this.population.nearestEnterable(this.player.group.position);
      const cruiser = this.police.stealableNear(this.player.group.position);
      const shop = this.shops.shopNear(this.player.group.position);
      if (shop?.kind === 'weapons') { this.openWeaponShop(); return; }
      if (shop?.kind === 'hotdog') { this.buyHotdog(); return; }
      const safehouse = this.safehouses.near(this.player.group.position);
      if (safehouse) { this.enterSafehouse(safehouse); return; }
      if (shop?.driveIn && !vehicle && !cruiser) { this.ui.notify(shop.name, shop.kind === 'spray' ? 'They only detail vehicles. Drive one onto the marker.' : 'Drive a vehicle onto the marker to store it.', false); return; }
      const pick = cruiser && (!vehicle || cruiser.group.position.distanceToSquared(this.player.group.position) < vehicle.group.position.distanceToSquared(this.player.group.position)) ? cruiser : vehicle;
      if (pick === cruiser && cruiser) { this.police.release(cruiser); this.population.vehicles.push(cruiser); } // stolen cruiser leaves the JMPD fleet
      if (pick) this.beginEnter(pick);
    }
  }

  /** Skydive tick: WASD trims pitch and heading via the pure step, walls still clamp the glide, SPACE (or F)
   *  spends a carried parachute, and touching the support surface settles the landing bill. */
  private updateAirborne(dt: number): void {
    const state = this.airborne; if (!state) return;
    const position = this.player.group.position;
    if ((this.input.consume('Space') || this.input.consume('KeyF')) && canDeploy(state.mode, this.inventory.parachutes)) {
      this.inventory.parachutes -= 1; deployParachute(state); this.player.setCanopy(true);
      this.audio.ui(true); this.ui.notify('Canopy out', 'Glide with WASD. Flare with S or SPACE just before touchdown.');
      this.persist();
    }
    const stick = {
      pitch: Number(this.input.down('KeyW')) - Number(this.input.down('KeyS')),
      steer: Number(this.input.down('KeyD')) - Number(this.input.down('KeyA')),
      flare: this.input.down('KeyS') || this.input.down('Space'),
    };
    const support = this.city.supportHeight(position.x, position.z, position.y); // rooftops count: you can land on them
    const step = stepAirborne(state, stick, dt, position.y, support);
    const desired = new THREE.Vector3(position.x + step.dx, position.y, position.z + step.dz);
    const clamped = this.city.clampMoveAt(position, desired, PLAYER.radius);
    position.x = clamped.x; position.z = clamped.z; position.y = step.y;
    this.player.heading = state.heading; this.player.group.rotation.y = state.heading;
    this.player.animateAirborne(dt, state.mode, state.pitch, state.bank);
    if (step.landed) this.landSkyfall(state, step.descent, support);
  }

  /** Touchdown: a flared canopy landing is free, a hot canopy landing bruises, and raw freefall pays the full
   *  fall-damage bill from the drop altitude — from 600u that is lethal unless the invulnerable cheat is on. */
  private landSkyfall(state: AirborneState, descent: number, support: number): void {
    this.airborne = undefined; this.player.setCanopy(false); this.player.resetAirbornePose(); // upright + controllable the instant feet touch
    this.player.onGround = true; this.player.velocityY = 0;
    const damage = state.mode === 'parachute' ? chuteLandingDamage(descent) : fallDamage(state.fallOriginY - support);
    if (damage > 0) {
      this.damagePlayer(damage); this.player.tumble();
      this.shake = Math.min(0.7, this.shake + 0.3); this.audio.collision(10 + damage * 0.3);
    } else if (state.mode === 'parachute') this.ui.notify('Textbook landing', 'Two feet down, no paperwork.');
  }

  /** H: jab a stim pack — +50 health, clamped; never wasted at full health. */
  private useStim(): void {
    if (this.inventory.stims <= 0) return;
    if (this.player.health >= this.player.maxHealth) { this.ui.notify('Stim pack', 'You are already at full health.', false); return; }
    this.inventory.stims -= 1; this.player.health = stimHeal(this.player.health, this.player.maxHealth);
    this.audio.pickup(); this.ui.notify('Stim pack used', `+50 health · ${this.inventory.stims} left.`);
    this.persist();
  }

  /** GTA-V-style cover: Q snaps flat against the nearest building face (third person only — in first person Q is a
   *  no-op), A/D slides along the wall, Ctrl at a corner leans out to shoot, mid-wall Ctrl just shows the crosshair
   *  without stepping out. Game owns the cover position; Player only performs the pose. */
  private updateCoverState(dt: number): CoverPose | undefined {
    const position = this.player.group.position;
    if (this.settings.cameraViewFoot === 0 || this.player.tumbling) { this.cover = undefined; this.coverAvailable = false; return undefined; } // FP Q is a no-op; a bump tumble knocks you out of cover
    if (!this.cover) {
      const spot = nearestGroundedCoverSpot(position.x, position.z, this.player.onGround, this.city.colliders, COVER_ENTER_RANGE, position.y); // only faces that shield the player's elevation
      this.coverAvailable = Boolean(spot);
      if (!spot || !this.input.consume('KeyQ')) return undefined;
      const t = clampT(spot, coverT(spot, position.x, position.z), PLAYER.radius);
      this.cover = { spot, t, peek: 0, corner: cornerSide(spot, t, PLAYER.radius), exitTimer: 0 };
    }
    this.coverAvailable = false;
    const cover = this.cover; const yaw = this.cameraController.yaw;
    const side = Number(this.input.down('KeyD')) - Number(this.input.down('KeyA'));
    const forward = Number(this.input.down('KeyW')) - Number(this.input.down('KeyS'));
    const move = new THREE.Vector3(side, 0, -forward).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    cover.exitTimer = movingAway(move, cover.spot.normal) ? cover.exitTimer + dt : 0;
    if (this.input.consume('KeyQ') || cover.exitTimer >= COVER_EXIT_HOLD) { this.cover = undefined; return undefined; }
    const tangent = cover.spot.tangent;
    const slide = side * Math.sign(Math.cos(yaw) * tangent.x - Math.sin(yaw) * tangent.z || 1); // A/D are screen-relative along the wall
    cover.t = clampT(cover.spot, cover.t + slide * SLIDE_SPEED * dt, PLAYER.radius);
    cover.corner = cornerSide(cover.spot, cover.t, PLAYER.radius);
    const aiming = this.input.aiming && !this.combat.spec.melee;
    cover.peek += ((aiming && cover.corner !== 0 ? 1 : 0) - cover.peek) * (1 - Math.exp(-dt * 10)); // peek only exists at a corner
    const base = coverPosition(cover.spot, cover.t, PLAYER.radius);
    const desired = new THREE.Vector3(
      base.x + (tangent.x * cover.corner * PEEK_STEP + cover.spot.normal.x * PEEK_OUT) * cover.peek, position.y,
      base.z + (tangent.z * cover.corner * PEEK_STEP + cover.spot.normal.z * PEEK_OUT) * cover.peek);
    const clamped = this.city.clampMoveAt(position, desired, PLAYER.radius);
    const snap = 1 - Math.exp(-dt * 14); // one fast lerp covers the entry snap and the slide/peek motion
    position.x = THREE.MathUtils.lerp(position.x, clamped.x, snap); position.z = THREE.MathUtils.lerp(position.z, clamped.z, snap);
    return { heading: aiming ? yaw + Math.PI : coverHeading(cover.spot), peek: cover.peek, twist: cover.corner * cover.peek * 0.45, moving: slide !== 0 };
  }

  /** Scope mode: aiming the sniper on foot (cover peeks included) — never from a vehicle seat or mid-transition. */
  private get scoped(): boolean {
    return this.mode === 'playing' && !this.transition && !this.airborne && !this.weaponWheelOpen && scopeActive(this.input.aiming, this.combat.current, Boolean(this.activeVehicle));
  }

  /** Shared aftermath for a ranged player shot: witnesses, fear, gore, and drops — on foot or drive-by.
   *  Bullet weapons land here after time of flight, so the firing weapon rides along rather than reading `combat.current`. */
  private handleGunshot(shot: ShotResult, position: THREE.Vector3, weapon: WeaponId = this.combat.current): void {
    const fear = scopeWeapon(weapon) ? FEAR_EVENTS.sniperShot : FEAR_EVENTS.gunshot; // the rifle crack carries further than a pistol pop
    this.reportCrime(position, 7, { victims: shot.victim ? [shot.victim] : [], radius: fear.radius, cityEvent: shot.victim && !shot.victim.hostile && !shot.victim.police ? (shot.killed ? 'civilian-murder' : 'civilian-assault') : undefined, label: shot.killed ? 'murder' : 'gunfire' }); this.population.broadcastFear(position, fear);
    if (shot.victim && shot.hitPoint) {
      this.gore.burst(shot.hitPoint, shot.killed ? 1.45 : 0.92, shot.killed);
      this.audio.splat(shot.killed ? 0.9 : 0.5, shot.hitPoint.x, shot.hitPoint.z);
      this.audio.scream('pain', shot.hitPoint.x, shot.hitPoint.z);
      if (shot.killed) this.population.broadcastFear(shot.victim.group.position, FEAR_EVENTS.kill);
    }
    if (shot.policeHit) this.reportCrime(position, 24, { copWitnessed: true, label: 'gunfire' });
    if (shot.killed && shot.victim) { this.spawnDrops(shot.victim); if (shot.victim.hostile) this.hostileDefeated += 1; }
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
    const speed = vehicle.updatePlayer(dt, this.input, this.city, this.driveSteer); this.player.group.position.copy(vehicle.group.position);
    if (!this.mouseSteerHintShown) { this.mouseSteerHintShown = true; this.ui.notify('Mouse steering', 'Hold Left-Click (when not aiming) to steer with the mouse.', false); }
    const driveBy = canFireFromVehicle(this.input.aiming, this.combat.spec.melee, Boolean(this.combat.spec.projectile), scopeWeapon(this.combat.current));
    if (vehicle.spec.twoWheeler) { // rider stays visible in the saddle — and wears no cocoon: hits land on the player
      const [saddleY, saddleZ] = vehicle.spec.saddle ?? [0.1, -0.2];
      this.player.group.position.add(new THREE.Vector3(Math.sin(vehicle.heading) * saddleZ, saddleY, Math.cos(vehicle.heading) * saddleZ));
      this.player.group.rotation.copy(vehicle.group.rotation);
      this.player.animateRiding(dt, vehicle.spec.kind, speed, driveBy);
      const hit = vehicle.consumeRiderHit();
      if (hit.damage > 0) this.damagePlayer(hit.damage);
      if (shouldKnockOff(hit.impact)) { this.knockOff(vehicle); return; }
    }
    const throttle = this.input.down('KeyW') ? 1 : this.input.down('KeyS') ? 0.6 : 0;
    this.audio.setEngine(true, speed, throttle, vehicle.spec.maxSpeed, vehicle.spec.kind); // 'bicycle' routes to the freewheel/wind voice, everything else to an engine profile
    this.wallCrashCooldown = Math.max(0, this.wallCrashCooldown - dt);
    if (this.wallCrashCooldown <= 0 && this.prevDrivenSpeed > 12 && this.prevDrivenSpeed - speed > this.prevDrivenSpeed * 0.6) { this.audio.collision(this.prevDrivenSpeed * 1.1); this.wallCrashCooldown = 0.8; this.taxiRide.recordCrash(this.prevDrivenSpeed); this.recordCourierCrash(this.prevDrivenSpeed); }
    this.prevDrivenSpeed = speed;
    this.potholeCooldown = Math.max(0, this.potholeCooldown - dt);
    if (this.potholeCooldown === 0 && Math.abs(vehicle.speed) > 9) {
      const position = vehicle.group.position;
      const hit = this.city.potholes.find((hole) => (hole.x - position.x) ** 2 + (hole.z - position.z) ** 2 < hole.r * hole.r);
      if (hit) {
        vehicle.speed *= 0.8; vehicle.bounce = Math.min(0.28, Math.abs(vehicle.speed) * 0.012); vehicle.takeDamage(2);
        this.recordCourierCrash(7);
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
    if (driveBy) { // drive-by (car window or bike saddle): Ctrl to aim, LMB fires along the camera ray; no aim, no shooting
      this.combat.tryReload(this.input);
      const shot = this.combat.fire(this.input, this.camera, vehicle.group.position, this.population, { exclude: vehicle, cooldownScale: DRIVEBY_COOLDOWN_SCALE });
      if (shot.fired && !shot.deferred) this.handleGunshot(shot, vehicle.group.position);
    }
    if (this.input.consume('KeyE')) {
      const shop = this.shops.shopNear(vehicle.group.position);
      if (shop?.kind === 'spray') { this.useSpray(vehicle); return; }
      if (shop?.kind === 'garage') { this.storeVehicle(vehicle); return; }
      this.beginExit(vehicle);
    }
    if (this.input.consume('KeyF')) { const pose = this.city.nearestRoadPose(vehicle.group.position); vehicle.heading = pose.heading; vehicle.reset(pose.position); this.ui.notify(vehicle.spec.twoWheeler ? 'Bike recovered' : 'Bakkie recovered', vehicle.spec.name); }
    if (isTaxiKind(vehicle.spec.kind)) {
      if (this.input.consume('KeyT')) this.handleTaxiKey(vehicle);
      this.updateTaxiJob(dt, vehicle);
    }
    if (vehicle.spec.kind === 'courier') {
      if (this.input.consume('KeyY')) this.handleCourierKey();
      this.updateCourierJob(dt, vehicle);
    }
    if (vehicle.police && this.input.consume('KeyG')) { vehicle.sirenOn = toggleSiren(vehicle); this.ui.notify(vehicle.sirenOn ? 'Siren on' : 'Siren off', vehicle.sirenOn ? 'Clear the road. You are the law now.' : 'Back to creeping quietly.'); }
    if (!vehicle.spec.twoWheeler && this.input.consume('KeyN')) {
      const station = this.audio.cycleRadio(this.input.down('ShiftLeft') || this.input.down('ShiftRight') ? -1 : 1);
      this.ui.notify(station ? `${station.name} ${station.frequency}` : 'Radio off', station?.tagline ?? 'Just the engine and the city outside.', true, 'music');
    }
    if (vehicle.onFire) this.damagePlayer(dt * BURN_DPS);
  }

  /** A hard hit on a two-wheeler throws the rider: the bike drops on the spot, the player tumbles beside it
   *  (pedestrian down-pose machinery, no death) and stands back up. */
  private knockOff(vehicle: Vehicle): void {
    if (vehicle.spec.kind === 'courier') this.endCourierShift(undefined, false);
    vehicle.playerControlled = false; vehicle.setFirstPerson(false); vehicle.speed = 0;
    this.activeVehicle = undefined; this.transition = undefined; this.player.inVehicle = false; this.player.setVisible(true);
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(1.5);
    const target = vehicle.group.position.clone().add(side);
    const spot = safePlacement(target.x, target.z, (px, pz) => this.city.collides(px, pz, PLAYER.radius)); // a hard crash into a wall can drop the side-offset inside the building; ring out to clear ground so the rider isn't trapped
    this.player.group.position.set(spot.x, this.city.surfaceHeightAt(spot.x, spot.z), spot.z);
    this.player.resetAirbornePose(); // the rider's group inherited the bike's full orientation (incl. terrain pitch on rotation.x); wipe it before the tumble or the body lands inverted under the tar
    this.player.tumble();
    this.audio.setEngine(false); this.audio.stopRadio(); this.shake = Math.min(0.7, this.shake + 0.35);
    this.ui.notify('Knocked off', 'Tar 1, rider 0. The bike is right there.', false);
  }

  /** T between rides toggles AVAILABLE/OCCUPIED; T during a hail/ride cancels it and leaves the cab OCCUPIED. */
  private handleTaxiKey(vehicle: Vehicle): void {
    const ride = this.taxiRide;
    if (ride.phase !== 'idle') {
      const hadPassenger = Boolean(this.taxiPassenger);
      this.cancelTaxi(true); ride.cancelByDriver(); this.taxiDestination = undefined;
      vehicle.setTaxiLight(false); this.audio.ui(false);
      this.ui.notify('Ride cancelled', `${hadPassenger ? 'The fare climbs out unpaid. ' : ''}You are OCCUPIED — press T to take fares again.`, false);
      return;
    }
    const duty = ride.toggleDuty();
    vehicle.setTaxiLight(ride.available); this.audio.ui(duty === 'available');
    const detail = duty === 'occupied' ? 'Roof light off. No new fares.'
      : this.wanted.isWanted ? "Roof light on — but no fares while the law's watching. Lose the heat first."
      : 'Roof light on — watch the curb for a raised arm.';
    this.ui.notify(duty === 'available' ? 'Taxi: AVAILABLE' : 'Taxi: OCCUPIED', detail, duty === 'available' && !this.wanted.isWanted);
  }

  /** Runs the hail -> board -> ride -> pay loop while the player drives a taxi. */
  private updateTaxiJob(dt: number, vehicle: Vehicle): void {
    const ride = this.taxiRide; const position = vehicle.group.position;
    if (ride.phase === 'idle') {
      this.taxiHailCooldown = Math.max(0, this.taxiHailCooldown - dt);
      if (this.taxiHailCooldown > 0 || ride.duty !== 'available' || vehicle.onFire || vehicle.disabled || this.wanted.isWanted) return; // nobody hails an off-duty, burning or police-chased cab
      const candidate = this.population.pedestrians
        .filter((ped) => canHail(ped, ped.group.position.distanceTo(position)))
        .sort((a, b) => a.group.position.distanceToSquared(position) - b.group.position.distanceToSquared(position))[0];
      if (candidate && ride.hail()) { this.taxiHailPed = candidate; candidate.setHail(true); this.ui.notify('Fare spotted', 'Someone is flagging you down — stop at the curb beside them.'); }
      return;
    }
    const hail = this.taxiHailPed;
    if (ride.phase === 'hailed') {
      if (!hail || hail.state !== 'idle' || hail.group.position.distanceTo(position) > HAIL_RADIUS * 1.6) { this.cancelTaxi(true); return; }
      if (Math.abs(vehicle.speed) < STOP_SPEED && hail.group.position.distanceTo(position) <= PICKUP_RADIUS && ride.beginBoarding()) { hail.state = 'walk'; vehicle.setTaxiLight(ride.available); } // fare inbound: auto-occupied, roof light dims
      return;
    }
    if (ride.phase === 'boarding') {
      if (!hail || (hail.state !== 'walk' && hail.state !== 'idle')) { this.cancelTaxi(true); return; } // run over or frightened mid-pickup
      const distance = hail.group.position.distanceTo(position);
      if (distance > ABANDON_RADIUS || Math.abs(vehicle.speed) > 6) { this.cancelTaxi(true); return; } // drove off; the fare gives up
      hail.state = 'walk'; hail.destination.copy(position);
      if (distance <= BOARD_RADIUS) this.boardPassenger(vehicle, hail);
      return;
    }
    ride.recordSpeeding(dt, Math.abs(vehicle.speed));
    if (vehicle.onFire) ride.frighten(FEAR_MAX * dt);
    if (ride.bailed) { this.passengerBail(vehicle); return; }
    const destination = this.taxiDestination; if (!destination) return;
    if (position.distanceTo(destination) < ARRIVE_RADIUS && Math.abs(vehicle.speed) < STOP_SPEED) this.completeRide(vehicle);
  }

  private boardPassenger(vehicle: Vehicle, ped: Pedestrian): void {
    ped.setHail(false); ped.state = 'idle'; ped.idleTime = 999999; ped.group.visible = false; // aboard: hidden but remembered
    const index = this.population.pedestrians.indexOf(ped); if (index >= 0) this.population.pedestrians.splice(index, 1);
    this.taxiHailPed = undefined; this.taxiPassenger = ped;
    const trip = this.planTaxiTrip(vehicle.group.position);
    this.taxiDestination = trip.destination;
    const fare = this.taxiRide.board(trip.distance);
    this.audio.ui(true);
    this.ui.notify('Passenger aboard', `Drop-off marked on the map · R${fare} on the meter. Drive lekker — they tip.`);
  }

  /** Picks a drop-off on the vehicle nav graph and prices the meter by A* route distance, not the crow's flight. */
  private planTaxiTrip(from: THREE.Vector3): { destination: THREE.Vector3; distance: number } {
    const graph = this.city.vehicleNav; const start = nearestNode(graph, from.x, from.z);
    for (let attempt = 0; attempt < 14; attempt++) {
      const goal = Math.floor(Math.random() * graph.nodes.length); const node = graph.nodes[goal];
      if (!node || Math.hypot(node.x - from.x, node.z - from.z) < MIN_TRIP_DISTANCE) continue;
      const path = findPath(graph, start, goal); if (!path) continue;
      const points = path.map((index) => graph.nodes[index]).filter((point): point is NavPoint => Boolean(point));
      return { destination: new THREE.Vector3(node.x, this.city.roadHeightAt(node.x, node.z), node.z), distance: routeDistance(points) };
    }
    const fallback = graph.nodes[nearestNode(graph, -from.x, -from.z)] ?? { x: 0, z: 0 }; // degenerate graph: cross town, straight-line priced
    return { destination: new THREE.Vector3(fallback.x, this.city.roadHeightAt(fallback.x, fallback.z), fallback.z), distance: Math.hypot(fallback.x - from.x, fallback.z - from.z) };
  }

  private completeRide(vehicle: Vehicle): void {
    const pay = this.taxiRide.payout(); this.economy.earn(pay.total); this.audio.ui(true);
    this.ui.notify('Fare paid', pay.tip > 0 ? `R${pay.fare} on the meter + R${pay.tip} tip. "Sharp sharp, driver!"` : `R${pay.fare} on the meter, no tip. "Eish, that driving..."`);
    this.disembarkPassenger(vehicle.group.position, vehicle.heading, false);
    this.taxiRide.reset(); this.taxiDestination = undefined; vehicle.setTaxiLight(this.taxiRide.available); this.persist(); // back on the clock: light returns
  }

  private passengerBail(vehicle: Vehicle): void {
    this.disembarkPassenger(vehicle.group.position, vehicle.heading, true);
    this.taxiRide.reset(); this.taxiDestination = undefined; vehicle.setTaxiLight(this.taxiRide.available);
    this.ui.notify('Passenger bailed', 'They fled without paying. Smoother driving keeps fares aboard.', false);
  }

  private disembarkPassenger(origin: THREE.Vector3, heading: number, panic: boolean): void {
    const ped = this.taxiPassenger; if (!ped) return; this.taxiPassenger = undefined; this.taxiHailCooldown = REHAIL_COOLDOWN;
    const side = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(2.2);
    ped.group.position.copy(origin).add(side); ped.group.position.y = this.city.surfaceHeightAt(ped.group.position.x, ped.group.position.z); ped.group.visible = true;
    ped.idleTime = 0; ped.pickDestination(this.city.sidewalkPoints);
    this.population.pedestrians.push(ped);
    if (panic) { ped.fear = 0; ped.applyFear(FEAR_MAX, origin); this.audio.scream('panic', ped.group.position.x, ped.group.position.z); }
  }

  /** Ends any hail/ride without payment: the hailer drops the arm, a boarded passenger climbs out where the cab stands. */
  private cancelTaxi(quiet = true): void {
    if (this.taxiHailPed) { this.taxiHailPed.setHail(false); this.taxiHailPed = undefined; }
    if (this.taxiPassenger) {
      const vehicle = this.activeVehicle ?? this.transition?.vehicle;
      this.disembarkPassenger(vehicle?.group.position ?? this.player.group.position, vehicle?.heading ?? 0, false);
      if (!quiet) this.ui.notify('Ride cancelled', 'The passenger climbs out, unpaid and unimpressed.', false);
    }
    this.taxiRide.reset(); this.taxiDestination = undefined;
  }

  /** Off shift entirely: end any ride, flip the sign to OCCUPIED and dim the light (exit, store, wreck, respawn, new game). */
  private endTaxiShift(vehicle?: Vehicle, quiet = true): void {
    this.cancelTaxi(quiet); this.taxiRide.duty = 'occupied'; vehicle?.setTaxiLight(false);
  }

  /** Y starts or ends a repeating Sixty-Sekonds shift. Every basket begins back at dispatch. */
  private handleCourierKey(): void {
    if (this.courierJob.active) {
      const abandoned = this.courierJob.phase === 'delivering';
      this.endCourierShift(); this.audio.ui(false);
      this.ui.notify('Sixty-Sekonds: CLOCKED OUT', abandoned ? 'The abandoned groceries have been promoted to pavement specials.' : 'Your acceptance rate is now between you and the algorithm.', false);
      return;
    }
    if (this.wanted.isWanted) { this.audio.ui(false); this.ui.notify('Application declined', 'Lose the JMPD first. Even the algorithm has standards.', false); return; }
    if (this.missions.active) { this.audio.ui(false); this.ui.notify('Too many jobs', 'Finish your current dramatic storyline before joining the gig economy.', false); return; }
    this.courierJob.clockIn(); this.audio.ui(true);
    this.ui.notify('Sixty-Sekonds: CLOCKED IN', 'Collect order 1 at the lime dispatch marker. Your manager is a push notification.');
  }

  private updateCourierJob(dt: number, vehicle: Vehicle): void {
    const job = this.courierJob; if (!job.active) return;
    if (job.update(dt)) this.ui.notify('Delivery is now “just now”', 'The ice cream has resigned. Deliver it anyway for the base pay.', false);
    if (vehicle.onFire || vehicle.disabled) { this.endCourierShift(); this.ui.notify('Shift auto-ended', 'The app has detected unusual heat near the groceries.', false); return; }
    if (Math.abs(vehicle.speed) >= COURIER_STOP_SPEED) return;
    if (job.phase === 'collecting') {
      const depot = new THREE.Vector3(COURIER_DEPOT.x, this.city.roadHeightAt(COURIER_DEPOT.x, COURIER_DEPOT.z), COURIER_DEPOT.z);
      if (vehicle.group.position.distanceTo(depot) > COURIER_STOP_RADIUS) return;
      const trip = this.planCourierTrip(vehicle.group.position);
      if (!job.collect(trip.distance)) return;
      this.courierDestination = trip.destination; this.audio.ui(true);
      this.ui.notify(`Order ${job.completed + 1}: ${job.order.basket}`, `${job.order.note} · ${Math.ceil(job.timeLeft)} seconds. Eggs dislike shortcuts.`);
      return;
    }
    if (!this.courierDestination || vehicle.group.position.distanceTo(this.courierDestination) > COURIER_STOP_RADIUS) return;
    const order = job.order; const pay = job.deliver(); if (!pay) return;
    this.courierDestination = undefined; this.economy.earn(pay.total); this.audio.ui(!pay.late && pay.condition >= 70);
    const bonuses = [`R${pay.base} base`, `R${pay.careBonus} un-scrambling fee`, ...(pay.timeBonus ? [`R${pay.timeBonus} now-now bonus`] : []), ...(pay.streakBonus ? [`R${pay.streakBonus} streak`] : [])].join(' + ');
    const verdict = pay.late ? 'Customer says the tracking dot went on holiday.' : pay.condition < 35 ? 'Customer accepted the smoothie formerly known as groceries.' : pay.condition < 70 ? 'Some of the avocados will need counselling.' : `Perfect drop. ${pay.streak} clean in a row.`;
    this.ui.notify(`Delivered: ${order.basket}`, `${bonuses} = R${pay.total}. ${verdict}`, !pay.late && pay.condition >= 70);
    this.persist();
  }

  /** Same navigation truth as taxi fares: pick a reachable cross-town node and measure the actual A* route. */
  private planCourierTrip(from: THREE.Vector3): { destination: THREE.Vector3; distance: number } {
    const graph = this.city.vehicleNav; const start = nearestNode(graph, from.x, from.z);
    for (let attempt = 0; attempt < 18; attempt++) {
      const goal = Math.floor(Math.random() * graph.nodes.length); const node = graph.nodes[goal];
      if (!node || Math.hypot(node.x - from.x, node.z - from.z) < COURIER_MIN_TRIP_DISTANCE) continue;
      const path = findPath(graph, start, goal); if (!path) continue;
      const points = path.map((index) => graph.nodes[index]).filter((point): point is NavPoint => Boolean(point));
      return { destination: new THREE.Vector3(node.x, this.city.roadHeightAt(node.x, node.z), node.z), distance: routeDistance(points) };
    }
    const fallback = graph.nodes[nearestNode(graph, -from.x, -from.z)] ?? { x: 0, z: 0 };
    return { destination: new THREE.Vector3(fallback.x, this.city.roadHeightAt(fallback.x, fallback.z), fallback.z), distance: Math.hypot(fallback.x - from.x, fallback.z - from.z) };
  }

  private recordCourierCrash(impact: number): void {
    const before = this.courierJob.condition; const damage = this.courierJob.recordCrash(impact); if (!damage) return;
    const after = this.courierJob.condition;
    if (before > 75 && after <= 75) this.ui.notify('Groceries bruised', 'The avocados have opened a workplace injury claim.', false);
    else if (before > 35 && after <= 35) this.ui.notify('Basket critical', 'Congratulations: the eggs are now a family-size omelette.', false);
  }

  private endCourierShift(_vehicle?: Vehicle, quiet = true): void {
    if (!this.courierJob.active) return;
    this.courierJob.clockOut(); this.courierDestination = undefined;
    if (!quiet) this.ui.notify('Sixty-Sekonds shift ended', 'The algorithm has marked you “temporarily horizontal”.', false);
  }

  private beginEnter(vehicle: Vehicle): void {
    this.cover = undefined;
    this.transition = { vehicle, timer: 0.5, entering: true }; vehicle.playerControlled = true; this.prevDrivenSpeed = 0;
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading)).multiplyScalar(1.6); this.player.group.position.copy(vehicle.group.position).add(side); this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z);
    if (vehicle.occupied) {
      const driver = this.population.ejectDriver(vehicle, this.player.group.position); this.reportCrime(this.player.group.position, 18, { victims: [driver], radius: FEAR_EVENTS.assault.radius, cityEvent: 'civilian-assault', label: 'carjacking' });
      this.ui.notify('Hijacking witnessed', 'The driver is fleeing. Expect a call to the JMPD.', false); vehicle.occupied = false;
    }
    if (this.missions.active?.id === 'hot-property' && vehicle.spec.kind === 'sport' && vehicle.spec.color === 0xd83a40) this.forceWanted(2);
    if (!vehicle.occupied) {
      const guard = this.population.pedestrians.find((ped) => ped.carGuard && ped.group.position.distanceTo(vehicle.group.position) < 14);
      if (guard) this.ui.notify('Car guard', '"Sharp sharp boss, I watched it like my own!"');
    }
  }

  private beginExit(vehicle: Vehicle): void {
    if (isTaxiKind(vehicle.spec.kind)) this.endTaxiShift(vehicle, false);
    const side = new THREE.Vector3(Math.cos(vehicle.heading), 0, -Math.sin(vehicle.heading));
    const left = vehicle.group.position.clone().addScaledVector(side, 2.4); const right = vehicle.group.position.clone().addScaledVector(side, -2.4);
    left.y = this.city.surfaceHeightAt(left.x, left.z); right.y = this.city.surfaceHeightAt(right.x, right.z);
    const exit = !this.city.collides(left.x, left.z, 0.7) ? left : !this.city.collides(right.x, right.z, 0.7) ? right : undefined;
    if (!exit) { this.ui.notify('Exit blocked', 'Move the vehicle into open space.', false); return; }
    if (vehicle.spec.kind === 'courier') this.endCourierShift(vehicle, false);
    this.transition = { vehicle, timer: 0.42, entering: false, exitPosition: exit }; this.audio.setEngine(false); this.audio.stopRadio();
  }

  private updateTransition(dt: number): void {
    const transition = this.transition; if (!transition) return; transition.timer -= dt;
    if (transition.entering) this.player.group.position.lerp(transition.vehicle.group.position, Math.min(1, dt * 8));
    if (transition.timer > 0) return;
    if (transition.entering) {
      this.activeVehicle = transition.vehicle; this.player.inVehicle = true; this.player.setVisible(transition.vehicle.spec.twoWheeler === true);
      if (!transition.vehicle.spec.twoWheeler) { // no radio in the open air
        this.audio.startRadio();
        const station = this.audio.currentRadio;
        if (!this.radioIntroShown) { this.radioIntroShown = true; this.ui.notify(station ? `${station.name} ${station.frequency}` : 'Radio off', station ? `${station.tagline} · N changes station.` : 'Press N to tune in.', true, 'music'); }
      }
    }
    else {
      transition.vehicle.playerControlled = false; transition.vehicle.setFirstPerson(false); this.activeVehicle = undefined; this.player.inVehicle = false; this.player.setVisible(true); this.player.group.position.copy(transition.exitPosition ?? transition.vehicle.group.position);
      this.player.resetAirbornePose(); // a two-wheeler rider's group inherited the bike's full orientation (incl. terrain pitch); wipe it on dismount or the player stands up inverted, feet under the ground
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
    const mission = MISSIONS.find((item) => !this.missions.completed.has(item.id) && Math.hypot(item.start.position.x - position.x, item.start.position.z - position.z) < 7);
    if (!mission || this.missions.active) return false;
    this.resetMissionRuntime(); this.missions.start(mission.id); this.ui.notify(mission.name, `${mission.contact}: ${mission.intro}`); return true;
  }

  private tryMugOrMelee(): void {
    const victim = this.population.nearestPedestrian(this.player.group.position);
    if (!victim) return;
    const cash = victim.mug(this.player.group.position);
    if (cash > 0) {
      this.pickups.spawnCash(this.scatter(victim.group.position), cash);
      this.reportCrime(this.player.group.position, 14, { victims: [victim], radius: FEAR_EVENTS.assault.radius, cityEvent: 'mugging', label: 'mugging' }); this.population.broadcastFear(this.player.group.position, FEAR_EVENTS.assault); this.audio.melee();
      this.ui.notify('Street robbery', `They dropped R${cash}. Witnesses are calling the JMPD.`, false); return;
    }
    const killed = victim.takeDamage(34); this.reportCrime(this.player.group.position, killed ? 24 : 16, { victims: [victim], radius: (killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: !victim.hostile && !victim.police ? (killed ? 'civilian-murder' : 'civilian-assault') : undefined, label: killed ? 'murder' : 'assault' }); this.population.broadcastFear(this.player.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault);
    this.gore.burst(victim.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)), killed ? 1.2 : 0.72, killed); this.audio.melee();
    this.audio.splat(killed ? 1 : 0.6, victim.group.position.x, victim.group.position.z); this.audio.scream('pain', victim.group.position.x, victim.group.position.z);
    if (killed) this.spawnDrops(victim);
  }

  /** Files a crime with JMPD using only what the world could actually see: a cop nearby means immediate heat
   *  and a sighting; otherwise a surviving victim or a living bystander within radius phones it in after
   *  REPORT_DELAY (stars land when the report matures); nobody left alive means no report at all. */
  private reportCrime(position: THREE.Vector3, heat: number, options: { victims?: Pedestrian[]; radius?: number; copWitnessed?: boolean; cityEvent?: CityEvent['kind']; label: CrimeLabel }): void {
    if (options.cityEvent) this.recordCityEvent(options.cityEvent, position);
    if (this.taxiRide.phase === 'riding' && this.activeVehicle && position.distanceTo(this.activeVehicle.group.position) < GUNFIRE_FEAR_RADIUS) this.taxiRide.frighten(heat * GUNFIRE_FEAR_SCALE); // violence near the cab spooks the passenger
    const copSaw = options.copWitnessed
      || this.police.vehicles.some((unit) => !unit.wrecked && unit.group.position.distanceTo(position) < SIGHT_RADIUS)
      || this.population.pedestrians.some((ped) => ped.police && ped.state !== 'down' && ped.group.position.distanceTo(position) < SIGHT_RADIUS);
    if (copSaw) { this.wanted.addCrime(heat); this.wanted.reportSeen(); this.knowledge.copWitness(position.x, position.z); this.radioDispatch(options.label, position.x, position.z, true); return; }
    const victims = options.victims ?? [];
    const candidates: WitnessCandidate<Pedestrian>[] = this.population.pedestrians.map((ped) => ({ ref: ped, x: ped.group.position.x, z: ped.group.position.z, alive: ped.state !== 'down', victim: victims.includes(ped) }));
    const reporter = determineReporter(position.x, position.z, candidates, options.radius);
    if (reporter) {
      const state = this.livingCity.district(this.city.districtAt(position.x, position.z));
      this.knowledge.fileReport(position.x, position.z, heat, reporter, REPORT_DELAY * witnessDelayMultiplier(state), options.label);
    }
  }

  /** Police-radio toast + synthesized ANI burst, throttled so a shooting spree reads as one dispatch call. */
  private radioDispatch(label: CrimeLabel, x: number, z: number, copWitnessed = false): void {
    if (this.radioCooldown > 0) return;
    this.radioCooldown = 4;
    const callout = radioCallout(label, this.city.districtAt(x, z), copWitnessed);
    this.audio.policeRadio(); this.ui.notify(`📻 ${callout.title}`, callout.detail, true, 'radio');
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
    const output = new THREE.Vector3(position.x + (Math.random() - 0.5) * 1.6, 0, position.z + (Math.random() - 0.5) * 1.6);
    output.y = this.city.surfaceHeightAt(output.x, output.z); return output;
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

  /** GTA rules at the front door: pending 911 calls don't matter, but a cop with live eyes on you does. */
  private enterSafehouse(place: SafehousePlace): void {
    if (!canEnterSafehouse(this.wanted.isWanted, this.knowledge.sightingAge)) { this.ui.notify(place.name, 'The JMPD has eyes on you. Lose the heat first.', false); return; }
    this.activeSafehouse = place;
    this.mode = 'paused'; this.closeWeaponWheel(); this.audio.setEngine(false); document.exitPointerLock();
    this.ui.showSafehouse(place.name, SLEEP_HOURS);
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
    const armour = resolveArmourPurchase(this.inventory.armour, this.economy.balance, multiplier);
    this.ui.showShop(entries, this.economy.balance, { price: armour.price, full: this.inventory.armour >= ARMOUR_MAX, canBuy: armour.ok });
  }

  private purchaseArmour(): void {
    const multiplier = shopPriceMultiplier(this.livingCity.district(CBD));
    const result = resolveArmourPurchase(this.inventory.armour, this.economy.balance, multiplier);
    if (!result.ok || !this.economy.spend(result.price)) { this.audio.ui(false); this.renderShop(); return; }
    this.inventory.armour = ARMOUR_MAX; this.livingCity.apply({ kind: 'shop-purchase', district: CBD }); this.audio.ui(true);
    this.ui.notify('Body armour fitted', `Full plate · -R${result.price.toLocaleString()}`);
    this.persist(); this.renderShop();
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
    vehicle.restore(); vehicle.speed = 0; this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.clearPolice();
    this.ui.screenFade(); this.audio.ui(true);
    this.ui.notify('Pik-’n’-Spray', `Fresh coat, clean record. Sharp sharp. -R${price}`); this.persist();
  }

  private storeVehicle(vehicle: Vehicle): void {
    if (vehicle.onFire || vehicle.wrecked || vehicle.disabled) { this.ui.notify('Avenida Garage', 'They refuse the wreck. Bring something roadworthy.', false); return; }
    if (isTaxiKind(vehicle.spec.kind)) this.endTaxiShift(vehicle, false);
    if (vehicle.spec.kind === 'courier') this.endCourierShift(vehicle, false);
    if (this.garageVehicle && this.garageVehicle !== vehicle) this.removeGarageVehicle();
    vehicle.playerControlled = false; vehicle.setFirstPerson(false); vehicle.occupied = false;
    vehicle.heading = GARAGE_PARK.heading; vehicle.reset(new THREE.Vector3(GARAGE_PARK.x, 0, GARAGE_PARK.z), this.city);
    const trafficIndex = this.population.traffic.indexOf(vehicle); if (trafficIndex >= 0) this.population.traffic.splice(trafficIndex, 1);
    this.garageVehicle = vehicle;
    this.activeVehicle = undefined; this.transition = undefined; this.player.inVehicle = false; this.player.setVisible(true);
    this.player.group.position.set(GARAGE_STEP_OUT.x, this.city.surfaceHeightAt(GARAGE_STEP_OUT.x, GARAGE_STEP_OUT.z), GARAGE_STEP_OUT.z); this.player.resetAirbornePose(); this.audio.setEngine(false); this.audio.ui(true);
    this.save.garage = { kind: vehicle.spec.kind, color: vehicle.spec.color, health: Math.round(vehicle.health) };
    this.persist();
    this.ui.notify('Vehicle stored', `${vehicle.spec.name} is tucked away in the garage.`);
  }

  private restoreGarageVehicle(): void {
    const saved = this.save.garage; if (!saved) return;
    const vehicle = new Vehicle(this.scene, saved.kind, new THREE.Vector3(GARAGE_PARK.x, this.city.roadHeightAt(GARAGE_PARK.x, GARAGE_PARK.z), GARAGE_PARK.z), saved.color);
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
      const spot = missionId === 'delivery-run' ? PORTIA_CAR_SPOT : GTI_SPOT;
      vehicle.restore();
      vehicle.heading = spot.heading;
      vehicle.reset(new THREE.Vector3(spot.x, 0, spot.z), this.city);
    }
  }

  private currentTarget(): WorldTarget | undefined {
    if (this.taxiDestination) return { position: this.taxiDestination, label: 'Drop-off', color: '#7fe08d' }; // active fare outranks mission breadcrumbs
    if (this.courierJob.phase === 'collecting') return { position: new THREE.Vector3(COURIER_DEPOT.x, this.city.roadHeightAt(COURIER_DEPOT.x, COURIER_DEPOT.z), COURIER_DEPOT.z), label: 'Sixty-Sekonds dispatch', color: '#84f01c' };
    if (this.courierDestination) return { position: this.courierDestination, label: `Order ${this.courierJob.completed + 1}`, color: '#84f01c' };
    const objective = this.missions.objective;
    if (objective?.kind === 'checkpoints') {
      const stop = DELIVERY_STOPS[Math.min(this.deliveryIndex, DELIVERY_STOPS.length - 1)];
      return stop ? { position: new THREE.Vector3(stop.x, this.city.roadHeightAt(stop.x, stop.z), stop.z), label: `Delivery ${this.deliveryIndex + 1}`, color: '#f5c451' } : undefined;
    }
    if (objective?.target) { const position = objective.target.position.clone(); position.y = this.city.surfaceHeightAt(position.x, position.z); return { ...objective.target, position }; }
    if (!this.missions.active) {
      let nearest: (typeof MISSIONS)[number] | undefined; let nearestDistance = Infinity;
      for (const mission of MISSIONS) {
        if (this.missions.completed.has(mission.id)) continue;
        const distance = (mission.start.position.x - this.player.group.position.x) ** 2 + (mission.start.position.z - this.player.group.position.z) ** 2;
        if (distance < nearestDistance) { nearest = mission; nearestDistance = distance; }
      }
      if (nearest) { const position = nearest.start.position.clone(); position.y = this.city.surfaceHeightAt(position.x, position.z); return { ...nearest.start, position }; }
      return undefined;
    }
    if (objective?.kind === 'enter-kind') {
      const vehicle = this.population.vehicles.find((item) => item.spec.kind === objective.vehicleKind && (!objective.vehicleColor || item.spec.color === objective.vehicleColor));
      if (vehicle) return { position: vehicle.group.position, label: vehicle.spec.name, color: '#65d8ff' };
    }
    return undefined;
  }

  /** LMB-drag mouse steering: while a non-aiming player holds the fire button in a vehicle (third person),
   *  the horizontal drag winds a self-centring virtual steering wheel that feeds Vehicle.updatePlayer like the
   *  A/D keys. Ticked once per frame (mouseDX is a whole-frame delta) — the camera tails the heading meanwhile. */
  private tickMouseSteer(dt: number): void {
    this.driveSteerActive = Boolean(this.activeVehicle) && this.settings.cameraViewVehicle !== 0 && this.input.firing && !this.input.aiming;
    if (this.driveSteerActive) this.driveSteer = THREE.MathUtils.clamp(this.driveSteer - this.input.mouseDX * MOUSE_STEER_GAIN, -1, 1); // drag right -> negative steer -> turn right, matching the D key
    else this.driveSteer *= Math.exp(-dt * 12); // released: the wheel springs back to centre
  }

  private updateCamera(dt: number): void {
    const target = this.activeVehicle?.group.position ?? this.player.group.position;
    const view = this.activeVehicle ? this.settings.cameraViewVehicle : this.settings.cameraViewFoot;
    const firstPerson = view === 0;
    const riding = Boolean(this.player.inVehicle && this.activeVehicle?.spec.twoWheeler); // riders stay visible except in first person
    const scoped = this.scoped; // scope: first-person eye from any view, model hidden, FOV from the zoom ladder
    this.player.setVisible(riding ? !firstPerson : !this.player.inVehicle && !((firstPerson || scoped) && !this.activeVehicle && !this.transition));
    this.activeVehicle?.setFirstPerson(firstPerson);
    const cover = this.cover;
    const leanTarget = cover && cover.corner !== 0 && !this.activeVehicle
      ? Math.sign(Math.cos(this.cameraController.yaw) * cover.spot.tangent.x * cover.corner - Math.sin(this.cameraController.yaw) * cover.spot.tangent.z * cover.corner || 1) * (0.55 + 0.45 * cover.peek)
      : 0; // pull the camera toward the exposed corner for visibility over the shoulder
    this.coverLean = THREE.MathUtils.lerp(this.coverLean, leanTarget, 1 - Math.exp(-dt * 8));
    const sensitivity = scoped ? scopeSensitivity(this.settings.mouseSensitivity, this.scopeLevel) : this.settings.mouseSensitivity;
    const airborneBoost = this.airborne ? (this.airborne.mode === 'freefall' ? 6 : 4) : 0; // skydives read better with the boom pulled back
    this.cameraController.update(dt, this.input, target, this.city, Boolean(this.activeVehicle), sensitivity, view, this.activeVehicle?.heading ?? 0, !this.combat.spec.melee && !this.airborne, this.coverLean, scoped ? scopeFov(this.scopeLevel) : 0, airborneBoost, this.driveSteerActive);
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
    this.marker.position.copy(this.markerTarget.position); this.markerPhase += dt; this.marker.rotation.y += dt * 0.7; this.marker.position.y += 0.2 + Math.sin(this.markerPhase * 2) * 0.15;
    const color = this.markerTarget.color ?? '#f5c542';
    if (color !== this.markerColor) {
      this.markerColor = color;
      this.marker.children.forEach((child: THREE.Object3D) => { const mesh = child as THREE.Mesh; (mesh.material as THREE.MeshBasicMaterial).color.set(color); });
    }
  }

  private handleVehicleCollisions(dt: number): void {
    for (const vehicle of [...this.population.vehicles, ...this.police.vehicles]) this.vehicleCollisionCooldown.set(vehicle, Math.max(0, (this.vehicleCollisionCooldown.get(vehicle) ?? 0) - dt));
    // JMPD vs civilian traffic: cruisers and cars physically exclude each other (police-police lives in PoliceSystem).
    for (const unit of this.police.vehicles) {
      if (unit.wrecked) continue;
      for (const other of this.population.vehicles) {
        if (other === this.activeVehicle || other.wrecked) continue;
        const push = separationPush(other.group.position.x - unit.group.position.x, other.group.position.z - unit.group.position.z, 3.3);
        if (!push) continue;
        unit.group.position.x -= push.x; unit.group.position.z -= push.z;
        other.group.position.x += push.x; other.group.position.z += push.z;
        if ((this.vehicleCollisionCooldown.get(unit) ?? 0) <= 0) {
          const impact = Math.abs(unit.speed - other.speed);
          unit.takeDamage(impact * 0.3); other.takeDamage(impact * 0.25);
          if (impact > 6 && unit.group.position.distanceTo(this.player.group.position) < 55) this.audio.collision(impact);
          this.vehicleCollisionCooldown.set(unit, 0.8);
        }
        unit.speed *= 0.7; other.speed *= 0.7;
      }
    }
    const driven = this.activeVehicle; if (!driven) return;
    for (const other of [...this.population.vehicles, ...this.police.vehicles]) { // JMPD contact is a genuine collision, never scripted damage
      if (other === driven || driven.group.position.distanceToSquared(other.group.position) > 10) continue;
      const direction = driven.group.position.clone().sub(other.group.position).setY(0).normalize(); driven.group.position.addScaledVector(direction, 0.4); other.group.position.addScaledVector(direction, -0.35);
      if ((this.vehicleCollisionCooldown.get(driven) ?? 0) <= 0) {
        const impact = Math.abs(driven.speed - other.speed);
        if (driven.spec.twoWheeler) this.damagePlayer(riderImpactDamage(impact)); else driven.takeDamage(impact * 0.35); // riders eat the hit themselves
        other.takeDamage(impact * 0.25); this.audio.collision(impact); this.taxiRide.recordCrash(impact); this.recordCourierCrash(impact); this.vehicleCollisionCooldown.set(driven, 0.8);
        if (driven.spec.twoWheeler && shouldKnockOff(impact)) { this.knockOff(driven); return; }
      }
      driven.speed *= 0.6; other.speed *= 0.7;
    }
  }

  private renderHUD(): void {
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    let prompt = '';
    if (this.mode === 'playing' && !this.transition) {
      const nearbyTarget = this.markerTarget;
      const shop = this.shops.shopNear(focus);
      if (this.online) prompt = this.online.localState?.vehicleId ? 'E  Exit vehicle  ·  ENTER  Global chat' : 'E  Enter nearby vehicle  ·  ENTER  Global chat  ·  Open PvP';
      else if (this.airborne) prompt = airborneHint(this.airborne.mode, this.inventory.parachutes);
      else if (this.activeVehicle) {
        if (shop?.kind === 'spray') prompt = `E  Pay-'n'-Spray · R${detailerPrice(this.wanted.level)}`;
        else if (shop?.kind === 'garage') prompt = 'E  Store vehicle';
        else {
          const taxiHint = !isTaxiKind(this.activeVehicle.spec.kind) ? ''
            : this.taxiRide.phase !== 'idle' ? '  ·  T  Cancel ride'
            : `  ·  T  ${this.taxiRide.duty === 'available' ? 'Go occupied' : 'Go available'}`;
          const courierHint = this.activeVehicle.spec.kind !== 'courier' ? '' : `  ·  Y  ${this.courierJob.active ? 'Clock out' : 'Clock in'}`;
          const sirenHint = this.activeVehicle.police ? '  ·  G  Siren' : '';
          const radioHint = this.activeVehicle.spec.twoWheeler ? '' : '  ·  N  Radio';
          prompt = `E  Exit vehicle  ·  F  Recover${radioHint}${taxiHint}${courierHint}${sirenHint}`;
        }
      }
      else if (this.cover) prompt = this.cover.corner !== 0 ? 'CTRL  Peek and fire  ·  Q  Leave cover' : 'A/D  Slide to a corner  ·  Q  Leave cover';
      else if (this.missions.objective?.kind === 'collect' && nearbyTarget && nearbyTarget.position.distanceTo(focus) < 8) prompt = 'E  Grab the route permit';
      else if (this.missions.state === 'failed') prompt = 'E  Restart mission';
      else if (this.missions.objective?.kind === 'choice') prompt = 'E  Decide the fate of Jozi Arms';
      else if (MISSIONS.some((mission) => !this.missions.completed.has(mission.id) && Math.hypot(mission.start.position.x - focus.x, mission.start.position.z - focus.z) < 7)) prompt = 'E  Speak to contact';
      else if (shop?.kind === 'weapons') prompt = 'E  Browse Jozi Arms';
      else if (shop?.kind === 'hotdog') prompt = `E  Boerewors roll · R${HOTDOG_PRICE}`;
      else if (this.safehouses.near(focus)) prompt = canEnterSafehouse(this.wanted.isWanted, this.knowledge.sightingAge) ? 'E  Enter safehouse' : 'Safehouse locked · lose the heat first';
      else if (shop?.driveIn && !this.population.nearestEnterable(focus)) prompt = shop.kind === 'spray' ? 'Drive a vehicle onto the marker to detail' : 'Drive a vehicle onto the marker to store';
      else if (this.coverAvailable) prompt = 'Q  Take cover';
      else if (this.population.nearestPedestrian(focus)) prompt = 'F  Mug / melee';
      else if (this.population.nearestEnterable(focus) || this.police.stealableNear(focus)) prompt = 'E  Enter vehicle';
    }
    const spec = this.combat.spec; const ammoState = this.combat.state;
    const district = this.city.districtAt(focus.x, focus.z);
    const objective = !this.online && this.missions.objective ? {
      missionName: this.missions.active?.name ?? '', text: this.missions.objective.text, progress: this.missions.objective.required ? this.missions.progress : undefined,
      required: this.missions.objective.required, remainingSeconds: this.missions.remainingTime > 0 ? this.missions.remainingTime : undefined,
    } : undefined;
    const vehicle = this.activeVehicle ? {
      name: this.activeVehicle.spec.name, speedKph: Math.abs(this.activeVehicle.speed) * 3.6, health: this.activeVehicle.health,
      radio: this.activeVehicle.spec.twoWheeler ? undefined : radioDial(this.audio.currentRadio),
      taxi: isTaxiKind(this.activeVehicle.spec.kind) ? { text: taxiHudText(this.taxiRide.phase, this.taxiRide.duty === 'available', this.taxiRide.fare, this.taxiRide.tip), available: this.taxiRide.available } : undefined,
      courier: this.activeVehicle.spec.kind === 'courier' ? { text: courierHudText(this.courierJob), available: this.courierJob.active } : undefined,
    } : undefined;
    const scoped = this.scoped; // the scope reticle replaces the HUD crosshair while glassing
    const crosshair = this.mode === 'playing' && !this.transition && !this.airborne && !this.weaponWheelOpen && !scoped && crosshairVisible(this.input.aiming, spec.melee) && (!this.activeVehicle || !spec.projectile); // weapons stay holstered mid-air
    this.ui.update({ health: this.player.health, armour: this.online ? 0 : this.inventory.armour, stims: this.online ? 0 : this.inventory.stims, parachutes: this.online ? 0 : this.inventory.parachutes, money: this.online ? 0 : this.economy.balance, weaponName: spec.name, melee: spec.melee, ammo: ammoState.ammo, reserve: ammoState.reserve, reloading: this.combat.reloading > 0, wanted: this.online ? 0 : this.wanted.level, district, clock: this.dayNight.clockText, reputation: !this.online && district === CBD ? reputationTier(this.livingCity.district(CBD).communityStanding) : undefined, prompt, crosshair, scope: scoped ? { zoom: scopeZoomLabel(this.scopeLevel) } : undefined, vehicle: this.online ? undefined : vehicle, objective, fps: this.fps, navCalls: this.navHudCalls, navMs: this.navHudMs, settings: this.settings, cheatsOn: !this.online && (this.cheats.fastRun || this.cheats.bigJump || this.cheats.invulnerable) });
    const markers = this.mapMarkers();
    const police = this.mapPolice();
    const hostiles = this.mapHostiles(); // arrest officers are on the map as JMPD, not as red hostiles
    const heading = this.activeVehicle?.heading ?? this.player.heading;
    this.ui.drawMap(focus.x, focus.z, heading, this.city.roadPaths, markers, police, hostiles, this.settings.minimapZoom);
    if (this.ui.mapOpen) this.ui.updateMap({ x: focus.x, z: focus.z, heading, markers, police, hostiles });
  }

  /** Single damage funnel: the invulnerable cheat short-circuits, then armour soaks before health bleeds. */
  private damagePlayer(amount: number): void {
    if (this.cheats.invulnerable || amount <= 0) return;
    this.ui.damageFlash();
    const routed = absorbDamage(this.inventory.armour, amount);
    this.inventory.armour = routed.armour;
    if (routed.through > 0) this.player.takeDamage(routed.through);
  }
  private mainMenuSummary() {
    return { hasSave: this.saveExists, money: this.economy.balance, completedMissions: this.missions.completed.size, totalMissions: MISSIONS.length, reputation: reputationTier(this.livingCity.district(CBD).communityStanding) };
  }
  private die(): void {
    if (this.mode === 'dead') return;
    if (this.missions.state === 'active') this.missions.fail('You were incapacitated');
    this.endCourierShift();
    this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false); this.mode = 'dead'; this.deathTimer = 3; this.audio.setEngine(false); this.audio.setTrafficEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio(); this.closeWeaponWheel(); this.closeConsole(); this.closeMap(); this.ui.notify('EISH', 'You got klapped. An ambulance is coming just now. Press E after respawning to restart the job.', false); document.exitPointerLock();
  }
  private respawn(): void {
    this.endTaxiShift(this.activeVehicle);
    this.endCourierShift(this.activeVehicle);
    if (this.activeVehicle) { this.activeVehicle.playerControlled = false; this.activeVehicle.setFirstPerson(false); this.activeVehicle = undefined; }
    this.transition = undefined; this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false); this.player.resetAirbornePose(); this.player.inVehicle = false; this.player.setVisible(true); this.player.heal(); this.player.group.position.set(...this.save.spawn); this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z); this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.clearPolice(); this.mode = 'playing';
  }
  /** Tears down the JMPD response and drops its foot officers from the population roster. */
  private clearPolice(): void {
    for (const officer of this.police.reset()) { const index = this.population.pedestrians.indexOf(officer); if (index >= 0) this.population.pedestrians.splice(index, 1); }
  }
  private pause(): void { this.mode = 'paused'; this.audio.setEngine(false); this.audio.setTrafficEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio(); this.closeWeaponWheel(); document.exitPointerLock(); this.ui.showPause(this.settings); }
  private persist(): void { this.save = { version: 2, money: this.economy.balance, completedMissions: [...this.missions.completed], spawn: this.save.spawn, settings: this.settings, weapons: this.combat.serialize(), cheats: { ...this.cheats }, garage: this.save.garage, livingCity: this.livingCity.state, timeOfDay: this.dayNight.hour, safehouses: this.save.safehouses, inventory: { ...this.inventory } }; this.saveManager.save(this.save); }
  private resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); this.composer?.setSize(innerWidth, innerHeight); }
}
