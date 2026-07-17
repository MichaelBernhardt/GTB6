import type { DialogueScript } from '../systems/DialogueSystem';
import type { MissionDefinition } from '../systems/MissionSystem';

/**
 * Face-to-face mission intros: 3–6 line exchanges played by the DialogueSystem when the
 * player talks to a contact. Finishing the exchange accepts the job; walking away declines.
 * Missions without an entry fall back to a single line built from their `intro` copy.
 */
export const INTRO_DIALOGUES: Readonly<Record<string, DialogueScript>> = {
  'delivery-run': { id: 'delivery-run:intro', lines: [
    { speaker: 'Auntie Portia', text: 'Howzit boet. Sold the couch on Marketplace, but eish — the bakkie is gone. Gone!' },
    { speaker: 'You', text: 'Gone like stolen, Auntie, or gone like Uncle Sipho borrowed it?' },
    { speaker: 'Auntie Portia', text: 'Same thing, my laaitie. Take my yellow Citi Golf. Three drops, sharp sharp, before the buyers change their minds.' },
    { speaker: 'Auntie Portia', text: 'And the couch fits in a Citi Golf. It fits. Don\'t start with me.' },
  ] },
  'hot-property': { id: 'hot-property:intro', lines: [
    { speaker: 'Bra Vusi', text: 'Yoh, my friend, perfect timing. There\'s a red GTI on Commissioner Street. Boot FULL of municipal cable.' },
    { speaker: 'You', text: 'Fell off a substation, did it?' },
    { speaker: 'Bra Vusi', text: 'Tripped and fell, swear on my mother. Bring it to the Braamfontein lock-up once the heat fades. Vrrr phaa — but gently, né?' },
  ] },
  'dockside-signal': { id: 'dockside-signal:intro', lines: [
    { speaker: 'Candice', text: 'Ag no man. The Wemmer crew took our route permit. TOOK it. Off the seat of Ricardo\'s taxi.' },
    { speaker: 'You', text: 'And you want it back politely?' },
    { speaker: 'Candice', text: 'I want it back TODAY. Go moer them, grab the permit, bring it here to the braai kiosk. I\'ll have a plate for you. Sharp?' },
  ] },
  'arms-deal': { id: 'arms-deal:intro', lines: [
    { speaker: 'Thandi', text: 'Two crews want tonight\'s shipment. I can pay you to keep the shop standing.' },
    { speaker: 'Thandi', text: 'Or you take the stock yourself and get rich. I\'m not going to pretend you haven\'t thought it.' },
    { speaker: 'Thandi', text: 'Either way, the CBD will remember what you do tonight.' },
  ] },
};

export function introScript(mission: MissionDefinition): DialogueScript {
  return INTRO_DIALOGUES[mission.id] ?? { id: `${mission.id}:intro`, lines: [{ speaker: mission.contact, text: mission.intro }] };
}
