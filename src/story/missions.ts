import { Vector3 } from 'three';
import type { MissionDefinition } from '../systems/MissionSystem';
import type { WorldTarget } from '../types';
import {
  CANDICE_START, CON_HILL_SPOT, ESCAPE_SPOT, EVIDENCE_VAN_SPOT, KELVIN_GATE_SPOT, KELVIN_OFFICE_SPOT,
  AIRPORT_APRON, CROWN_STATION, KIOSK_SPOT, LOCKUP_SPOT, PADSTAL_SPOT, PAPER_DROP, PARK_STATION_SPOT, PERMIT_SPOT, PIER_SPOT, PONTE_FORECOURT,
  CABLE_YARD_SPOT, PONTE_POINT, PORTIA_START, QUARRY_SPAWN, RENT_BAG_PLATFORM, RENT_BAG_SPOT, RIDDLE_SPOTS, SAFEHOUSE_SITE, SINDI_START, SIPHO_START,
  SOLLY_START, SUBSTATION_BREAKER, SUBSTATION_SPOT, TERMINAL_SPOT, THANDI_START, VUSI_START,
} from '../world/placements';
import { CANDICE_VAN_COLOR, TANKER_COLOR } from './scripts';

const SOLLY = 'Solly the Genny King';
const SINDI = 'Sindi Mokoena';
const SPOTTED = { kind: 'detected', reason: 'Floodlights slam on. The whole yard saw you.' } as const;

/** Candice's van dying ends the mission at any stage. */
const VAN_DOWN = { kind: 'vehicle-health-below', value: 0.12, reason: 'Candice\'s van is finished — and so is her route' } as const;

export const target = (x: number, y: number, z: number, label: string, color = '#f5c542'): WorldTarget => ({ position: new Vector3(x, y, z), label, color });
export const spot = (place: { x: number; z: number }, label: string): WorldTarget => target(place.x, 0, place.z, label);

/** Mission anchors are data-driven (world/placements): they re-anchor when the map regenerates. */
export const MISSIONS: MissionDefinition[] = [
  {
    id: 'delivery-run', name: 'Couch Run', contact: 'Auntie Portia', reward: 900, act: 'hustle',
    intro: 'Howzit boet. I sold the couch online but my pickup is gone. Take my yellow Citi Golf — two drops round the corner. The couch fits, I promise.',
    start: spot(PORTIA_START, 'Auntie Portia'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Enter Auntie Portia\'s yellow Citi Golf' },
      { kind: 'checkpoints', text: 'Make the two drops quickly — no dawdling', required: 2, checkpoint: true },
      { kind: 'reach', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Return the Citi Golf to Auntie Portia', target: spot(PORTIA_START, 'Auntie Portia\'s driveway'), checkpoint: true },
    ],
  },
  {
    id: 'hot-property', name: 'Hot Copper', contact: 'Bra Vusi', reward: 1500, act: 'hustle',
    intro: 'A red GTI is parked on Commissioner Street, boot full of municipal cable that fell off a substation. Bring it to my Braamfontein lock-up when the heat fades — gently, hey.',
    start: spot(VUSI_START, 'Bra Vusi'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Take the red GTI from the CBD' },
      { kind: 'lose-wanted', text: 'Lose the JMPD pursuit', checkpoint: true },
      { kind: 'reach', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Deliver the GTI to Braamfontein', target: spot(LOCKUP_SPOT, 'Lock-up garage'), checkpoint: true },
    ],
  },
  {
    id: 'dockside-signal', name: 'Rank Business', contact: 'Candice from Boksburg', reward: 2200, act: 'hustle',
    intro: 'Ag no man. The Wemmer crew stole our taxi route permit. Go deal with them at their terminal, grab the permit, and bring it back to me here at the Newtown rank. Deal?',
    start: spot(CANDICE_START, 'Candice'), objectives: [
      { kind: 'reach', text: 'Travel to the Wemmer taxi terminal', target: spot(TERMINAL_SPOT, 'Wemmer terminal') },
      { kind: 'defeat', text: 'Take down the rank enforcers', required: 3, checkpoint: true },
      { kind: 'collect', text: 'Grab the route permit', target: spot(PERMIT_SPOT, 'Route permit'), checkpoint: true },
      { kind: 'escape', text: 'Escape the terminal perimeter', target: spot(ESCAPE_SPOT, 'Safe route'), checkpoint: true },
      { kind: 'reach', text: 'Bring it to Candice at the Newtown rank', target: spot(KIOSK_SPOT, 'Candice'), checkpoint: true },
    ],
  },
  {
    id: 'arms-deal', name: 'The Arms Deal', contact: 'Thandi at Jozi Arms', reward: 0, act: 'hustle',
    intro: 'Two crews want tonight\'s shipment. Help us keep the shop standing, or take the stock and make yourself rich. Either way, the CBD will remember.',
    start: spot(THANDI_START, 'Thandi at Jozi Arms'), objectives: [
      { kind: 'choice', text: 'Decide the fate of Jozi Arms', choices: [
        { id: 'protect', label: 'Protect the shop', detail: 'Earn local trust and a Jozi Arms discount. Police pressure will rise.', reward: 900 },
        { id: 'rob', label: 'Rob the shipment', detail: 'Take a large payout and ammo. Locals will fear you and JMPD will harden the CBD.', reward: 2200 },
      ] },
    ],
  },

  // ---- Act 1: "Hustle" ------------------------------------------------------------
  {
    id: 'last-coach-home', name: 'Last Coach Home', contact: 'Auntie Portia', reward: 1100, act: 'hustle',
    prerequisites: { missions: ['delivery-run'] },
    intro: 'My nephew fell asleep on the train and left my rent bag on the platform at Park Station, the silly child. Hop a train out and fetch it before someone honest finds it, boet.',
    start: spot(PORTIA_START, 'Auntie Portia'), objectives: [
      { kind: 'reach', conditionsOnly: true, conditions: { onTrain: true, stationName: 'Johannesburg Park Station' }, text: 'Ride a train out to Park Station', target: spot(RENT_BAG_PLATFORM, 'Park Station') },
      { kind: 'collect', text: 'Grab Portia\'s rent bag beside the Park Station platform', target: spot(RENT_BAG_SPOT, 'Rent bag'), checkpoint: true },
      { kind: 'reach', text: 'Bring the bag back to Auntie Portia', target: spot(PORTIA_START, 'Auntie Portia'), checkpoint: true },
    ],
  },
  {
    id: 'copper-wire-blues', name: 'Copper Wire Blues', contact: 'Bra Vusi', reward: 1800, act: 'hustle',
    prerequisites: { missions: ['hot-property'] },
    intro: 'The cable buyer pays well but keeps his yard a secret. His pickup is up the block. When it moves, you move — and don\'t let him see you sweat.',
    start: spot(VUSI_START, 'Bra Vusi'), objectives: [
      { kind: 'reach', text: 'Get near the buyer\'s pickup — quietly', target: spot(QUARRY_SPAWN, 'The buyer\'s pickup') },
      { kind: 'follow', text: 'Tail the pickup — stay with it, don\'t spook it', checkpoint: true, failIf: [
        { kind: 'strayed', value: 150, reason: 'You lost the pickup in traffic' },
        { kind: 'escort-down', reason: 'The pickup is wrecked — no yard today' },
      ] },
      { kind: 'reach', text: 'Get eyes on the buyer\'s cable yard', target: spot(CABLE_YARD_SPOT, 'The cable yard'), checkpoint: true },
    ],
  },
  {
    id: 'rank-cold-war', name: 'Rank Cold War', contact: 'Candice from Boksburg', reward: 2600, act: 'hustle',
    prerequisites: { missions: ['dockside-signal'] },
    intro: 'The Wemmer crew is leaning on my ranks now. Drive my van down the route, show the flag, and if they want to make a point — make it right back at them, hard.',
    start: spot(CANDICE_START, 'Candice'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'van', vehicleColor: CANDICE_VAN_COLOR, text: 'Take the wheel of Candice\'s route van' },
      { kind: 'checkpoints', required: 2, vehicleColor: CANDICE_VAN_COLOR, text: 'Show the flag at both contested ranks', failIf: [VAN_DOWN] },
      { kind: 'defeat', required: 3, vehicleColor: CANDICE_VAN_COLOR, text: 'Drive the Wemmer heavies off the van', checkpoint: true, failIf: [VAN_DOWN] },
      { kind: 'reach', vehicleKind: 'van', vehicleColor: CANDICE_VAN_COLOR, text: 'Get the van back to the Newtown rank in one piece', target: spot(CANDICE_START, 'Newtown rank'), checkpoint: true, failIf: [VAN_DOWN] },
    ],
  },
  {
    id: 'reading-signs', name: 'The Reading of the Signs', contact: 'Oupa Jakes', reward: 1500, act: 'hustle',
    prerequisites: { missions: ['delivery-run'] },
    intro: 'Thirty years I called the trains at Park Station. Now I call the streets. Three riddles — I\'ll ring each block on your map, but no arrows: read the signs inside the circle like we used to.',
    start: spot(PARK_STATION_SPOT, 'Oupa Jakes'), objectives: [
      { kind: 'reach', hidden: true, streetName: 'Pothole Street', text: '"Stand where the street sign admits what broke your suspension."', target: spot(RIDDLE_SPOTS[0]!, 'Pothole Street') },
      { kind: 'reach', hidden: true, streetName: 'Loadshed Lane', text: '"Stand in the lane they named after the dark — Eskom\'s favourite address."', target: spot(RIDDLE_SPOTS[1]!, 'Loadshed Lane'), checkpoint: true },
      { kind: 'reach', hidden: true, streetName: 'Fax Street', text: '"Stand in the street named for what offices sent before email."', target: spot(RIDDLE_SPOTS[2]!, 'Fax Street'), checkpoint: true },
      { kind: 'reach', text: 'Tell Oupa Jakes what you saw', target: spot(PARK_STATION_SPOT, 'Oupa Jakes') },
    ],
  },

  // ---- Act 2: "The Payroll" — inside the cartel -------------------------------------
  {
    id: 'the-audition', name: 'The Audition', contact: SOLLY, reward: 3000, act: 'payroll',
    prerequisites: { missions: ['copper-wire-blues'] },
    intro: 'Vusi says you can drive and you can keep quiet. Prove half of that: there\'s a diesel tanker parked over on De Villiers Street that forgot who it belongs to. Bring it all the way home to Kelvin Yard without a scratch.',
    start: spot(SOLLY_START, 'Solly'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'van', vehicleColor: TANKER_COLOR, text: 'Take the diesel tanker from De Villiers Street' },
      { kind: 'reach', vehicleKind: 'van', vehicleColor: TANKER_COLOR, text: 'Bring the tanker to Kelvin Yard — gently', target: spot(KELVIN_GATE_SPOT, 'Kelvin Yard'), radius: 12, checkpoint: true, failIf: [
        { kind: 'vehicle-health-below', value: 0.3, reason: 'The tanker is bleeding diesel — Solly\'s money burns with it' },
      ] },
    ],
  },
  {
    id: 'pull-the-plug', name: 'Pull the Plug', contact: SOLLY, reward: 4200, act: 'payroll',
    prerequisites: { missions: ['the-audition'] },
    intro: 'Ophirton feeder substation. After dark. There\'s a main breaker inside with nobody\'s name on it. Throw it, walk away, and let the city remember who sells light in this town.',
    start: spot(SOLLY_START, 'Solly'), objectives: [
      { kind: 'reach', radius: 16, conditions: { atNight: true }, text: 'Get to the Ophirton feeder substation after dark', target: spot(SUBSTATION_SPOT, 'Ophirton feeder') },
      { kind: 'collect', text: 'Throw the main breaker', target: spot(SUBSTATION_BREAKER, 'Main breaker'), checkpoint: true },
      { kind: 'lose-wanted', text: 'Get clear of the JMPD response', checkpoint: true },
    ],
  },
  {
    id: 'stage-fright', name: 'Stage Fright', contact: SOLLY, reward: 5000, act: 'payroll',
    prerequisites: { missions: ['pull-the-plug'] },
    intro: 'There\'s a superbike in a showroom up in the northern suburbs that a friend of mine keeps dreaming about. Fetch it tonight. However loud it gets — it arrives.',
    start: spot(SOLLY_START, 'Solly'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'superbike', text: 'Take the showroom superbike up north' },
      { kind: 'reach', vehicleKind: 'superbike', text: 'Bring it to Kelvin Yard', target: spot(KELVIN_GATE_SPOT, 'Kelvin Yard'), radius: 12, checkpoint: true },
    ],
  },
  {
    id: 'genny-round', name: 'The Genny Round', contact: SOLLY, reward: 3600, act: 'payroll',
    prerequisites: { missions: ['the-audition'] },
    intro: 'Three businesses think a generator subscription is optional. Visit all three. The last one has opinions — bring better ones.',
    start: spot(SOLLY_START, 'Solly'), objectives: [
      { kind: 'checkpoints', required: 3, text: 'Collect the generator subscriptions — three doors, no receipts' },
      { kind: 'defeat', required: 2, text: 'The holdout\'s muscle wants a discount. Correct them.', checkpoint: true },
      { kind: 'reach', text: 'Bring Solly his money', target: spot(SOLLY_START, 'Solly'), checkpoint: true },
    ],
  },
  {
    id: 'paper-round', name: 'Paper Round', contact: SINDI, reward: 2800, act: 'payroll',
    prerequisites: { missions: ['pull-the-plug'] },
    intro: 'I read the fault logs. That trip pattern was manual — a hand on a breaker. Your hand. Let\'s see if you can read too: "FOR SALE: one-way ticket. Collect where the whole city changes trains."',
    start: spot(SINDI_START, 'Sindi'), objectives: [
      { kind: 'reach', hidden: true, text: '"Collect where the whole city changes trains — the big station, beside the platform."', target: spot(PAPER_DROP, 'The dead drop') },
      { kind: 'collect', text: 'Take the dossier from beside the platform', target: spot(PAPER_DROP, 'Dossier'), checkpoint: true },
      { kind: 'reach', text: 'Bring the dossier back to Sindi', target: spot(SINDI_START, 'Sindi'), checkpoint: true },
    ],
  },
  {
    id: 'the-wrong-train', name: 'The Wrong Train', contact: SOLLY, reward: 5500, act: 'payroll',
    prerequisites: { missions: ['the-audition'] },
    intro: 'Transnet lost a consist tonight — misplaced it, hey. It moves my diesel now. Take the controls and stop it dead at the Crown Station siding. My people do the rest.',
    start: spot(SOLLY_START, 'Solly'), objectives: [
      { kind: 'reach', conditionsOnly: true, conditions: { drivingTrain: true }, text: 'Take the controls of a consist', target: spot(PARK_STATION_SPOT, 'Park Station') },
      { kind: 'reach', conditionsOnly: true, conditions: { drivingTrain: true, stationName: 'Crown Station' }, text: 'Stop the train dead at the Crown Station siding', target: spot(CROWN_STATION, 'Crown siding'), checkpoint: true },
      { kind: 'reach', radius: 45, conditionsOnly: true, conditions: { onFoot: true }, text: 'Step off — the crew takes it from here', target: spot(CROWN_STATION, 'Crown siding'), checkpoint: true },
    ],
  },
  {
    id: 'crosswinds', name: 'Crosswinds', contact: 'Skywise Sipho', reward: 6000, act: 'payroll',
    prerequisites: { missions: ['genny-round'] },
    intro: 'Solly\'s "spare parts" fly tonight and my licence doesn\'t. Kite\'s fuelled on the apron. Get high over Ponte — the drop is the roof of the city — and don\'t bend my aeroplane.',
    start: spot(SIPHO_START, 'Skywise Sipho'), objectives: [
      { kind: 'reach', conditionsOnly: true, conditions: { inPlane: true, altitudeAbove: 40 }, text: 'Get a Karoo Kite in the air', target: spot(AIRPORT_APRON, 'O.R. Tambourine apron') },
      { kind: 'reach', radius: 260, conditions: { inPlane: true, altitudeAbove: 150 }, text: 'Bring the parts high over Ponte Tower', target: spot(PONTE_POINT, 'Over Ponte'), checkpoint: true },
      { kind: 'reach', timeLimit: 300, text: 'Get down to the Ponte forecourt drop — quickly', target: spot(PONTE_FORECOURT, 'Forecourt drop'), checkpoint: true },
    ],
  },
  {
    id: 'two-fires', name: 'Two Fires', contact: SOLLY, reward: 0, act: 'payroll',
    prerequisites: { missions: ['stage-fright', 'paper-round'] },
    intro: 'The engineer has a van full of paper with my name in it. Tonight the van burns. Unless, of course, you\'ve been reading her paper too. Choose, my laaitie.',
    start: spot(SOLLY_START, 'Solly'), objectives: [
      { kind: 'choice', text: 'Solly wants Sindi\'s evidence burning tonight', choices: [
        { id: 'solly', label: 'Burn the van', detail: 'Stay loyal. The right hand of the Genny King wants for nothing — except friends.', reward: 1000 },
        { id: 'sindi', label: 'Warn Sindi', detail: 'Sell the cartel to the engineer. Her case fund pays — and a dying cartel drops its wallet.', reward: 1000 },
      ] },
    ],
  },
  {
    id: 'paper-fire', name: 'Paper Fire', contact: SOLLY, reward: 4500, act: 'payroll',
    prerequisites: { flags: ['choice:two-fires:solly'] },
    intro: 'Her van sleeps on a side street just below Braamfontein. Paper burns nicely. Go before the shift changes.',
    start: spot(SOLLY_START, 'Solly'), setFlags: ['act3'], objectives: [
      { kind: 'reach', timeLimit: 600, text: 'Find Sindi\'s evidence van', target: spot(EVIDENCE_VAN_SPOT, 'Evidence van') },
      { kind: 'collect', text: 'Douse the van and strike the match', target: spot(EVIDENCE_VAN_SPOT, 'Evidence van'), checkpoint: true },
      { kind: 'lose-wanted', text: 'Vanish before JMPD boxes the block', checkpoint: true },
    ],
  },
  {
    id: 'catch-them-cutting', name: 'Catch Them Cutting', contact: SINDI, reward: 4500, act: 'payroll',
    prerequisites: { flags: ['choice:two-fires:sindi'] },
    intro: 'They cut the Ophirton feeder again tonight — your old crew. Be there when they clock in. I need the rig on camera and the cutters on the ground.',
    start: spot(SINDI_START, 'Sindi'), setFlags: ['act3'], objectives: [
      { kind: 'reach', radius: 16, conditions: { atNight: true }, text: 'Be at the Ophirton feeder after dark', target: spot(SUBSTATION_SPOT, 'Ophirton feeder') },
      { kind: 'defeat', required: 3, text: 'Drop the cutting crew before they finish the job', checkpoint: true },
      { kind: 'collect', text: 'Photograph the cutting rig', target: spot(SUBSTATION_BREAKER, 'Cutting rig'), checkpoint: true },
      { kind: 'reach', text: 'Bring Sindi the proof', target: spot(SINDI_START, 'Sindi'), checkpoint: true },
    ],
  },

  // ---- Act 3: "Stage Six" -------------------------------------------------------------
  {
    id: 'dark-house', name: 'Dark House', contact: 'A burner phone', reward: 8000, act: 'stage-six',
    prerequisites: { flags: ['act3'] },
    intro: 'The black ledger sleeps in the records office at Kelvin Yard. Security answers to nobody — not even Solly. Figure it out.',
    start: spot(SAFEHOUSE_SITE.pad, 'The burner phone'), setFlags: ['ledger'], objectives: [
      { kind: 'reach', radius: 14, text: 'Case Kelvin Yard', target: spot(KELVIN_GATE_SPOT, 'Kelvin Yard') },
      { kind: 'reach', radius: 6, conditions: { undetected: true }, failIf: [SPOTTED], checkpoint: true, text: 'Get into the records office. Figure it out.', target: spot(KELVIN_OFFICE_SPOT, 'Records office') },
      { kind: 'collect', conditions: { undetected: true }, failIf: [SPOTTED], checkpoint: true, text: 'Take the black ledger', target: spot(KELVIN_OFFICE_SPOT, 'Black ledger') },
      { kind: 'escape', radius: 12, failIf: [SPOTTED], text: 'Get out of the yard, unseen', target: spot(KELVIN_GATE_SPOT, 'Out the gate') },
    ],
  },
  {
    id: 'long-live-the-king', name: 'Long Live the King', contact: 'Lieutenant Mo', reward: 12000, act: 'stage-six',
    prerequisites: { flags: ['choice:two-fires:solly'], missions: ['dark-house'] },
    intro: 'The lieutenants read the ledger. Every skimmed rand, every name Solly sold. They\'re yours — if you can hold the yard when his loyal ones come to take it back.',
    start: spot(SOLLY_START, 'Kelvin Yard gate'), setFlags: ['endgame'], objectives: [
      { kind: 'reach', radius: 14, text: 'Stand in Kelvin Yard as the word goes out', target: spot(KELVIN_GATE_SPOT, 'Kelvin Yard') },
      { kind: 'survive', timeLimit: 60, text: 'Hold the yard — Solly\'s loyalists want it back', checkpoint: true },
      { kind: 'defeat', required: 4, text: 'Break the last of the loyalists', checkpoint: true },
    ],
  },
  {
    id: 'carcass', name: 'Carcass', contact: SINDI, reward: 12000, act: 'stage-six',
    prerequisites: { flags: ['choice:two-fires:sindi'], missions: ['dark-house'] },
    intro: 'The ledger goes to the Constitution Hill handover — and the cartel knows you have it. After that, everything they own is evidence. Evidence goes missing all the time.',
    start: spot(SINDI_START, 'Sindi'), setFlags: ['endgame'], objectives: [
      { kind: 'reach', radius: 14, timeLimit: 600, text: 'Run the ledger to the Constitution Hill handover', target: spot(CON_HILL_SPOT, 'Handover') },
      { kind: 'lose-wanted', text: 'Shake the heat', checkpoint: true },
      { kind: 'checkpoints', required: 3, timeLimit: 1200, text: 'Pick the carcass: three cartel stashes before SAPS seals them', checkpoint: true },
    ],
  },
  {
    id: 'the-switch', name: 'The Switch', contact: SINDI, reward: 20000, act: 'stage-six',
    prerequisites: { flags: ['endgame'] },
    intro: 'Listen to me. The Ophirton feeder is rigged to blow — a permanent Stage Six, the whole grid on its knees. Whatever you are now, your city dies with that substation. Go.',
    start: spot(SINDI_START, 'Sindi'), setFlags: ['stage-six-over'], objectives: [
      { kind: 'reach', radius: 16, timeLimit: 800, text: 'Get to the Ophirton feeder before the wreckers finish', target: spot(SUBSTATION_SPOT, 'Ophirton feeder') },
      { kind: 'defeat', required: 4, text: 'Put the wreckers down', checkpoint: true },
      { kind: 'survive', timeLimit: 90, text: 'Hold the substation until the relief crew arrives', checkpoint: true },
    ],
  },

  // ---- Side pieces ----------------------------------------------------------------------
  {
    id: 'padstal-run', name: 'Ouma se Padstal Run', contact: 'Auntie Portia', reward: 4000, act: 'side',
    prerequisites: { missions: ['last-coach-home'] },
    intro: 'The aunties\' savings club ordered pastries and dried meat from Grandma\'s farm stall, out over the northern ridge. It\'s a proper drive, boet — take something with a working radio.',
    start: spot(PORTIA_START, 'Auntie Portia'), objectives: [
      { kind: 'reach', radius: 10, timeLimit: 900, text: 'Drive the order out to the farm stall over the ridge', target: spot(PADSTAL_SPOT, 'Ouma se Padstal') },
      { kind: 'collect', text: 'Load the club\'s order', target: spot(PADSTAL_SPOT, 'The order'), checkpoint: true },
      { kind: 'reach', timeLimit: 900, text: 'Drive it all the way home before the tea goes cold', target: spot(PORTIA_START, 'Auntie Portia'), checkpoint: true },
    ],
  },
  {
    id: 'pier-pressure', name: 'Pier Pressure', contact: 'Candice from Boksburg', reward: 3000, act: 'side',
    prerequisites: { missions: ['rank-cold-war'] },
    intro: 'A fare ran on Ricardo — a BIG fare, airport run, coastal toll, the lot. He\'s bragging at Seepunt Pier before his boat leaves. Go collect. With interest.',
    start: spot(CANDICE_START, 'Candice'), objectives: [
      { kind: 'reach', radius: 12, timeLimit: 960, text: 'Catch the fare-skipper before his boat leaves Seepunt Pier', target: spot(PIER_SPOT, 'Seepunt Pier') },
      { kind: 'defeat', required: 1, text: 'Convince him', checkpoint: true },
      { kind: 'collect', text: 'Take what he owes — plus interest', target: spot(PIER_SPOT, 'The fare'), checkpoint: true },
    ],
  },
];
