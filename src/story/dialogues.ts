import type { DialogueScript } from '../systems/DialogueSystem';
import type { MissionDefinition } from '../systems/MissionSystem';

/**
 * Face-to-face mission intros: 3–6 line exchanges played by the DialogueSystem when the
 * player talks to a contact. Finishing the exchange accepts the job; walking away declines.
 * Missions without an entry fall back to a single line built from their `intro` copy.
 */
export const INTRO_DIALOGUES: Readonly<Record<string, DialogueScript>> = {
  'delivery-run': { id: 'delivery-run:intro', lines: [
    { speaker: 'Auntie Portia', text: 'Howzit boet. Sold the couch online, but the pickup is gone. GONE.' },
    { speaker: 'You', text: 'A couch. In a Citi Golf?' },
    { speaker: 'Auntie Portia', text: 'It FITS. Two drops, right away — not later, NOW. The buyers change their minds like traffic lights change to red.' },
    { speaker: 'Auntie Portia', text: 'And if the lights go while you drive, don\'t stop at the dead traffic lights. Nobody else does.' },
  ] },
  'hot-property': { id: 'hot-property:intro', lines: [
    { speaker: 'Bra Vusi', text: 'Portia\'s driver! Perfect timing. There\'s a red GTI on Commissioner Street, boot FULL of municipal cable — the thick stuff, off the Ophirton feeder.' },
    { speaker: 'You', text: 'The feeder that keeps tripping?' },
    { speaker: 'Bra Vusi', text: 'Keeps tripping, keeps getting stripped, keeps getting paid for. A beautiful circle, née? Bring the car to my Braamfontein lock-up when the heat fades — but gently.' },
  ] },
  'dockside-signal': { id: 'dockside-signal:intro', lines: [
    { speaker: 'Candice', text: 'Ag no man. The Wemmer crew took our route permit. TOOK it. Off the seat of Ricardo\'s taxi.' },
    { speaker: 'You', text: 'And you want it back politely?' },
    { speaker: 'Candice', text: 'I want it back TODAY. Go deal with them, grab the permit, bring it back to me here at the rank. I\'ll have a plate for you. Deal?' },
  ] },
  'arms-deal': { id: 'arms-deal:intro', lines: [
    { speaker: 'Thandi', text: 'Two crews want tonight\'s shipment. I can pay you to keep the shop standing — or you take the stock and get rich. I won\'t pretend you haven\'t thought it.' },
    { speaker: 'Thandi', text: 'You know why my sales double every stage of shedding? Dark streets sell steel.' },
    { speaker: 'Thandi', text: 'Someone is FARMING this city. Either way, the CBD will remember what you do tonight.' },
  ] },
  'last-coach-home': { id: 'last-coach-home:intro', lines: [
    { speaker: 'Auntie Portia', text: 'Boet! Disaster. My nephew fell asleep on the train and got off without my rent bag — left it on the platform at Park Station.' },
    { speaker: 'You', text: 'Your rent was riding the train?' },
    { speaker: 'Auntie Portia', text: 'It\'s down beside the platform, right where the silly child left it. Hop a train out — the TRAIN, boet, that bag doesn\'t trust cars — and bring it home before someone honest finds it.' },
  ] },
  'copper-wire-blues': { id: 'copper-wire-blues:intro', lines: [
    { speaker: 'Bra Vusi', text: 'That cable from the GTI? The buyer paid cash, no name, no yard. A man like that is worth knowing better.' },
    { speaker: 'You', text: 'So I go ask him nicely where he lives?' },
    { speaker: 'Bra Vusi', text: 'You ask NOTHING. His pickup is up the block. When it moves, you move. Stay close, stay boring. I want that yard\'s address, not a funeral.' },
  ] },
  'rank-cold-war': { id: 'rank-cold-war:intro', lines: [
    { speaker: 'Candice', text: 'The Wemmer crew is leaning on my ranks now. MY ranks. Two stops on my route think Candice has gone soft.' },
    { speaker: 'You', text: 'And I\'m the hard part?' },
    { speaker: 'Candice', text: 'You\'re the van driver, sweetie. Drive my green van down the route, show the flag at both ranks, and if they get brave — drive them off my property. Bring my van back breathing.' },
  ] },
  'reading-signs': { id: 'reading-signs:intro', lines: [
    { speaker: 'Oupa Jakes', text: 'Thirty years I called the trains at Park Station. Platform two, the eight-fifteen, mind the gap. Now the city calls ME names. Hah.' },
    { speaker: 'You', text: 'And you\'re telling me this because…' },
    { speaker: 'Oupa Jakes', text: 'Because you look like someone who reads. Three riddles — each answer is a street with its NAME on the pole, inside the circle I\'ll mark on your map.' },
    { speaker: 'Oupa Jakes', text: 'The lights people own this city now, laaitie, but the streets still tell the truth. Ask me again any time — the words get easier the longer you stand there looking lost.' },
  ] },
  'the-audition': { id: 'the-audition:intro', lines: [
    { speaker: 'Solly', text: 'So this is Vusi\'s quiet driver. You found my yard by following one of my pickups. That was either very good or very stupid.' },
    { speaker: 'You', text: 'Can\'t it be both?' },
    { speaker: 'Solly', text: 'Hah! Both pays double. There\'s a diesel tanker on Wemmer Jubilee that forgot who it belongs to. Bring it home without a scratch and you\'re on the payroll, my laaitie.' },
  ] },
  'pull-the-plug': { id: 'pull-the-plug:intro', lines: [
    { speaker: 'Solly', text: 'You know what sells generators? Not adverts. Darkness sells generators. Tonight you\'re my salesman.' },
    { speaker: 'You', text: 'And Eskom takes the blame.' },
    { speaker: 'Solly', text: 'Eskom built the blame, I just rent it. The Ophirton feeder, after dark. One breaker. Throw it and walk. Don\'t run — running looks guilty.' },
  ] },
  'stage-fright': { id: 'stage-fright:intro', lines: [
    { speaker: 'Solly', text: 'A friend of mine dreams about a superbike in a showroom window up in the northern suburbs. Glass, floodlights, a very rude alarm.' },
    { speaker: 'You', text: 'And I fetch it when?' },
    { speaker: 'Solly', text: 'Tonight. However loud that street gets — the bike arrives at my yard. How you keep it quiet is your business.' },
  ] },
  'genny-round': { id: 'genny-round:intro', lines: [
    { speaker: 'Solly', text: 'Three businesses are behind on their generator subscriptions. Terrible thing, being behind. Anything could happen to a fridge.' },
    { speaker: 'Solly', text: 'Visit all three. The last one has opinions and muscle — bring better ones. My money comes back with you.' },
  ] },
  'paper-round': { id: 'paper-round:intro', lines: [
    { speaker: 'Sindi', text: 'I pulled the Ophirton fault logs. Breakers don\'t trip in that pattern by themselves. That was a hand. Your hand.' },
    { speaker: 'You', text: 'Careful, engineer. Accusations need paper.' },
    { speaker: 'Sindi', text: 'I HAVE paper. More than your boss knows. Test first, though — see if you can read. The classifieds this morning: "FOR SALE: one-way ticket. Collect where the whole city changes trains."' },
    { speaker: 'Sindi', text: 'I\'ve ringed the district on your map — the dead drop\'s somewhere inside the circle, not on any pin. Read the station for yourself. Bring my dossier back and we\'ll talk about what it\'s worth. To either side.' },
  ] },
  'the-wrong-train': { id: 'the-wrong-train:intro', lines: [
    { speaker: 'Solly', text: 'Transnet misplaced a consist tonight. Tragic. It moves my diesel now — but a train needs a driver with no timetable.' },
    { speaker: 'You', text: 'I\'ve always wanted a train set.' },
    { speaker: 'Solly', text: 'Then drive yours to the Crown Station siding and stop it DEAD. Not near. Dead. My people take it from there.' },
  ] },
  'crosswinds': { id: 'crosswinds:intro', lines: [
    { speaker: 'Skywise Sipho', text: 'You\'re Solly\'s new hands? Lucky you. His "spare parts" fly tonight and my licence, tragically, does not.' },
    { speaker: 'You', text: 'So I fly the parts.' },
    { speaker: 'Skywise Sipho', text: 'The Kite\'s fuelled on the apron. Get HIGH over Ponte — the drop is at the roof of the city, and the fast way down is under your seat. Don\'t bend my aeroplane.' },
  ] },
  'two-fires': { id: 'two-fires:intro', lines: [
    { speaker: 'Solly', text: 'The engineer has a van full of paper with my name in every line. Tonight the van burns.' },
    { speaker: 'Solly', text: 'Unless… you\'ve been reading her paper too, my laaitie. I hear things. I always hear things.' },
    { speaker: 'Solly', text: 'So choose. Right here, at my table, with my coffee going cold. Choose.' },
  ] },
  'paper-fire': { id: 'paper-fire:intro', lines: [
    { speaker: 'Solly', text: 'Good. Her van sleeps on a side street below Braamfontein. Paper burns nicely in this dry air.' },
    { speaker: 'Solly', text: 'Before the shift changes. And laaitie — after tonight, you\'re not staff. You\'re family.' },
  ] },
  'catch-them-cutting': { id: 'catch-them-cutting:intro', lines: [
    { speaker: 'Sindi', text: 'You came. Good — because they cut the Ophirton feeder again tonight. Your old crew, your old ladder, your old life.' },
    { speaker: 'You', text: 'And you want them stopped, or filmed?' },
    { speaker: 'Sindi', text: 'Both. Rig on camera, cutters on the ground. After that, everything Solly owns starts belonging to the case file. And case files… leak value. You follow me.' },
  ] },
  'dark-house': { id: 'dark-house:intro', lines: [
    { speaker: 'Burner phone', text: 'One job stands between you and the rest of it.' },
    { speaker: 'Burner phone', text: 'The black ledger sleeps in the records office at Kelvin Yard. Every rand, every name, every breaker. Security answers to nobody — not even Solly.' },
    { speaker: 'Burner phone', text: 'Figure it out.' },
  ] },
  'long-live-the-king': { id: 'long-live-the-king:intro', lines: [
    { speaker: 'Lieutenant Mo', text: 'We read the ledger. Every rand he skimmed off US, every name he sold. The lieutenants are yours.' },
    { speaker: 'Lieutenant Mo', text: 'But his loyal ones are coming for the yard tonight. Hold it, and nobody argues about who sits at the plastic table.' },
  ] },
  'carcass': { id: 'carcass:intro', lines: [
    { speaker: 'Sindi', text: 'The handover is at Constitution Hill. My people are waiting — and Solly\'s people are hunting. You have the only copy.' },
    { speaker: 'You', text: 'And after the paper lands?' },
    { speaker: 'Sindi', text: 'After that, everything the cartel owns is evidence. And evidence goes missing all the time. I\'ll be looking at my paperwork very, very hard.' },
  ] },
  'the-switch': { id: 'the-switch:intro', lines: [
    { speaker: 'Sindi', text: 'Listen to me very carefully. The Ophirton feeder is rigged to blow. Not a trip — a permanent Stage Six. The grid on its knees for years.' },
    { speaker: 'You', text: 'Why would anyone burn the thing they milk?' },
    { speaker: 'Sindi', text: 'Spite. Insurance. A throne someone lost. It doesn\'t matter — whatever you are now, your city dies with that substation. GO.' },
  ] },
  'padstal-run': { id: 'padstal-run:intro', lines: [
    { speaker: 'Auntie Portia', text: 'The aunties\' savings club put in an order at Grandma\'s farm stall — pastries, dried meat, the works. It\'s a real drive, boet, over the ridge and gone.' },
    { speaker: 'Auntie Portia', text: 'Take something with a working radio and don\'t eat the order. I counted every pastry. I always count.' },
  ] },
  'pier-pressure': { id: 'pier-pressure:intro', lines: [
    { speaker: 'Candice', text: 'A fare ran on Ricardo. Airport run, coastal tolls, waiting time — a BIG fare. Now he\'s bragging at Seepunt Pier before his boat leaves.' },
    { speaker: 'You', text: 'And the interest rate?' },
    { speaker: 'Candice', text: 'Whatever his face can afford. Go collect, sweetie.' },
  ] },
};

export function introScript(mission: MissionDefinition): DialogueScript {
  return INTRO_DIALOGUES[mission.id] ?? { id: `${mission.id}:intro`, lines: [{ speaker: mission.contact, text: mission.intro }] };
}
