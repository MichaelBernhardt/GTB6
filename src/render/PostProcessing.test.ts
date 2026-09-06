import { PerspectiveCamera, Scene, Vector2, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { describe, expect, it, vi } from 'vitest';
import { createPostProcessing, usesGtao } from './PostProcessing';

// Use the actual Three passes and targets: construction/disposal does not require a GL context.
const renderer = (maxSamples = 4): WebGLRenderer => ({
  getSize: (target: Vector2) => target.set(915, 412),
  getDrawingBufferSize: (target: Vector2) => target.set(1830, 824),
  getPixelRatio: () => 2,
  capabilities: { maxSamples },
}) as WebGLRenderer;

describe('post-processing quality budget', () => {
  it('reserves the full-scene GTAO passes for the opt-in Ultra tier', () => {
    expect(usesGtao('medium')).toBe(false);
    expect(usesGtao('high')).toBe(false);
    expect(usesGtao('ultra')).toBe(true);
  });

  it('uses the current renderer size and respects the driver multisample limit', async () => {
    const stack = await createPostProcessing(renderer(1), new Scene(), new PerspectiveCamera(), 'high');
    expect(stack.composer.renderTarget1.width).toBe(1830);
    expect(stack.composer.renderTarget1.height).toBe(824);
    expect(stack.composer.renderTarget1.samples).toBe(1);
    expect(stack.composer.renderTarget2.samples).toBe(1);
    stack.dispose();
  });

  it('releases Ultra targets and the shader materials omitted by the installed GTAO disposer once', async () => {
    const stack = await createPostProcessing(renderer(), new Scene(), new PerspectiveCamera(), 'ultra');
    const bloom = stack.composer.passes.find((pass) => pass instanceof UnrealBloomPass)!;
    const resources = [stack.composer.renderTarget1, stack.composer.renderTarget2,
      stack.gtao!.gtaoRenderTarget, stack.gtao!.pdRenderTarget, stack.gtao!.gtaoMaterial, stack.gtao!.blendMaterial,
      bloom.materialHighPassFilter];
    const disposed = resources.map((resource) => { const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener; });
    stack.dispose(); stack.dispose();
    for (const listener of disposed) expect(listener).toHaveBeenCalledOnce();
  });

  it('releases already-created passes and buffers when a later pass fails to initialise', async () => {
    const failure = new Error('Bloom resize failed');
    const released = vi.spyOn(EffectComposer.prototype, 'dispose');
    const bloomReleased = vi.spyOn(UnrealBloomPass.prototype, 'dispose');
    const resize = vi.spyOn(UnrealBloomPass.prototype, 'setSize').mockImplementation(() => { throw failure; });
    try {
      await expect(createPostProcessing(renderer(), new Scene(), new PerspectiveCamera(), 'ultra')).rejects.toBe(failure);
      expect(released).toHaveBeenCalledOnce();
      expect(bloomReleased).toHaveBeenCalledOnce();
    } finally {
      resize.mockRestore(); released.mockRestore(); bloomReleased.mockRestore();
    }
  });
});
