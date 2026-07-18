import * as THREE from 'three';

interface Droplet { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; }
interface Decal { mesh: THREE.Mesh; life: number; }

export class GoreSystem {
  private droplets: Droplet[] = [];
  private decals: Decal[] = [];
  private dropletGeometry = new THREE.SphereGeometry(0.02, 6, 4); // fine droplets — the old 0.055 spheres at 2x scale read as cartoon balls
  private bloodMaterial = new THREE.MeshStandardMaterial({ color: 0x5d0005, roughness: 0.64, metalness: 0.02 });
  private decalMaterial = new THREE.MeshStandardMaterial({ map: this.createBloodTexture(), color: 0x7b0509, transparent: true, depthWrite: false, roughness: 0.72, polygonOffset: true, polygonOffsetFactor: -2 });

  constructor(private scene: THREE.Scene, private groundHeight: (x: number, z: number) => number = () => 0) {}

  burst(position: THREE.Vector3, force = 1, large = false): void {
    // Fine spatter: many small fast droplets, stretched along their spray direction into streaks.
    const count = Math.round((large ? 70 : 40) * THREE.MathUtils.clamp(force, 0.6, 1.7));
    const up = new THREE.Vector3(0, 1, 0); const direction = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.dropletGeometry, this.bloodMaterial); mesh.position.copy(position);
      const angle = Math.random() * Math.PI * 2; const speed = (3.2 + Math.random() * 7.5) * force;
      const velocity = new THREE.Vector3(Math.cos(angle) * speed, 1.2 + Math.random() * 5.2, Math.sin(angle) * speed);
      const droplet = 0.4 + Math.random() * (large ? 1.3 : 0.9);
      mesh.scale.set(droplet * 0.55, droplet * (1.6 + Math.random() * 1.4), droplet * 0.55); // streak, not ball
      mesh.quaternion.setFromUnitVectors(up, direction.copy(velocity).normalize());
      this.scene.add(mesh); this.droplets.push({ mesh, velocity, life: 1.6 });
    }
    this.addDecal(position, large ? 1.9 + Math.random() * 1.3 : 0.6 + Math.random() * 0.7);
  }

  update(dt: number): void {
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const drop = this.droplets[i]; if (!drop) continue;
      drop.life -= dt; drop.velocity.y -= 26 * dt; drop.mesh.position.addScaledVector(drop.velocity, dt); // heavier gravity: spatter snaps to the ground instead of lobbing
      const ground = this.groundHeight(drop.mesh.position.x, drop.mesh.position.z) + 0.06;
      if (drop.mesh.position.y <= ground || drop.life <= 0) {
        if (drop.mesh.position.y <= ground && Math.random() > 0.25) this.addDecal(drop.mesh.position, 0.07 + Math.random() * 0.2); // finer, denser landing speckle
        this.scene.remove(drop.mesh); this.droplets.splice(i, 1);
      }
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const decal = this.decals[i]; if (!decal) continue; decal.life -= dt;
      if (decal.life < 8) (decal.mesh.material as THREE.MeshStandardMaterial).opacity = Math.max(0, decal.life / 8);
      if (decal.life <= 0) { this.scene.remove(decal.mesh); this.decals.splice(i, 1); }
    }
    while (this.decals.length > 80) { const decal = this.decals.shift(); if (decal) this.scene.remove(decal.mesh); }
  }

  private addDecal(position: THREE.Vector3, size: number): void {
    const material = this.decalMaterial.clone();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material); mesh.rotation.x = -Math.PI / 2; mesh.rotation.z = Math.random() * Math.PI * 2; mesh.position.set(position.x, this.groundHeight(position.x, position.z) + 0.055 + this.decals.length * 0.0001, position.z); this.scene.add(mesh); this.decals.push({ mesh, life: 75 });
  }

  private createBloodTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D unavailable');
    const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 102); gradient.addColorStop(0, '#8d080c'); gradient.addColorStop(0.62, '#610306'); gradient.addColorStop(1, '#48000300'); context.fillStyle = gradient;
    context.beginPath(); for (let point = 0; point < 32; point++) { const angle = point / 32 * Math.PI * 2; const radius = 68 + Math.sin(point * 7.3) * 21 + Math.random() * 15; const x = 128 + Math.cos(angle) * radius; const y = 128 + Math.sin(angle) * radius; if (point === 0) context.moveTo(x, y); else context.lineTo(x, y); } context.closePath(); context.fill();
    context.fillStyle = '#670206'; for (let i = 0; i < 24; i++) { context.beginPath(); context.arc(22 + Math.random() * 212, 22 + Math.random() * 212, 2 + Math.random() * 8, 0, Math.PI * 2); context.fill(); }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
  }
}
