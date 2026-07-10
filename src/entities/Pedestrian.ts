import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { accumulateFear, CALM_THRESHOLD, decayFear, fearResponse, FEAR_MAX } from '../systems/FearSystem';
import type { City, RoadPoint } from '../world/City';

export type PedState = 'walk' | 'idle' | 'flee' | 'hostile' | 'cower' | 'down';
const skinColors = [0x613e30, 0x8b5b43, 0xb77a58, 0xd2a078];
const shirtColors = [0x375e70, 0x9d5d55, 0xd1a343, 0x536f4a, 0x725887];

export class Pedestrian {
  group = new THREE.Group();
  health = 60;
  state: PedState = 'walk';
  hostile = false;
  police = false;
  contact = false;
  aggressive = false;
  mugged = false;
  wallet = 0;
  fear = 0;
  bravery = 0.5;
  enraged = false;
  destination = new THREE.Vector3();
  threat = new THREE.Vector3();
  speed = 2.4;
  idleTime = 0;
  private punchTimer = 0;
  private phase = Math.random() * Math.PI * 2;
  private legs: THREE.Mesh[] = [];
  private arms: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, position: THREE.Vector3, index: number, hostile = false, police = false) {
    this.group.position.copy(position); this.hostile = hostile; this.police = police; this.state = hostile ? 'hostile' : 'walk';
    this.group.name = police ? 'SCPD Officer' : hostile ? 'Dock Guard' : 'Citizen'; this.group.userData.pedestrian = this;
    this.aggressive = !hostile && !police && index % 9 === 0; this.wallet = 25 + (index * 47) % 180; this.bravery = ((index * 37 + 11) % 100) / 100;
    scene.add(this.group); this.buildModel(index);
  }

  update(dt: number, city: City, choices: RoadPoint[], player: THREE.Vector3): void {
    if (this.state === 'down') return;
    this.fear = decayFear(this.fear, dt);
    const distance = this.group.position.distanceTo(player);
    if (this.state === 'cower') {
      this.setPanicPose(true, true);
      if (this.fear < CALM_THRESHOLD) { this.setPanicPose(false, false); this.pickDestination(choices); }
      return;
    }
    if (this.enraged) { if (this.fear < CALM_THRESHOLD) { this.enraged = false; this.setPanicPose(false, false); this.pickDestination(choices); } else { this.state = 'hostile'; this.destination.copy(player); } }
    if (this.aggressive && !this.contact && distance < 4.5 && this.state !== 'flee') { this.state = 'hostile'; this.destination.copy(player); }
    if (this.hostile && distance < 70) { this.state = 'hostile'; this.destination.copy(player); }
    this.punchTimer = Math.max(0, this.punchTimer - dt);
    if (this.state === 'hostile') this.setGuardPose(distance); else { this.group.rotation.x = 0; this.setPanicPose(this.state === 'flee', false); }
    if (this.state === 'idle') { this.idleTime -= dt; if (this.idleTime <= 0) this.pickDestination(choices); return; }
    if (this.destination.distanceToSquared(this.group.position) < 5) {
      if (this.state === 'flee' && this.fear >= CALM_THRESHOLD) { this.fleeFrom(this.threat); return; }
      this.state = 'idle'; this.idleTime = 1 + Math.random() * 4; return;
    }
    const direction = this.destination.clone().sub(this.group.position); direction.y = 0; direction.normalize();
    const pace = this.state === 'flee' ? 5.5 + this.fear * 0.014 : this.state === 'hostile' ? 5.5 : this.speed;
    const desired = this.group.position.clone().addScaledVector(direction, pace * dt);
    const moved = city.clampMove(this.group.position, desired, 0.42); this.group.position.copy(moved);
    if (moved.distanceToSquared(desired) > 0.01) this.pickDestination(choices);
    this.group.rotation.y = Math.atan2(direction.x, direction.z); this.phase += dt * pace * 2.4;
    this.legs[0].rotation.x = Math.sin(this.phase) * 0.55; this.legs[1].rotation.x = -Math.sin(this.phase) * 0.55;
  }

  applyFear(amount: number, origin: THREE.Vector3): void {
    if (amount <= 0 || this.state === 'down' || this.contact || this.hostile || this.police) return;
    this.fear = accumulateFear(this.fear, amount); this.threat.copy(origin);
    const response = fearResponse(this.fear, this.aggressive, this.bravery, this.state === 'flee');
    if (response === 'fight') { this.enraged = true; this.state = 'hostile'; this.destination.copy(origin); }
    else if (response === 'cower') this.state = 'cower';
    else if (response === 'flee') { this.state = 'flee'; this.fleeFrom(origin); }
  }

  takeDamage(amount: number): boolean {
    if (this.state === 'down' || this.contact) return false;
    this.health = Math.max(0, this.health - amount); this.fear = FEAR_MAX; this.enraged = this.aggressive && this.health > 0;
    this.state = this.health === 0 ? 'down' : this.aggressive ? 'hostile' : 'flee';
    if (this.state === 'down') { this.setPanicPose(false, false); this.group.rotation.x = 0; this.group.rotation.z = Math.PI / 2; this.group.position.y = 0.36; }
    return this.health === 0;
  }

  mug(player: THREE.Vector3): number {
    if (this.contact || this.state === 'down' || this.mugged) return 0;
    const cash = this.wallet; this.wallet = 0; this.mugged = true; this.fear = FEAR_MAX; this.enraged = this.aggressive;
    this.state = this.aggressive ? 'hostile' : 'flee'; this.threat.copy(player); this.fleeFrom(player);
    return cash;
  }

  pickDestination(choices: RoadPoint[]): void {
    const point = choices[Math.floor(Math.random() * choices.length)];
    if (point) this.destination.set(point.x + (Math.random() - 0.5) * 12, 0, point.z + (Math.random() - 0.5) * 12);
    this.state = this.hostile ? 'hostile' : 'walk';
  }

  private fleeFrom(origin: THREE.Vector3): void {
    const away = this.group.position.clone().sub(origin); away.y = 0;
    if (away.lengthSq() < 0.01) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    this.destination.copy(this.group.position).addScaledVector(away.normalize(), 55);
  }

  punch(): void { this.punchTimer = 0.28; }

  private setPanicPose(armsUp: boolean, crouch: boolean): void {
    for (const arm of this.arms) arm.rotation.x = armsUp ? Math.PI * 0.92 : 0;
    this.group.scale.y = crouch ? 0.66 : 1;
    this.group.rotation.x = crouch ? 0.42 : 0;
  }

  private setGuardPose(distance: number): void {
    this.group.scale.y = 1; this.group.rotation.x = distance > 3 ? 0.14 : 0.05;
    const jab = this.punchTimer > 0 ? Math.sin((0.28 - this.punchTimer) / 0.28 * Math.PI) : 0;
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
    this.group.add(torso, head, hair);
    for (const x of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.51, 4, 8), new THREE.MeshStandardMaterial({ color: 0x242832, roughness: 0.84 })); leg.position.set(x, 0.47, 0); this.group.add(leg); this.legs.push(leg);
      const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.18, 0.11, 0.3, 2, 0.04), new THREE.MeshStandardMaterial({ color: 0x111516, roughness: 0.68 })); shoe.position.set(x, 0.1, 0.06); this.group.add(shoe);
    }
    for (const x of [-0.32, 0.32]) { const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.48, 4, 8), x < 0 ? cloth : skin); arm.position.set(x, 1.03, 0); arm.geometry.translate(0, -0.24, 0); arm.position.y = 1.27; this.group.add(arm); this.arms.push(arm); }
    if (this.police) { const badge = new THREE.Mesh(new THREE.CircleGeometry(0.055, 10), new THREE.MeshStandardMaterial({ color: 0xd6bd63, metalness: 0.75, roughness: 0.25 })); badge.position.set(0.12, 1.14, 0.157); this.group.add(badge); }
    this.group.traverse((child: THREE.Object3D) => { if (child instanceof THREE.Mesh) child.castShadow = true; });
  }
}
