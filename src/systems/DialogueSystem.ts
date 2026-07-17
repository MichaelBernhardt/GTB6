export interface DialogueLine { speaker: string; text: string; }
export interface DialogueScript { id: string; lines: DialogueLine[]; }

export type DialogueAdvance = 'line' | 'finished' | 'idle';

/**
 * Sequential speaker-attributed lines, advanced by the player (E/click). Non-pausing:
 * the game keeps simulating; the HUD shows the current line. Pure state machine — the
 * caller owns presentation, input routing, and the walk-away-abandons rule.
 */
export class DialogueSystem {
  private script?: DialogueScript;
  private index = 0;

  get active(): boolean { return this.script !== undefined; }
  get id(): string | undefined { return this.script?.id; }
  get line(): DialogueLine | undefined { return this.script?.lines[this.index]; }
  /** True while more lines follow the current one (drives the "E ▸" vs "E ✓" affordance). */
  get hasMore(): boolean { return this.script !== undefined && this.index < this.script.lines.length - 1; }

  /** Begin a script; a script already playing is not interrupted (returns false). Empty scripts don't start. */
  start(script: DialogueScript): boolean {
    if (this.script || script.lines.length === 0) return false;
    this.script = script; this.index = 0;
    return true;
  }

  /** Player pressed the advance key: step to the next line, or finish on the last one. */
  advance(): DialogueAdvance {
    if (!this.script) return 'idle';
    if (this.index < this.script.lines.length - 1) { this.index += 1; return 'line'; }
    this.script = undefined; this.index = 0;
    return 'finished';
  }

  /** Walked away / mission cancelled: drop the script without finishing it. */
  abandon(): void { this.script = undefined; this.index = 0; }
}
