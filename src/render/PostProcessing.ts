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

/** GTAO redraws scene depth/normals and roughly doubles submissions in the dense city. High keeps the
 *  much cheaper bloom/output stack; Ultra is the explicit opt-in tier for maximum-cost AO. */
export function usesGtao(quality: PostProcessingQuality): boolean { return quality === 'ultra'; }

/** Build the optional post stack. This module is dynamically imported only for medium-or-better
 *  quality; GTAO has a second boundary because only Ultra opts into its full-scene extra passes. */
export async function createPostProcessing(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  quality: PostProcessingQuality,
): Promise<PostProcessingStack> {
  // Resolve optional code before owning GPU targets. A failed lazy import used to leave an
  // unreachable composer behind on every retry/quality change.
  const aoModule = usesGtao(quality) ? await import('three/addons/postprocessing/GTAOPass.js') : undefined;
  const size = renderer.getDrawingBufferSize(new Vector2());
  const composer = new EffectComposer(renderer);
  let gtao: GTAOPass | undefined;
  let bloom: UnrealBloomPass | undefined;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // EffectComposer owns its render targets but not every pass target. Three r178 also omits
    // GTAO's main/blend materials and bloom's high-pass filter from their dispose methods.
    for (const pass of composer.passes) pass.dispose();
    gtao?.gtaoMaterial.dispose(); gtao?.blendMaterial.dispose();
    bloom?.materialHighPassFilter.dispose();
    composer.dispose();
  };
  try {
    // Ultra already supersamples. Two MSAA samples retain edge stability without the redundant
    // four-sample HDR/depth buffers that made its largest windows particularly prone to GPU OOM.
    const samples = Math.min(2, renderer.capabilities.maxSamples);
    composer.renderTarget1.samples = samples; composer.renderTarget2.samples = samples;
    // Keep post targets in physical pixels. Resizes then need one setSize call, avoiding the
    // old setPixelRatio + setSize pair that rebuilt all pass targets twice on a DPR change.
    composer.setPixelRatio(1);
    composer.setSize(size.width, size.height);
    composer.addPass(new RenderPass(scene, camera));
    if (aoModule) {
      gtao = new aoModule.GTAOPass(scene, camera, size.width, size.height);
      composer.addPass(gtao);
      gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 2, thickness: 1 }); gtao.blendIntensity = 0.9;
    }
    bloom = new UnrealBloomPass(size, 0.32, 0.45, 0.85);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return { composer, gtao, dispose };
  } catch (error) {
    dispose(); // a later pass failing must not strand the earlier passes and HDR buffers
    throw error;
  }
}
