import { ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';
import { guardPooledLightLoops } from './PooledLightShader';

describe('pooled-light shader guards', () => {
  it('supports the installed Three chunk while retaining shadows, spot maps and all light loops', () => {
    const source = ShaderChunk.lights_fragment_begin;
    const guarded = guardPooledLightLoops(source);
    expect(guarded).not.toBe(source);
    for (const light of ['pointLight', 'spotLight']) expect(guarded).toContain(`if ( ${light}.color != vec3( 0.0 ) )`);
    expect(guarded.match(/if \( directLight.visible \)/g)).toHaveLength(2);
    for (const token of ['getPointShadow(', 'getShadow(', 'spotLightMap[', 'getDirectionalLightInfo(', 'RE_Direct_RectArea(']) {
      expect(guarded.split(token).length).toBe(source.split(token).length);
    }
    expect(guarded.match(/#pragma unroll_loop_start/g)?.length).toBe(source.match(/#pragma unroll_loop_start/g)?.length);
    expect(guarded.match(/#pragma unroll_loop_end/g)?.length).toBe(source.match(/#pragma unroll_loop_end/g)?.length);
  });

  it('is idempotent and leaves an unsupported upstream layout intact', () => {
    const source = ShaderChunk.lights_fragment_begin;
    const guarded = guardPooledLightLoops(source);
    expect(guardPooledLightLoops(guarded)).toBe(guarded);
    const changed = source.replace('spotLight = spotLights[ i ];', 'spotLight = nextSpot();');
    expect(guardPooledLightLoops(changed)).toBe(changed);
    expect(guardPooledLightLoops('void main() {}')).toBe('void main() {}');
  });
});
