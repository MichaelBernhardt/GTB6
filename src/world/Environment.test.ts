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
});
