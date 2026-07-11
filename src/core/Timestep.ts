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

/** Slices a frame's elapsed time into simulation steps: each at most SIM_STEP_MAX, at most SIM_CATCHUP_STEPS
 *  of them, surplus discarded. The slices sum to min(rawDt, cap), so distance covered per real second is
 *  frame-rate independent within the catch-up window. */
export function simSteps(rawDt: number): number[] {
  const total = Math.min(Math.max(rawDt, 0), SIM_STEP_MAX * SIM_CATCHUP_STEPS);
  const steps: number[] = [];
  for (let remaining = total; remaining > 1e-9; remaining -= SIM_STEP_MAX) steps.push(Math.min(remaining, SIM_STEP_MAX));
  return steps;
}
