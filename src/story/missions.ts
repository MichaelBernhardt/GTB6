import { Vector3 } from 'three';
import type { MissionDefinition } from '../systems/MissionSystem';
import type { WorldTarget } from '../types';
import { CANDICE_START, ESCAPE_SPOT, KIOSK_SPOT, LOCKUP_SPOT, PERMIT_SPOT, PORTIA_START, TERMINAL_SPOT, THANDI_START, VUSI_START } from '../world/placements';

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
];
