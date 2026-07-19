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
import { FrameProfiler } from './core/FrameProfiler';
import { adjustedShopPrice, ammoPrice, detailerPrice, HOTDOG_PRICE, hotdogHeal, reserveFull, resolveArmourPurchase, resolvePurchase, weaponPrice } from './core/ShopRules';
import { applyDrink, decayInebriation, DRINK_BY_ID, DRINKS, drunkHealthDelta, inebriationFraction, INEBRIATION_MAX, resolveDrinkPurchase, type DrinkId } from './core/DrinkRules';
import type { Pedestrian } from './entities/Pedestrian';
import { Player, type CoverPose } from './entities/Player';
import { functionalPlaneSpawns, Plane } from './entities/Plane';
import { Vehicle } from './entities/Vehicle';
import { loadVehicleLibraries } from './entities/VehicleAssets';
import { BulletSystem } from './systems/BulletSystem';
import { CombatSystem, type ShotResult } from './systems/CombatSystem';
import { BUMP_ASSAULT_HEAT } from './systems/BumpSystem';
import { heatAfterStarDrop, runConsoleCommand, type ConsoleHost } from './systems/Console';
import { clampT, cornerSide, COVER_ENTER_RANGE, COVER_EXIT_HOLD, coverHeading, coverPosition, coverT, movingAway, nearestGroundedCoverSpot, PEEK_OUT, PEEK_STEP, SLIDE_SPEED, type CoverSpot } from './systems/CoverSystem';
import { COURIER_MIN_TRIP_DISTANCE, COURIER_STOP_RADIUS, COURIER_STOP_SPEED, CourierJob, courierHudText } from './systems/CourierJobSystem';
import { FEAR_EVENTS, FEAR_MAX } from './systems/FearSystem';
import { GoreSystem } from './systems/GoreSystem';
import { LoadSheddingSystem } from './systems/LoadSheddingSystem';
import { MISSIONS, MissionSystem, type MissionDefinition, type MissionUpdate } from './systems/MissionSystem';
import { StoryDirector } from './systems/StoryDirector';
import { DialogueSystem } from './systems/DialogueSystem';
import { introScript } from './story/dialogues';
import { MISSION_SCRIPTS } from './story/scripts';
import { DIARY_STASH_NOTE, DIARY_STASH_REWARD, DIARY_TEXTS, DIARY_WORLD_PAGES } from './story/diaries';
import { DEPOT_DARK_THRESHOLD, DepotSecurity, depotDark, guardSees } from './systems/DepotSecurity';
import { KELVIN_FENCE_RADIUS, KELVIN_OFFICE_SPOT, KELVIN_YARD_CENTER } from './world/placements';
import { buildKelvinYard } from './world/KelvinYard';
import { CAR_TARGET_CAP, clampBusy, isAmbientPedestrian, LifecycleSystem, PED_TARGET_CAP } from './systems/LifecycleSystem';
import { PickupSystem, type Pickup } from './systems/PickupSystem';
import { determineReporter, PoliceKnowledge, radioCallout, REPORT_DELAY, SIGHT_RADIUS, type CrimeLabel, type WitnessCandidate } from './systems/PoliceKnowledge';
import { BLACKOUT_STEALTH_THRESHOLD, concealedInBlackout, inHeadlightCone, MUZZLE_FLASH_SECONDS } from './systems/BlackoutStealth';
import { nextBustMeter, PoliceSystem, separationPush, toggleSiren } from './systems/PoliceSystem';
import { PopulationSystem } from './systems/PopulationSystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { PropSystem } from './systems/PropSystem';
import { TorchSystem } from './systems/TorchSystem';
import { formatCountdown, TrainSystem } from './systems/TrainSystem';
import { findPath, nearestNode, type NavPoint } from './systems/NavGraph';
import { canEnterSafehouse, SAFEHOUSES, SafehouseSystem, safehouseSpawn, SLEEP_HOURS, sleepHour, type SafehousePlace } from './systems/SafehouseSystem';
import { GARAGE_PARK, GARAGE_STEP_OUT, SHOPS, ShopSystem } from './systems/ShopSystem';
import { airborneHint, canDeploy, chuteLandingDamage, deployParachute, SKYFALL_ALTITUDE, startAirborne, stepAirborne, type AirborneState } from './systems/SkyfallSystem';
import { PLANE_EXIT_SPEED, PLANE_MAX_SPEED, planeCrashDamage, planeHint } from './systems/FlightSystem';
import { buildTeleportTargets, clampToWorld, districtAnchors, resolveTeleport, safePlacement, type TeleportTarget } from './systems/Teleport';
import { ABANDON_RADIUS, ARRIVE_RADIUS, BOARD_RADIUS, canHail, GUNFIRE_FEAR_RADIUS, GUNFIRE_FEAR_SCALE, HAIL_RADIUS, isTaxiKind, MIN_TRIP_DISTANCE, PICKUP_RADIUS, REHAIL_COOLDOWN, routeDistance, STOP_SPEED, TaxiRide, taxiHudText } from './systems/TaxiJobSystem';
import { BURN_DPS, OCCUPANT_BURNOUT_DAMAGE, POLICE_WRECK_HEAT, VehicleFireSystem } from './systems/VehicleFireSystem';
import { WantedSystem } from './systems/WantedSystem';
import { CBD, civilianDisposition, LivingCitySystem, policeReinforcementModifier, reputationTier, shopPriceMultiplier, witnessDelayMultiplier, type CityEvent } from './systems/LivingCitySystem';
import type { BaseQuality, CheatSettings, GameMode, GameSettings, GameSnapshot, Inventory, SavedGame, WorldTarget } from './types';
import { weaponWheelResponds } from './ui/mapRender';
import type { MapViewFrame } from './ui/MapView';
import { type MapMarker, type MapPoint, MINIMAP_ZOOM_NAMES, stepMinimapZoom } from './ui/MinimapView';
import { TouchControls } from './ui/TouchControls';
import { shouldEnableTouch, touchQuality } from './ui/TouchModels';
import { UIManager } from './ui/UIManager';
import { City, ROAD_NETWORK } from './world/City';
import { COURIER_DEPOT, PLAYER_SPAWN, POLICE_STATION } from './world/placements';
import { DayNightSystem, nightFactor } from './world/DayNight';
import { buildEnvironment, type EnvironmentHandle } from './world/Environment';
import { ETOLL_GANTRIES } from './world/UrbanInfrastructure';
import { setPower } from './world/powerGrid';
import { loadTreeLibrary } from './world/FoliageAssets';

const MOUSE_STEER_GAIN = 0.005; // px of horizontal LMB-drag per unit of steer: ~200px winds the virtual wheel to full lock — tuned light, for small trim adjustments rather than hard cornering
const ULTRA_MIN_SCALE = 2; // Ultra renders at ≥2× the CSS resolution and downsamples — real supersampling AA. The floor bites hardest on LOW-dpi screens (a 1× monitor jumps to 2×, where aliasing shows most); HiDPI already renders dense, so it just stays at native.
const ULTRA_MAX_SCALE = 3; // …but cap the buffer so a 4×-dpi panel doesn't blow up VRAM/fill

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
  private trainEye = new THREE.Vector3(); // FP drive eye anchor, pushed past the hidden cab shell
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
  private trains: TrainSystem;
  private missions = new MissionSystem();
  private story = new StoryDirector();
  private dialogue = new DialogueSystem();
  /** Mission-script overlay merged into every engine snapshot (detection verdicts, escort/follow state). */
  private missionContext: Partial<GameSnapshot> = {};
  private focusSpeed = 0;
  private lastFocus?: THREE.Vector3;
  /** Scripted tail target (follow missions): spawned/parked/removed by mission beats. */
  private quarry?: Vehicle;
  private quarryArrived = false;
  private contactCullTimer = 0;
  private objectiveElapsed = 0;
  private missionPassedTimer = 0;
  private missionPassedView?: { name: string; items: string[] };
  private followElapsed = 0;
  private followCapFired = false;
  private hintsFired = new Set<number>();
  private riddleRevealed = false;
  private depotSecurity = new DepotSecurity();
  private depotWasSpotted = false;
  private depotClock = 0; // sweeps the Kelvin Yard guards' torch cones
  private yardGuards: Pedestrian[] = [];
  private loadShedding = new LoadSheddingSystem();
  private torch: TorchSystem;
  private torchHintShown = false; // the first blackout that lands in the dark teaches the L key, once
  private muzzleFlash = 0; // seconds the player's last shot keeps them lit for blackout stealth — shooting gives you away
  private concealed = false; // blackout stealth verdict this frame: JMPD sight checks shrink to whites-of-eyes while true
  private livingCity: LivingCitySystem;
  private economy: Economy;
  private shops: ShopSystem;
  private safehouses: SafehouseSystem;
  private activeSafehouse?: SafehousePlace;
  private activeBottleStore = ''; // name of the bottle store currently being browsed (for the menu header)
  private garageVehicle?: Vehicle;
  private ui = new UIManager();
  private touch?: TouchControls;
  private readonly touchMode = shouldEnableTouch(location.search, navigator.maxTouchPoints > 0 || 'ontouchstart' in window, matchMedia('(pointer: coarse)').matches);
  private multiplayerOverlay = new MultiplayerOverlay();
  private online?: OnlineSession;
  private onlineWasDead = false;
  private mode: GameMode = 'loading';
  private requiredAssetsReady = false;
  private assetLoadAttempt = 0;
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
  private bustTimer = 0;
  private bustMeter = 0; // 0→1 arrest progress while JMPD foot officers crowd the on-foot player
  private saveTimer = 0;
  private potholeCooldown = 0;
  private etollCooldowns: number[] = ETOLL_GANTRIES.map(() => 0);
  private radioIntroShown = false;
  private debugMapNpcs = false; // `mapnpcs` console toggle: draw every ambient car/ped as a dot on the full map
  private mouseSteerHintShown = false;
  private driveSteer = 0; // virtual steering-wheel offset [-1,1] wound by LMB-drag mouse steering (only in a vehicle, third person, not aiming)
  private driveSteerActive = false;
  private driveWander = 0; // mean-reverting random walk that drifts the wheel when driving drunk
  private driveWanderPhase = 0;
  private footstepTimer = 0;
  private prevDrivenSpeed = 0;
  private wallCrashCooldown = 0;
  private fps = 60;
  private simStepCostMs = 0; // EMA of one update()'s wall time; sizes the per-frame catch-up budget (see maxCatchupSteps)
  private navHudCalls = 0; private navHudMs = 0; // A* solves/sec and ms/sec, shown beside the FPS counter
  private navHudTimer = 0; private navHudLastSolves = 0; private navHudLastMs = 0; // rolling 1s sampler state
  private readonly profiler = new FrameProfiler(); // per-frame CPU breakdown as a % of the 60fps budget (perf display only)
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
  private planes: Plane[] = [];
  private activePlane?: Plane;
  private districtTargets: TeleportTarget[];

  constructor(private container: HTMLElement) {
    this.saveExists = this.saveManager.hasSave(); this.save = this.saveManager.load(); this.settings = { ...this.save.settings }; this.cheats = { ...this.save.cheats }; this.inventory = { ...this.save.inventory }; this.economy = new Economy(this.save.money); this.livingCity = new LivingCitySystem(this.save.livingCity);
    if (this.touchMode) this.settings.quality = touchQuality(this.saveExists, this.settings.quality, 'low'); // phones start on low; a saved choice from the settings menu wins
    this.setupRenderer(); this.setupScene();
    this.ui.showLoading({ progress: 18, label: 'Building Johannesburg', detail: 'Laying out roads, terrain, water and landmarks.' });
    this.city = new City(this.scene, this.baseQuality());
    this.ui.showLoading({ progress: 46, label: 'City foundations ready', detail: 'Starting the people, traffic and game systems.' });
    this.districtTargets = districtAnchors((x, z) => this.city.districtAt(x, z));
    this.dayNight = new DayNightSystem(this.scene, this.environment, this.city, this.baseQuality(), this.save.timeOfDay);
    this.torch = new TorchSystem(this.scene);
    this.shops = new ShopSystem(this.scene, this.city);
    buildKelvinYard(this.scene, this.city);
    this.safehouses = new SafehouseSystem(this.scene, this.city);
    this.player = new Player(this.scene, new THREE.Vector3(...this.save.position)); // resume where the last save actually left off (Continue); New Game repositions to spawn in startGame
    this.player.group.position.y = this.restoreY(this.save.position[0], this.save.position[2], this.save.position[1]); // keep saved elevation (rooftop/overpass), else sit on the ground
    this.player.setHeading(this.save.heading); // resume facing the saved direction
    this.cameraController = new CameraController(this.camera);
    this.cameraController.yaw = this.save.heading + Math.PI; // camera parked behind, looking the way the player faces
    this.population = new PopulationSystem(this.scene, this.city, this.audio);
    // Guards need the population roster: this spawn must stay AFTER the PopulationSystem line above.
    this.yardGuards = [0, Math.PI].map((angle) => this.population.spawnYardGuard(KELVIN_OFFICE_SPOT.x + Math.sin(angle) * 12, KELVIN_OFFICE_SPOT.z + Math.cos(angle) * 12));
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
    this.trains = new TrainSystem(this.scene, this.city);
    this.planes = functionalPlaneSpawns().map((spawn, index) => new Plane(this.scene, spawn, this.city, 4242 + index * 101));
    this.input = new InputManager(this.renderer.domElement);
    if (this.touchMode) this.touch = new TouchControls(this.input, this.renderer.domElement, this.ui.root);
    this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current); this.player.cheats = this.cheats;
    this.missions.completed = new Set(this.save.completedMissions);
    this.story.restore(this.save.storyFlags, this.save.diaryPages);
    this.restoreGarageVehicle();
    this.buildMarker(); this.bindUI(); this.animate(); void this.prepareAssets();
    if (import.meta.env.DEV) Object.assign(window, { __game: this, __scripts: MISSION_SCRIPTS, __roads: ROAD_NETWORK });
  }

  private async prepareAssets(retry = false): Promise<void> {
    const attempt = ++this.assetLoadAttempt; this.requiredAssetsReady = false; this.mode = 'loading';
    this.ui.showLoading({ progress: 52, label: retry ? 'Retrying required models' : 'Loading required models', detail: 'Player, vehicles and trees · 0 of 3 ready.' });
    let completed = 0; let failed = false;
    const track = (name: string, task: Promise<void>): Promise<void> => task.then(() => {
      completed++;
      if (failed || attempt !== this.assetLoadAttempt) return;
      this.ui.showLoading({ progress: 52 + completed * 10, label: `${name} ready`, detail: `Player, vehicles and trees · ${completed} of 3 ready.` });
    });
    try {
      await Promise.all([
        track('Player and moves', retry ? this.player.retryCharacter() : this.player.loadCharacter()),
        track('Joburg trees', loadTreeLibrary()),
        track('Joburg vehicle fleet', loadVehicleLibraries()),
      ]);
      if (attempt !== this.assetLoadAttempt) return;
      this.ui.showLoading({ progress: 85, label: 'Planting the city', detail: 'Installing authored trees and preparing nearby streets.' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      this.city.installTreeAssets();
      await this.city.warmInitialBuildings(this.player.group.position, (complete, total) => {
        if (attempt !== this.assetLoadAttempt) return;
        const fraction = total > 0 ? complete / total : 1;
        this.ui.showLoading({ progress: 86 + fraction * 13, label: 'Opening your neighbourhood', detail: `Nearby building blocks · ${complete} of ${total} ready.` });
      });
      if (attempt !== this.assetLoadAttempt) return;
      this.ui.showLoading({ progress: 100, label: 'Joburg is ready', detail: 'Welcome to the city.' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      this.requiredAssetsReady = true; this.mode = 'menu'; this.ui.showMainMenu(this.mainMenuSummary());
    } catch (error) {
      failed = true;
      if (attempt !== this.assetLoadAttempt) return;
      console.error('[assets] A required 3D asset failed to load.', error);
      this.ui.showAssetFailure(() => { void this.prepareAssets(true); });
    }
  }

  private setupRenderer(): void {
    this.renderer.setPixelRatio(this.renderPixelRatio()); this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low'; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.22;
    this.renderer.shadowMap.autoUpdate = true;
    this.container.append(this.renderer.domElement); window.addEventListener('resize', () => this.resize());
  }

  private setupScene(): void {
    this.environment = buildEnvironment(this.scene, this.baseQuality());
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    this.scene.environmentIntensity = 0.32;
    this.setupComposer();
  }

  private setupComposer(): void {
    this.composer?.dispose(); this.composer = undefined; this.gtao = undefined;
    if (this.settings.quality === 'low') return; // low quality: plain renderer.render, no post stack
    const ultra = this.settings.quality === 'ultra';
    const composer = new EffectComposer(this.renderer);
    // Two samples preserve edge stability while halving the multisample bandwidth/memory of the old 4x
    // full-screen half-float targets. Resolution is already quality-capped by renderPixelRatio(). Ultra
    // stacks 4x MSAA on top of its 2x supersample for the cleanest possible edges.
    const samples = ultra ? 4 : 2;
    composer.renderTarget1.samples = samples; composer.renderTarget2.samples = samples;
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (this.settings.quality === 'high' || ultra) { // GTAO is the expensive pass — high and ultra only
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
    this.ui.onBuyDrink = (id) => this.buyDrink(id);
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
      cars: this.mapCars(), peds: this.mapPeds(),
    };
  }
  private mapMarkers(): MapMarker[] {
    if (this.online) {
      const target = this.online.objective?.target;
      return [
        ...this.online.playerStates.filter((player) => player.id !== this.online?.selfId && !player.dead).map((player) => ({ x: player.x, z: player.z, color: '#55e0bb', shape: 'diamond' as const })),
        ...(target ? [{ x: target.x, z: target.z, color: target.color, objective: true }] : []),
      ];
    }
    return [
      ...this.shops.mapIcons(), ...this.safehouses.mapIcons(),
      ...(this.markerTarget ? [{ x: this.markerTarget.position.x, z: this.markerTarget.position.z, color: this.markerTarget.color ?? '#f5c542', objective: true }] : []),
      ...((area) => area ? [{ x: area.x, z: area.z, color: '#f5c542', area: area.radius }] : [])(this.riddleSearchArea()),
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
  /** `mapnpcs` debug dots: every ambient car / ped, only while the toggle is on (empty otherwise, so it costs nothing). */
  private mapCars(): MapPoint[] {
    if (!this.debugMapNpcs || this.online) return [];
    return this.population.traffic.filter((vehicle) => !vehicle.wrecked).map((vehicle) => ({ x: vehicle.group.position.x, z: vehicle.group.position.z }));
  }
  private mapPeds(): MapPoint[] {
    if (!this.debugMapNpcs || this.online) return [];
    return this.population.pedestrians.map((ped) => ({ x: ped.group.position.x, z: ped.group.position.z }));
  }

  /** Console command handlers: every mutation goes through the same paths the game itself uses. */
  private consoleHost: ConsoleHost = {
    setTime: (hour) => { this.dayNight.hour = hour; this.persist(); return `Clock set to ${this.dayNight.clockText}.`; },
    setTimerate: (rate) => { this.dayNight.timeRate = Math.min(120, Math.max(0, rate)); return this.dayNight.timeRate === 0 ? 'Time frozen.' : `Time runs at ${this.dayNight.timeRate}× normal.`; },
    toggleFps: () => { this.settings.showFps = !this.settings.showFps; this.persist(); return `Performance display ${this.settings.showFps ? 'on' : 'off'}.`; },
    togglePerfChart: () => { this.settings.showPerfChart = !this.settings.showPerfChart; this.persist(); return `Game-loop timing chart ${this.settings.showPerfChart ? 'on' : 'off'}.`; },
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
    toggleMapNpcs: () => { this.debugMapNpcs = !this.debugMapNpcs; return this.debugMapNpcs ? 'NPC map dots ON — cars magenta, peds deep blue. Open the map with M.' : 'NPC map dots off.'; },
    save: () => { this.persist(); this.saveManager.saveCheckpoint(this.save); return 'Checkpoint saved. Progress is autosaved continuously; `reload` returns to this exact spot.'; },
    reload: () => this.reloadSavedGame(),
    ghost: () => {
      this.closeConsole();
      const on = this.player.toggleGhost();
      return on ? 'Ghost mode ON — mouse wheel = altitude, gravity off, clipping off. Type "ghost" again to land.' : 'Ghost mode OFF — gravity restored.';
    },
    setPosition: (axis, value) => { this.player.group.position[axis] = value; return `Player ${axis} set to ${value}.`; },
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
    setInebriation: (level) => {
      this.player.inebriation = Math.max(0, Math.min(INEBRIATION_MAX, level ?? INEBRIATION_MAX));
      return this.player.inebriation <= 0 ? 'Sobered up. Straight as an arrow.' : `Inebriation set to ${Math.round(this.player.inebriation)}/100. Mind the lampposts.`;
    },
    missionList: () => MISSIONS.map((mission, index) =>
      `${index + 1}. ${mission.name} — ${mission.contact}${this.missions.active?.id === mission.id ? ' ← active' : this.missions.completed.has(mission.id) ? ' ✓ done' : ''}`),
    missionStart: (index) => {
      const target = this.missions.missions[index - 1];
      if (!target) return `Eish, no mission ${index}. Type "mission" for the list (1-${MISSIONS.length}).`;
      this.story.synthesizePrerequisites(target, this.missions.missions, this.missions.completed); // works cold from a fresh save
      this.dialogue.abandon(); this.story.abandonOffer();
      this.missions.active = undefined; this.missions.state = 'available';
      this.resetMissionRuntime();
      const mission = this.missions.forceStart(index);
      if (!mission) return `Eish, mission ${index} would not arm.`;
      this.teleportPlayer(mission.start.position.x, mission.start.position.z, mission.contact);
      return `Mission ${index} "${mission.name}" armed — you're with ${mission.contact}. Objective: ${this.missions.objective?.text ?? ''}`;
    },
  };

  /** The gazetteer is rebuilt per query so the `spawn` entry tracks the current wake-up spot; districts are sampled once. */
  private teleportTargets(): TeleportTarget[] {
    return buildTeleportTargets({ spawn: this.save.spawn, districts: this.districtTargets, shops: SHOPS, safehouses: SAFEHOUSES, missions: MISSIONS });
  }

  /** Drops the player safely at (x, z): vehicle, cover and airborne states end cleanly, the spot nudges off any
   *  collider, and the camera snaps behind the new position instead of flying across town. Driving? You arrive
   *  on foot — the vehicle stays where it was. */
  /** Put the player on foot: exit/free any vehicle, drop cover, cancel airborne/canopy, unwind the airborne pose. */
  private leaveVehicleOnFoot(): void {
    this.trains.endRide();
    const vehicle = this.activeVehicle ?? this.transition?.vehicle;
    if (vehicle) {
      this.endTaxiShift(vehicle);
      this.endCourierShift();
      vehicle.playerControlled = false; vehicle.setFirstPerson(false);
      this.activeVehicle = undefined; this.transition = undefined;
      this.audio.setEngine(false); this.audio.stopRadio();
    }
    this.releasePlane();
    this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false); this.player.resetAirbornePose();
    this.player.inVehicle = false; this.player.setVisible(true);
  }

  private teleportPlayer(x: number, z: number, label: string): string {
    this.leaveVehicleOnFoot();
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
    this.dayNight.setQuality(this.baseQuality());
    this.city.setWaterQuality(this.baseQuality()); // rebuilds water meshes; disposes the old tier's materials and mirror target
    this.setupComposer();
  }

  /** Visual tier the world subsystems (city, lights, water, environment) render at. `ultra` is a render-only
   *  super-tier — everything except the renderer's pixel ratio and post stack treats it as `high`. */
  private baseQuality(): BaseQuality { return this.settings.quality === 'ultra' ? 'high' : this.settings.quality; }

  /** Render resolution multiplier. Base tiers only CAP the ratio (min with devicePixelRatio → never above
   *  native, so they're a HiDPI perf throttle, NOT antialiasing). Ultra instead FORCES the ratio up to at
   *  least ULTRA_MIN_SCALE — genuine supersampling that downsamples geometry, textures and specular alike.
   *  Because it's a floor (max, not min), the boost lands hardest on low-dpi screens where aliasing is most
   *  visible: a 1× monitor renders at 2× (2× SSAA); a 2× Retina panel is already dense, so it stays at native. */
  private renderPixelRatio(): number {
    if (this.settings.quality === 'ultra') return Math.min(ULTRA_MAX_SCALE, Math.max(devicePixelRatio || 1, ULTRA_MIN_SCALE));
    const cap: Record<BaseQuality, number> = { low: 1, medium: 1.25, high: 1.5 };
    return Math.min(devicePixelRatio || 1, cap[this.settings.quality]);
  }

  private startGame(fresh: boolean): void {
    if (!this.requiredAssetsReady || this.player.characterStatus !== 'ready') return;
    this.online?.close(); this.online = undefined; this.multiplayerOverlay.hide();
    if (fresh) { this.endTaxiShift(); this.endCourierShift(); this.removeGarageVehicle(); this.saveManager.clearCheckpoint(); this.save = structuredClone(DEFAULT_SAVE); this.saveManager.save(this.save); this.saveExists = true; this.economy.balance = this.save.money; this.livingCity = new LivingCitySystem(this.save.livingCity); this.missions.completed.clear(); this.story.restore([], []); this.airborne = undefined; this.releasePlane(); this.player.setCanopy(false); this.inventory = { ...this.save.inventory }; this.player.group.position.set(...this.save.spawn); this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z); this.player.setHeading(this.save.heading); this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current); Object.assign(this.cheats, this.save.cheats); this.dayNight.hour = this.save.timeOfDay; }
    this.player.setDead(false); this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.audio.resume(); this.audio.setVolume(this.settings.masterVolume); void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    this.ui.notify('Welcome to Joburg', 'Mind the potholes. Mission contacts are marked in gold.');
  }

  private startOnline(name: string): void {
    if (!this.requiredAssetsReady || this.player.characterStatus !== 'ready') return;
    this.endTaxiShift(); this.endCourierShift(); this.online?.close(); this.trains.endRide();
    this.player.inVehicle = false; this.player.setVisible(true); this.player.heal(); this.combat.restore(DEFAULT_SAVE.weapons); this.combat.select('pistol'); this.player.setWeapon('pistol');
    this.activeVehicle = undefined; this.transition = undefined; this.cover = undefined; this.airborne = undefined; this.player.resetAirbornePose(); this.releasePlane();
    this.player.group.position.set(...PLAYER_SPAWN); this.player.group.position.y = this.city.surfaceHeightAt(PLAYER_SPAWN[0], PLAYER_SPAWN[2]);
    this.player.setDead(false); this.onlineWasDead = false; this.online = new OnlineSession(this.scene, this.multiplayerOverlay, name, (x, z) => this.city.surfaceHeightAt(x, z));
    this.markerTarget = undefined;
    this.mode = 'playing'; this.input.reset(); this.ui.hideMenu(); void this.audio.resume();
    void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    this.ui.notify('Global world', 'Open PvP is active. Press Enter to chat.');
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.profiler.enabled = this.settings.showFps || this.settings.showPerfChart; this.profiler.frameStart(); // off = zero overhead
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
    else if (this.mode === 'busted') { this.bustTimer -= frameDt; if (this.bustTimer <= 0) this.respawn(true); }
    else if (this.input.consume('Escape')) this.ui.back();
    this.player.updateVisual(frameDt);
    this.profiler.mark('camera');
    this.tickMouseSteer(frameDt); this.updateCamera(frameDt); this.updateMarker(frameDt); this.renderHUD();
    this.profiler.mark('culling');
    this.environment.updateShadowFocus(this.activeVehicle?.group.position ?? this.player.group.position);
    this.city.updateVisibility(this.activeVehicle?.group.position ?? this.player.group.position, this.requiredAssetsReady); // cull the menu backdrop immediately; stream required-asset models only after their load gate
    const measure = import.meta.env.DEV && !this.loggedDrawCalls && this.clock.elapsedTime > 2; // >2s: the staggered chunk culling needs its first full pass before the number means anything
    if (measure) { this.renderer.info.autoReset = false; this.renderer.info.reset(); }
    this.profiler.mark('render');
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    if (measure) { this.loggedDrawCalls = true; console.info(`[render] calls=${this.renderer.info.render.calls} tris=${this.renderer.info.render.triangles}`); this.renderer.info.autoReset = true; }
    this.profiler.frameEnd();
    this.input.endFrame();
  };

  private update(dt: number): void {
    this.profiler.mark('player');
    if (this.input.consume('Escape')) { this.pause(); return; }
    if (this.input.consume('Backquote')) this.openConsole(); // input suspends, world keeps running
    if (this.input.consume('KeyM')) this.openMap(); // Esc/M closes it (handled by the overlay while open)
    if (this.input.consume('KeyV') && (!this.trains.riding || this.trains.driving)) { // the train aisle is FP-only
      const key = this.activeVehicle || this.trains.driving ? 'cameraViewVehicle' : 'cameraViewFoot';
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
    if (this.input.consume('KeyL')) this.audio.ui(this.torch.toggle()); // works on foot, driving, riding, flying — the click doubles as on/off feedback
    if (this.airborne) this.updateAirborne(dt);
    else if (this.transition) this.updateTransition(dt);
    else if (this.activePlane) this.updateFlying(dt);
    else if (this.trains.riding) this.updateTrainRide();
    else if (this.activeVehicle) this.updateDriving(dt);
    else this.updateOnFoot(dt);
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    this.brandishCooldown = Math.max(0, this.brandishCooldown - dt);
    if (this.input.aiming && !this.combat.spec.melee && !this.transition && !this.airborne && this.brandishCooldown === 0) { this.population.broadcastBrandish(focus); this.brandishCooldown = 1.5; } // a raised gun scares witnesses; no police heat for merely aiming
    this.profiler.mark('world');
    this.livingCity.update(dt); this.updateLivingCityRuntime(dt, focus);
    this.audio.updateListener(focus.x, focus.z, this.cameraController.yaw, this.city.isPark(focus.x, focus.z));
    this.profiler.mark('traffic');
    this.population.update(dt, focus, (amount) => this.damagePlayer(amount), !this.activeVehicle && !this.transition && !this.airborne);
    for (const hit of this.population.consumePlayerVehicleHits()) { // civilian traffic vs the on-foot player: the driver is AI, the player the victim — no heat, just physics
      if (hit.damage > 0) this.damagePlayer(hit.damage);
      if (hit.knockdown && !this.player.tumbling) { this.player.tumble(); this.shake = Math.min(0.7, this.shake + 0.3); }
    }
    this.profiler.mark('world');
    const forward = this.camera.getWorldDirection(this.cameraForward);
    const guarded = new Set<Vehicle>();
    for (const vehicle of [this.activeVehicle, this.transition?.vehicle, this.garageVehicle]) if (vehicle) guarded.add(vehicle);
    // Visibility apex is the CAMERA (the actual eye), not the player. The camera sits behind and above the
    // character, so a patch beside/behind the player is still on-screen; testing from the player's feet
    // mis-classified it as hidden and spawned/culled agents in view — most obvious walking backward, when the
    // character pivots to face the camera and you're looking straight at that patch. The camera is the eye for
    // the sight-line/occlusion ray too, so origin the whole ViewPoint there.
    const eye = this.camera.position;
    this.lifecycle.update(dt, this.dayNight.hour, { x: eye.x, z: eye.z, dirX: forward.x, dirZ: forward.z }, guarded);
    this.city.update(dt);
    this.trains.update(dt);
    this.updatePlanes(dt);
    const aboard = this.trains.riderPose(); // platform motion composes into the player BEFORE the camera reads the position
    if (aboard) { this.player.group.position.set(aboard.x, aboard.y, aboard.z); this.player.setHeading(aboard.heading); this.player.animateAboard(aboard.walkSpeed, aboard.side, aboard.forward); }
    this.applyEskom(this.loadShedding.update(dt));
    this.dayNight.update(dt, focus, this.population.vehicles, this.police.vehicles, this.activeVehicle ?? this.transition?.vehicle);
    for (const impact of this.population.consumeImpacts()) {
      const intensity = Math.min(1.6, Math.abs(impact.vehicle.speed) / 16);
      this.gore.burst(impact.position, intensity, impact.killed);
      this.audio.splat(intensity, impact.position.x, impact.position.z);
      if (impact.vehicle === this.activeVehicle) this.reportCrime(impact.position, impact.killed ? 24 : 12, { victims: [impact.ped], radius: (impact.killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: impact.killed ? 'civilian-murder' : 'civilian-assault', label: impact.killed ? 'murder' : 'hit-and-run' });
      if (impact.killed) this.spawnDropsAt(impact.position, 'civilian');
    }
    this.profiler.mark('police');
    const districtState = this.livingCity.district(this.city.districtAt(focus.x, focus.z));
    const reinforcementModifier = policeReinforcementModifier(districtState);
    this.population.setPolicePatrolCount(reinforcementModifier, focus);
    // Two-wheelers stay a vehicle pursuit (no standoff/arrest), but they grant no cover: JMPD fire lands on the rider.
    const riddenBike = Boolean(this.activeVehicle?.spec.twoWheeler);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);
    this.concealed = this.isConcealed(focus.x, focus.z);
    this.police.update(dt, focus, Boolean(this.activeVehicle), this.wanted, this.knowledge, (amount) => this.damagePlayer(amount), reinforcementModifier,
      (amount) => { if (riddenBike) this.damagePlayer(amount); else this.activeVehicle?.takeDamage(amount); }, Boolean(this.activeVehicle?.police && this.activeVehicle.sirenOn), this.concealed);
    for (const event of this.police.consumeEvents()) {
      if (event.kind === 'freeze') this.ui.notify('JMPD', '"FREEZE! Hands where I can see them!"', false);
      else if (event.kind === 'officers') this.population.pedestrians.push(...event.officers);
      else if (event.kind === 'reboard') for (const officer of event.officers) this.population.removePedestrian(officer);
      else this.population.vehicles.push(event.vehicle); // abandoned cruiser joins the civilian pool — enterable like any parked car
    }
    // Arrest: foot officers crowding an on-foot suspect fill the bust meter (faster the more of them), and once
    // it tops out JMPD gets the cuffs on. Sitting in a car makes it a vehicle pursuit, not a collar.
    const contacting = this.activeVehicle || this.transition ? 0 : this.police.countContacting(this.player.group.position);
    this.bustMeter = nextBustMeter(this.bustMeter, contacting, dt);
    if (this.bustMeter >= 1) this.getBusted();
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
    this.profiler.mark('combat');
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
    this.updateInebriation(dt);
    this.saveTimer += dt; if (this.saveTimer > 8 && !this.activePlane) { this.persist(); this.saveTimer = 0; } // no autosave mid-flight: a resumed save would float the player at altitude
    if (this.player.health <= 0) this.die();
  }

  private updateOnline(dt: number): void {
    this.profiler.mark('online');
    const online = this.online; if (!online) return;
    if (this.input.consume('Escape')) { this.pause(); return; }
    const stateBefore = online.localState;
    if (this.input.consume('KeyE')) online.interact();
    if (!stateBefore?.dead && !stateBefore?.vehicleId) {
      this.player.setVisible(true); this.player.update(dt, this.input, this.cameraController.yaw, this.city);
      if (stateBefore) {
        this.combat.loadout.pistol.ammo = stateBefore.ammo; this.combat.loadout.pistol.reserve = stateBefore.reserve;
        this.combat.reloading = stateBefore.reloading ? Math.max(this.combat.reloading, 0.1) : 0;
      }
      if (this.input.consume('KeyR')) { online.reload(); if (stateBefore && !stateBefore.reloading && stateBefore.ammo < 12 && stateBefore.reserve > 0) this.audio.reload(); }
      this.combat.update(dt);
      const shot = this.combat.fire(this.input, this.camera, this.player.group.position, this.population, { aim: this.input.aiming, heading: this.player.heading });
      if (shot.fired && !shot.melee) { this.player.registerShot(); online.fire(this.camera.getWorldDirection(new THREE.Vector3()).normalize()); }
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
    this.markerTarget = this.currentTarget();
  }

  private applyEskom(event: 'start' | 'end' | undefined): void {
    if (event === 'start') {
      setPower(false);
      const hint = !this.torchHintShown && nightFactor(this.dayNight.hour) > 0.5; if (hint) this.torchHintShown = true; // teach the key the first time the lights die in actual darkness
      this.ui.notify('Load shedding: Stage 4', hint ? 'Eskom sends regards. Pitch dark out there — L for torch.' : 'Eskom sends regards. The robots are out.', false);
    }
    else if (event === 'end') { setPower(true); this.ui.notify('Power restored', 'For now. Sharp sharp.'); }
    // The start-of-stage hint only fires if the blackout LANDS in darkness — when shedding begins in
    // daylight and carries into night, teach the key the moment it actually gets dark instead.
    if (!this.torchHintShown && !this.torch.on && this.dayNight.blackoutDarkness > 0.5) {
      this.torchHintShown = true;
      this.ui.notify('Pitch dark', 'No street lights tonight. L for torch.', false);
    }
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
    if (scroll && this.player.ghost) this.player.ghostAdjustAltitude(scroll); // free-fly: wheel flies up/down instead of cycling weapons
    else if (scroll && weaponWheelResponds(this.ui.mapOpen)) {
      if (wheelAction(this.scoped) === 'zoom') this.scopeLevel = stepScopeLevel(this.scopeLevel, scroll > 0 ? -1 : 1);
      else this.combat.cycle(scroll > 0 ? 1 : -1);
    }
    this.footstepTimer -= dt;
    if (this.player.onGround && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((key) => this.input.down(key)) && this.footstepTimer <= 0) { const running = this.input.down('ShiftLeft'); this.audio.footstep(running, this.city.isPark(this.player.group.position.x, this.player.group.position.z)); this.footstepTimer = running ? 0.24 : this.input.down('AltLeft') ? 0.56 : 0.38; }
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
      this.player.registerShot();
      this.muzzleFlash = MUZZLE_FLASH_SECONDS; // set before the crime files: the flash lights the shooter for the report itself
      if (!shot.deferred) this.handleGunshot(shot, this.player.group.position); // rockets report at launch; bullets report when they land
      if (scopeWeapon(this.combat.current)) this.cameraController.recoil(SNIPER_RECOIL); // .303 shoulder thump
    }
    this.player.setWeapon(this.combat.current);
    if (this.input.consume('KeyF')) this.tryMugOrMelee();
    if (this.input.consume('KeyE')) {
      if (this.advanceDialogue()) return;
      const collectTarget = this.missions.objective?.kind === 'collect' ? this.missionTargetRaw() : undefined;
      if (collectTarget && collectTarget.position.distanceTo(this.player.group.position) < 8) { this.collectedItem = true; return; }
      if (this.tryMissionInteraction()) return;
      if (this.tryDiaryPickup()) return;
      const vehicle = this.population.nearestEnterable(this.player.group.position);
      const cruiser = this.police.stealableNear(this.player.group.position);
      const shop = this.shops.shopNear(this.player.group.position);
      if (shop?.kind === 'weapons') { this.openWeaponShop(); return; }
      if (shop?.kind === 'bottle') { this.openBottleStore(shop.name); return; }
      if (shop?.kind === 'hotdog') { this.buyHotdog(); return; }
      const safehouse = this.safehouses.near(this.player.group.position);
      if (safehouse) { this.enterSafehouse(safehouse); return; }
      const plane = this.nearestPlane();
      if (plane) { this.enterPlane(plane); return; }
      if (this.trains.tryBoard(this.player.group.position)) { this.cover = undefined; this.ui.notify('All aboard', 'WASD walks the aisle. E steps off — or takes the controls from a cab.'); return; }
      if (shop?.driveIn && !vehicle && !cruiser) { this.ui.notify(shop.name, shop.kind === 'spray' ? 'They only detail vehicles. Drive one onto the marker.' : 'Drive a vehicle onto the marker to store it.', false); return; }
      const pick = cruiser && (!vehicle || cruiser.group.position.distanceToSquared(this.player.group.position) < vehicle.group.position.distanceToSquared(this.player.group.position)) ? cruiser : vehicle;
      if (pick === cruiser && cruiser) { this.police.release(cruiser); this.population.vehicles.push(cruiser); } // stolen cruiser leaves the JMPD fleet
      if (pick) this.beginEnter(pick);
    }
  }

  /** Aboard a train: E steps off, takes the cab controls, or hands them back; movement intent is
   *  sampled here and applied by TrainSystem.update after the shuttles advance (see the aboard hook). */
  private updateTrainRide(): void {
    if (this.input.consume('KeyE')) {
      if (this.trains.driving) { this.trains.releaseControls(); this.ui.notify('Controls released', 'The schedule takes it from here.'); }
      else if (this.trains.atCab) { this.trains.takeControls(); this.ui.notify('You have the train', 'W drives, S brakes then reverses. E in the cab hands it back.'); }
      else {
        const exit = this.trains.dismount();
        if (!exit) { this.ui.notify('Exit blocked', 'No clear ground beside the tracks here.', false); return; }
        this.player.group.position.set(exit.x, exit.y, exit.z); this.player.velocityY = 0; this.player.onGround = true;
        if (exit.tumble) { this.player.tumble(); this.shake = Math.min(0.7, this.shake + 0.25); }
        return;
      }
    }
    this.trains.setRideStick(Number(this.input.down('KeyD')) - Number(this.input.down('KeyA')), Number(this.input.down('KeyW')) - Number(this.input.down('KeyS')), this.cameraController.yaw, this.input.down('ShiftLeft'));
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

  /** The nearest boardable flight-ready aircraft: on foot, standing by the airframe. */
  private nearestPlane(): Plane | undefined {
    const position = this.player.group.position;
    return this.planes.find((plane) => !plane.wrecked && plane.group.position.distanceTo(position) < 7);
  }

  /** Hands the aircraft back to the world (or the tow truck) without touching the player's pose. */
  private releasePlane(): void {
    const plane = this.activePlane; if (!plane) return;
    plane.pilot = false; this.activePlane = undefined;
  }

  /** Into the cockpit: instant boarding (no lerp transition — the wing is in the way), and the seat-back
   *  parachute tops the inventory up to one so a bail-out is always survivable. */
  private enterPlane(plane: Plane): void {
    this.cover = undefined; this.activePlane = plane; plane.pilot = true;
    this.player.inVehicle = true; this.player.setVisible(false); this.player.group.position.copy(plane.group.position);
    if (this.inventory.parachutes < 1) { this.inventory.parachutes = 1; this.persist(); }
    this.audio.ui(true);
    this.ui.notify(plane.name, 'W/S throttle · ←/→ bank · ↓ pulls back to climb · A/D rudder · E bail out. A packed chute waits on the seat back.');
  }

  /** Flight tick: the plane flies itself through the pure step; E bails out mid-air (into the skydive) or
   *  climbs out on the ground once the roll has stopped; a crash hands the wreck to the tow-truck loop. */
  private updateFlying(dt: number): void {
    const plane = this.activePlane; if (!plane) return;
    const result = plane.updatePlayer(dt, this.input, this.city);
    this.player.group.position.copy(plane.group.position);
    this.player.heading = plane.state.heading;
    this.audio.setEngine(true, plane.state.speed, plane.state.throttle, PLANE_MAX_SPEED, 'plane');
    if (result.crashed) { this.crashActivePlane(plane, result.sink, result.speed); return; }
    if (this.input.consume('KeyE')) {
      if (!plane.state.grounded) this.bailOut(plane);
      else if (plane.state.speed <= PLANE_EXIT_SPEED) this.exitPlane(plane);
      else this.ui.notify('Still rolling', 'Brake with S before climbing out.', false);
    }
  }

  /** E mid-flight: out the door into the existing skydive — freefall at the plane's position and heading,
   *  SPACE deploys the seat-back chute. The pilotless plane flies on, bleeds off and comes down by itself. */
  private bailOut(plane: Plane): void {
    this.releasePlane();
    this.player.inVehicle = false; this.player.setVisible(true);
    const position = this.player.group.position; position.copy(plane.group.position);
    position.y = Math.max(this.city.surfaceHeightAt(position.x, position.z), position.y - 2.5); // drop clear of the airframe
    this.player.onGround = false; this.player.velocityY = 0;
    this.airborne = startAirborne(plane.state.heading, position.y);
    this.player.startSkydive();
    this.cameraController.pitch = 0.62;
    this.audio.setEngine(false);
    this.ui.notify('Geronimo!', this.inventory.parachutes > 0 ? 'SPACE deploys the parachute. W dives, S flattens, A/D steer.' : 'No parachute aboard. Good luck.', this.inventory.parachutes > 0);
  }

  /** Climbing out on the tar: step out under the wing, ringing outward if the stand is cluttered. */
  private exitPlane(plane: Plane): void {
    this.releasePlane();
    this.player.inVehicle = false; this.player.setVisible(true);
    const heading = plane.state.heading;
    const door = plane.group.position.clone().add(new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(3.2));
    const spot = safePlacement(door.x, door.z, (px, pz) => this.city.collides(px, pz, PLAYER.radius));
    this.player.group.position.set(spot.x, this.city.surfaceHeightAt(spot.x, spot.z), spot.z);
    this.player.velocityY = 0; this.player.onGround = true;
    this.audio.setEngine(false);
  }

  /** Hard arrival with the player aboard: the airframe is written off (towed back to the apron later), the
   *  pilot is thrown clear and billed for the impact — a full-speed stall-in is lethal without the cheat. */
  private crashActivePlane(plane: Plane, sink: number, speed: number): void {
    const at = plane.group.position.clone();
    plane.wreck(); this.releasePlane();
    this.audio.explosion(at.x, at.z); this.audio.setEngine(false);
    this.shake = Math.min(0.7, this.shake + 0.5);
    this.population.broadcastFear(at, FEAR_EVENTS.kill);
    this.player.inVehicle = false; this.player.setVisible(true);
    const spot = safePlacement(at.x + 4, at.z, (px, pz) => this.city.collides(px, pz, PLAYER.radius));
    this.player.group.position.set(spot.x, this.city.surfaceHeightAt(spot.x, spot.z), spot.z);
    this.player.velocityY = 0; this.player.onGround = true; this.player.resetAirbornePose(); this.player.tumble();
    this.damagePlayer(planeCrashDamage(sink, speed));
    this.ui.notify('Plane down', 'That was not a landing. The wreck gets towed back to the airfield just now.', false);
  }

  /** Pilotless aircraft keep living: a bailed plane stalls in and crashes, wrecks respawn at their stand. */
  private updatePlanes(dt: number): void {
    for (const plane of this.planes) {
      if (plane === this.activePlane) continue;
      const crash = plane.updateAmbient(dt, this.city);
      if (!crash) continue;
      this.audio.explosion(crash.x, crash.z);
      this.shake = Math.min(0.7, this.shake + 0.25);
      this.population.broadcastFear(new THREE.Vector3(crash.x, 0, crash.z), FEAR_EVENTS.kill);
    }
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
    return this.mode === 'playing' && !this.transition && !this.airborne && !this.activePlane && !this.weaponWheelOpen && scopeActive(this.input.aiming, this.combat.current, Boolean(this.activeVehicle));
  }

  /** Shared aftermath for a ranged player shot: witnesses, fear, gore, and drops — on foot or drive-by.
   *  Bullet weapons land here after time of flight, so the firing weapon rides along rather than reading `combat.current`. */
  private handleGunshot(shot: ShotResult, position: THREE.Vector3, weapon: WeaponId = this.combat.current): void {
    const fear = scopeWeapon(weapon) ? FEAR_EVENTS.sniperShot : FEAR_EVENTS.gunshot; // the rifle crack carries further than a pistol pop
    this.population.broadcastFear(position, fear); // the crack still scatters the street
    // This is Jozi: a shot that hits nobody is just noise to the public — no 911 call. But a cop who sees the shot
    // reacts on the spot (copOnly), so firing in front of JMPD is an instant wanted; hitting someone always reports.
    if (shot.victim) this.reportCrime(position, 7, { victims: [shot.victim], radius: fear.radius, cityEvent: !shot.victim.hostile && !shot.victim.police ? (shot.killed ? 'civilian-murder' : 'civilian-assault') : undefined, label: shot.killed ? 'murder' : 'gunfire' });
    else this.reportCrime(position, 7, { copOnly: true, label: 'gunfire' });
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

  /** A drunk driver can't hold the wheel steady: a mean-reverting random walk plus a slow lurch, scaled by how
   *  legless the player is, drifts the steer input so the car waves across the lane. Zero while sober; smoother
   *  and slower than the on-foot stagger. Steering only bites at speed, so a parked car sits still. */
  private drunkDriveSteer(dt: number): number {
    const drunk = inebriationFraction(this.player.inebriation);
    this.driveWander += (Math.random() - 0.5) * dt * 4;
    this.driveWander -= this.driveWander * dt * 1.6;
    this.driveWander = THREE.MathUtils.clamp(this.driveWander, -1, 1);
    this.driveWanderPhase += dt * (0.6 + drunk * 1.1);
    if (drunk <= 0) return 0;
    return (this.driveWander + Math.sin(this.driveWanderPhase) * 0.45) * drunk * 0.3;
  }

  private updateDriving(dt: number): void {
    const vehicle = this.activeVehicle; if (!vehicle) return;
    const speed = vehicle.updatePlayer(dt, this.input, this.city, this.driveSteer + this.drunkDriveSteer(dt)); this.player.group.position.copy(vehicle.group.position);
    if (!this.mouseSteerHintShown) { this.mouseSteerHintShown = true; this.ui.notify('Mouse steering', 'Hold Left-Click (when not aiming) to steer with the mouse.', false); }
    const driveBy = canFireFromVehicle(this.input.aiming, this.combat.spec.melee, Boolean(this.combat.spec.projectile), scopeWeapon(this.combat.current));
    if (vehicle.spec.twoWheeler) { // rider stays visible in the saddle — and wears no cocoon: hits land on the player
      const [saddleY, saddleZ] = vehicle.spec.saddle ?? [0.1, -0.2];
      this.player.group.position.add(new THREE.Vector3(Math.sin(vehicle.heading) * saddleZ, saddleY, Math.cos(vehicle.heading) * saddleZ));
      this.player.group.rotation.copy(vehicle.group.rotation);
      this.player.animateRiding(dt, vehicle.spec.kind, speed, driveBy, driveBy && this.input.firing);
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
      if (shot.fired) { this.player.registerShot(); this.muzzleFlash = MUZZLE_FLASH_SECONDS; }
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

  /** T between rides toggles AVAILABLE/OCCUPIED; T during a hail/ride cancels it and leaves the taxi OCCUPIED. */
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
    const detail = duty === 'occupied' ? 'Duty set to OCCUPIED. No new fares.'
      : this.wanted.isWanted ? "Duty is AVAILABLE — but no fares while the law's watching. Lose the heat first."
      : 'Duty is AVAILABLE — watch the curb for a raised arm.';
    this.ui.notify(duty === 'available' ? 'Taxi: AVAILABLE' : 'Taxi: OCCUPIED', detail, duty === 'available' && !this.wanted.isWanted);
  }

  /** Runs the hail -> board -> ride -> pay loop while the player drives a taxi. */
  private updateTaxiJob(dt: number, vehicle: Vehicle): void {
    const ride = this.taxiRide; const position = vehicle.group.position;
    if (ride.phase === 'idle') {
      this.taxiHailCooldown = Math.max(0, this.taxiHailCooldown - dt);
      if (this.taxiHailCooldown > 0 || ride.duty !== 'available' || vehicle.onFire || vehicle.disabled || this.wanted.isWanted) return; // nobody hails an off-duty, burning or police-chased taxi
      const candidate = this.population.pedestrians
        .filter((ped) => canHail(ped, ped.group.position.distanceTo(position)))
        .sort((a, b) => a.group.position.distanceToSquared(position) - b.group.position.distanceToSquared(position))[0];
      if (candidate && ride.hail()) { this.taxiHailPed = candidate; candidate.setHail(true); this.ui.notify('Fare spotted', 'Someone is flagging you down — stop at the curb beside them.'); }
      return;
    }
    const hail = this.taxiHailPed;
    if (ride.phase === 'hailed') {
      if (!hail || hail.state !== 'idle' || hail.group.position.distanceTo(position) > HAIL_RADIUS * 1.6) { this.cancelTaxi(true); return; }
      if (Math.abs(vehicle.speed) < STOP_SPEED && hail.group.position.distanceTo(position) <= PICKUP_RADIUS && ride.beginBoarding()) { hail.state = 'walk'; vehicle.setTaxiLight(ride.available); } // fare inbound: duty auto-switches to occupied
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
    this.taxiRide.reset(); this.taxiDestination = undefined; vehicle.setTaxiLight(this.taxiRide.available); this.persist(); // back on the clock: AVAILABLE returns
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

  /** Ends any hail/ride without payment: the hailer drops the arm, a boarded passenger climbs out where the taxi stands. */
  private cancelTaxi(quiet = true): void {
    if (this.taxiHailPed) { this.taxiHailPed.setHail(false); this.taxiHailPed = undefined; }
    if (this.taxiPassenger) {
      const vehicle = this.activeVehicle ?? this.transition?.vehicle;
      this.disembarkPassenger(vehicle?.group.position ?? this.player.group.position, vehicle?.heading ?? 0, false);
      if (!quiet) this.ui.notify('Ride cancelled', 'The passenger climbs out, unpaid and unimpressed.', false);
    }
    this.taxiRide.reset(); this.taxiDestination = undefined;
  }

  /** Off shift entirely: end any ride and return duty to OCCUPIED (exit, store, wreck, respawn, new game). */
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
    this.updateDialogueAbandon();
    this.updateContactPresence(dt);
    const objective = this.missions.objective;
    if (this.missions.state === 'active' && objective?.vehicleColor) {
      const requiredVehicle = this.findMissionVehicle(undefined, objective.vehicleColor);
      if (requiredVehicle?.disabled) { this.processMissionUpdate(this.missions.fail(`${requiredVehicle.spec.name} was destroyed`)); return; }
    }
    this.updateQuarry(dt);
    this.updateDepot(dt);
    if (this.missions.active?.id === 'hot-property' && objective?.kind === 'enter-kind' && this.activeVehicle?.spec.kind === 'sport' && this.activeVehicle.spec.color === 0xd83a40) this.forceWanted(2);
    const target = this.missionTargetRaw(); const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    if (dt > 0 && this.lastFocus) this.focusSpeed = Math.min(80, Math.hypot(focus.x - this.lastFocus.x, focus.z - this.lastFocus.z) / dt);
    (this.lastFocus ??= new THREE.Vector3()).copy(focus);
    const reached = objective?.streetName
      ? this.onNamedStreet(objective.streetName, focus.x, focus.z) // street-answer riddle: the whole road corridor triggers
      : Boolean(target && focus.distanceTo(target.position) < (objective?.radius ?? (objective?.hidden ? 20 : objective?.kind === 'escape' ? 12 : 8)));
    if (objective?.kind === 'checkpoints' && reached) {
      const stopIndex = this.deliveryIndex;
      const stopObjective = this.missions.objectiveIndex; // captured BEFORE the register: the final stop advances the index
      const missionId = this.missions.active?.id ?? '';
      const result = this.missions.registerCheckpoint(); this.deliveryIndex += 1;
      for (const wave of MISSION_SCRIPTS[missionId]?.waves ?? []) if (wave.objective === stopObjective && wave.checkpoint === stopIndex) this.population.spawnHostileWave(wave.spots);
      this.processMissionUpdate(result);
    }
    const result = this.missions.update(dt, this.buildMissionSnapshot(focus), reached);
    this.processMissionUpdate(result);
    const current = `${this.missions.active?.id ?? ''}:${this.missions.objectiveIndex}`;
    if (current !== this.previousObjective) {
      this.previousObjective = current;
      this.hostileDefeated = 0; // defeat counters are per-objective, not per-mission
      this.collectedItem = false;
      this.objectiveElapsed = 0; this.hintsFired.clear(); this.riddleRevealed = false;
      this.followElapsed = 0; this.followCapFired = false;
      this.runObjectiveBeats();
      if (this.missions.objective) this.ui.notify('Objective updated', this.missions.objective.text);
    }
    // Marker truth lives in the sim step, not the render loop: the frame a mission starts or an
    // objective advances, the gold marker and minimap blip already point at the new target
    // (owner playtest: accepting Couch Run left the marker on Portia instead of the Golf).
    this.markerTarget = this.currentTarget();
    this.objectiveElapsed += dt;
    this.updateRiddleHints();
    if (this.missionPassedTimer > 0) { this.missionPassedTimer -= dt; if (this.missionPassedTimer <= 0) this.missionPassedView = undefined; }
  }

  /** Riddle fail-softs: a generous minimap search circle around the answer (offset centre so the
   *  circle never pinpoints it), and hints that sharpen on a clock — the final hint drops a real
   *  blip (owner: markerless one-liners against a whole city are hostile; deduction stays, despair goes). */
  /** Aboard-a-train guidance for the objective card (owner: "wtf am I supposed to do?" on a train).
   *  Tells the rider the next stop, the stops-to-destination, or that they boarded the wrong way. */
  private trainRideHint(): string {
    if (this.online || !this.trains.riding) return '';
    const objective = this.missions.objective;
    if (!objective?.conditions?.onTrain && !objective?.conditions?.drivingTrain) return '';
    const dest = objective.conditions?.stationName;
    const guide = this.trains.rideGuidance(dest);
    if (!guide) return '';
    if (guide.wrong) return ' — Wrong way: get off at the next stop and catch one going back';
    const shortDest = dest?.replace('Johannesburg ', '');
    if (guide.toDest != null && shortDest) return ` — Next stop: ${guide.next ?? shortDest}. ${shortDest} in ${guide.toDest} stop${guide.toDest > 1 ? 's' : ''}`;
    if (guide.next) return ` — Next stop: ${guide.next}. Stay aboard`;
    return ' — Arriving: this is your stop';
  }

  /** Is (x,z) within a lane's width of the named street's road polyline? The trigger for a riddle
   *  whose answer is a whole street — the owner walked all over Fax Street and a single dot never fired.
   *  Same name source as the generated street signs, so the sign the player reads IS the trigger. */
  private onNamedStreet(name: string, x: number, z: number, tol = 14): boolean {
    for (const road of ROAD_NETWORK) {
      if (road.name !== name) continue;
      const pts = road.points;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1]!.x, az = pts[i - 1]!.z, bx = pts[i]!.x, bz = pts[i]!.z;
        const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
        if (Math.hypot(x - (ax + t * dx), z - (az + t * dz)) <= tol) return true;
      }
    }
    return false;
  }

  private riddleSearchArea(): { x: number; z: number; radius: number } | undefined {
    const objective = this.missions.objective;
    if (!objective?.hidden || !objective.target || this.missions.state !== 'active') return undefined;
    if (this.riddleRevealed) return undefined; // final hint escalated to an exact blip
    const seed = `${this.missions.active?.id}:${this.missions.objectiveIndex}`;
    let hash = 0; for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const angle = (hash % 628) / 100; const offset = 90 + (Math.abs(hash >> 4) % 80);
    return { x: objective.target.position.x + Math.sin(angle) * offset, z: objective.target.position.z + Math.cos(angle) * offset, radius: 300 };
  }

  /** Hint escalation: fires each script hint once per objective when its clock passes (re-briefs also escalate). */
  private updateRiddleHints(): void {
    const mission = this.missions.active;
    if (!mission || this.missions.state !== 'active') return;
    const hints = MISSION_SCRIPTS[mission.id]?.hints ?? [];
    for (let index = 0; index < hints.length; index++) {
      const hint = hints[index]!;
      if (hint.objective !== this.missions.objectiveIndex || this.hintsFired.has(index) || this.objectiveElapsed < hint.afterSeconds) continue;
      this.hintsFired.add(index);
      this.ui.notify(mission.contact, hint.detail, true, 'radio');
      if (hint.reveal) this.riddleRevealed = true; // the final mercy: an exact blip
    }
  }

  /** Scripted events keyed to the objective the mission just entered (waves, quarry spawn/departure). */
  private runObjectiveBeats(): void {
    const mission = this.missions.active;
    if (!mission || this.missions.state !== 'active') return;
    const script = MISSION_SCRIPTS[mission.id];
    const index = this.missions.objectiveIndex;
    for (const wave of script?.waves ?? []) if (wave.objective === index && wave.checkpoint === undefined) this.population.spawnHostileWave(wave.spots);
    if (script?.forceBlackout === index && !this.loadShedding.active) this.applyEskom(this.loadShedding.force());
    if (script?.wanted?.objective === index) this.forceWanted(script.wanted.level);
    if (script?.grantParachute === index) this.inventory.parachutes = Math.max(1, this.inventory.parachutes);
    for (const beat of script?.radio ?? []) if (beat.objective === index) this.ui.notify(beat.title, beat.detail, true, 'radio');
    if (script?.alarm && script.alarm.objective === index) {
      // Evaluated once, diegetically: mains up means the showroom screams; a blackout means it can't.
      const dead = this.dayNight.blackoutDarkness >= DEPOT_DARK_THRESHOLD;
      if (dead) this.ui.notify(script.alarm.silentTitle, script.alarm.silentDetail, true, 'reputation');
      else { this.forceWanted(script.alarm.level); this.ui.notify(script.alarm.title, script.alarm.detail, false); }
    }
    const quarry = script?.quarry;
    if (!quarry) return;
    if (index >= quarry.spawnObjective && !this.quarry) {
      this.quarry = this.population.spawnScriptVehicle(quarry.kind as VehicleKind, quarry.spawn.x, quarry.spawn.z, quarry.spawn.heading, quarry.color);
      this.quarryArrived = false;
    }
    if (quarry.departObjective !== undefined && index >= quarry.departObjective && quarry.destination && this.quarry && !this.quarryArrived) this.population.routeVehicleTo(this.quarry, quarry.destination.x, quarry.destination.z);
    if (quarry.igniteObjective === index && this.quarry && !this.quarry.onFire) this.quarry.ignite();
  }

  /** Kelvin Yard security tick (Dark House): the pure DepotSecurity verdict feeds the mission snapshot. */
  private updateDepot(dt: number): void {
    const script = MISSION_SCRIPTS[this.missions.active?.id ?? ''];
    if (!script?.depot || this.missions.state !== 'active') { this.depotWasSpotted = false; return; }
    this.depotClock += dt;
    const focus = this.player.group.position;
    const insideFence = Math.hypot(focus.x - KELVIN_YARD_CENTER.x, focus.z - KELVIN_YARD_CENTER.z) < KELVIN_FENCE_RADIUS;
    const dark = depotDark(this.dayNight.blackoutFactor, nightFactor(this.dayNight.hour) > 0.5);
    // The two posted guards sweep their torches like slow turrets; a downed guard sweeps nothing.
    const guards = this.yardGuards.filter((guard) => guard.state !== 'down').map((guard, index) => {
      const base = Math.atan2(KELVIN_OFFICE_SPOT.x - guard.group.position.x, KELVIN_OFFICE_SPOT.z - guard.group.position.z) + Math.PI; // face outward from the office
      const heading = base + Math.sin(this.depotClock * 0.5 + index * 2.1) * 1.2;
      guard.group.rotation.y = heading;
      return { x: guard.group.position.x, z: guard.group.position.z, heading };
    });
    const seen = dark && guards.some((guard) => guardSees(guard, focus.x, focus.z));
    const cone = (vehicle: Vehicle) => vehicle.headlightsOn && inHeadlightCone(vehicle.group.position.x, vehicle.group.position.z, vehicle.heading, focus.x, focus.z);
    const verdict = this.depotSecurity.update(dt, {
      insideFence, playerX: focus.x, playerZ: focus.z,
      blackout: this.dayNight.blackoutFactor, isNight: nightFactor(this.dayNight.hour) > 0.5,
      torchOn: this.torch.on, muzzleFlash: this.muzzleFlash,
      headlights: [...this.population.vehicles, ...this.police.vehicles].filter(cone).map((vehicle) => ({ x: vehicle.group.position.x, z: vehicle.group.position.z, heading: vehicle.heading })),
      guardSees: seen,
    });
    const spotted = verdict === 'spotted';
    this.missionContext.detected = spotted;
    if (spotted && !this.depotWasSpotted) {
      this.audio.ui(false);
      if (!dark) { this.forceWanted(4); this.ui.notify('Kelvin Yard', 'Klaxons. Every floodlight in the yard finds you at once.', false); }
      else this.ui.notify('Kelvin Yard', 'A torch beam stops dead on you. Then the shouting starts.', false);
      this.forceWanted(Math.max(2, this.wanted.level));
    }
    this.depotWasSpotted = spotted;
  }

  /** Per-frame follow feed: distance to the quarry, arrival at its mark, and whether it survives.
   *  A successful tail COMPLETES after followCapSeconds — the low-agency crawl converts into a
   *  free-drive reach with an in-fiction beat (owner: no follow may outstay ~90s of wall time). */
  private updateQuarry(dt: number): void {
    const quarry = this.quarry;
    const script = MISSION_SCRIPTS[this.missions.active?.id ?? '']?.quarry;
    if (!quarry || !script || this.missions.state !== 'active') return;
    const position = quarry.group.position;
    if (!this.quarryArrived && script.destination && Math.hypot(position.x - script.destination.x, position.z - script.destination.z) < (script.arriveRadius ?? 20)) {
      this.quarryArrived = true;
      this.population.parkScriptVehicle(quarry);
    }
    if (this.missions.objective?.kind !== 'follow') return;
    this.missionContext.escortAlive = !quarry.disabled;
    const focus = this.activeVehicle?.group.position ?? this.player.group.position;
    const distance = Math.hypot(position.x - focus.x, position.z - focus.z);
    this.missionContext.followDistance = distance;
    const strayLimit = (this.missions.objective.failIf ?? []).find((rule) => rule.kind === 'strayed');
    if (!quarry.disabled && (!strayLimit || distance <= strayLimit.value)) this.followElapsed += dt;
    if (script.followCapSeconds && this.followElapsed >= script.followCapSeconds && !this.followCapFired) {
      this.followCapFired = true;
      if (script.followCapNote) this.ui.notify(script.followCapNote.title, script.followCapNote.detail, true, 'radio');
    }
    this.missionContext.followArrived = this.quarryArrived || this.followCapFired;
  }

  /** Snapshot for the pure mission engine: combat/vehicle facts plus story context and any script overlay. */
  private buildMissionSnapshot(focus: THREE.Vector3): GameSnapshot {
    const objective = this.missions.objective;
    const requiredVehicle = objective?.vehicleColor ? this.findMissionVehicle(undefined, objective.vehicleColor) : undefined;
    const missionVehicle = requiredVehicle ?? this.activeVehicle;
    return {
      playerPosition: focus, inVehicle: Boolean(this.activeVehicle), vehicleKind: this.activeVehicle?.spec.kind, vehicleColor: this.activeVehicle?.spec.color,
      wantedLevel: this.wanted.level, shotsFired: this.combat.shotsFired, hostileDefeated: this.population.defeatedHostiles(), collectedItem: this.collectedItem,
      hour: this.dayNight.hour, blackout: this.dayNight.blackoutFactor, isNight: nightFactor(this.dayNight.hour) > 0.5,
      onTrain: this.trains.riding, drivingTrain: this.trains.driving, trainSpeed: this.trains.rideSpeedKph / 3.6, stationName: this.trains.currentStationName,
      inPlane: Boolean(this.activePlane),
      altitude: this.activePlane ? Math.max(0, this.activePlane.group.position.y - this.city.surfaceHeightAt(this.activePlane.group.position.x, this.activePlane.group.position.z))
        : this.airborne ? Math.max(0, this.player.group.position.y - this.city.supportHeight(focus.x, focus.z, this.player.group.position.y)) : undefined,
      parachuted: this.airborne ? this.airborne.mode === 'parachute' : undefined,
      playerSpeed: this.trains.driving ? this.trains.rideSpeedKph / 3.6 : this.activeVehicle ? Math.abs(this.activeVehicle.speed) : this.focusSpeed,
      vehicleHealthPct: missionVehicle ? missionVehicle.health / missionVehicle.maxHealth : undefined,
      torchOn: this.torch.on,
      ...this.missionContext,
    };
  }

  /** E while a dialogue card shows: step it; finishing an intro exchange accepts the offered mission. */
  private advanceDialogue(): boolean {
    if (!this.dialogue.active) return false;
    if (this.dialogue.advance() === 'finished') {
      const offered = this.story.acceptOffer();
      if (offered) { this.resetMissionRuntime(); this.missions.start(offered); }
    }
    this.audio.ui(true);
    return true;
  }

  /** Walking away from the contact mid-exchange declines the offer (or drops a re-stated riddle). */
  private updateDialogueAbandon(): void {
    if (!this.dialogue.active) return;
    const pendingId = this.story.pendingOffer;
    const anchor = pendingId ? MISSIONS.find((item) => item.id === pendingId)?.start : this.missions.active?.start;
    if (!anchor) return;
    const position = this.player.group.position;
    if (Math.hypot(anchor.position.x - position.x, anchor.position.z - position.z) > 12) {
      const declined = pendingId ? MISSIONS.find((item) => item.id === pendingId) : undefined;
      this.dialogue.abandon(); this.story.abandonOffer();
      // A silent decline reads as "mission started but no marker" — say it out loud (owner playtest, Couch Run).
      if (declined) this.ui.notify('Job declined', `You walked out on ${declined.contact}. The offer stands — go back and hear them out.`, false);
    }
  }

  /** A contact with nothing left to offer leaves the corner (owner steer: "if it's done, she
   *  probably shouldn't even be there any more"). Locked-but-pending missions keep them around;
   *  visibility flips back if a fresh game resets completions. Cheap 1.5s cadence. */
  private updateContactPresence(dt: number): void {
    this.contactCullTimer -= dt;
    if (this.contactCullTimer > 0) return;
    this.contactCullTimer = 1.5;
    for (const ped of this.population.pedestrians) {
      if (!ped.contact || ped.carGuard) continue; // car guards and yard security are contact-flagged but not mission givers
      const name = ped.group.name;
      ped.group.visible = MISSIONS.some((mission) => mission.contact === name && !this.missions.completed.has(mission.id));
    }
  }

  /** What E would actually do at the player's position — the prompt and the key MUST agree
   *  (owner playtest: "E Speak to contact" showed during an active mission and E did nothing).
   *  During their own active mission the contact re-briefs: the intro replays plus the current
   *  objective, "in case you need reminding what you were supposed to do" (owner amendment). */
  private contactAction(): { kind: 'offer'; mission: MissionDefinition } | { kind: 'rebrief'; mission: MissionDefinition } | undefined {
    if (this.dialogue.active) return undefined;
    const position = this.player.group.position;
    if (this.missions.active) {
      const active = this.missions.active;
      if (this.missions.state === 'active' && Math.hypot(active.start.position.x - position.x, active.start.position.z - position.z) < 7) return { kind: 'rebrief', mission: active };
      return undefined;
    }
    const mission = MISSIONS.find((item) => !this.missions.completed.has(item.id) && this.story.isUnlocked(item, this.missions.completed) && Math.hypot(item.start.position.x - position.x, item.start.position.z - position.z) < 7);
    return mission ? { kind: 'offer', mission } : undefined;
  }

  /** Prompt copy for whatever E would do at a contact: a fresh offer, a riddle re-state, or a job re-brief. */
  private contactPrompt(): string | undefined {
    const action = this.contactAction();
    if (!action) return undefined;
    if (action.kind === 'offer') return 'E  Speak to contact';
    return this.missions.objective?.hidden ? 'E  Ask for the riddle again' : 'E  Ask about the job';
  }

  private tryMissionInteraction(): boolean {
    if (this.missions.state === 'failed' && this.missions.active) { this.resetMissionRuntime(); this.missions.restart(); this.ui.notify('Mission restarted', this.missions.active?.name ?? ''); return true; }
    if (this.missions.objective?.kind === 'collect') return false;
    if (this.missions.objective?.kind === 'choice') {
      this.mode = 'paused'; document.exitPointerLock(); this.ui.showMissionChoice(this.missions.active?.name ?? 'Choose', this.missions.objective.choices ?? []); return true;
    }
    const action = this.contactAction();
    if (!action) return false;
    if (action.kind === 'rebrief') {
      // Same lines as the briefing, ending on the live objective; no offer is pending, so
      // finishing (or walking away from) the replay arms nothing and pays nothing.
      const objective = this.missions.objective;
      const lines = [...introScript(action.mission).lines];
      if (objective) lines.push({ speaker: action.mission.contact, text: objective.text });
      this.dialogue.start({ id: `${action.mission.id}:rebrief`, lines });
      return true;
    }
    this.story.beginOffer(action.mission.id);
    this.dialogue.start(introScript(action.mission));
    return true;
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
    const killed = victim.takeDamage(34, this.player.group.position); this.reportCrime(this.player.group.position, killed ? 24 : 16, { victims: [victim], radius: (killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault).radius, cityEvent: !victim.hostile && !victim.police ? (killed ? 'civilian-murder' : 'civilian-assault') : undefined, label: killed ? 'murder' : 'assault' }); this.population.broadcastFear(this.player.group.position, killed ? FEAR_EVENTS.kill : FEAR_EVENTS.assault);
    this.gore.burst(victim.group.position.clone().add(new THREE.Vector3(0, 1.05, 0)), killed ? 1.2 : 0.72, killed); this.audio.melee();
    this.audio.splat(killed ? 1 : 0.6, victim.group.position.x, victim.group.position.z); this.audio.scream('pain', victim.group.position.x, victim.group.position.z);
    if (killed) this.spawnDrops(victim);
  }

  /** Live blackout-stealth verdict at a world point: concealed only in deep night-time load shedding with no
   *  torch, no fresh muzzle flash, no lit ride under the player, and no live headlight cone catching them. */
  private isConcealed(px: number, pz: number): boolean {
    if (this.online || this.dayNight.blackoutDarkness <= BLACKOUT_STEALTH_THRESHOLD) return false; // grid up, daylight, or ramp still fading: no dark to hide in
    const cone = (vehicle: Vehicle) => vehicle.headlightsOn && inHeadlightCone(vehicle.group.position.x, vehicle.group.position.z, vehicle.heading, px, pz);
    return concealedInBlackout(this.dayNight.blackoutDarkness, this.torch.on || this.muzzleFlash > 0 || Boolean(this.activeVehicle?.headlightsOn) || this.population.vehicles.some(cone) || this.police.vehicles.some(cone));
  }

  /** Files a crime with JMPD using only what the world could actually see: a cop nearby means immediate heat
   *  and a sighting; otherwise a surviving victim or a living bystander within radius phones it in after
   *  REPORT_DELAY (stars land when the report matures); nobody left alive means no report at all. */
  private reportCrime(position: THREE.Vector3, heat: number, options: { victims?: Pedestrian[]; radius?: number; copWitnessed?: boolean; copOnly?: boolean; cityEvent?: CityEvent['kind']; label: CrimeLabel }): void {
    if (options.cityEvent) this.recordCityEvent(options.cityEvent, position);
    if (this.taxiRide.phase === 'riding' && this.activeVehicle && position.distanceTo(this.activeVehicle.group.position) < GUNFIRE_FEAR_RADIUS) this.taxiRide.frighten(heat * GUNFIRE_FEAR_SCALE); // violence near the taxi spooks the passenger
    // A concealed-in-blackout player commits crimes unseen: proximity cops don't witness what they can't make
    // out (a muzzle flash lights the shooter first, so gunfire near JMPD is still caught in the act), but a
    // directly-affected cop (copWitnessed, e.g. one you shot) always knows, and civilian phone-ins run as usual.
    const copSaw = options.copWitnessed
      || (!this.isConcealed(position.x, position.z) && (this.police.vehicles.some((unit) => !unit.wrecked && unit.group.position.distanceTo(position) < SIGHT_RADIUS)
        || this.population.pedestrians.some((ped) => ped.police && ped.state !== 'down' && ped.group.position.distanceTo(position) < SIGHT_RADIUS)));
    if (copSaw) { this.wanted.addCrime(heat); this.wanted.reportSeen(); this.knowledge.copWitness(position.x, position.z); this.radioDispatch(options.label, position.x, position.z, true); return; }
    if (options.copOnly) return; // only a cop who saw it counts (e.g. a shot that hit no one): civilians don't phone it in
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

  private openBottleStore(name: string): void {
    this.activeBottleStore = name;
    this.mode = 'paused'; this.closeWeaponWheel(); this.audio.setEngine(false); document.exitPointerLock();
    this.renderBottleStore();
  }

  private renderBottleStore(): void {
    const entries = DRINKS.map((drink) => ({
      id: drink.id, name: drink.name, note: drink.note, price: drink.price, potency: drink.potency,
      canBuy: resolveDrinkPurchase(drink, this.economy.balance, this.player.inebriation).ok,
    }));
    this.ui.showBottleStore(this.activeBottleStore, entries, this.economy.balance, this.player.inebriation);
  }

  private buyDrink(id: DrinkId): void {
    const drink = DRINK_BY_ID[id];
    const result = resolveDrinkPurchase(drink, this.economy.balance, this.player.inebriation);
    if (!result.ok || !this.economy.spend(result.price)) { this.audio.ui(false); this.renderBottleStore(); return; }
    this.player.inebriation = applyDrink(this.player.inebriation, drink);
    this.livingCity.apply({ kind: 'shop-purchase', district: CBD }); this.audio.pickup();
    if (drink.potency < 0) this.ui.notify(drink.name, `Aaah, that clears the head. -R${result.price}`);
    else this.ui.notify(drink.name, `${this.player.inebriation >= INEBRIATION_MAX ? 'Totaal gedrink. Careful now.' : 'Down the hatch. Lekker.'} -R${result.price}`);
    this.persist(); this.renderBottleStore();
  }

  /** Per-frame dop tick: sober up with elapsed time, then apply the drunk health advantage (a slow heal through
   *  the merry band) or its blackout penalty (a mild drain, floored so booze alone can't put you down). */
  private updateInebriation(dt: number): void {
    if (this.player.inebriation <= 0) return;
    this.player.inebriation = decayInebriation(this.player.inebriation, dt);
    const delta = drunkHealthDelta(this.player.inebriation, this.player.health, dt);
    if (delta > 0) this.player.health = Math.min(this.player.maxHealth, this.player.health + delta);
    else if (delta < 0 && !this.cheats.invulnerable) this.player.health = Math.max(0, this.player.health + delta);
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
    this.scene.remove(vehicle.group); vehicle.dispose();
    const index = this.population.vehicles.indexOf(vehicle); if (index >= 0) this.population.vehicles.splice(index, 1);
    const trafficIndex = this.population.traffic.indexOf(vehicle); if (trafficIndex >= 0) this.population.traffic.splice(trafficIndex, 1);
    this.garageVehicle = undefined;
  }

  private processMissionUpdate(update: MissionUpdate): void {
    if (update.failed) { this.audio.ui(false); this.ui.notify('Mission failed', `${update.failed}. Press E to restart.`, false); }
    if (update.choice) {
      const { missionId, choice } = update.choice;
      this.story.onChoice(missionId, choice.id);
      if (missionId === 'arms-deal') {
        const protectedShop = choice.id === 'protect';
        this.livingCity.apply({ kind: protectedShop ? 'mission-protected' : 'mission-robbed', district: CBD });
        this.economy.earn(choice.reward);
        if (!protectedShop) { this.combat.addAmmo(); this.combat.addAmmo(); this.forceWanted(2); }
        this.audio.ui(true); this.ui.notify('The CBD will remember', protectedShop
          ? `Jozi Arms is safe · trusted status · 20% discount · +R${choice.reward.toLocaleString()}`
          : `Shipment taken · notorious status · ammo secured · +R${choice.reward.toLocaleString()}`, protectedShop);
      } else {
        this.economy.earn(choice.reward);
        this.audio.ui(true); this.ui.notify('The word is given', `${choice.label} · +R${choice.reward.toLocaleString()}`);
      }
    } else if (update.completed) { this.celebrateMission(update.completed); }
    if (update.completed) {
      for (const flag of this.story.onMissionCompleted(update.completed)) if (flag.startsWith('act')) this.ui.notify('Word travels', 'New contacts will hear your name now.', true, 'reputation');
      const outro = MISSION_SCRIPTS[update.completed.id]?.outro;
      if (outro?.length) this.dialogue.start({ id: `${update.completed.id}:outro`, lines: outro });
      const page = MISSION_SCRIPTS[update.completed.id]?.diaryPage;
      if (page !== undefined && this.story.collectDiaryPage(page)) this.ui.notify('Grid Diary', `Page ${page} of 12 — someone planned all of this.`, true, 'reputation');
      this.quarry = undefined; this.quarryArrived = false; // a parked quarry stays where it arrived
      if (update.completed.id === 'the-switch') this.settleStageSix();
      this.persist();
    }
  }

  /** Mission complete: pay the base cash, apply extra payback (keepable car, weapon, standing) and
   *  raise the GTA-style MISSION PASSED card with an itemized reward list (owner: 'give them something
   *  in return for the work', celebrate it — not a 4-second toast). */
  private celebrateMission(mission: MissionDefinition): void {
    this.economy.earn(mission.reward);
    this.audio.ui(true);
    const items: string[] = [`R${mission.reward.toLocaleString()} cash`];
    const rewards = MISSION_SCRIPTS[mission.id]?.rewards;
    if (rewards?.weapon) { const result = this.combat.grantWeapon(rewards.weapon); items.push(`${WEAPON_BY_ID[rewards.weapon].name}${result === 'ammo' ? ' ammo' : ''}`); }
    if (rewards?.grantVehicle) { this.grantGarageVehicle(rewards.grantVehicle.kind as VehicleKind, rewards.grantVehicle.color); items.push(`${VEHICLE_SPECS[rewards.grantVehicle.kind as VehicleKind].name} (garaged)`); }
    if (rewards?.armour) { this.inventory.armour = Math.min(ARMOUR_MAX, this.inventory.armour + rewards.armour); items.push(`Body armour +${rewards.armour}`); }
    if (rewards?.standing) { this.livingCity.district(CBD).communityStanding = Math.min(100, this.livingCity.district(CBD).communityStanding + rewards.standing); items.push(`Street respect +${rewards.standing}`); }
    if (rewards?.note) items.push(rewards.note);
    this.missionPassedView = { name: mission.name, items };
    this.missionPassedTimer = 6.5;
  }

  /** Hand the player a permanent vehicle in the garage (mission reward). Replaces any stored car. */
  private grantGarageVehicle(kind: VehicleKind, color: number): void {
    if (this.garageVehicle) this.removeGarageVehicle();
    this.save.garage = { kind, color, health: VEHICLE_SPECS[kind].health };
    this.restoreGarageVehicle();
  }

  /** Finale epilogue: the branch decides what the city remembers about the grid — and about you. */
  private settleStageSix(): void {
    const throne = this.story.flags.has('choice:two-fires:solly');
    this.livingCity.apply({ kind: throne ? 'grid-sold' : 'grid-defended', district: CBD });
    this.dialogue.start({ id: 'stage-six-epilogue', lines: throne ? [
      { speaker: 'Lieutenant Mo', text: 'The feeder holds. The Genny King is a story taxi drivers tell. Long live the King.' },
      { speaker: 'You', text: 'Get the gennies on the trucks. The city still needs light — and light still needs a salesman.' },
    ] : [
      { speaker: 'Sindi', text: 'The feeder holds. The docket is filed. The cartel is a carcass, and you got fat off it.' },
      { speaker: 'You', text: 'And the lights stay on.' },
      { speaker: 'Sindi', text: 'Until the next chancer reads the fault logs. Keep the burner charged.' },
    ] });
  }

  private resetMissionRuntime(): void {
    this.deliveryIndex = 0; this.collectedItem = false; this.hostileDefeated = 0; this.previousObjective = ''; this.missionContext = {};
    const script = MISSION_SCRIPTS[this.missions.active?.id ?? ''];
    if (script?.vehicle) {
      const vehicle = this.findMissionVehicle(undefined, script.vehicle.color);
      if (vehicle) {
        vehicle.restore();
        vehicle.heading = script.vehicle.spot.heading;
        vehicle.reset(new THREE.Vector3(script.vehicle.spot.x, 0, script.vehicle.spot.z), this.city);
      }
    }
    if (this.quarry) { this.population.removeVehicle(this.quarry); this.quarry = undefined; this.quarryArrived = false; }
    this.depotSecurity.reset(); this.depotWasSpotted = false;
  }

  /** The nearest uncollected Grid Diary page within reach of the player, if any. */
  private nearbyDiaryPage(): { page: number; x: number; z: number } | undefined {
    const position = this.player.group.position;
    return DIARY_WORLD_PAGES.find((entry) => !this.story.diaryPages.has(entry.page) && Math.hypot(entry.x - position.x, entry.z - position.z) < 5);
  }

  /** E on a torn page: pocket it, show its line of the planner's story, pay the stash when the set completes. */
  private tryDiaryPickup(): boolean {
    const entry = this.nearbyDiaryPage();
    if (!entry || !this.story.collectDiaryPage(entry.page)) return false;
    this.audio.ui(true);
    this.ui.notify(`Grid Diary — page ${entry.page} of 12`, DIARY_TEXTS[entry.page] ?? '', true, 'reputation');
    if (this.story.diaryComplete) { this.economy.earn(DIARY_STASH_REWARD); this.ui.notify('The planner\'s stash', `${DIARY_STASH_NOTE} +R${DIARY_STASH_REWARD.toLocaleString()}`); }
    this.persist();
    return true;
  }

  /** Mission vehicles resolve to parked/scripted cars first — ambient traffic that happens to share
   *  the paint colour must never steal the blip or the destroyed-check (owner playtest, Hot Copper). */
  private findMissionVehicle(kind: string | undefined, color: number | undefined): Vehicle | undefined {
    const matches = this.population.vehicles.filter((item) => (!kind || item.spec.kind === kind) && (!color || item.spec.color === color));
    return matches.find((item) => !this.population.traffic.includes(item)) ?? matches[0];
  }

  /** The active objective's real-world target, blip or not — hidden riddles still need reach checks. */
  private missionTargetRaw(): WorldTarget | undefined {
    const objective = this.missions.objective;
    if (!objective) return undefined;
    if (objective.kind === 'checkpoints') {
      const stops = MISSION_SCRIPTS[this.missions.active?.id ?? '']?.stops ?? [];
      const stop = stops[Math.min(this.deliveryIndex, stops.length - 1)];
      return stop ? { position: new THREE.Vector3(stop.x, this.city.roadHeightAt(stop.x, stop.z), stop.z), label: `Stop ${this.deliveryIndex + 1}`, color: '#f5c451' } : undefined;
    }
    if (objective.target) { const position = objective.target.position.clone(); position.y = this.city.surfaceHeightAt(position.x, position.z); return { ...objective.target, position }; }
    return undefined;
  }

  private currentTarget(): WorldTarget | undefined {
    if (this.online) {
      const onlineTarget = this.online.objective?.target;
      return onlineTarget ? { position: new THREE.Vector3(onlineTarget.x, this.city.surfaceHeightAt(onlineTarget.x, onlineTarget.z), onlineTarget.z), label: onlineTarget.label, color: onlineTarget.color } : undefined;
    }
    if (this.missions.state === 'failed' && this.missions.active) {
      // The failure card says "find the gold beacon to retry" — the beacon must therefore lead home.
      const start = this.missions.active.start;
      const position = start.position.clone(); position.y = this.city.surfaceHeightAt(position.x, position.z);
      return { position, label: `Retry: ${this.missions.active.name}`, color: '#e3533f' };
    }
    if (this.taxiDestination) return { position: this.taxiDestination, label: 'Drop-off', color: '#7fe08d' }; // active fare outranks mission breadcrumbs
    if (this.courierJob.phase === 'collecting') return { position: new THREE.Vector3(COURIER_DEPOT.x, this.city.roadHeightAt(COURIER_DEPOT.x, COURIER_DEPOT.z), COURIER_DEPOT.z), label: 'Sixty-Sekonds dispatch', color: '#84f01c' };
    if (this.courierDestination) return { position: this.courierDestination, label: `Order ${this.courierJob.completed + 1}`, color: '#84f01c' };
    const objective = this.missions.objective;
    if (objective?.hidden && !this.riddleRevealed) return undefined; // riddles: search circle + hints, exact blip only after the final hint
    if (objective?.kind === 'follow' && this.quarry) return { position: this.quarry.group.position, label: 'The bakkie', color: '#e8a13d' };
    const raw = this.missionTargetRaw();
    if (raw) return raw;
    if (!this.missions.active) {
      let nearest: (typeof MISSIONS)[number] | undefined; let nearestDistance = Infinity;
      for (const mission of MISSIONS) {
        if (this.missions.completed.has(mission.id) || !this.story.isUnlocked(mission, this.missions.completed)) continue;
        const distance = (mission.start.position.x - this.player.group.position.x) ** 2 + (mission.start.position.z - this.player.group.position.z) ** 2;
        if (distance < nearestDistance) { nearest = mission; nearestDistance = distance; }
      }
      if (nearest) { const position = nearest.start.position.clone(); position.y = this.city.surfaceHeightAt(position.x, position.z); return { ...nearest.start, position }; }
      return undefined;
    }
    if (objective?.kind === 'enter-kind') {
      const vehicle = this.findMissionVehicle(objective.vehicleKind, objective.vehicleColor);
      if (vehicle) return { position: vehicle.group.position, label: vehicle.spec.name, color: '#65d8ff' };
    }
    return undefined;
  }

  /** LMB-drag mouse steering: while a non-aiming player holds the fire button in a vehicle (third person),
   *  the horizontal drag winds a self-centring virtual steering wheel that feeds Vehicle.updatePlayer like the
   *  A/D keys. Ticked once per frame (mouseDX is a whole-frame delta) — the camera tails the heading meanwhile. */
  private tickMouseSteer(dt: number): void {
    this.driveSteerActive = Boolean(this.activeVehicle) && this.input.firing && !this.input.aiming;
    if (this.driveSteerActive) this.driveSteer = THREE.MathUtils.clamp(this.driveSteer - this.input.mouseDX * MOUSE_STEER_GAIN, -1, 1); // drag right -> negative steer -> turn right, matching the D key
    else this.driveSteer *= Math.exp(-dt * 12); // released: the wheel springs back to centre
  }

  private updateCamera(dt: number): void {
    const flying = this.activePlane;
    const target = flying?.group.position ?? this.activeVehicle?.group.position ?? this.player.group.position;
    // Aboard a train the aisle is first-person only (a boom would sit outside the shell), but at the
    // CONTROLS the vehicle view ladder applies: chase cam by default, or V down to first person — where
    // the occupied cab's nose shell hides for a clear windscreen (same trick as the cars' cabins).
    const view = this.trains.riding
      ? (this.trains.driving ? this.settings.cameraViewVehicle : 0)
      : this.activeVehicle || flying ? this.settings.cameraViewVehicle : this.settings.cameraViewFoot;
    const firstPerson = view === 0;
    this.trains.setDriveFirstPerson(this.trains.driving && firstPerson);
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
    const airborneBoost = this.airborne ? (this.airborne.mode === 'freefall' ? 6 : 4) : flying ? 7 : this.trains.driving ? 10 : 0; // skydives, flights and a 60 m consist read better with the boom pulled back
    const backpedal = this.input.down('KeyS') && !this.input.down('KeyW'); // reversing is a clean straight backpedal — no auto-follow slew, or the camera whips 180° to get behind the rearward heading
    const footTrail = !this.activeVehicle && this.player.moving && !this.input.aiming && !this.cover && !backpedal; // lazy camera follow on foot: keeps keyboard/gamepad-only players oriented; off while aiming or in cover so the shoulder/peek framing holds
    const trainHeading = this.trains.driveHeading;
    const trainFp = this.trains.driving && firstPerson;
    // FP at the controls: nudge the eye forward past the (hidden) cab shell so the end wall never clips the view.
    if (trainFp && trainHeading !== undefined) this.trainEye.set(target.x + Math.sin(trainHeading) * 1.15, target.y, target.z + Math.cos(trainHeading) * 1.15);
    this.cameraController.update(dt, this.input, trainFp && trainHeading !== undefined ? this.trainEye : target, this.city, Boolean(this.activeVehicle) || Boolean(flying) || this.trains.driving, sensitivity, view, flying?.state.heading ?? this.activeVehicle?.heading ?? trainHeading ?? 0, !this.combat.spec.melee && !this.airborne && !flying, this.coverLean, scoped ? scopeFov(this.scopeLevel) : 0, airborneBoost, this.driveSteerActive, flying ? 2.6 : this.trains.driving ? 3.4 : this.activeVehicle?.spec.size[1] ?? 0, this.player.heading, footTrail);
    this.torch.frame(this.camera, target, firstPerson || scoped, !this.online); // after the camera settles so the beam tracks this frame's free-look exactly
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.35;
    }
  }

  private buildMarker(): void {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.16, 8, 28), new THREE.MeshBasicMaterial({ color: 0xf5c451 })); ring.rotation.x = Math.PI / 2;
    // A beacon you can orient by from streets away — the old 11u x 12%-opacity beam was invisible.
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 130, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xf5c451, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false })); core.position.y = 65;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.8, 130, 18, 1, true), new THREE.MeshBasicMaterial({ color: 0xf5c451, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })); beam.position.y = 65;
    this.marker.add(ring, core, beam); this.scene.add(this.marker);
  }

  private updateMarker(dt: number): void {
    if (this.mode !== 'playing') this.markerTarget = this.currentTarget(); // menus/backdrop: no sim step refreshes it
    this.marker.visible = Boolean(this.markerTarget);
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
      const contactPrompt = this.contactPrompt(); // offer / riddle re-state / job re-brief — undefined when E would do nothing
      if (this.online) prompt = this.online.localState?.vehicleId ? 'E  Exit vehicle  ·  ENTER  Global chat' : 'E  Enter nearby vehicle  ·  ENTER  Global chat  ·  Open PvP';
      else if (this.airborne) prompt = airborneHint(this.airborne.mode, this.inventory.parachutes);
      else if (this.activePlane) prompt = planeHint(this.activePlane.state);
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
      else if (this.trains.riding) prompt = this.trains.driving ? `${Math.round(this.trains.rideSpeedKph)} km/h  ·  W/S  Drive  ·  V  Camera  ·  E  Release controls` : this.trains.atCab ? 'E  Take the controls' : 'E  Step off the train';
      else if (this.cover) prompt = this.cover.corner !== 0 ? 'CTRL  Peek and fire  ·  Q  Leave cover' : 'A/D  Slide to a corner  ·  Q  Leave cover';
      else if (this.missions.objective?.kind === 'collect' && nearbyTarget && nearbyTarget.position.distanceTo(focus) < 8) prompt = `E  Take the ${(this.missions.objective.target?.label ?? 'item').toLowerCase()}`;
      else if (this.missions.state === 'failed' && nearbyTarget && nearbyTarget.position.distanceTo(focus) < 10) prompt = 'E  Restart mission';
      else if (this.missions.objective?.kind === 'choice') prompt = `E  ${this.missions.objective.text}`;
      else if (contactPrompt) prompt = contactPrompt;
      else if (shop?.kind === 'weapons') prompt = 'E  Browse Jozi Arms';
      else if (shop?.kind === 'bottle') prompt = `E  Browse ${shop.name}`;
      else if (shop?.kind === 'hotdog') prompt = `E  Boerewors roll · R${HOTDOG_PRICE}`;
      else if (this.safehouses.near(focus)) prompt = canEnterSafehouse(this.wanted.isWanted, this.knowledge.sightingAge) ? 'E  Enter safehouse' : 'Safehouse locked · lose the heat first';
      else if (shop?.driveIn && !this.population.nearestEnterable(focus)) prompt = shop.kind === 'spray' ? 'Drive a vehicle onto the marker to detail' : 'Drive a vehicle onto the marker to store';
      else if (this.trains.boardable(focus)) { const wait = this.trains.boardCountdown(focus); prompt = wait === undefined ? 'E  Board the train' : `E  Board · departs in ${formatCountdown(wait)}`; }
      else if (this.nearbyDiaryPage()) prompt = 'E  Take the torn page';
      else if (this.coverAvailable) prompt = 'Q  Take cover';
      else if (this.nearestPlane()) prompt = 'E  Enter plane';
      else if (this.population.nearestPedestrian(focus)) prompt = 'F  Mug / melee';
      else if (this.population.nearestEnterable(focus) || this.police.stealableNear(focus)) prompt = 'E  Enter vehicle';
    }
    // Being collared: this warning trumps any contextual hint while foot officers are on you.
    if (this.mode === 'playing' && this.bustMeter > 0 && !this.activeVehicle && !this.transition) prompt = 'JMPD ON YOU — break away or get nicked!';
    const spec = this.combat.spec; const ammoState = this.combat.state;
    const district = this.city.districtAt(focus.x, focus.z);
    const riddleHunt = this.missions.objective?.hidden && !this.riddleRevealed; // the search circle is up
    const objective = this.online ? this.online.objective ? {
      missionName: this.online.objective.missionName, text: this.online.objective.text, progress: this.online.objective.progress,
      required: this.online.objective.required, remainingSeconds: this.online.objective.remainingSeconds,
    } : undefined : this.missions.objective ? {
      missionName: this.missions.active?.name ?? '', text: this.missions.objective.text + (riddleHunt ? ' — search inside the circle on your map' : '') + this.trainRideHint(), progress: this.missions.objective.required ? this.missions.progress : undefined,
      required: this.missions.objective.required, remainingSeconds: this.missions.remainingTime > 0 ? this.missions.remainingTime : undefined,
      failed: !this.online && this.missions.state === 'failed' ? this.missions.failReason ?? 'Mission failed' : undefined,
    } : undefined;
    const onlineVehicle = this.online?.vehicleStates.find((entry) => entry.id === this.online?.localState?.vehicleId);
    const vehicle = onlineVehicle ? {
      name: onlineVehicle.isHot ? 'HOT BAKKIE' : onlineVehicle.kind === 'bakkie' ? 'Hilux Bakkie' : onlineVehicle.kind === 'sport' ? 'Golf GTI' : 'Citi Golf',
      speedKph: Math.abs(onlineVehicle.speed) * 3.6, health: onlineVehicle.health,
    } : this.activePlane ? {
      name: `${this.activePlane.name} · ${Math.max(0, Math.round(this.activePlane.group.position.y - this.city.surfaceHeightAt(this.activePlane.group.position.x, this.activePlane.group.position.z)))}m`,
      speedKph: this.activePlane.state.speed * 3.6, health: this.activePlane.wrecked ? 0 : 100,
    } : this.activeVehicle ? {
      name: this.activeVehicle.spec.name, speedKph: Math.abs(this.activeVehicle.speed) * 3.6, health: this.activeVehicle.health,
      radio: this.activeVehicle.spec.twoWheeler ? undefined : radioDial(this.audio.currentRadio),
      taxi: isTaxiKind(this.activeVehicle.spec.kind) ? { text: taxiHudText(this.taxiRide.phase, this.taxiRide.duty === 'available', this.taxiRide.fare, this.taxiRide.tip), available: this.taxiRide.available } : undefined,
      courier: this.activeVehicle.spec.kind === 'courier' ? { text: courierHudText(this.courierJob), available: this.courierJob.active } : undefined,
    } : undefined;
    const scoped = this.scoped; // the scope reticle replaces the HUD crosshair while glassing
    const crosshair = this.mode === 'playing' && !this.transition && !this.airborne && !this.activePlane && !this.weaponWheelOpen && !scoped && crosshairVisible(this.input.aiming, spec.melee) && (!this.activeVehicle || !spec.projectile); // weapons stay holstered mid-air
    const onlineState = this.online?.localState;
    this.ui.update({ health: this.player.health, armour: this.online ? 0 : this.inventory.armour, stims: this.online ? 0 : this.inventory.stims, parachutes: this.online ? 0 : this.inventory.parachutes, torch: !this.online && this.torch.on, money: this.online ? 0 : this.economy.balance, weaponName: spec.name, melee: spec.melee, ammo: onlineState?.ammo ?? ammoState.ammo, reserve: onlineState?.reserve ?? ammoState.reserve, reloading: onlineState?.reloading ?? this.combat.reloading > 0, wanted: this.online ? 0 : this.wanted.level, unseen: !this.online && this.concealed && this.wanted.isWanted, district, clock: this.dayNight.clockText, reputation: !this.online && district === CBD ? reputationTier(this.livingCity.district(CBD).communityStanding) : undefined, prompt, dialogue: !this.online && this.dialogue.line ? { speaker: this.dialogue.line.speaker, text: this.dialogue.line.text, more: this.dialogue.hasMore, offer: Boolean(this.story.pendingOffer) } : undefined, missionPassed: !this.online ? this.missionPassedView : undefined, crosshair, scope: scoped ? { zoom: scopeZoomLabel(this.scopeLevel) } : undefined, vehicle, objective, fps: this.fps, loopTotalPct: this.profiler.total(), loopSample: this.profiler.sample(), navCalls: this.navHudCalls, navMs: this.navHudMs, position: this.player.group.position, settings: this.settings, cheatsOn: !this.online && (this.cheats.fastRun || this.cheats.bigJump || this.cheats.invulnerable), inebriation: this.online ? 0 : this.player.inebriation });
    this.touch?.update({
      active: this.mode === 'playing' && !this.ui.mapOpen && !this.ui.consoleOpen && !this.weaponWheelOpen,
      prompt,
      dialogue: !this.online && Boolean(this.dialogue.line),
      driving: Boolean(this.activeVehicle),
      flying: Boolean(this.activePlane),
      airborneFlight: this.activePlane ? !this.activePlane.state.grounded : false,
      weapon: spec.name,
    });
    const markers = this.mapMarkers();
    const police = this.mapPolice();
    const hostiles = this.mapHostiles(); // arrest officers are on the map as JMPD, not as red hostiles
    const heading = this.activeVehicle?.heading ?? this.player.heading;
    // Corner minimap tracks the live view so it spins as you mouse-look on foot (player.heading only catches up when you actually move). In a vehicle the camera tails the car, so keep the true heading. `yaw + PI` is the parked camera-behind relationship (see spawn: yaw = heading + PI).
    const minimapHeading = this.activeVehicle ? heading : this.cameraController.yaw + Math.PI;
    this.ui.drawMap(focus.x, focus.z, minimapHeading, this.city.roadPaths, markers, police, hostiles, this.settings.minimapZoom);
    if (this.ui.mapOpen) this.ui.updateMap({ x: focus.x, z: focus.z, heading, markers, police, hostiles, cars: this.mapCars(), peds: this.mapPeds() });
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
    this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false); this.player.setDead(true); this.mode = 'dead'; this.deathTimer = 3; this.audio.setEngine(false); this.audio.setTrafficEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio(); this.closeWeaponWheel(); this.closeConsole(); this.closeMap(); this.ui.notify('EISH', 'You got klapped. An ambulance is coming just now. Press E after respawning to restart the job.', false); document.exitPointerLock();
  }
  /** `reload` console command: restore the manual checkpoint live (no page refresh) — money, time, kit, cheats,
   *  living-city and mission progress, wanted cleared, and the player set back at the checkpoint position/facing.
   *  Reads the checkpoint slot the autosave never touches, so it always returns to the last `save`. */
  /** Restore height: keep a saved elevation only when it's clearly above the ground (a rooftop/overpass);
   *  otherwise sit on the surface — which also absorbs the placeholder y in the default spawn. */
  private restoreY(x: number, z: number, savedY: number): number {
    const surface = this.city.surfaceHeightAt(x, z);
    return savedY > surface + 0.5 ? savedY : surface;
  }

  private reloadSavedGame(): string {
    const checkpoint = this.saveManager.loadCheckpoint();
    if (!checkpoint) return 'No checkpoint yet — type `save` to stamp one, then `reload` returns to it.';
    this.closeConsole();
    this.save = checkpoint;
    this.economy.balance = this.save.money;
    this.inventory = { ...this.save.inventory };
    Object.assign(this.cheats, this.save.cheats);
    this.combat.restore(this.save.weapons); this.player.setWeapon(this.combat.current);
    this.livingCity = new LivingCitySystem(this.save.livingCity);
    this.missions.completed = new Set(this.save.completedMissions);
    this.story.restore(this.save.storyFlags, this.save.diaryPages);
    this.dayNight.hour = this.save.timeOfDay;
    this.player.heal();
    this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.clearPolice();
    this.leaveVehicleOnFoot();
    // Place at the EXACT saved spot — no safePlacement nudge, which reads a rooftop footprint as "blocked" and
    // rings the player outward off the roof edge. The checkpoint is a spot the player already stood on.
    const [px, , pz] = this.save.position;
    this.player.group.position.set(px, this.restoreY(px, pz, this.save.position[1]), pz);
    this.player.velocityY = 0; this.player.onGround = true;
    this.player.setHeading(this.save.heading);
    this.cameraController.yaw = this.save.heading + Math.PI; this.cameraController.snapBehind(this.player.group.position);
    this.ui.screenFade();
    return `Reloaded checkpoint — ${this.dayNight.clockText}, R${this.economy.balance.toLocaleString()}.`;
  }

  /** Nicked: JMPD have the cuffs on. Short "BUSTED" beat, then release at the station lighter a few things.
   *  Mirrors die(), but the collar is survivable — you keep your progress, just not your hardware or bail money. */
  private getBusted(): void {
    if (this.mode === 'dead' || this.mode === 'busted') return;
    if (this.missions.state === 'active') this.missions.fail('JMPD nicked you');
    this.endCourierShift();
    this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false);
    this.mode = 'busted'; this.bustTimer = 3; this.bustMeter = 0;
    this.audio.setEngine(false); this.audio.setTrafficEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio();
    this.closeWeaponWheel(); this.closeConsole(); this.closeMap();
    this.ui.notify('BUSTED', 'JMPD got the cuffs on you. Processed and kicked out the station — lighter a few things.', false);
    document.exitPointerLock();
  }

  private respawn(busted = false): void {
    this.trains.endRide();
    this.endTaxiShift(this.activeVehicle);
    this.endCourierShift(this.activeVehicle);
    if (this.activeVehicle) { this.activeVehicle.playerControlled = false; this.activeVehicle.setFirstPerson(false); this.activeVehicle = undefined; }
    this.releasePlane();
    this.transition = undefined; this.cover = undefined; this.airborne = undefined; this.player.setCanopy(false); this.player.resetAirbornePose(); this.player.inVehicle = false; this.player.setVisible(true); this.player.heal();
    const at = busted ? POLICE_STATION : this.save.spawn;
    this.player.group.position.set(...at); this.player.group.position.y = this.city.surfaceHeightAt(this.player.group.position.x, this.player.group.position.z);
    this.wanted.clear(); this.previousWanted = false; this.knowledge.reset(); this.clearPolice(); this.bustMeter = 0;
    if (busted) { // confiscate every weapon (bare fists) and take bail: 10% of cash, minimum R100, never more than you hold
      this.combat.disarm(); this.player.setWeapon(this.combat.current);
      const bail = Math.min(this.economy.balance, Math.max(100, Math.round(this.economy.balance * 0.1)));
      this.economy.spend(bail); this.persist();
      this.ui.notify('Released', `Bail: R${bail.toLocaleString()}. Weapons confiscated. Wanted level cleared.`, false);
    }
    this.mode = 'playing';
  }
  /** Tears down the JMPD response and drops its foot officers from the population roster. */
  private clearPolice(): void {
    for (const officer of this.police.reset()) this.population.removePedestrian(officer);
  }
  private pause(): void { this.mode = 'paused'; this.audio.setEngine(false); this.audio.setTrafficEngine(false); this.audio.setSiren(false); this.audio.setFire(false); this.audio.stopRadio(); this.closeWeaponWheel(); document.exitPointerLock(); this.ui.showPause(this.settings); }
  private persist(): void {
    const at = this.activeVehicle?.group.position ?? this.player.group.position; // live location (the vehicle is the player while driving)
    const heading = this.activeVehicle?.heading ?? this.player.heading;
    this.save = { version: 3, money: this.economy.balance, completedMissions: [...this.missions.completed], storyFlags: this.story.serializeFlags(), diaryPages: this.story.serializeDiaryPages(), spawn: this.save.spawn, position: [at.x, at.y, at.z], heading, settings: this.settings, weapons: this.combat.serialize(), cheats: { ...this.cheats }, garage: this.save.garage, livingCity: this.livingCity.state, timeOfDay: this.dayNight.hour, safehouses: this.save.safehouses, inventory: { ...this.inventory } };
    this.saveManager.save(this.save);
  }
  private resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); this.composer?.setSize(innerWidth, innerHeight); }
}
