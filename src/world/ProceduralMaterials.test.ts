import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyUrbanGroundShader, facadeWindowGrammar, facadeWorldTile, GRIME_ATLAS_CELLS, GRIME_TAG_CELLS_BY_CLASS, GRIME_TAG_CLASSES, grimeTagClass, SIGN_NIGHT_EMISSIVE, SIGN_RETRO_BOOST, gennySignEmissiveIntensity, signAtlasLayout, signDiffuseScale, signEmissiveIntensity, signSlotIndex, type GrimeTagClass } from './ProceduralMaterials';
import { STREET_SIGN_JUNCTIONS } from './mapData';

describe('facade physical grammars', () => {
  it('uses compact floor tiles for houses and broad tall bays for factories', () => {
    expect(facadeWorldTile(6).height).toBeLessThan(10);
    expect(facadeWorldTile(10).width).toBeGreaterThan(facadeWorldTile(6).width);
    expect(facadeWorldTile(10).height).toBeGreaterThan(facadeWorldTile(6).height);
  });

  it('gives each building family a recognisable window language', () => {
    expect(facadeWindowGrammar(0)).toBe('punched');
    expect(facadeWindowGrammar(1)).toBe('strip');
    expect(facadeWindowGrammar(6)).toBe('barred');
    expect(facadeWindowGrammar(7)).toBe('curtained');
    expect(facadeWindowGrammar(10)).toBe('clerestory');
    expect(facadeWindowGrammar(-1)).toBe('clerestory');
  });
});

/**
 * The colour classification is MEASURED data about a binary asset, not taste, and the planner
 * weights the whole city off it (planGrimeDecals picks a class first and a cell second). Nothing at
 * runtime can catch it drifting out of step with the sheet — a wrong entry just quietly paints the
 * CBD the wrong colour — so the table's own invariants are pinned here. If the generated sheet is
 * ever re-rendered, re-measure the p98 chroma per cell and update BOTH the table and its comment.
 */
describe('grime tag colour classification (the measured mono/colour/piece split of the atlas)', () => {
  it('classifies every tag cell, and only the tag cells', () => {
    const tagCells = GRIME_ATLAS_CELLS.filter((cell) => cell.kind === 'tag');
    expect(GRIME_TAG_CLASSES).toHaveLength(tagCells.length);
    for (let cell = 0; cell < GRIME_ATLAS_CELLS.length; cell++) {
      const expected = GRIME_ATLAS_CELLS[cell]!.kind === 'tag';
      expect(grimeTagClass(cell) !== undefined, `cell ${cell}`).toBe(expected);
    }
    expect(grimeTagClass(99)).toBeUndefined();
  });

  it('holds the shipped sheet\'s measured 4 mono / 2 colour / 2 piece split', () => {
    // Measured off public/textures/graffiti-tags-gpt.png: cells 0/1/4/6 are p98 chroma <= 43
    // (white, black, white-black bubble, dark-olive bubble); 3/7 carry a teal at chroma 151/164;
    // 2/5 carry the largest saturated masses (chroma 228 red, 176 teal) and earn the piece tier.
    expect(GRIME_TAG_CELLS_BY_CLASS.mono).toEqual([0, 1, 4, 6]);
    expect(GRIME_TAG_CELLS_BY_CLASS.colour).toEqual([3, 7]);
    expect(GRIME_TAG_CELLS_BY_CLASS.piece).toEqual([2, 5]);
  });

  it('keeps at least two cells in every class, so no class repeats one image citywide', () => {
    const classes: GrimeTagClass[] = ['mono', 'colour', 'piece'];
    const seen = new Set<number>();
    for (const cls of classes) {
      expect(GRIME_TAG_CELLS_BY_CLASS[cls].length, cls).toBeGreaterThanOrEqual(2);
      for (const cell of GRIME_TAG_CELLS_BY_CLASS[cls]) {
        expect(seen.has(cell), `cell ${cell} in two classes`).toBe(false);
        seen.add(cell);
      }
    }
    expect(seen.size).toBe(GRIME_TAG_CLASSES.length); // the pools partition the tag band exactly
  });
});

describe('sign atlas capacity', () => {
  it('holds every unique sign the map needs, with headroom (no wrap-and-overwrite)', () => {
    const names = new Set<string>();
    for (const j of STREET_SIGN_JUNCTIONS) { if (j.roadA) names.add(j.roadA); if (j.roadB) names.add(j.roadB); }
    const { capacity } = signAtlasLayout();
    // ~372 unique street names + the shop/model/vehicle boards (~100). If the atlas can't hold them all it
    // wraps, and early signs (JOZI ARMS, street names) get overwritten with someone else's text.
    expect(capacity).toBeGreaterThan(names.size + 120);
  });
});

describe('sign glow ramp (BUG: boards stayed full-bright through load shedding, at any distance)', () => {
  it('glows at full atlas brightness on a healthy-grid night — the unchanged readable look', () => {
    expect(signEmissiveIntensity(1, 0)).toBe(SIGN_NIGHT_EMISSIVE);
  });

  it('sinks with the eased blackout factor and lands fully dark when shedding bites', () => {
    expect(signEmissiveIntensity(1, 0.5)).toBeCloseTo(SIGN_NIGHT_EMISSIVE * 0.5); // mid-fade tracks the same 3s ramp as the sky
    expect(signEmissiveIntensity(1, 1)).toBe(0); // no glow at ANY distance — only the torch/headlights reveal a board
  });

  it('stays off by day, shedding or not (the sun lights the boards through the diffuse face)', () => {
    expect(signEmissiveIntensity(0, 0)).toBe(0);
    expect(signEmissiveIntensity(0, 1)).toBe(0); // daytime load shedding changes nothing, like applyBlackout
  });

  it('keeps the genny boards lit right through a blackout — the forecourt is the lit thing on a dark street', () => {
    // A filling station runs a generator, and a red fuel gauge in a load-shedding night is exactly
    // when the player needs to SEE one. Its pylon board therefore ignores the blackout factor.
    expect(gennySignEmissiveIntensity(1)).toBe(SIGN_NIGHT_EMISSIVE);
    expect(gennySignEmissiveIntensity(1)).toBeGreaterThan(signEmissiveIntensity(1, 1));
    expect(gennySignEmissiveIntensity(1)).toBeGreaterThan(signEmissiveIntensity(1, 0.5));
    expect(gennySignEmissiveIntensity(0)).toBe(0); // still nothing by day — the sun does that job
  });

  it('boosts the diffuse response only in a night blackout — the retro-reflective pop under a beam', () => {
    expect(signDiffuseScale(1, 0)).toBe(1); // normal night: face untouched
    expect(signDiffuseScale(0, 1)).toBe(1); // day: face untouched
    expect(signDiffuseScale(1, 1)).toBeCloseTo(1 + SIGN_RETRO_BOOST);
    expect(signDiffuseScale(1, 0.5)).toBeGreaterThan(1); // ramps in with the same blackout factor, no second clock
  });
});

describe('signSlotIndex — an allocated slot is never overwritten', () => {
  const { capacity } = signAtlasLayout();

  it('gives each sign a distinct slot until the atlas is full', () => {
    const seen = new Set<number>();
    for (let order = 0; order < capacity - 1; order++) seen.add(signSlotIndex(order, capacity));
    expect(seen.size).toBe(capacity - 1); // all distinct — no two signs share a slot
    expect(signSlotIndex(0, capacity)).toBe(0);
    expect(signSlotIndex(capacity - 2, capacity)).toBe(capacity - 2);
  });

  it('parks every overflow sign on the last slot, never back over slot 0 (which would clobber JOZI ARMS)', () => {
    expect(signSlotIndex(capacity - 1, capacity)).toBe(capacity - 1);
    expect(signSlotIndex(capacity, capacity)).toBe(capacity - 1);
    expect(signSlotIndex(capacity + 9999, capacity)).toBe(capacity - 1);
    expect(signSlotIndex(capacity + 9999, capacity)).not.toBe(0);
  });
});

/**
 * The urban-ground pass is shader-only and stacks on whatever the ground material already wears
 * (the lawn macro pass, then the altitude rock/snow band). Chained onBeforeCompile hooks are easy
 * to get wrong in exactly two ways — dropping the prior hook, and sharing a program cache key with
 * an unrelated variant — so both are pinned here rather than left to a screenshot.
 */
describe('applyUrbanGroundShader — downtown is dust, not lawn', () => {
  const material = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial();
  const compile = (mat: THREE.MeshStandardMaterial): { vertexShader: string; fragmentShader: string } => {
    const shader = {
      vertexShader: 'void main() {\n#include <common>\n#include <begin_vertex>\n}',
      fragmentShader: 'void main() {\n#include <common>\n#include <color_fragment>\n}',
      uniforms: {},
    };
    mat.onBeforeCompile!(shader as never, undefined as never);
    return shader;
  };

  it('runs a prior hook and then tints, so it composes with the lawn/snow passes', () => {
    const mat = material();
    let priorRan = false;
    mat.onBeforeCompile = () => { priorRan = true; };
    applyUrbanGroundShader(mat, [{ x: 100, z: -200, radius: 500 }]);
    const shader = compile(mat);
    expect(priorRan).toBe(true);
    expect(shader.vertexShader).toContain('vUrbWorld');
    expect(shader.fragmentShader).toContain('urbTone');
    // The anchor survives, so a later pass (applySnowShader) can still find it.
    expect(shader.fragmentShader).toContain('#include <color_fragment>');
  });

  it('keys its program per site list, and does nothing at all without sites', () => {
    const one = material(); applyUrbanGroundShader(one, [{ x: 0, z: 0, radius: 500 }]);
    const two = material(); applyUrbanGroundShader(two, [{ x: 900, z: 0, radius: 500 }]);
    expect(one.customProgramCacheKey!()).not.toBe(two.customProgramCacheKey!());
    const none = material(); applyUrbanGroundShader(none, []);
    expect(none.onBeforeCompile).toBe(THREE.MeshStandardMaterial.prototype.onBeforeCompile);
  });
});
