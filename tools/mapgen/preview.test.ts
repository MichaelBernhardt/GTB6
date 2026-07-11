import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPreviewHtml, renderMapModuleJs, rendererHash, rendererVersion } from './preview';
import type { JoburgMap } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(readFileSync(resolve(HERE, '../../src/world/generated/joburg-map.json'), 'utf8')) as JoburgMap;
const rendererSource = readFileSync(resolve(HERE, '../../src/ui/mapRender.ts'), 'utf8');

describe('preview single-source renderer', () => {
  it('inlines the transpiled shared renderer verbatim (no fork-and-diverge)', () => {
    const html = buildPreviewHtml(map);
    // The emitted preview must contain the *current* transpiled src/ui/mapRender.ts, so the in-game
    // MapView and the dev preview always draw with the exact same code.
    expect(html).toContain(renderMapModuleJs());
    expect(html).toContain('function renderMap(');
    expect(html).toContain('function drawPlayerArrow(');
  });

  it('stamps the shared renderer version + source hash for drift detection', () => {
    const html = buildPreviewHtml(map);
    const expectedHash = createHash('sha256').update(rendererSource).digest('hex').slice(0, 12);
    expect(rendererHash()).toBe(expectedHash);
    expect(rendererVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(html).toContain(`mapRender v${rendererVersion()} sha256:${expectedHash}`);
  });

  it('does not leave any injection placeholders unresolved', () => {
    const html = buildPreviewHtml(map);
    expect(html).not.toContain('__MAP_DATA__');
    expect(html).not.toContain('__CURRENT_NETWORK__');
    expect(html).not.toContain('/*__RENDERER__*/');
  });
});
