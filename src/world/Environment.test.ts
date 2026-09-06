import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildEnvironment, fogDensity } from './Environment';

describe('environment sky', () => {
  it('installs the atmospheric dome and keeps it centred on the active focus', () => {
    const scene = new THREE.Scene(); const environment = buildEnvironment(scene, 'low');
    expect(scene.getObjectByName('Atmospheric Sky')).toBe(environment.sky.mesh);
    expect(scene.getObjectByName('Ambient Sky Traffic')).toBe(environment.skyTraffic.group);
    environment.updateShadowFocus(new THREE.Vector3(180, 45, -230));
    expect(environment.sky.mesh.position.toArray()).toEqual([180, 45, -230]);
  });

  it('uses denser haze on reduced tiers while preserving the same clear-air ordering', () => {
    expect(fogDensity('high')).toBe(fogDensity('medium'));
    expect(fogDensity('low')).toBeGreaterThan(fogDensity('high'));
    expect(fogDensity('potato')).toBeGreaterThan(fogDensity('low'));
  });

  it('keeps the shadow frustum on elevated streets, roofs and aircraft instead of sea level', () => {
    const scene = new THREE.Scene(); const environment = buildEnvironment(scene, 'high');
    for (const height of [8, 120, 600]) {
      const focus = new THREE.Vector3(2200, height, 2000);
      environment.updateShadowFocus(focus);
      scene.updateMatrixWorld(true); environment.sun.shadow.updateMatrices(environment.sun);
      const shadowPoint = focus.clone().applyMatrix4(environment.sun.shadow.matrix);
      expect(shadowPoint.x).toBeCloseTo(0.5, 3); expect(shadowPoint.y).toBeCloseTo(0.5, 3);
      expect(shadowPoint.z).toBeGreaterThan(0); expect(shadowPoint.z).toBeLessThan(1);
      expect(environment.sun.target.position.distanceTo(focus)).toBeLessThan(0.06);
    }
  });

  it('holds the same shadow texels under sub-texel camera motion for an oblique sun', () => {
    const scene = new THREE.Scene(); const environment = buildEnvironment(scene, 'high');
    const direction = new THREE.Vector3(0.4, 0.8, -0.3).normalize();
    environment.setSunDirection(direction);
    const basis = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), environment.sun.shadow.camera.up);
    const right = new THREE.Vector3().setFromMatrixColumn(basis, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(basis, 1);
    const texel = 160 / environment.sun.shadow.mapSize.x;
    const focus = direction.clone().multiplyScalar(100).addScaledVector(right, 80 * texel).addScaledVector(up, 64 * texel);
    const project = (target: THREE.Vector3): THREE.Vector3 => {
      environment.updateShadowFocus(target); scene.updateMatrixWorld(true);
      environment.sun.shadow.updateMatrices(environment.sun);
      return new THREE.Vector3(8, 3, -6).applyMatrix4(environment.sun.shadow.matrix);
    };
    const before = project(focus);
    const after = project(focus.clone().addScaledVector(right, texel * 0.2).addScaledVector(up, texel * 0.2));
    expect(after.x).toBeCloseTo(before.x, 10); expect(after.y).toBeCloseTo(before.y, 10);
    const stepped = project(focus.clone().addScaledVector(right, texel));
    expect(Math.abs(stepped.x - before.x)).toBeCloseTo(1 / environment.sun.shadow.mapSize.x, 10);
  });

  it('re-centres the last elevated focus when the sun or moon changes direction', () => {
    const scene = new THREE.Scene(); const environment = buildEnvironment(scene, 'high');
    const focus = new THREE.Vector3(-1200, 180, 730);
    environment.updateShadowFocus(focus);
    for (const direction of [new THREE.Vector3(1, 0.1, 0.4), new THREE.Vector3(-1, 0.8, 0.4)]) {
      environment.setSunDirection(direction);
      expect(environment.sun.target.position.distanceTo(focus)).toBeLessThan(0.06);
      expect(environment.sky.mesh.position.toArray()).toEqual(focus.toArray());
      const offset = environment.sun.position.clone().sub(environment.sun.target.position).normalize();
      expect(offset.distanceTo(direction.clone().normalize())).toBeLessThan(1e-10);
    }
  });
});
