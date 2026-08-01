export type FearResponse = 'calm' | 'fight' | 'flee' | 'cower';
export interface FearEvent { base: number; radius: number; }

/**
 * FEAR COMES FROM VIOLENCE, NEVER FROM THE SIGHT OF A WEAPON.
 *
 * The owner: "They shouldn't scare away at all unless actually shot at or punched. Seeing a gun or
 * whatever spooks them now is not enough."
 *
 * That is a rule about this table, so the table enforces it: every entry below is a thing that
 * HAPPENED — a round went off, a body hit the pavement, someone was struck, a car came through.
 * There is no entry for a gun being drawn, held, aimed or carried past, and nothing broadcasts
 * one, because a player walking a street with a pistol out is not doing anything to anybody.
 * The cost of getting this wrong is the whole street: peds who scatter on approach cannot be
 * talked to, hailed, mugged, guarded by, or bought from, so a passive-sight fear source silently
 * deletes every pedestrian interaction within its radius.
 *
 * If you are about to add an event here, ask: did something happen TO someone? If the answer is
 * "the player was holding a gun", it does not belong in this table — see DRAWN_ON_ME_FEAR for the
 * one and only place a firearm frightens anyone, and note that it is not broadcast either.
 */
export const FEAR_EVENTS = {
  gunshot: { base: 34, radius: 48 },
  sniperShot: { base: 42, radius: 84 }, // a rifle crack carries: witnesses well beyond a pistol's earshot

  kill: { base: 62, radius: 58 },
  assault: { base: 42, radius: 24 },
  body: { base: 22, radius: 10 },
  panic: { base: 16, radius: 12 }, // contagion: a shrieking ped spooks bystanders a little
} as const satisfies Record<string, FearEvent>;

/**
 * The single exception, and it is not a sight: someone who is CURRENTLY PUNCHING THE PLAYER sees
 * the player's firearm come out mid-fight and breaks off (Pedestrian.updateMotion). That is an
 * event in a fight they started, aimed at them personally, so it is applied to that one attacker
 * by hand — deliberately a bare number rather than a FearEvent, because a FearEvent is a thing
 * `broadcastFear` can scatter a street with and this must never be one. Sized above
 * FLEE_THRESHOLD so the break is decisive, below `kill` so a raised gun is not a murder.
 */
export const DRAWN_ON_ME_FEAR = 45;

export const FEAR_MAX = 100;
export const FLEE_THRESHOLD = 35;
export const COWER_THRESHOLD = 85;
export const CALM_THRESHOLD = 12;
export const FEAR_DECAY_RATE = 5;
export const BRAVE_FIGHT = 0.85;
export const TIMID_COWER = 0.25;

export function fearContribution(event: FearEvent, distance: number): number {
  if (distance >= event.radius) return 0;
  return event.base * (1 - distance / event.radius);
}

export function accumulateFear(current: number, amount: number): number {
  return Math.min(FEAR_MAX, Math.max(0, current + Math.max(0, amount)));
}

export function decayFear(current: number, dt: number): number {
  return Math.max(0, current - FEAR_DECAY_RATE * dt);
}

/**
 * PEOPLE WHOSE STANDING STILL IS THE ACTIVITY — and the answer to "everyone gets scared of me and
 * runs away". Two kinds of person qualify, for the same reason and through this one cap.
 *
 * THE PICKET. Nothing registered the player as a threat; the ordinary fear machine did its job and
 * the job was wrong for this one place. A protest crowd is ten people standing shoulder to shoulder in
 * the road, so walking into it BUMPS someone; a second bump inside BUMP_WINDOW reads as `assault`
 * (42 ≥ FLEE_THRESHOLD) and that one person bolts; `spreadPanic` then hands every neighbour up to
 * `panic` (16) each and three fleeing neighbours is 48. The crowd scatters in about two seconds and
 * the fault is not any single number — it is that nobody had ever said these particular people came
 * here on purpose.
 *
 * THE FIXTURE (`Pedestrian.scripted`) — the dealer under the orange column, the worker under the
 * purple one, the forecourt attendant, the golf pro, the yard guard. A feature puts a marker over a
 * person and tells the player to walk to it, which makes leaving the marker a BROKEN PROMISE rather
 * than a reaction: the column stays lit over an empty slab and the `E  Talk to …` rung, resolved from
 * the ped's live position, goes with them. Removing the sight-of-a-gun fear was necessary but not
 * sufficient — a pistol fired anywhere inside `gunshot`'s 48-unit radius still cleared every corner
 * within earshot, so one shot across the road un-staffed a corner the player was walking to. Their
 * job is to be found where the marker says.
 *
 * So neither gets an immunity, they get a NERVE. Fear still accumulates (the value moves, the threat
 * is remembered, the moment the hold breaks it is already there to act on) but it is held below the
 * flee threshold. That covers the bumping, the panicking bystander and the bang two streets away with
 * one rule instead of four exemptions — and it leaves `takeDamage`/`knockdown`/`mug`, which set fear
 * DIRECTLY rather than through this path, free to break it. So the line is exactly the owner's:
 * ambient violence is noise you stand through, and being personally shot, punched, floored or robbed
 * is not. Attacking someone is what ends it.
 */
export const HOLD_GROUND_CAP = FLEE_THRESHOLD - 1;

export function holdGroundFear(current: number, amount: number): number {
  return Math.min(HOLD_GROUND_CAP, accumulateFear(current, amount));
}

/**
 * Which player-on-pedestrian contact counts as an ATTACK — for everyone: the picket's solidarity,
 * the witness sweep, and JMPD's blotter alike. The owner's rule is "unless I actually attack
 * someone", and a shove is not an attack: a protest is people packed shoulder to shoulder, so
 * walking through your own picket trips the bump-escalation — and both consequences of routing
 * that through reportCrime were wrong in turn. First the witness sweep revoked the crowd's
 * solidarity (the player un-joined his own protest by arriving in it); then, with the sweep
 * exempted but the heat kept, the police shot him over a shoulder-bump once two stars accrued.
 * So a bump files NOTHING until a body goes down. Knockdown and kill only come from a sprint,
 * which is the honest line between barging and trampling — and fear still broadcasts either way,
 * because being barged is frightening even when it isn't criminal.
 */
export function bumpIsAttack(bump: { knockdown: boolean; killed: boolean }): boolean {
  return bump.knockdown || bump.killed;
}

export function fearResponse(fear: number, aggressive: boolean, bravery: number, fleeing = false): FearResponse {
  if (fear < FLEE_THRESHOLD) return 'calm';
  if (aggressive || bravery >= BRAVE_FIGHT) return 'fight';
  if (!fleeing && fear >= COWER_THRESHOLD && bravery <= TIMID_COWER) return 'cower';
  return 'flee';
}
