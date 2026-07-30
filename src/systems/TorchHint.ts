/**
 * Teaching the torch key — ONE derived condition, ONE call site.
 *
 * The hint used to be a pair of `notify` calls bolted onto the load-shedding event handler, which
 * only ever covered the two orders the author happened to think of (outage lands at night; night
 * falls mid-outage) and burned its once-per-session flag even when the player was driving with
 * headlights on, indoors, or on a train — after which the key was never taught again. That is why it
 * "went away".
 *
 * So the shape here is a state machine over a DERIVED condition sampled every sim step, not a hint
 * call per path. "Dark and shedding, torch off, on foot under the open sky, eyes on the world" is
 * true however the player arrived — the outage starting, dusk arriving, stepping out of a car, off a
 * train, out of an interior, closing the map — so no path can be missed and no new path needs new
 * hint code.
 *
 * The nag budget (patience is a resource):
 *  - It fires on the RISING EDGE, once per outage at most (it re-arms only when the darkness lifts).
 *  - TORCH_HINT_MAX_SHOWS caps the whole session: one nudge, one second chance, then silence.
 *  - Lighting the torch even once retires it for good — a player who found L does not need telling.
 *  - The condition must HOLD for TORCH_HINT_SETTLE_SECONDS before it speaks. That keeps the toast off
 *    the back of the "Load shedding: Stage 4" toast it would otherwise overwrite (the HUD has one
 *    toast slot and the blackout takes BLACKOUT_FADE_SECONDS to actually get dark), and it stops a
 *    momentary car exit or a passing menu from spending a showing.
 */

/** Blackout darkness (eased blackout × nightFactor) past which a torch is genuinely worth having.
 *  Below BlackoutStealth's 0.6 on purpose: the hint should arrive as the street goes dark, not once
 *  it is dark enough to hide in. Daytime shedding is darkness 0, so it never fires. */
export const TORCH_HINT_DARKNESS = 0.5;

/** How long the condition must hold before the hint speaks. Tuned against BLACKOUT_FADE_SECONDS (3)
 *  and TOAST_MS (4000): an outage that starts at full night crosses the darkness threshold ~1.5 s in,
 *  so the hint lands ~4 s in — as the Stage 4 toast retires, rather than stamping over it. */
export const TORCH_HINT_SETTLE_SECONDS = 2.5;

/** Showings per session. Two: one for the first dark street, one for the next outage in case the
 *  first arrived mid-firefight. After that the player has been told, and telling them again is noise. */
export const TORCH_HINT_MAX_SHOWS = 2;

/** Everything the hint needs to know about the world this step. All of it is already computed for
 *  other reasons — nothing here exists solely to feed the hint. */
export interface TorchHintWorld {
  /** LoadSheddingSystem.active: the grid is down. */
  readonly shedding: boolean;
  /** DayNightSystem.blackoutDarkness — eased blackout × nightFactor, so daytime shedding is 0. */
  readonly darkness: number;
  /** The torch is already lit: there is nothing left to teach. */
  readonly torchOn: boolean;
  /** On foot under the open sky, where a torch is the only light there is: not driving (headlights
   *  own the road), not mid vehicle transition, not flying or under a canopy, not on a train, not
   *  inside a shop/safehouse/building interior (they keep their own ambient), not in PvP. */
  readonly exposed: boolean;
  /** Eyes on the world: no map, console or menu over the top. A toast behind an overlay teaches
   *  nobody, and spending a showing on one is exactly how the hint went missing before. */
  readonly watching: boolean;
}

/** The dark half of the condition: load shedding AND real darkness. Split out because it also drives
 *  re-arming — when this goes false the outage (or the night) is over and the next one gets a turn. */
export function darkAndShedding(world: TorchHintWorld): boolean {
  return world.shedding && world.darkness > TORCH_HINT_DARKNESS;
}

/** Is the hint useful to this player, right now? The full derived condition, minus the timing. */
export function torchHintUseful(world: TorchHintWorld): boolean {
  return darkAndShedding(world) && !world.torchOn && world.exposed && world.watching;
}

export class TorchHint {
  /** One showing per outage: consumed when shown, restored when the darkness lifts. */
  private armed = true;
  /** Seconds the full condition has held continuously. */
  private held = 0;
  private shows = 0;
  private retired = false;

  /** Showings spent this session — the HUD does not use it; the tests and the console do. */
  get shown(): number { return this.shows; }
  /** True once the hint will never speak again this session. */
  get finished(): boolean { return this.retired || this.shows >= TORCH_HINT_MAX_SHOWS; }

  /** Call every sim step. Returns true on the single step the hint should be shown. */
  update(dt: number, world: TorchHintWorld): boolean {
    if (!darkAndShedding(world)) { this.armed = true; this.held = 0; return false; } // grid back, or dawn: re-arm for the next dark outage
    if (this.finished || !this.armed) { this.held = 0; return false; }
    if (!torchHintUseful(world)) { this.held = 0; return false; } // driving, indoors, torch already lit, map open — wait, do NOT spend the showing
    this.held += dt;
    if (this.held < TORCH_HINT_SETTLE_SECONDS) return false;
    this.held = 0; this.armed = false; this.shows += 1;
    return true;
  }

  /** The player lit the torch. They know the key — retire the hint for the session. */
  learned(): void { this.retired = true; }
}

/** The toast copy. Phones have a permanent ⚡ torch button in the utility cluster (TouchControls), so
 *  a hint that names a keyboard key is useless there — and prompt-parsed pills (parsePromptActions)
 *  only cover the E-ladder prompt band, not toasts. Name the control the player actually has. */
export function torchHintToast(touch: boolean): { title: string; detail: string } {
  return {
    title: 'Pitch dark',
    detail: touch ? 'No street lights tonight. Tap ⚡ for your torch.' : 'No street lights tonight. L for torch.',
  };
}
