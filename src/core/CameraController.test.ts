import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';
import { aimedViewDistance, CameraController, cycleView, sanitizeView, viewDistance, DEFAULT_CAMERA_VIEW } from './CameraController';

const city = { collides: () => false } as unknown as City;
const input = (mouseDX: number, mouseDY: number, aiming = false): InputManager => ({ mouseDX, mouseDY, firing: false, aiming }) as InputManager;

describe('CameraController mouse look', () => {
  it('tilts down when the mouse moves down and up when it moves up', () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    const target = new THREE.Vector3();
    controller.update(1 / 60, input(0, 20), target, city, false, 0.01);
    expect(controller.pitch).toBeCloseTo(0.55);
    controller.update(1 / 60, input(0, -20), target, city, false, 0.01);
    expect(controller.pitch).toBeCloseTo(0.35);
  });

  it('retains the vertical orbit limits', () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    const target = new THREE.Vector3();
    controller.update(1 / 60, input(0, 10_000), target, city);
    expect(controller.pitch).toBe(0.9);
    controller.update(1 / 60, input(0, -10_000), target, city);
    expect(controller.pitch).toBe(-0.1);
  });
});

describe('CameraController over-the-shoulder aim', () => {
  const settle = (controller: CameraController, camera: THREE.PerspectiveCamera, target: THREE.Vector3, aiming: boolean): THREE.Vector3 => {
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0, aiming), target, city);
    return camera.position.clone();
  };

  it('pulls the camera closer while aiming on foot', () => {
    const target = new THREE.Vector3();
    const walkCamera = new THREE.PerspectiveCamera();
    const walkPosition = settle(new CameraController(walkCamera), walkCamera, target, false);
    const aimCamera = new THREE.PerspectiveCamera();
    const aimPosition = settle(new CameraController(aimCamera), aimCamera, target, true);
    expect(aimPosition.distanceTo(target)).toBeLessThan(walkPosition.distanceTo(target));
  });

  it('centers the player when relaxed and shifts over the shoulder while aiming', () => {
    const target = new THREE.Vector3();
    const camera = new THREE.PerspectiveCamera();
    const controller = new CameraController(camera);
    settle(controller, camera, target, false);
    camera.updateMatrixWorld();
    const centered = target.clone().add(new THREE.Vector3(0, 1.45, 0)).project(camera);
    expect(Math.abs(centered.x)).toBeLessThan(0.02);
    settle(controller, camera, target, true);
    camera.updateMatrixWorld();
    const offset = target.clone().add(new THREE.Vector3(0, 1.78, 0)).project(camera);
    expect(Math.abs(offset.x)).toBeGreaterThan(0.05);
  });
});

describe('camera view cycle', () => {
  it('wraps First person -> Near -> Medium -> Far -> First person', () => {
    expect(cycleView(0)).toBe(1);
    expect(cycleView(1)).toBe(2);
    expect(cycleView(2)).toBe(3);
    expect(cycleView(3)).toBe(0);
  });

  it('sanitizes invalid views to Medium and keeps valid ones', () => {
    for (const bad of [undefined, null, -1, 4, 1.5, '2', Number.NaN]) expect(sanitizeView(bad)).toBe(DEFAULT_CAMERA_VIEW);
    for (const good of [0, 1, 2, 3]) expect(sanitizeView(good)).toBe(good);
  });

  it('selects the base distance per view and mode', () => {
    expect([1, 2, 3].map((view) => viewDistance(view, false))).toEqual([4.2, 6.35, 9.5]);
    expect([1, 2, 3].map((view) => viewDistance(view, true))).toEqual([7.5, 10.5, 15]);
    expect(viewDistance(99, true)).toBe(10.5);
    expect(viewDistance(0, false)).toBe(0);
  });

  it('zooms Medium/Far aim in to the Near distance and leaves Near and first person alone', () => {
    expect(aimedViewDistance(2, false, 1)).toBe(4.2);
    expect(aimedViewDistance(3, false, 1)).toBe(4.2);
    expect(aimedViewDistance(1, false, 1)).toBe(4.2);
    expect(aimedViewDistance(0, false, 1)).toBe(0);
    expect(aimedViewDistance(2, true, 1)).toBe(7.5);
    expect(aimedViewDistance(3, true, 1)).toBe(7.5);
    expect(aimedViewDistance(1, true, 0.5)).toBe(7.5);
  });

  it('keeps the base distance with no aim blend and interpolates between', () => {
    expect(aimedViewDistance(3, false, 0)).toBe(9.5);
    expect(aimedViewDistance(3, false, 0.5)).toBeCloseTo((9.5 + 4.2) / 2);
  });
});

describe('camera views in the world', () => {
  const settleView = (view: number, vehicle = false, firing = false): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(60, 1);
    const controller = new CameraController(camera);
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0, firing), new THREE.Vector3(), city, vehicle, 0.0025, view);
    return camera;
  };

  it('settles farther for larger third-person views', () => {
    const target = new THREE.Vector3();
    const foot = [1, 2, 3].map((view) => settleView(view).position.distanceTo(target));
    expect(foot[0]).toBeLessThan(foot[1]);
    expect(foot[1]).toBeLessThan(foot[2]);
    const driving = [1, 2, 3].map((view) => settleView(view, true).position.distanceTo(target));
    expect(driving[0]).toBeLessThan(driving[1]);
    expect(driving[1]).toBeLessThan(driving[2]);
  });

  it('still tightens the aim relative to the selected base distance', () => {
    const target = new THREE.Vector3();
    expect(settleView(3, false, true).position.distanceTo(target)).toBeLessThan(settleView(3).position.distanceTo(target));
  });

  it('puts the first-person camera at the player head on foot', () => {
    const camera = settleView(0);
    expect(camera.position.y).toBeCloseTo(1.62, 2);
    expect(Math.hypot(camera.position.x, camera.position.z)).toBeLessThan(0.01);
  });

  it('allows a wider pitch range in first person', () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    controller.update(1 / 60, input(0, 10_000), new THREE.Vector3(), city, false, 0.0025, 0);
    expect(controller.pitch).toBe(1.2);
    controller.update(1 / 60, input(0, -20_000), new THREE.Vector3(), city, false, 0.0025, 0);
    expect(controller.pitch).toBe(-1.2);
  });

  it('zooms the FOV while aiming in first person and restores it in third person', () => {
    const camera = new THREE.PerspectiveCamera(60, 1);
    const controller = new CameraController(camera);
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0, true), new THREE.Vector3(), city, false, 0.0025, 0);
    expect(camera.fov).toBeCloseTo(52, 0);
    controller.update(1 / 60, input(0, 0, false), new THREE.Vector3(), city, false, 0.0025, 2);
    expect(camera.fov).toBe(60);
  });

  it('locks the vehicle first-person view to the vehicle heading', () => {
    const controller = new CameraController(new THREE.PerspectiveCamera(60, 1));
    controller.update(1 / 60, input(0, 0), new THREE.Vector3(), city, true, 0.0025, 0, Math.PI / 2);
    expect(controller.yaw).toBeCloseTo(Math.PI * 1.5);
  });
});

describe('sniper scope camera', () => {
  const scopeSettle = (view: number, scopeFov: number): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(60, 1);
    const controller = new CameraController(camera);
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0, scopeFov > 0), new THREE.Vector3(), city, false, 0.0025, view, 0, true, 0, scopeFov);
    return camera;
  };

  it('snaps to the first-person eye and the scope FOV from any third-person view', () => {
    for (const view of [1, 2, 3]) {
      const camera = scopeSettle(view, 10);
      expect(camera.fov).toBe(10);
      expect(camera.position.y).toBeCloseTo(1.62, 2);
      expect(Math.hypot(camera.position.x, camera.position.z)).toBeLessThan(0.01);
    }
  });

  it('restores the chosen view and resting FOV once the scope drops', () => {
    const camera = new THREE.PerspectiveCamera(60, 1);
    const controller = new CameraController(camera);
    for (let i = 0; i < 60; i++) controller.update(1 / 60, input(0, 0, true), new THREE.Vector3(), city, false, 0.0025, 2, 0, true, 0, 4);
    expect(camera.fov).toBe(4);
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0), new THREE.Vector3(), city, false, 0.0025, 2);
    expect(camera.fov).toBe(60);
    expect(camera.position.distanceTo(new THREE.Vector3())).toBeGreaterThan(4); // back over the shoulder
  });

  it('kicks the pitch up on recoil and settles most of it back', () => {
    const controller = new CameraController(new THREE.PerspectiveCamera(60, 1));
    const before = controller.pitch;
    controller.recoil(0.05);
    expect(controller.pitch).toBeCloseTo(before - 0.05);
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0, true), new THREE.Vector3(), city, false, 0.0025, 0, 0, true, 0, 10);
    expect(controller.pitch).toBeGreaterThan(before - 0.05); // partially recovered
    expect(controller.pitch).toBeLessThan(before); // but the muzzle stays a touch high
  });
});
