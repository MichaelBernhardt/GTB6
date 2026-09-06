import { ShaderChunk } from 'three';

const MARKER = '// GTB pooled-light guards';

/** Light pools keep shader counts stable when a shot or explosion fires. Three still evaluates a
 * complete PBR light contribution for their zero-intensity slots. Uniform branches skip idle slots;
 * the visibility branch also skips BRDF work outside an active light's cone/range. */
export function guardPooledLightLoops(source: string): string {
  if (source.includes(MARKER)) return source;
  let result = source;
  for (const [light, info] of [['pointLight', 'getPointLightInfo'], ['spotLight', 'getSpotLightInfo']]) {
    const assignment = `\t\t${light} = ${light}s[ i ];`;
    const call = `${info}( ${light}, geometryPosition, directLight );`;
    const start = result.indexOf(assignment);
    const end = result.indexOf('\n\t}\n\t#pragma unroll_loop_end', start);
    const query = result.indexOf(call, start);
    // An upstream chunk change must fall back to ordinary lighting, never emit a broken shader.
    if (start < 0 || end < 0 || query < start || query > end) return source;
    result = result.slice(0, end) + '\n\t\t}\n\t\t}' + result.slice(end);
    result = result.replace(assignment, `${assignment}\n\t\tif ( ${light}.color != vec3( 0.0 ) ) {`);
    result = result.replace(call, `${call}\n\t\tif ( directLight.visible ) {`);
  }
  return `${MARKER}\n${result}`;
}

/** Install before any material compiles, including the environment-map bake. All later streamed
 * materials inherit the same shader; light colour/intensity changes never invalidate its program. */
export function installPooledLightGuards(): void {
  ShaderChunk.lights_fragment_begin = guardPooledLightLoops(ShaderChunk.lights_fragment_begin);
}
