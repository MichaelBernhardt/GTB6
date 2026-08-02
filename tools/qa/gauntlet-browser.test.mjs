import { describe, expect, it } from 'vitest';
import { assessFixedRuns, parseArguments, profileUrl, sidecarPath } from './gauntlet-browser.mjs';

function run(id, p95, p99, census = { meshes: 10, traffic: 15 }) {
  return {
    file: `/tmp/run-${id}.json`,
    payload: {
      profiles: [{
        role: 'fixed', pacing: 'native-rAF', frameTimeGateEligible: true, frames: 2,
        dtMs: { p95, p99 }, rawSamples: [{ dt: 16 }, { dt: 17 }],
        sceneCensus: { stable: true, start: census, end: census },
        readiness: { start: { ready: true }, end: { ready: true } },
      }],
    },
    sidecar: {
      artifact: { sha256: `artifact-${id}` },
      setup: { sha256: 'same-setup' },
      revision: { revision: 'abc123', dirtyHash: 'same-tree' },
    },
  };
}

describe('Gauntlet browser evidence contract', () => {
  it('resolves fixed defaults while preserving explicit negative coordinates', () => {
    const options = parseArguments(['profile', '--url', 'http://127.0.0.1:5173/', '--out', 'run.json', '--x', '-430', '--z', '820']);
    expect(options).toMatchObject({ command: 'profile', width: 1920, height: 1080, x: -430, z: 820, seed: 424242, world: 2000, detail: 500, buildings: 1100 });
    const url = new URL(profileUrl(options));
    expect(url.searchParams.get('profile')).toBe('fixed');
    expect(url.searchParams.get('x')).toBe('-430');
    expect(url.searchParams.has('fastraf')).toBe(false);
  });

  it('requires an explicit throughput acknowledgement for fastraf URLs', () => {
    const options = parseArguments(['profile', '--url', 'http://localhost/?fastraf', '--out', 'run.json', '--x', '0', '--z', '0']);
    expect(() => profileUrl(options)).toThrow(/--throughput/);
    expect(new URL(profileUrl({ ...options, throughput: true })).searchParams.has('fastraf')).toBe(true);
  });

  it('uses an unambiguous sidecar suffix for JSON evidence', () => {
    expect(sidecarPath('/tmp/frame.png')).toBe('/tmp/frame.png.json');
    expect(sidecarPath('/tmp/profile.json')).toBe('/tmp/profile.json.meta.json');
  });

  it('marks three identical native fixed runs eligible only inside the five-percent band', () => {
    const eligible = assessFixedRuns([run(1, 20, 30), run(2, 20.5, 31), run(3, 20.8, 31.4)]);
    expect(eligible.eligibleToRegenerateBaseline).toBe(true);
    expect(eligible.reasons).toEqual([]);

    const unstable = assessFixedRuns([run(1, 20, 30), run(2, 20.5, 31), run(3, 21.2, 33, { meshes: 11, traffic: 15 })]);
    expect(unstable.eligibleToRegenerateBaseline).toBe(false);
    expect(unstable.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('scene census differs'),
      expect.stringContaining('p95 spread exceeds 5%'),
      expect.stringContaining('p99 spread exceeds 5%'),
    ]));
  });
});
