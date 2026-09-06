import { describe, expect, it, vi } from 'vitest';
import { requestGamePointerLock } from './PointerLock';

describe('optional pointer lock', () => {
  it('accepts modern, legacy and unavailable browser APIs', async () => {
    for (const request of [vi.fn(() => Promise.resolve()), vi.fn(() => undefined), undefined]) {
      const element = { requestPointerLock: request } as unknown as HTMLElement;
      expect(() => requestGamePointerLock(element)).not.toThrow();
      if (request) expect(request).toHaveBeenCalledOnce();
    }
    await Promise.resolve();
  });

  it('handles asynchronous and synchronous denials and keeps the native receiver', async () => {
    const denied = { requestPointerLock: vi.fn(() => Promise.reject(new Error('relock cooldown'))) } as unknown as HTMLElement;
    expect(() => requestGamePointerLock(denied)).not.toThrow();
    const element = { requestPointerLock() { expect(this).toBe(element); throw new Error('not permitted'); } } as unknown as HTMLElement;
    expect(() => requestGamePointerLock(element)).not.toThrow();
    await Promise.resolve();
  });
});
