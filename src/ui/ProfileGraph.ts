/** A tiny scrolling stacked-area chart of the game loop's per-frame cost, drawn on a small canvas.
 *
 *  Each frame pushes one 1px-wide column at the right edge and scrolls the history left, so the graph reads as a
 *  live oscilloscope of where time goes. Within a column the phases (render, traffic, …) stack bottom-up, each in
 *  its own colour, so the column's total height is the whole loop's cost. A horizontal reference line marks the
 *  60fps budget (100%): a stack that stays below the line is comfortably inside frame; a stack that pokes above it
 *  means the CPU work alone can't hold 60fps that frame. The vertical scale runs 0–200% of budget, so the target
 *  line sits at mid-height with a full budget of headroom above it before the trace clips. */

/** Fixed phase → colour map. Stable so a phase keeps its colour across frames and matches the legend. Any phase
 *  not listed (e.g. a future bucket) falls back to a neutral grey rather than going invisible. */
export const PHASE_COLORS: Record<string, string> = {
  render: '#5aa9ff', // blue — GPU submission / post
  traffic: '#ffa94d', // orange — population + nav
  police: '#ff6b6b', // red — police AI
  combat: '#ffd43b', // yellow — bullets, projectiles, FX, collisions
  world: '#51cf66', // green — city / day-night / living-city sims
  player: '#3bc9db', // cyan — on-foot / vehicle control
  camera: '#b197fc', // purple — camera smoothing + HUD build
  culling: '#adb5bd', // grey — shadow focus + chunk visibility
  online: '#f783ac', // pink — multiplayer step
};
const FALLBACK_COLOR = '#e5e7eb';
const BG = 'rgba(17, 24, 23, .86)'; // matches the .hud-fps chip so the graph reads as part of the same panel
const TARGET_LINE = 'rgba(255, 255, 255, .55)';
const MAX_PCT = 200; // canvas top = 200% of the 60fps budget; the 100% target line lands at mid-height

export class ProfileGraph {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w: number;
  private readonly h: number;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.w = canvas.width;
    this.h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ProfileGraph: 2D canvas context unavailable');
    this.ctx = ctx;
    this.reset();
  }

  private targetY(): number { return this.h - (100 / MAX_PCT) * this.h; }

  /** Blank the canvas back to background + a full-width target line. Called on creation and whenever the graph is
   *  re-shown, so a hidden gap doesn't leave a frozen smear scrolling back into view. */
  reset(): void {
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.ctx.fillStyle = TARGET_LINE;
    this.ctx.fillRect(0, Math.round(this.targetY()), this.w, 1);
  }

  /** Scroll left by one pixel and draw this frame's stacked column at the right edge. `sample` is the raw
   *  per-phase percentages in stable order (phases stack in array order, bottom-up). */
  push(sample: { name: string; pct: number }[]): void {
    this.ctx.drawImage(this.canvas, -1, 0); // cheap scroll: shift the whole trace one column left
    const x = this.w - 1;
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(x, 0, 1, this.h); // clear the incoming column (the drawImage left a stale duplicate here)
    const scale = this.h / MAX_PCT;
    let y = this.h;
    for (const phase of sample) {
      const segH = phase.pct * scale;
      if (segH <= 0) continue;
      this.ctx.fillStyle = PHASE_COLORS[phase.name] ?? FALLBACK_COLOR;
      this.ctx.fillRect(x, y - segH, 1, segH);
      y -= segH;
    }
    this.ctx.fillStyle = TARGET_LINE; // redraw the target pixel on top so the 100% line stays continuous
    this.ctx.fillRect(x, Math.round(this.targetY()), 1, 1);
  }
}
