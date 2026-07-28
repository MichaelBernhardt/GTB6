import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D4 regression guard: "large empty unlit areas".
 *
 * Unit tests never construct City or DayNight (both need a GL context), so the bug this guards
 * against is invisible to the rest of the suite. It was this: City creates one facade material per
 * `style-facadeIndex` pair, LAZILY, the first time a chunk containing that pair streams in — and
 * DayNight took a one-time snapshot of that map in its constructor and animated only the members of
 * the snapshot. Every style/variant pair first built after boot therefore kept the emissiveIntensity
 * of 0 it was constructed with, permanently. Measured in-engine at 22:00 on the Vaalpunt shore, the
 * towns out there rendered as unlit black slabs while the CBD lit up normally: 65-72% of the near
 * ground and frontage under 40/255 against 0-6% for the same shot inside the city.
 *
 * Two invariants keep it fixed, and they must BOTH hold — either one alone leaves a hole:
 *   1. the cycle pushes a LEVEL into City rather than walking a captured list, and
 *   2. a facade material born later is constructed already carrying that level.
 */
const here = dirname(fileURLToPath(import.meta.url));
const city = readFileSync(join(here, 'City.ts'), 'utf8');
const dayNight = readFileSync(join(here, 'DayNight.ts'), 'utf8');

describe('lit windows survive chunk streaming (D4)', () => {
  it('drives window glow through a City setter, never a snapshot of the material map', () => {
    expect(dayNight).toContain('this.city.setFacadeGlow(');
    // A captured array of facade materials is the bug itself: the map it was copied from grows.
    expect(dayNight).not.toMatch(/facades\s*=\s*city\.facadeMaterials\(\)/);
    expect(dayNight).not.toMatch(/for\s*\(const material of this\.facades\)/);
  });

  it('remembers the level and applies it to every material, present and future', () => {
    expect(city).toMatch(/setFacadeGlow\(intensity: number\): void \{/);
    expect(city).toContain('this.facadeGlow = intensity;');
    expect(city).toMatch(/for \(const material of this\.buildingMaterial\.values\(\)\) material\.emissiveIntensity = intensity;/);
    // ...and the lazy cache seeds new materials from it rather than from a hard 0.
    const creation = city.slice(city.indexOf('let facade = this.buildingMaterial.get(materialKey)'));
    const line = creation.slice(0, creation.indexOf('this.buildingMaterial.set(materialKey, facade)'));
    expect(line).toContain('emissiveIntensity: this.facadeGlow');
    expect(line).not.toContain('emissiveIntensity: 0');
  });
});
