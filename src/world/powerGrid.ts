import type * as THREE from 'three';

interface PoweredEntry {
  material: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;
  onColor: number;
  offColor: number;
  onEmissiveIntensity?: number;
}

const entries: PoweredEntry[] = [];
const listeners: Array<(on: boolean) => void> = [];
let powered = true;

const apply = (entry: PoweredEntry, on: boolean): void => {
  entry.material.color.setHex(on ? entry.onColor : entry.offColor);
  if (entry.onEmissiveIntensity !== undefined && 'emissiveIntensity' in entry.material) entry.material.emissiveIntensity = on ? entry.onEmissiveIntensity : 0;
};

export function registerPowered(material: PoweredEntry['material'], onColor: number, offColor = 0x1c2022): void {
  const entry: PoweredEntry = { material, onColor, offColor, onEmissiveIntensity: 'emissiveIntensity' in material ? material.emissiveIntensity : undefined };
  entries.push(entry);
  if (!powered) apply(entry, false);
}

export function onPowerChange(listener: (on: boolean) => void): void { listeners.push(listener); }

export function powerOn(): boolean { return powered; }

export function setPower(on: boolean): void {
  if (powered === on) return;
  powered = on;
  for (const entry of entries) apply(entry, on);
  for (const listener of listeners) listener(on);
}
