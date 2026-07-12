/** Decouples simulation time from render frames. The old loop fed `min(rawDt, 0.05)` straight into update(),
 *  so any frame slower than 20fps silently ran the world below real time (walking through the CBD at 15fps felt
 *  like wading through syrup). Instead the elapsed wall-clock time is sliced into sub-steps no larger than the
 *  physics-stable clamp and the world is stepped once per slice: fewer rendered frames, full-speed simulation. */

/** Largest single step the simulation ever takes — the same 50ms ceiling the old clamp enforced, so collision,
 *  AI and vehicle physics never see a coarser step than they were tuned (and known stable) at. */
export const SIM_STEP_MAX = 0.05;

/** Catch-up ceiling per rendered frame. Four slices keep real time down to 5fps; past that (tab restore, GC
 *  monster hitch) the surplus is dropped — a one-off skip beats a slow-motion crawl or a death spiral where
 *  catch-up work makes the next frame even later. */
export const SIM_CATCHUP_STEPS = 4;

/** Real wall-clock a single rendered frame is allowed to spend on catch-up sub-steps before the surplus is
 *  dropped. The fixed ceiling above bounds how far behind we let the clock fall; this bounds how much CPU we
 *  burn trying to catch up, which is what actually breaks the death spiral: when one sim step already costs a
 *  big fraction of the frame budget, running four of them per frame keeps every frame past the 50ms threshold
 *  that demanded the catch-up in the first place, so the step count ratchets to the ceiling and never comes
 *  back down — the world locks at <10fps sitting still. Capping catch-up by measured cost means a slow machine
 *  simply runs the world a hair slow under sustained overload (self-healing) instead of spiralling. */
export const SIM_CATCHUP_BUDGET_MS = 40;

/** How many of a frame's planned sub-steps to actually run, given the measured cost of one step (ms). Fast
 *  enough to fit several in the budget → full catch-up (frame-rate-independent motion, as intended). Too slow
 *  → clamps toward one step, trading a touch of slow-motion for a frame that can recover. Zero/unknown cost
 *  (first frame) allows the full ceiling; it self-corrects after one measured step. */
export function maxCatchupSteps(stepCostMs: number): number {
  if (!(stepCostMs > 0)) return SIM_CATCHUP_STEPS;
  return Math.max(1, Math.min(SIM_CATCHUP_STEPS, Math.floor(SIM_CATCHUP_BUDGET_MS / stepCostMs)));
}

/** Slices a frame's elapsed time into simulation steps: each at most SIM_STEP_MAX, at most SIM_CATCHUP_STEPS
 *  of them, surplus discarded. The slices sum to min(rawDt, cap), so distance covered per real second is
 *  frame-rate independent within the catch-up window. */
export function simSteps(rawDt: number): number[] {
  const total = Math.min(Math.max(rawDt, 0), SIM_STEP_MAX * SIM_CATCHUP_STEPS);
  const steps: number[] = [];
  for (let remaining = total; remaining > 1e-9; remaining -= SIM_STEP_MAX) steps.push(Math.min(remaining, SIM_STEP_MAX));
  return steps;
}
