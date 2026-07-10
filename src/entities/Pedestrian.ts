import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { City, RoadPoint } from '../world/City';

export type PedState = 'walk' | 'idle' | 'flee' | 'hostile' | 'down';
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
  aggressive = false;
  mugged = false;
  wallet = 0;
  destination = new THREE.Vector3();
  speed = 2.4;
  idleTime = 0;
  private phase = Math.random() * Math.PI * 2;
  private legs: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, position: THREE.Vector3, index: number, hostile = false, police = false) {
    this.group.position.copy(position); this.hostile = hostile; this.police = police; this.state = hostile ? 'hostile' : 'walk';
    this.group.name = police ? 'JMPD Officer' : hostile ? 'Rank Enforcer' : 'Citizen'; this.group.userData.pedestrian = this;
    this.aggressive = !hostile && !police && index % 9 === 0; this.wallet = 25 + (index * 47) % 180;
    scene.add(this.group); this.buildModel(index);
  }

  update(dt: number, city: City, choices: RoadPoint[], player: THREE.Vector3, danger = false): void {
    if (this.state === 'down') return;
    const distance = this.group.position.distanceTo(player);
    if (!this.hostile && !this.contact && danger && distance < 45) { this.state = 'flee'; this.destination.copy(this.group.position).add(this.group.position.clone().sub(player).normalize().multiplyScalar(55)); }
    if (this.aggressive && !this.contact && distance < 4.5 && this.state !== 'flee') { this.state = 'hostile'; this.destination.copy(player); }
    if (this.hostile && distance < 70) { this.state = 'hostile'; this.destination.copy(player); }
    if (this.state === 'idle') { this.idleTime -= dt; if (this.idleTime <= 0) this.pickDestination(choices); return; }
    if (this.destination.distanceToSquared(this.group.position) < 5) {
      this.state = 'idle'; this.idleTime = 1 + Math.random() * 4; return;
    }
    const direction = this.destination.clone().sub(this.group.position); direction.y = 0; direction.normalize();
    const pace = this.state === 'flee' || this.state === 'hostile' ? 5.5 : this.speed;
    const desired = this.group.position.clone().addScaledVector(direction, pace * dt);
    const moved = city.clampMove(this.group.position, desired, 0.42); this.group.position.copy(moved);
    if (moved.distanceToSquared(desired) > 0.01) this.pickDestination(choices);
    this.group.rotation.y = Math.atan2(direction.x, direction.z); this.phase += dt * pace * 2.4;
    this.legs[0].rotation.x = Math.sin(this.phase) * 0.55; this.legs[1].rotation.x = -Math.sin(this.phase) * 0.55;
  }

  takeDamage(amount: number): boolean {
    if (this.state === 'down' || this.contact) return false;
    this.health = Math.max(0, this.health - amount); this.state = this.health === 0 ? 'down' : this.aggressive ? 'hostile' : 'flee';
    if (this.state === 'down') { this.group.rotation.z = Math.PI / 2; this.group.position.y = 0.36; }
    return this.health === 0;
  }

  makeCarGuard(): void {
    this.carGuard = true; this.contact = true; this.group.name = 'Car Guard';
    const vest = new THREE.Mesh(new RoundedBoxGeometry(0.52, 0.5, 0.34, 3, 0.06), new THREE.MeshStandardMaterial({ color: 0xb6f22e, emissive: 0x86c010, emissiveIntensity: 0.55, roughness: 0.6 }));
    vest.position.y = 1.08; vest.castShadow = true; this.group.add(vest);
  }

  mug(player: THREE.Vector3): number {
    if (this.contact || this.state === 'down' || this.mugged) return 0;
    const cash = this.wallet; this.wallet = 0; this.mugged = true; this.state = this.aggressive ? 'hostile' : 'flee';
    this.destination.copy(this.group.position).add(this.group.position.clone().sub(player).normalize().multiplyScalar(45));
    return cash;
  }

  pickDestination(choices: RoadPoint[]): void {
    const point = choices[Math.floor(Math.random() * choices.length)];
    if (point) this.destination.set(point.x + (Math.random() - 0.5) * 12, 0, point.z + (Math.random() - 0.5) * 12);
    this.state = this.hostile ? 'hostile' : 'walk';
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
    for (const x of [-0.32, 0.32]) { const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.48, 4, 8), x < 0 ? cloth : skin); arm.position.set(x, 1.03, 0); this.group.add(arm); }
    if (this.police) { const badge = new THREE.Mesh(new THREE.CircleGeometry(0.055, 10), new THREE.MeshStandardMaterial({ color: 0xd6bd63, metalness: 0.75, roughness: 0.25 })); badge.position.set(0.12, 1.14, 0.157); this.group.add(badge); }
    this.group.traverse((child: THREE.Object3D) => { if (child instanceof THREE.Mesh) child.castShadow = true; });
  }
}
