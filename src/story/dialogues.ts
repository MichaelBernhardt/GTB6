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
  'last-coach-home': { id: 'last-coach-home:intro', lines: [
    { speaker: 'Auntie Portia', text: 'Boet! Disaster. My nephew fell asleep on the Sandton train and got off without my rent bag.' },
    { speaker: 'You', text: 'Your rent was riding the train?' },
    { speaker: 'Auntie Portia', text: 'The vetkoek lady by Sandton Station is holding it. Ride out there — the TRAIN, boet, that bag doesn\'t trust cars — and bring it home.' },
  ] },
  'copper-wire-blues': { id: 'copper-wire-blues:intro', lines: [
    { speaker: 'Bra Vusi', text: 'That cable from the GTI? The buyer paid cash, no name, no yard. A man like that is worth knowing better.' },
    { speaker: 'You', text: 'So I go ask him nicely where he lives?' },
    { speaker: 'Bra Vusi', text: 'You ask NOTHING. His bakkie is up the block. When it moves, you move. Stay close, stay boring. I want that yard\'s address, not a funeral.' },
  ] },
  'rank-cold-war': { id: 'rank-cold-war:intro', lines: [
    { speaker: 'Candice', text: 'The Wemmer crew is leaning on my ranks now. MY ranks. Two stops on my route think Candice has gone soft.' },
    { speaker: 'You', text: 'And I\'m the hard part?' },
    { speaker: 'Candice', text: 'You\'re the van driver, sweetie. Drive my green van down the route, show the flag at both ranks, and if they get brave — moer them off my property. Bring my van back breathing.' },
  ] },
  'reading-signs': { id: 'reading-signs:intro', lines: [
    { speaker: 'Oupa Jakes', text: 'Thirty years I called the trains at Park Station. Platform two, the eight-fifteen, mind the gap. Now the city calls ME names. Hah.' },
    { speaker: 'You', text: 'And you\'re telling me this because…' },
    { speaker: 'Oupa Jakes', text: 'Because you look like someone who reads. Three riddles. No map. The streets of this city confess everything if you read their signs. Come back when you\'ve stood in all three places.' },
    { speaker: 'Oupa Jakes', text: 'Ask me again if you forget the words. My memory is the last thing still working.' },
  ] },
};

export function introScript(mission: MissionDefinition): DialogueScript {
  return INTRO_DIALOGUES[mission.id] ?? { id: `${mission.id}:intro`, lines: [{ speaker: mission.contact, text: mission.intro }] };
}
