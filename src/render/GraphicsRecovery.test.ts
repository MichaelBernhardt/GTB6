import { describe, expect, it, vi } from 'vitest';
import { GraphicsRecovery } from './GraphicsRecovery';

function harness(rebuild = vi.fn(async () => {})) {
  const canvas = new EventTarget();
  const actions = { pause: vi.fn(), rebuild, resume: vi.fn(), changed: vi.fn() };
  const recovery = new GraphicsRecovery(canvas, actions);
  const lose = (): Event => { const event = new Event('webglcontextlost', { cancelable: true }); canvas.dispatchEvent(event); return event; };
  const restore = (): void => { canvas.dispatchEvent(new Event('webglcontextrestored')); };
  return { canvas, actions, recovery, lose, restore };
}
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('graphics context recovery', () => {
  it('pauses once, rebuilds the GPU state, and waits for Continue before simulation resumes', async () => {
    const h = harness();
    expect(h.lose().defaultPrevented).toBe(true); h.lose();
    expect(h.actions.pause).toHaveBeenCalledOnce();
    expect(h.recovery.suspended).toBe(true);
    h.recovery.resume(); expect(h.actions.resume).not.toHaveBeenCalled();
    h.restore(); h.restore(); await settle();
    expect(h.actions.rebuild).toHaveBeenCalledOnce();
    expect(h.recovery.state).toBe('ready'); expect(h.recovery.suspended).toBe(true);
    h.recovery.resume(); h.recovery.resume();
    expect(h.actions.resume).toHaveBeenCalledOnce(); expect(h.recovery.suspended).toBe(false);
  });

  it('cannot resume an old restoration after another context loss', async () => {
    const pending: Array<() => void> = [];
    const h = harness(vi.fn(() => new Promise<void>((resolve) => pending.push(resolve))));
    h.lose(); h.restore();
    h.lose(); pending[0]!(); await settle();
    expect(h.recovery.state).toBe('lost');
    h.restore(); pending[1]!(); await settle();
    expect(h.recovery.state).toBe('ready');
  });

  it('offers reload after rebuilding fails and ignores later graphics events', async () => {
    const error = new Error('GPU resource recreation failed');
    const h = harness(vi.fn(async () => { throw error; }));
    h.lose(); h.restore(); await settle();
    expect(h.recovery.state).toBe('failed');
    expect(h.actions.changed).toHaveBeenLastCalledWith('failed', error);
    h.restore(); h.recovery.resume(); h.lose(); await settle();
    expect(h.recovery.state).toBe('failed'); expect(h.actions.resume).not.toHaveBeenCalled();
  });

  it('reports a fatal frame once and prevents an in-flight restoration from clearing it', async () => {
    let finish!: () => void;
    const h = harness(vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })));
    h.lose(); h.restore();
    const error = new Error('frame failed'); h.recovery.fail(error); h.recovery.fail(new Error('cascade'));
    finish(); await settle();
    expect(h.recovery.state).toBe('failed');
    expect(h.actions.changed.mock.calls.filter(([state]) => state === 'failed')).toHaveLength(1);
    expect(h.actions.changed).toHaveBeenLastCalledWith('failed', error);
  });

  it('detaches listeners and ignores an asynchronous completion after disposal', async () => {
    let finish!: () => void;
    const h = harness(vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })));
    h.lose(); h.restore(); h.recovery.dispose();
    finish(); await settle();
    expect(h.actions.changed).not.toHaveBeenCalledWith('ready', undefined);
    expect(h.lose().defaultPrevented).toBe(false);
    h.recovery.resume(); expect(h.actions.resume).not.toHaveBeenCalled();
  });
});
