export type GraphicsState = 'running' | 'lost' | 'restoring' | 'ready' | 'failed';

interface RecoveryActions {
  pause(): void;
  rebuild(): Promise<void>;
  resume(): void;
  changed(state: GraphicsState, error?: unknown): void;
}

/** A lost context suspends both drawing and simulation. Restoration rebuilds generated GPU targets,
 * then waits for an explicit Continue so a restored frame cannot immediately move/fire for the player. */
export class GraphicsRecovery {
  state: GraphicsState = 'running';
  private generation = 0;
  private disposed = false;
  private terminal = false;

  constructor(private canvas: EventTarget, private actions: RecoveryActions) {
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  get suspended(): boolean { return this.state !== 'running'; }

  private change(state: GraphicsState, error?: unknown): void {
    this.state = state;
    this.actions.changed(state, error);
  }

  private onLost = (event: Event): void => {
    event.preventDefault(); // opt into browser restoration
    if (this.disposed || this.terminal || this.state === 'lost') return;
    this.generation++;
    if (!this.suspended) this.actions.pause();
    this.change('lost');
  };

  private onRestored = (): void => { void this.restore(); };

  private async restore(): Promise<void> {
    if (this.disposed || this.terminal || this.state !== 'lost') return;
    const generation = this.generation;
    this.change('restoring');
    try {
      await this.actions.rebuild();
      if (!this.disposed && generation === this.generation) this.change('ready');
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.fail(error);
    }
  }

  resume(): void {
    if (this.disposed || this.state !== 'ready') return;
    this.actions.resume();
    this.change('running');
  }

  /** Stop a failing frame loop once, retaining a readable reload action instead of throwing on
   * every animation frame. A context-restored event must never resume a failed simulation. */
  fail(error: unknown): void {
    if (this.disposed || this.terminal) return;
    this.terminal = true;
    this.generation++;
    if (!this.suspended) this.actions.pause();
    this.change('failed', error);
  }

  dispose(): void {
    this.disposed = true; this.generation++;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
  }
}
