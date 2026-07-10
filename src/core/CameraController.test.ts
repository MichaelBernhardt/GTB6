import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';
import { CameraController } from './CameraController';

const city = { collides: () => false } as unknown as City;
const input = (mouseDX: number, mouseDY: number, firing = false): InputManager => ({ mouseDX, mouseDY, firing }) as InputManager;

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
  const settle = (controller: CameraController, camera: THREE.PerspectiveCamera, target: THREE.Vector3, firing: boolean): THREE.Vector3 => {
    for (let i = 0; i < 240; i++) controller.update(1 / 60, input(0, 0, firing), target, city);
    return camera.position.clone();
  };

  it('pulls the camera closer while firing on foot', () => {
    const target = new THREE.Vector3();
    const walkCamera = new THREE.PerspectiveCamera();
    const walkPosition = settle(new CameraController(walkCamera), walkCamera, target, false);
    const aimCamera = new THREE.PerspectiveCamera();
    const aimPosition = settle(new CameraController(aimCamera), aimCamera, target, true);
    expect(aimPosition.distanceTo(target)).toBeLessThan(walkPosition.distanceTo(target));
  });

  it('keeps the player offset from screen center even when not firing', () => {
    const target = new THREE.Vector3();
    const camera = new THREE.PerspectiveCamera();
    settle(new CameraController(camera), camera, target, false);
    camera.updateMatrixWorld();
    const projected = target.clone().add(new THREE.Vector3(0, 1.45, 0)).project(camera);
    expect(Math.abs(projected.x)).toBeGreaterThan(0.05);
  });
});
