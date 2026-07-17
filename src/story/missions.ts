import { Vector3 } from 'three';
import type { MissionDefinition } from '../systems/MissionSystem';
import type { WorldTarget } from '../types';
import { CANDICE_START, ESCAPE_SPOT, KELVIN_GATE_SPOT, KIOSK_SPOT, LOCKUP_SPOT, PARK_STATION_SPOT, PERMIT_SPOT, PORTIA_START, QUARRY_SPAWN, RIDDLE_SPOTS, SANDTON_BAG_SPOT, SANDTON_PLATFORM, TERMINAL_SPOT, THANDI_START, VUSI_START } from '../world/placements';
import { CANDICE_VAN_COLOR } from './scripts';

/** Candice's van dying ends the mission at any stage. */
const VAN_DOWN = { kind: 'vehicle-health-below', value: 0.35, reason: 'Candice\'s van is finished — and so is her route' } as const;

export const target = (x: number, y: number, z: number, label: string, color = '#f5c542'): WorldTarget => ({ position: new Vector3(x, y, z), label, color });
export const spot = (place: { x: number; z: number }, label: string): WorldTarget => target(place.x, 0, place.z, label);

/** Mission anchors are data-driven (world/placements): they re-anchor when the map regenerates. */
export const MISSIONS: MissionDefinition[] = [
  {
    id: 'delivery-run', name: 'Couch Run', contact: 'Auntie Portia', reward: 900, act: 'hustle',
    intro: 'Howzit boet. Sold the couch on Marketplace but eish, the bakkie is gone. Take my yellow Citi Golf — three drops, sharp sharp. The couch fits, I promise.',
    start: spot(PORTIA_START, 'Auntie Portia'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Enter Auntie Portia\'s yellow Citi Golf' },
      { kind: 'checkpoints', text: 'Make the three drops (now now, not just now)', required: 3, timeLimit: 210 },
      { kind: 'reach', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Return the Citi Golf to Auntie Portia', target: spot(PORTIA_START, 'Auntie Portia\'s driveway') },
    ],
  },
  {
    id: 'hot-property', name: 'Hot Copper', contact: 'Bra Vusi', reward: 1500, act: 'hustle',
    intro: 'A red GTI is parked on Commissioner Street, boot full of municipal cable that fell off a substation, yoh. Bring it to my Braamfontein lock-up when the heat fades. Vrrr phaa, but gently.',
    start: spot(VUSI_START, 'Bra Vusi'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Take the red GTI from the CBD' },
      { kind: 'lose-wanted', text: 'Lose the JMPD pursuit' },
      { kind: 'reach', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Deliver the GTI to Braamfontein', target: spot(LOCKUP_SPOT, 'Lock-up garage') },
    ],
  },
  {
    id: 'dockside-signal', name: 'Rank Business', contact: 'Candice from Boksburg', reward: 2200, act: 'hustle',
    intro: 'Ag no man. The Wemmer crew stole our taxi route permit. Go moer them, grab the permit, and bring it to the braai kiosk at Zoo Lake. Sharp?',
    start: spot(CANDICE_START, 'Candice'), objectives: [
      { kind: 'reach', text: 'Travel to the Wemmer taxi terminal', target: spot(TERMINAL_SPOT, 'Wemmer terminal') },
      { kind: 'defeat', text: 'Moer the rank enforcers', required: 3, checkpoint: true },
      { kind: 'collect', text: 'Grab the route permit', target: spot(PERMIT_SPOT, 'Route permit') },
      { kind: 'escape', text: 'Escape the terminal perimeter', target: spot(ESCAPE_SPOT, 'Safe route') },
      { kind: 'reach', text: 'Bring it to Candice at Zoo Lake', target: spot(KIOSK_SPOT, 'Braai kiosk') },
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
    intro: 'My nephew fell asleep on the Sandton train and walked off without my rent bag. Ride out there and fetch it, boet — before someone honest finds it.',
    start: spot(PORTIA_START, 'Auntie Portia'), objectives: [
      { kind: 'reach', conditionsOnly: true, conditions: { onTrain: true, stationName: 'Sandton Station' }, text: 'Ride the rails to Sandton Station', target: spot(SANDTON_PLATFORM, 'Sandton Station') },
      { kind: 'collect', text: 'Fetch the rent bag from the vetkoek stand', target: spot(SANDTON_BAG_SPOT, 'Rent bag'), checkpoint: true },
      { kind: 'reach', text: 'Bring the bag back to Auntie Portia', target: spot(PORTIA_START, 'Auntie Portia') },
    ],
  },
  {
    id: 'copper-wire-blues', name: 'Copper Wire Blues', contact: 'Bra Vusi', reward: 1800, act: 'hustle',
    prerequisites: { missions: ['hot-property'] },
    intro: 'The cable buyer pays lekker but keeps his yard a secret. His bakkie is up the block. When it moves, you move — and don\'t let him see you sweat.',
    start: spot(VUSI_START, 'Bra Vusi'), objectives: [
      { kind: 'reach', text: 'Get near the buyer\'s bakkie — quietly', target: spot(QUARRY_SPAWN, 'The buyer\'s bakkie') },
      { kind: 'follow', text: 'Tail the bakkie — stay with it, don\'t spook it', checkpoint: true, failIf: [
        { kind: 'strayed', value: 90, reason: 'You lost the bakkie in traffic' },
        { kind: 'escort-down', reason: 'The bakkie is wrecked — no yard today' },
      ] },
      { kind: 'reach', text: 'Get eyes on the yard gate', target: spot(KELVIN_GATE_SPOT, 'Kelvin Yard'), checkpoint: true },
    ],
  },
  {
    id: 'rank-cold-war', name: 'Rank Cold War', contact: 'Candice from Boksburg', reward: 2600, act: 'hustle',
    prerequisites: { missions: ['dockside-signal'] },
    intro: 'The Wemmer crew is leaning on my ranks now. Drive my van down the route, show the flag, and if they want to make a point — moer the point right back.',
    start: spot(CANDICE_START, 'Candice'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'van', vehicleColor: CANDICE_VAN_COLOR, text: 'Take the wheel of Candice\'s route van' },
      { kind: 'checkpoints', required: 2, vehicleColor: CANDICE_VAN_COLOR, text: 'Show the flag at both contested ranks', failIf: [VAN_DOWN] },
      { kind: 'defeat', required: 3, vehicleColor: CANDICE_VAN_COLOR, text: 'Moer the Wemmer heavies off the van', checkpoint: true, failIf: [VAN_DOWN] },
      { kind: 'reach', vehicleKind: 'van', vehicleColor: CANDICE_VAN_COLOR, text: 'Get the van back to Zoo Lake in one piece', target: spot(CANDICE_START, 'Zoo Lake rank'), failIf: [VAN_DOWN] },
    ],
  },
  {
    id: 'reading-signs', name: 'The Reading of the Signs', contact: 'Oupa Jakes', reward: 1500, act: 'hustle',
    prerequisites: { missions: ['delivery-run'] },
    intro: 'Thirty years I called the trains at Park Station. Now I call the streets. Three riddles, no map, no hand-holding — read the signs like we used to.',
    start: spot(PARK_STATION_SPOT, 'Oupa Jakes'), objectives: [
      { kind: 'reach', hidden: true, text: '"Stand where the road confesses its own condition."', target: spot(RIDDLE_SPOTS[0]!, 'Pothole Street') },
      { kind: 'reach', hidden: true, text: '"Stand where the lights never stay."', target: spot(RIDDLE_SPOTS[1]!, 'Loadshed Lane'), checkpoint: true },
      { kind: 'reach', hidden: true, text: '"Stand where the city still sends paper."', target: spot(RIDDLE_SPOTS[2]!, 'Fax Street'), checkpoint: true },
      { kind: 'reach', text: 'Tell Oupa Jakes what you saw', target: spot(PARK_STATION_SPOT, 'Oupa Jakes') },
    ],
  },
];
