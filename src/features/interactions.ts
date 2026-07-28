import type { InteractionCtx, InteractionDescriptor, InteractionOffer } from './types';

/**
 * The ordered interaction ladder, as pure functions.
 *
 * The repo has a known shipped bug class: the E key handler and the HUD prompt band are two
 * independent if/else chains that must agree, and once didn't ("E Speak to contact" showed while E
 * did nothing). The fix is structural rather than disciplinary — `act()` is literally `resolve()`
 * followed by running the winner's `act`, so the prompt on screen always belongs to the branch the
 * key will take. Both Game ladders call the same resolver with the same context.
 *
 * The prompt string is ALSO parsed by parsePromptActions (src/ui/TouchModels.ts) to build the mobile
 * context pills, which is why promptKey() exists and interactions.test.ts asserts every registered
 * descriptor yields a pill.
 */

/** Stable ordering: `order` ascending, ties broken on id so two features never race. */
export function sortInteractions(descriptors: readonly InteractionDescriptor[]): InteractionDescriptor[] {
  return [...descriptors].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** First descriptor in the given context that offers something. Returns the descriptor too, so the
 *  caller can tell an eager stand-in from a loaded feature's own rung. */
export function resolveInteraction(
  descriptors: readonly InteractionDescriptor[],
  ctx: InteractionCtx,
): { descriptor: InteractionDescriptor; offer: InteractionOffer } | undefined {
  for (const descriptor of sortInteractions(descriptors)) {
    if (descriptor.context !== ctx.context) continue;
    const offer = descriptor.test(ctx);
    if (offer) return { descriptor, offer };
  }
  return undefined;
}

/** The key token a prompt promises, or undefined when the prompt is malformed. Mirrors the segment
 *  grammar parsePromptActions expects: `<KEY><two spaces><label>`, segments joined by ` · `. */
export function promptKey(prompt: string): string | undefined {
  const match = /^\s*([A-Z]+)\s{2,}(\S.*?)\s*$/.exec(prompt.split('·')[0] ?? '');
  return match ? match[1] : undefined;
}
