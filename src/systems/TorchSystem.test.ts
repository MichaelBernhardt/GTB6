import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TORCH_CHEST_HEIGHT, TORCH_FP_FORWARD, TORCH_INTENSITY, TORCH_RANGE, TorchSystem } from './TorchSystem';

const rig = (): { camera: THREE.PerspectiveCamera; torch: TorchSystem } => {
  const camera = new THREE.PerspectiveCamera();
  return { camera, torch: new TorchSystem(new THREE.Scene()) };
};

describe('torch toggle', () => {
  it('starts pocketed and flips per press', () => {
    const { torch } = rig();
    expect(torch.on).toBe(false); // never persisted — off every session
    expect(torch.toggle()).toBe(true); expect(torch.on).toBe(true);
    expect(torch.toggle()).toBe(false); expect(torch.on).toBe(false);
  });

  it('stays dark while off, and while disabled (online) even when on', () => {
    const { camera, torch } = rig();
    torch.frame(camera, new THREE.Vector3(), false, true);
    expect(torch.spot.intensity).toBe(0);
    torch.toggle(); torch.frame(camera, new THREE.Vector3(), false, false);
    expect(torch.spot.intensity).toBe(0);
    torch.frame(camera, new THREE.Vector3(), false, true);
    expect(torch.spot.intensity).toBe(TORCH_INTENSITY);
  });
});

describe('torch aim', () => {
  it('third person: beam rises from the carrier chest and targets the point centre-screen aims at', () => {
    const { camera, torch } = rig();
    camera.position.set(0, 5, 10); camera.lookAt(0, 5, -100); // free-look straight down -z
    torch.toggle(); torch.frame(camera, new THREE.Vector3(2, 0, 4), false, true);
    expect(torch.spot.position.x).toBeCloseTo(2); expect(torch.spot.position.y).toBeCloseTo(TORCH_CHEST_HEIGHT); expect(torch.spot.position.z).toBeCloseTo(4);
    expect(torch.spot.target.position.x).toBeCloseTo(0); expect(torch.spot.target.position.y).toBeCloseTo(5); expect(torch.spot.target.position.z).toBeCloseTo(10 - TORCH_RANGE);
  });

  it('first person: beam starts just ahead of the eye so the cone never clips the near plane', () => {
    const { camera, torch } = rig();
    camera.position.set(1, 1.6, 0); camera.lookAt(1 + 50, 1.6, 0); // looking down +x
    torch.toggle(); torch.frame(camera, new THREE.Vector3(1, 0, 0), true, true);
    expect(torch.spot.position.x).toBeCloseTo(1 + TORCH_FP_FORWARD); expect(torch.spot.position.y).toBeCloseTo(1.6);
    expect(torch.spot.target.position.x).toBeCloseTo(1 + TORCH_RANGE);
  });
});
