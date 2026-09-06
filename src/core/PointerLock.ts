/** Browsers expose promise-returning, legacy void-returning, or no pointer-lock API. Denials and
 * relock cooldowns are normal; they must not throw from Start/Resume or a canvas click. */
export function requestGamePointerLock(element: HTMLElement): void {
  try { void Promise.resolve(element.requestPointerLock?.()).catch(() => undefined); }
  catch { /* A synchronous browser denial leaves the standing click-to-lock action available. */ }
}
