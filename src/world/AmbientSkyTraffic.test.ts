import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAmbientSkyTraffic, SKY_TRAFFIC_COUNT, SKY_TRAFFIC_SPAN, skyTrafficPose } from './AmbientSkyTraffic';

describe('ambient sky traffic', () => {
  it('moves deterministically along a wrapping player-relative flight lane', () => {
    const focus = new THREE.Vector3(100, 20, -80); const a = { x: 0, y: 0, z: 0, heading: 0 }; const b = { ...a };
    skyTrafficPose(0, 0, focus, a); skyTrafficPose(0, SKY_TRAFFIC_SPAN / 34, focus, b);
    expect(a.y).toBe(360);
    expect(b.x).toBeCloseTo(a.x); expect(b.z).toBeCloseTo(a.z); // one full lane traversal wraps cleanly
    skyTrafficPose(0, 1, focus, b);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(34);
  });

  it('scales aircraft count by quality and hides the flights at night', () => {
    const traffic = createAmbientSkyTraffic('high'); const focus = new THREE.Vector3(); const sun = new THREE.Color(0xffddaa);
    traffic.setMood(focus, 4, 0, sun);
    expect(traffic.aircraft.filter((plane) => plane.visible)).toHaveLength(SKY_TRAFFIC_COUNT.high);
    traffic.setQuality('low');
    expect(traffic.aircraft.filter((plane) => plane.visible)).toHaveLength(SKY_TRAFFIC_COUNT.low);
    traffic.setMood(focus, 5, 0, sun);
    expect(traffic.aircraft.filter((plane) => plane.visible)).toHaveLength(SKY_TRAFFIC_COUNT.low);
    traffic.setMood(focus, 6, 1, sun);
    expect(traffic.aircraft.every((plane) => !plane.visible)).toBe(true);
  });

  it('builds readable silhouettes with twin contrails', () => {
    const traffic = createAmbientSkyTraffic('medium');
    expect(traffic.group.name).toBe('Ambient Sky Traffic');
    expect(traffic.aircraft[0]!.children.filter((child) => child instanceof THREE.Mesh)).toHaveLength(6);
  });
});
