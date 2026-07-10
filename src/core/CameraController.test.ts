import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';
import { CameraController } from './CameraController';

const city = { collides: () => false } as unknown as City;
const input = (mouseDX: number, mouseDY: number): InputManager => ({ mouseDX, mouseDY, firing: false }) as InputManager;

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
