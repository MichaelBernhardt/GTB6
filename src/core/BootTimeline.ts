/** Boot checkpoint timeline: every boot stage records (label, ms since navigation). Cheap enough
 *  to stay on in production — the boot error card prints the tail so a stuck mobile boot reports
 *  WHERE it died, and dev builds expose the whole thing as window.__bootTimeline. */
export interface BootMarkEntry { label: string; at: number }

export const bootTimeline: BootMarkEntry[] = [];

export function bootMark(label: string): void {
  bootTimeline.push({ label, at: Math.round(performance.now()) });
}

/** The last few checkpoints, newest last — the error card's "it died after X" breadcrumb. */
export function bootTimelineTail(count = 4): string {
  return bootTimeline.slice(-count).map((entry) => `${entry.label} +${entry.at}ms`).join(' → ');
}
