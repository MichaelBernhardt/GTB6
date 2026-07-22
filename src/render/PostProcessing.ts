import { Vector2, type Camera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export type PostProcessingQuality = 'medium' | 'high' | 'ultra';

export interface PostProcessingStack {
  composer: EffectComposer;
  gtao?: GTAOPass;
  dispose(): void;
}

/** Build the optional post stack. This module is dynamically imported only for medium-or-better
 *  quality; GTAO has a second boundary because medium uses bloom/output but not ambient occlusion. */
export async function createPostProcessing(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  quality: PostProcessingQuality,
): Promise<PostProcessingStack> {
  const ultra = quality === 'ultra';
  const composer = new EffectComposer(renderer);
  // Two samples preserve edge stability while halving the multisample bandwidth/memory of the old 4x
  // full-screen half-float targets. Ultra stacks 4x MSAA on top of its 2x supersample.
  const samples = ultra ? 4 : 2;
  composer.renderTarget1.samples = samples; composer.renderTarget2.samples = samples;
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));

  let gtao: GTAOPass | undefined;
  if (quality === 'high' || ultra) {
    const module = await import('three/addons/postprocessing/GTAOPass.js');
    gtao = new module.GTAOPass(scene, camera, innerWidth, innerHeight);
    gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 2, thickness: 1 }); gtao.blendIntensity = 0.9;
    composer.addPass(gtao);
  }
  composer.addPass(new UnrealBloomPass(new Vector2(innerWidth, innerHeight), 0.32, 0.45, 0.85));
  composer.addPass(new OutputPass());

  return {
    composer,
    gtao,
    dispose: () => {
      // EffectComposer owns its render targets but not every pass target. Dispose both layers so
      // repeated settings changes cannot strand GTAO/bloom framebuffers in GPU memory.
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    },
  };
}
