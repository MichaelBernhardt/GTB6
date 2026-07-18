import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAtmosphericSky, SKY_DOME_RADIUS, type SkyMood } from './AtmosphericSky';

function mood(): SkyMood {
  return {
    zenith: new THREE.Color(0x123456),
    horizon: new THREE.Color(0x654321),
    sunColor: new THREE.Color(0xffaa55),
    sunDirection: new THREE.Vector3(1, 2, 3).normalize(),
    moonDirection: new THREE.Vector3(-1, -2, -3).normalize(),
    night: 0.75,
    blackout: 0.4,
    time: 12.5,
  };
}

describe('atmospheric sky', () => {
  it('builds one inward-facing dome outside the playable horizon', () => {
    const sky = createAtmosphericSky('high');
    expect(sky.mesh.geometry.parameters.radius).toBe(SKY_DOME_RADIUS);
    expect(sky.material.side).toBe(THREE.BackSide);
    expect(sky.material.depthWrite).toBe(false);
    expect(sky.material.depthTest).toBe(false);
    expect(sky.mesh.frustumCulled).toBe(false);
  });

  it('copies a day/night mood into shader uniforms', () => {
    const sky = createAtmosphericSky('medium'); const next = mood();
    sky.setMood(next);
    expect((sky.material.uniforms.uZenithColor!.value as THREE.Color).getHex()).toBe(next.zenith.getHex());
    expect((sky.material.uniforms.uHorizonColor!.value as THREE.Color).getHex()).toBe(next.horizon.getHex());
    expect((sky.material.uniforms.uSunDirection!.value as THREE.Vector3).toArray()).toEqual(next.sunDirection.toArray());
    expect(sky.material.uniforms.uNight!.value).toBe(0.75);
    expect(sky.material.uniforms.uBlackout!.value).toBe(0.4);
    expect(sky.material.uniforms.uTime!.value).toBe(12.5);

    next.zenith.setHex(0xffffff); // uniforms own their values; later sample reuse cannot mutate them by alias
    expect((sky.material.uniforms.uZenithColor!.value as THREE.Color).getHex()).toBe(0x123456);
  });

  it('reduces procedural cloud work by quality tier', () => {
    expect(createAtmosphericSky('low').material.fragmentShader).toContain('octave < 2');
    expect(createAtmosphericSky('medium').material.fragmentShader).toContain('octave < 3');
    expect(createAtmosphericSky('high').material.fragmentShader).toContain('octave < 4');

    const sky = createAtmosphericSky('high'); sky.setQuality('low');
    expect(sky.material.fragmentShader).toContain('octave < 2');
  });

  it('renders distinct dimensional cumulus and high cirrus layers', () => {
    const shader = createAtmosphericSky('high').material.fragmentShader;
    expect(shader).toContain('float lowerBase = cloudNoise');
    expect(shader).toContain('vec3 cloudShadow');
    expect(shader).toContain('float cirrusField');
  });
});
