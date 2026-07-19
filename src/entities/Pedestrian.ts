import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { KNOCKDOWN_DAMAGE, knockdownOutcome, STUMBLE_DURATION } from '../systems/BumpSystem';
import { accumulateFear, CALM_THRESHOLD, decayFear, FEAR_EVENTS, fearResponse, FEAR_MAX } from '../systems/FearSystem';
import { advanceSwing, beginSwing, MELEE_COOLDOWN_JITTER, MELEE_COOLDOWN_MIN, MELEE_ENGAGE_RANGE, MELEE_ENGAGE_RELEASE, swingExtension, type MeleeSwing } from '../systems/MeleeSystem';
import { ProgressWatchdog } from '../systems/NavGraph';
import type { City, RoadPoint } from '../world/City';
import type { NpcCharacterId } from './NpcCatalog';
import { impactKickSpeed, type RagdollEnvironment } from './PedRagdoll';
import { RiggedPedestrianVisual } from './RiggedPedestrianVisual';

export type PedState = 'walk' | 'idle' | 'flee' | 'hostile' | 'cower' | 'down';
export const DEATH_SPIN_DURATION = 0.38; // seconds of impact whip as the body drops — matched to the ~0.3s slam
const skinColors = [0x613e30, 0x8b5b43, 0xb77a58, 0xd2a078];
const shirtColors = [0x375e70, 0x9d5d55, 0xd1a343, 0x536f4a, 0x725887];

export class Pedestrian {
  group = new THREE.Group();
  health = 60;
  state: PedState = 'walk';
  hostile = false;
  police = false;
  contact = false;
  carGuard = false;
  hailing = false;
  aggressive = false;
  mugged = false;
  frozen = false; // set by PopulationSystem distance culling: a frozen ped receives no update() at all
  wallet = 0;
  fear = 0;
  bravery = 0.5;
  enraged = false;
  destination = new THREE.Vector3();
  threat = new THREE.Vector3();
  speed = 2.4;
  idleTime = 0;
  route: RoadPoint[] = [];
  private groundY = 0;
  private routeIndex = 0;
  private routed = false;
  private replanCooldown = 0; // seconds until this ped may ask the planner again — set when a plan attempt yields nothing (budget-starved or unreachable) so a ped can't hammer A* every frame
  private watchdog = new ProgressWatchdog();
  private swing?: MeleeSwing;
  private meleeCooldown = 0;
  private pendingMeleeHit = false;
  private engaged = false; // squared up at melee range this frame (drives the braced visual)
  private engagedHold = false; // sticky engage: held until the player backs beyond the release ring
  private pursuing = false; // destination copied from the player this frame: actively hunting them
  private downTimer = 0;
  private knockedDown = false;
  private deathSpinTotal = 0;
  private deathSpinElapsed = DEATH_SPIN_DURATION;
  private stumbleTimer = 0;
  private covering = false;
  private phase = Math.random() * Math.PI * 2;
  private legs: THREE.Mesh[] = [];
  private arms: THREE.Mesh[] = [];
  private proceduralModel = new THREE.Group();
  readonly riggedVisual?: RiggedPedestrianVisual;
  private direction = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private ragdollCity?: City;
  /** Built once; the ragdoll queries ground/walls through it every step without per-frame closures. */
  private readonly ragdollEnv: RagdollEnvironment = {
    heightAt: (x, z) => this.ragdollCity ? this.ragdollCity.surfaceHeightAt(x, z) : this.groundY,
    blockedAt: (x, z, radius) => this.ragdollCity ? this.ragdollCity.collides(x, z, radius) : false,
  };

  constructor(scene: THREE.Scene, position: THREE.Vector3, index: number, hostile = false, police = false, readonly visualVariant?: NpcCharacterId) {
    this.group.position.copy(position); this.groundY = position.y; this.hostile = hostile; this.police = police; this.state = hostile ? 'hostile' : 'walk';
    this.group.name = police ? 'JMPD Officer' : hostile ? 'Rank Enforcer' : 'Citizen'; this.group.userData.pedestrian = this;
    this.aggressive = !hostile && !police && index % 9 === 0; this.wallet = 25 + (index * 47) % 180; this.bravery = ((index * 37 + 11) % 100) / 100;
    this.proceduralModel.name = 'ProceduralPedestrianFallback'; this.group.add(this.proceduralModel);
    scene.add(this.group); this.buildModel(index);
    if (visualVariant) {
      this.riggedVisual = new RiggedPedestrianVisual(this.group, visualVariant, { onReady: () => { this.proceduralModel.visible = false; } });
      void this.riggedVisual.load().catch(() => { /* fail open: the procedural pedestrian remains visible */ });
    }
  }

  /** Free this ped's GPU geometry when it despawns — otherwise every culled/replaced ped leaks its meshes
   *  and the session slowly degrades. Geometries are built per-ped (unique), so disposing them is safe. */
  dispose(): void {
    this.riggedVisual?.dispose();
    this.proceduralModel.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  }

  update(dt: number, city: City, choices: RoadPoint[], player: THREE.Vector3): void {
    this.ragdollCity = city;
    try { this.updateMotion(dt, city, choices, player); } finally { this.updateRiggedVisual(dt); }
  }

  private updateMotion(dt: number, city: City, choices: RoadPoint[], player: THREE.Vector3): void {
    this.engaged = false; this.pursuing = false;
    if (this.state === 'down') {
      this.groundY = city.surfaceHeightAt(this.group.position.x, this.group.position.z); this.group.position.y = this.groundY + 0.36;
      if (this.deathSpinElapsed < DEATH_SPIN_DURATION) {
        // Impact whip: yaw the felled body away from the shot, fast at first and decaying to rest.
        const ease = (t: number) => 1 - (1 - t) ** 2;
        const before = ease(this.deathSpinElapsed / DEATH_SPIN_DURATION);
        this.deathSpinElapsed = Math.min(DEATH_SPIN_DURATION, this.deathSpinElapsed + dt);
        this.group.rotation.y += this.deathSpinTotal * (ease(this.deathSpinElapsed / DEATH_SPIN_DURATION) - before);
      }
      if (this.downTimer <= 0) return; // health depleted: stays down
      this.downTimer -= dt;
      if (this.downTimer <= 0) this.rise(player);
      return;
    }
    this.groundY = city.surfaceHeightAt(this.group.position.x, this.group.position.z); this.group.position.y = this.groundY;
    this.fear = decayFear(this.fear, dt);
    if (this.stumbleTimer > 0) {
      this.stumbleTimer = Math.max(0, this.stumbleTimer - dt);
      const sway = this.stumbleTimer / STUMBLE_DURATION;
      this.group.rotation.x = -0.32 * sway;
      for (const arm of this.arms) arm.rotation.x = 0.7 * sway;
      if (this.stumbleTimer > 0) return;
    }
    const distance = this.group.position.distanceTo(player);
    if (this.state === 'cower') {
      this.setPanicPose(true, true);
      if (this.fear < CALM_THRESHOLD) { this.setPanicPose(false, false); this.pickDestination(this.localTarget(city, choices)); }
      return;
    }
    if (this.enraged) { if (this.fear < CALM_THRESHOLD) { this.enraged = false; this.setPanicPose(false, false); this.pickDestination(this.localTarget(city, choices)); } else { this.state = 'hostile'; this.destination.copy(player); this.pursuing = true; } }
    if (this.state === 'flee' && this.fear < CALM_THRESHOLD) this.pickDestination(this.localTarget(city, choices)); // calm down even when a wall kept the flee point unreachable
    if (this.aggressive && !this.contact && distance < 4.5 && this.state !== 'flee') { this.state = 'hostile'; this.destination.copy(player); this.pursuing = true; }
    if (this.hostile && distance < 70) { this.state = 'hostile'; this.destination.copy(player); this.pursuing = true; }
    if (this.swing) {
      const { hit, done } = advanceSwing(this.swing, dt);
      if (hit) this.pendingMeleeHit = true;
      if (done) { this.swing = undefined; this.meleeCooldown = MELEE_COOLDOWN_MIN + Math.random() * MELEE_COOLDOWN_JITTER; }
    }
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    this.replanCooldown = Math.max(0, this.replanCooldown - dt);
    if (this.state === 'hostile') this.setGuardPose(distance); else { this.group.rotation.x = 0; this.setPanicPose(this.state === 'flee', false); }
    if (this.hailing && this.state === 'idle') { const arm = this.arms[1]; if (arm) { arm.rotation.x = Math.PI * 0.95; arm.rotation.z = -0.22; } } // curbside hail: one arm out for the taxi
    if (this.state === 'idle') { this.idleTime -= dt; if (this.idleTime <= 0) this.pickDestination(this.localTarget(city, choices)); return; }
    // Squared up: a pursuer at melee range holds ground FACING the player and STAYS in 'hostile'
    // state — the generic arrival branch below used to flip pursuers to 'idle' at arm's length,
    // which starved the attack scan (they walked up and just stood there, never swinging).
    // `pursuing` is only set where the destination was copied from the player this frame, so
    // arrest officers (who reuse the 'hostile' state to hustle to the cruiser door) and hostiles
    // whose quarry left aggro range keep the old arrival behaviour, bust flow included.
    // Horizontal range on purpose: a pursuer under a rooftop player gathers directly below and
    // glowers up (swings and damage are height-gated in PopulationSystem) instead of grinding
    // the wall forever. Hysteresis on the release: once squared up, a short shuffle out to
    // MELEE_ENGAGE_RELEASE keeps the stance — the guard must not flicker off between swings.
    const horizontal = Math.hypot(player.x - this.group.position.x, player.z - this.group.position.z);
    if (this.pursuing && horizontal < (this.engagedHold ? MELEE_ENGAGE_RELEASE : MELEE_ENGAGE_RANGE)) {
      this.engaged = true; this.engagedHold = true; this.watchdog.reset();
      this.group.rotation.y = Math.atan2(player.x - this.group.position.x, player.z - this.group.position.z);
      this.phase += dt * 5.5 * 2.4; // keep the guard-pose bounce alive while holding ground
      return;
    }
    this.engagedHold = false;
    // Pursuers also skip the arrival check: their destination IS the player, and the idle flip
    // at sqrt(5) would stop them just outside engage range. They keep closing until the engage
    // branch above takes over.
    if (!this.pursuing && (this.destination.x - this.group.position.x) ** 2 + (this.destination.z - this.group.position.z) ** 2 < 5) {
      if (this.state === 'flee' && this.fear >= CALM_THRESHOLD) { this.fleeFrom(this.threat); return; }
      if (this.state !== 'walk' || !this.advanceRoute()) { this.state = 'idle'; this.idleTime = 1 + Math.random() * 4; return; }
    }
    if (this.state !== 'walk') this.watchdog.reset(); // progress is only tracked while walking a route; fear states manage themselves
    else if (this.watchdog.update(Math.hypot(this.destination.x - this.group.position.x, this.destination.z - this.group.position.z), dt)) {
      // 10s without closing on the current waypoint: abandon the route, pause briefly (so it doesn't look robotic), then pick fresh.
      this.watchdog.reset(); this.route = []; this.routeIndex = 0; this.routed = false;
      this.state = 'idle'; this.idleTime = 0.4 + Math.random() * 0.9; return;
    }
    const direction = this.direction.subVectors(this.destination, this.group.position); direction.y = 0; direction.normalize();
    const pace = this.state === 'flee' ? 5.5 + this.fear * 0.014 : this.state === 'hostile' ? 5.5 : this.speed;
    const step = pace * dt;
    const desired = this.desired.copy(this.group.position).addScaledVector(direction, step);
    const moved = city.clampMove(this.group.position, desired, 0.42); this.group.position.copy(moved);
    this.groundY = city.surfaceHeightAt(moved.x, moved.z); this.group.position.y = this.groundY;
    if (moved.distanceToSquared(desired) > step * step * 0.25) { // blocked = progress well below the frame step (an absolute threshold never fires at 60fps and pinned peds on walls forever)
      if (this.state !== 'walk') this.pickDestination(this.localTarget(city, choices));
      else if (!this.advanceRoute()) { this.state = 'idle'; this.idleTime = 0.4 + Math.random() * 0.9; } // skip the snagged waypoint; wedged with no route left → brief pause, then a fresh pick
    }
    this.group.rotation.y = Math.atan2(direction.x, direction.z); this.phase += dt * pace * 2.4;
    this.legs[0].rotation.x = Math.sin(this.phase) * 0.55; this.legs[1].rotation.x = -Math.sin(this.phase) * 0.55;
  }

  private updateRiggedVisual(dt: number): void {
    const visual = this.riggedVisual; if (!visual) return;
    if (visual.ready) {
      // Procedural reactions squash/tilt the whole group. The rig layers those
      // reactions on bones instead, so preserve only the gameplay heading.
      this.group.scale.set(1, 1, 1); this.group.rotation.x = 0; this.group.rotation.z = 0;
      if (this.state === 'down') this.group.position.y = this.groundY;
    }
    visual.setState({
      state: this.state,
      dead: this.state === 'down' && this.health === 0,
      knockdown: this.state === 'down' && this.knockedDown,
      punching: this.swing !== undefined,
      punchElapsed: this.swing?.elapsed ?? 0,
      braced: this.engaged,
      hailing: this.hailing,
      covering: this.covering,
      stumbling: this.stumbleTimer > 0,
      stumbleAmount: THREE.MathUtils.clamp(this.stumbleTimer / STUMBLE_DURATION, 0, 1),
    });
    visual.update(dt, this.ragdollEnv);
    this.covering = false;
  }

  applyFear(amount: number, origin: THREE.Vector3): void {
    if (amount <= 0 || this.state === 'down' || this.contact || this.hostile || this.police) return;
    this.fear = accumulateFear(this.fear, amount); this.threat.copy(origin);
    const response = fearResponse(this.fear, this.aggressive, this.bravery, this.state === 'flee');
    if (response === 'fight') { this.enraged = true; this.state = 'hostile'; this.destination.copy(origin); }
    else if (response === 'cower') this.state = 'cower';
    else if (response === 'flee') { this.state = 'flee'; this.fleeFrom(origin); }
  }

  takeDamage(amount: number, origin?: THREE.Vector3): boolean {
    if (this.state === 'down' || this.contact) return false;
    this.swing = undefined; this.pendingMeleeHit = false; // a hit interrupts the wind-up: no punches landed from the floor
    this.health = Math.max(0, this.health - amount); this.fear = FEAR_MAX; this.enraged = this.aggressive && this.health > 0;
    this.state = this.health === 0 ? 'down' : this.aggressive ? 'hostile' : 'flee';
    if (this.state === 'down') { this.setPanicPose(false, false); this.group.rotation.x = 0; this.group.rotation.z = Math.PI / 2; this.group.position.y = this.groundY + 0.36; this.beginDeathFall(origin, amount); }
    return this.health === 0;
  }

  /** A kill starts either the ragdoll (rigged ragdoll-fated peds — the sim gets the impact as a
   *  damage-scaled kick, and yawing the group would drag the whole particle frame) or the pose
   *  path's yaw whip. */
  private beginDeathFall(origin: THREE.Vector3 | undefined, damage: number): void {
    const visual = this.riggedVisual;
    if (visual?.ready && visual.deathStyle === 'ragdoll') {
      visual.primeRagdollImpact(
        origin ? this.group.position.x - origin.x : undefined,
        origin ? this.group.position.z - origin.z : undefined,
        impactKickSpeed(damage),
      );
      return;
    }
    this.beginDeathSpin(origin);
  }

  /** Impact theatre for a kill: pick how far the dropping body whips around, torqued away from the
   *  side the shot came from (or whichever way, when the source is unknown — e.g. a blast at the feet). */
  private beginDeathSpin(origin?: THREE.Vector3): void {
    const heading = this.group.rotation.y;
    let side = this.phase > Math.PI ? -1 : 1; // no known source: the ped's own random phase picks the side
    if (origin) {
      const cross = Math.cos(heading) * (origin.x - this.group.position.x) - Math.sin(heading) * (origin.z - this.group.position.z);
      if (Math.abs(cross) > 0.001) side = cross > 0 ? -1 : 1; // hit from the right → spin left, and vice versa
    }
    this.deathSpinTotal = side * (1.1 + ((this.phase * 7) % 1) * 1.1); // ~65–125°, deterministic per ped
    this.deathSpinElapsed = 0;
  }

  /** Soft player bump: a brief off-balance reaction, no state change. */
  stumble(origin: THREE.Vector3): void {
    if (this.state === 'down' || this.contact) return;
    this.stumbleTimer = STUMBLE_DURATION; this.threat.copy(origin);
  }

  /** Sprint bump / vehicle hit: floors the ped; they get back up after ~2s unless health is depleted.
   *  Rigged peds ragdoll for the whole down window (owner call — no posed knockdowns), kicked away
   *  from the impact with damage-scaled force; the procedural fallback keeps the lie-flat pose.
   *  Returns true on kill. */
  knockdown(origin: THREE.Vector3, damage = KNOCKDOWN_DAMAGE): boolean {
    if (this.state === 'down' || this.contact) return false;
    const outcome = knockdownOutcome(this.health, damage);
    this.swing = undefined; this.pendingMeleeHit = false;
    this.health = outcome.health; this.downTimer = outcome.downTime; this.threat.copy(origin);
    this.fear = accumulateFear(this.fear, FEAR_EVENTS.assault.base); this.stumbleTimer = 0; this.state = 'down'; this.knockedDown = true;
    this.setPanicPose(false, false); this.group.rotation.x = 0; this.group.rotation.z = Math.PI / 2; this.group.position.y = this.groundY + 0.36;
    if (this.riggedVisual?.ready) this.riggedVisual.primeRagdollImpact(this.group.position.x - origin.x, this.group.position.z - origin.z, impactKickSpeed(damage));
    else if (outcome.killed) this.beginDeathSpin(origin);
    if (outcome.killed) this.enraged = false;
    return outcome.killed;
  }

  /** Back on their feet after a knockdown: personality decides fight or flight. */
  private rise(player: THREE.Vector3): void {
    this.group.rotation.z = 0; this.group.position.y = this.groundY; this.knockedDown = false;
    const response = fearResponse(this.fear, this.aggressive, this.bravery);
    if (response === 'fight') { this.enraged = true; this.state = 'hostile'; this.destination.copy(player); }
    else if (response === 'cower') this.state = 'cower';
    else { this.state = 'flee'; this.fleeFrom(this.threat); }
  }

  makeCarGuard(): void {
    // The hi-vis vest is painted into the car-guard's outfit texture now (outfitOverlay —
    // body-conforming and light-responsive, so it goes dark in a blackout like everything else);
    // the old emissive RoundedBox glowed through the night from any distance.
    this.carGuard = true; this.contact = true; this.group.name = 'Car Guard';
  }

  /** Flags the player's taxi down: freeze at the curb with an arm out until picked up or released. */
  setHail(on: boolean): void {
    this.hailing = on;
    if (on) { this.state = 'idle'; this.idleTime = 999999; return; }
    const arm = this.arms[1]; if (arm) { arm.rotation.x = 0; arm.rotation.z = 0; }
    if (this.state === 'idle') this.idleTime = Math.min(this.idleTime, 0.5);
  }

  mug(player: THREE.Vector3): number {
    if (this.contact || this.state === 'down' || this.mugged) return 0;
    const cash = this.wallet; this.wallet = 0; this.mugged = true; this.fear = FEAR_MAX; this.enraged = this.aggressive;
    this.state = this.aggressive ? 'hostile' : 'flee'; this.threat.copy(player); this.fleeFrom(player);
    return cash;
  }

  /** Freeze/thaw boundary: stalled time must not carry across a frozen gap. */
  resetProgress(): void { this.watchdog.reset(); }

  /** Prefer a sidewalk point near where the ped is standing over a citywide-random one: a nearby goal makes the
   *  A* route short and reachable (no map-spanning solve, no unreachable-goal exhaustion). Wrapped as a
   *  one-element choice list so pickDestination is unchanged; falls back to the full list when the ped is
   *  somewhere with no sidewalk nearby (or the city has no wander grid, e.g. under a unit-test stub). */
  private localTarget(city: City, choices: RoadPoint[]): RoadPoint[] {
    const near = city.wanderTarget(this.group.position.x, this.group.position.z);
    return near ? [near] : choices;
  }

  pickDestination(choices: RoadPoint[]): void {
    this.route = []; this.routeIndex = 0; this.routed = false; this.watchdog.reset(); // fallback wander until the population planner budgets a graph route
    const point = choices[Math.floor(Math.random() * choices.length)];
    if (point) this.destination.set(point.x + (Math.random() - 0.5) * 6, 0, point.z + (Math.random() - 0.5) * 6); // small jitter keeps peds off single-file rails without aiming them inside parcels
    this.state = this.hostile ? 'hostile' : 'walk';
  }

  /** True while reeling from a soft bump: mid-stumble peds should not be offered taxi hails. */
  get stumbling(): boolean { return this.stumbleTimer > 0; }

  /** True while wandering without a planned sidewalk route: the population system should assign one. The
   *  cooldown gate means a ped whose last request came back empty waits before asking again, so a crowd that
   *  can't be served this frame (budget spent, or goals the graph can't reach) doesn't re-solve A* every frame. */
  get wantsRoute(): boolean { return this.state === 'walk' && !this.contact && !this.hostile && !this.routed && !this.hailing && this.replanCooldown <= 0; }

  /** No route came back (frame budget spent, or an unreachable goal exhausted the search). Hold off before the
   *  next attempt — staggered so a whole backlog doesn't retry in lockstep — instead of hammering the planner. */
  deferRoute(): void { this.replanCooldown = 0.8 + Math.random() * 1.2; }

  setRoute(points: RoadPoint[]): void {
    this.route = points; this.routeIndex = 0; this.routed = true; this.state = 'walk';
    if (!this.advanceRoute()) { this.state = 'idle'; this.idleTime = 1 + Math.random() * 4; }
  }

  private advanceRoute(): boolean {
    this.watchdog.reset(); // new waypoint, new progress baseline
    const point = this.route[this.routeIndex];
    if (!point) { this.routed = false; return false; }
    this.routeIndex += 1;
    this.destination.set(point.x + (Math.random() - 0.5) * 2.4, 0, point.z + (Math.random() - 0.5) * 2.4);
    return true;
  }

  private fleeFrom(origin: THREE.Vector3): void {
    const away = this.direction.subVectors(this.group.position, origin); away.y = 0;
    if (away.lengthSq() < 0.01) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    this.destination.copy(this.group.position).addScaledVector(away.normalize(), 55);
  }

  /** Begin a melee swing (windup → hit frame → recover). The caller resolves the hit via
   *  consumeMeleeHit; damage is never applied here. Returns false while mid-swing or recovering. */
  punch(): boolean {
    if (this.swing || this.meleeCooldown > 0 || this.state === 'down') return false;
    this.swing = beginSwing();
    return true;
  }

  /** Mid-swing: the punch animation (rigged clip or procedural jab) is playing. */
  get punching(): boolean { return this.swing !== undefined; }

  /** Able to start a fresh swing right now. */
  get meleeReady(): boolean { return !this.swing && this.meleeCooldown <= 0 && this.state !== 'down'; }

  /** True exactly once per swing, on the frame the fist reaches full extension. The caller
   *  (PopulationSystem) then decides whether the hit lands — still in range and in the arc. */
  consumeMeleeHit(): boolean {
    const hit = this.pendingMeleeHit && this.state !== 'down';
    this.pendingMeleeHit = false;
    return hit;
  }

  /** Crouch behind cover (arrest officers). Reapplied every frame by the police system, after update() resets the pose. */
  takeCover(): void {
    this.covering = true;
    if (!this.riggedVisual?.ready) this.setPanicPose(false, true);
  }

  private setPanicPose(armsUp: boolean, crouch: boolean): void {
    for (const arm of this.arms) arm.rotation.x = armsUp ? Math.PI * 0.92 : 0;
    this.group.scale.y = crouch ? 0.66 : 1;
    this.group.rotation.x = crouch ? 0.42 : 0;
  }

  private setGuardPose(distance: number): void {
    this.group.scale.y = 1; this.group.rotation.x = distance > 3 ? 0.14 : 0.05;
    const jab = this.swing ? swingExtension(this.swing.elapsed) : 0;
    const bounce = distance < 4 ? Math.sin(this.phase * 3) * 0.12 : 0;
    const lead = this.arms[0]; const rear = this.arms[1];
    if (lead) lead.rotation.x = 1.32 + jab * 0.55 + bounce;
    if (rear) rear.rotation.x = 1.18 - jab * 0.25 - bounce;
  }

  private buildModel(index: number): void {
    const uniform = this.police ? 0x263b54 : this.hostile ? 0x6e3b35 : shirtColors[index % shirtColors.length];
    const skin = new THREE.MeshStandardMaterial({ color: skinColors[index % skinColors.length], roughness: 0.8 });
    const cloth = new THREE.MeshStandardMaterial({ color: uniform, roughness: 0.76 });
    const torso = new THREE.Mesh(new RoundedBoxGeometry(0.48, 0.68, 0.3, 4, 0.09), cloth); torso.position.y = 1.05;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), skin); head.position.y = 1.55; head.scale.y = 1.08;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: index % 3 === 0 ? 0x2a1c17 : 0x191918, roughness: 0.95 })); hair.position.y = 1.62;
    this.proceduralModel.add(torso, head, hair);
    for (const x of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.51, 4, 8), new THREE.MeshStandardMaterial({ color: 0x242832, roughness: 0.84 })); leg.position.set(x, 0.47, 0); this.proceduralModel.add(leg); this.legs.push(leg);
      const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.18, 0.11, 0.3, 2, 0.04), new THREE.MeshStandardMaterial({ color: 0x111516, roughness: 0.68 })); shoe.position.set(x, 0.1, 0.06); this.proceduralModel.add(shoe);
    }
    for (const x of [-0.32, 0.32]) { const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.48, 4, 8), x < 0 ? cloth : skin); arm.position.set(x, 1.03, 0); arm.geometry.translate(0, -0.24, 0); arm.position.y = 1.27; this.proceduralModel.add(arm); this.arms.push(arm); }
    if (this.police) { const badge = new THREE.Mesh(new THREE.CircleGeometry(0.055, 10), new THREE.MeshStandardMaterial({ color: 0xd6bd63, metalness: 0.75, roughness: 0.25 })); badge.position.set(0.12, 1.14, 0.157); this.proceduralModel.add(badge); }
    this.proceduralModel.traverse((child: THREE.Object3D) => { if (child instanceof THREE.Mesh) child.castShadow = true; });
  }
}
