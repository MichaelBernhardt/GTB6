import { Vector3 } from 'three';
import type { GameSnapshot, WorldTarget } from '../types';
import { CANDICE_START, ESCAPE_SPOT, KIOSK_SPOT, LOCKUP_SPOT, PERMIT_SPOT, PORTIA_START, TERMINAL_SPOT, THANDI_START, VUSI_START } from '../world/placements';

export type ObjectiveKind = 'reach' | 'enter-kind' | 'checkpoints' | 'lose-wanted' | 'defeat' | 'collect' | 'escape' | 'choice';
export interface MissionChoice { id: 'protect' | 'rob'; label: string; detail: string; reward: number; }
export interface MissionObjective {
  text: string;
  kind: ObjectiveKind;
  target?: WorldTarget;
  vehicleKind?: string;
  vehicleColor?: number;
  required?: number;
  timeLimit?: number;
  choices?: MissionChoice[];
}
export interface MissionDefinition { id: string; name: string; contact: string; intro: string; reward: number; start: WorldTarget; objectives: MissionObjective[]; }
export type MissionState = 'available' | 'active' | 'failed' | 'complete';

const target = (x: number, y: number, z: number, label: string, color = '#f5c542'): WorldTarget => ({ position: new Vector3(x, y, z), label, color });
const spot = (place: { x: number; z: number }, label: string): WorldTarget => target(place.x, 0, place.z, label);

/** Mission anchors are data-driven (world/placements): they re-anchor when the map regenerates. */
export const MISSIONS: MissionDefinition[] = [
  {
    id: 'delivery-run', name: 'Couch Run', contact: 'Auntie Portia', reward: 900,
    intro: 'Howzit boet. Sold the couch on Marketplace but eish, the bakkie is gone. Take my yellow Citi Golf — three drops, sharp sharp. The couch fits, I promise.',
    start: spot(PORTIA_START, 'Auntie Portia'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Enter Auntie Portia\'s yellow Citi Golf' },
      { kind: 'checkpoints', text: 'Make the three drops (now now, not just now)', required: 3, timeLimit: 210 },
      { kind: 'reach', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Return the Citi Golf to Auntie Portia', target: spot(PORTIA_START, 'Auntie Portia\'s driveway') },
    ],
  },
  {
    id: 'hot-property', name: 'Hot Copper', contact: 'Bra Vusi', reward: 1500,
    intro: 'A red GTI is parked on Commissioner Street, boot full of municipal cable that fell off a substation, yoh. Bring it to my Braamfontein lock-up when the heat fades. Vrrr phaa, but gently.',
    start: spot(VUSI_START, 'Bra Vusi'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Take the red GTI from the CBD' },
      { kind: 'lose-wanted', text: 'Lose the JMPD pursuit' },
      { kind: 'reach', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Deliver the GTI to Braamfontein', target: spot(LOCKUP_SPOT, 'Lock-up garage') },
    ],
  },
  {
    id: 'dockside-signal', name: 'Rank Business', contact: 'Candice from Boksburg', reward: 2200,
    intro: 'Ag no man. The Wemmer crew stole our taxi route permit. Go moer them, grab the permit, and bring it to the braai kiosk at Zoo Lake. Sharp?',
    start: spot(CANDICE_START, 'Candice'), objectives: [
      { kind: 'reach', text: 'Travel to the Wemmer taxi terminal', target: spot(TERMINAL_SPOT, 'Wemmer terminal') },
      { kind: 'defeat', text: 'Moer the rank enforcers', required: 3 },
      { kind: 'collect', text: 'Grab the route permit', target: spot(PERMIT_SPOT, 'Route permit') },
      { kind: 'escape', text: 'Escape the terminal perimeter', target: spot(ESCAPE_SPOT, 'Safe route') },
      { kind: 'reach', text: 'Bring it to Candice at Zoo Lake', target: spot(KIOSK_SPOT, 'Braai kiosk') },
    ],
  },
  {
    id: 'arms-deal', name: 'The Arms Deal', contact: 'Thandi at Jozi Arms', reward: 0,
    intro: 'Two crews want tonight\'s shipment. Help us keep the shop standing, or take the stock and make yourself rich. Either way, the CBD will remember.',
    start: spot(THANDI_START, 'Thandi at Jozi Arms'), objectives: [
      { kind: 'choice', text: 'Decide the fate of Jozi Arms', choices: [
        { id: 'protect', label: 'Protect the shop', detail: 'Earn local trust and a Jozi Arms discount. Police pressure will rise.', reward: 900 },
        { id: 'rob', label: 'Rob the shipment', detail: 'Take a large payout and ammo. Locals will fear you and JMPD will harden the CBD.', reward: 2200 },
      ] },
    ],
  },
];

export interface MissionChoiceResult { missionId: string; choice: MissionChoice; }
export interface MissionUpdate { advanced?: boolean; completed?: MissionDefinition; failed?: string; choice?: MissionChoiceResult; }

export class MissionSystem {
  active?: MissionDefinition;
  objectiveIndex = 0;
  progress = 0;
  remainingTime = 0;
  completed = new Set<string>();
  state: MissionState = 'available';

  get objective(): MissionObjective | undefined { return this.active?.objectives[this.objectiveIndex]; }

  start(id: string): boolean {
    const mission = MISSIONS.find((item) => item.id === id);
    if (!mission || this.active) return false;
    this.active = mission; this.objectiveIndex = 0; this.progress = 0; this.state = 'active';
    this.remainingTime = mission.objectives[0]?.timeLimit ?? 0;
    return true;
  }

  restart(): boolean {
    if (!this.active || this.state !== 'failed') return false;
    const id = this.active.id; this.active = undefined; return this.start(id);
  }

  fail(reason: string): MissionUpdate { this.state = 'failed'; return { failed: reason }; }

  update(dt: number, snapshot: GameSnapshot, reachedTarget: boolean): MissionUpdate {
    const objective = this.objective;
    if (!this.active || !objective || this.state !== 'active') return {};
    if (this.remainingTime > 0) {
      this.remainingTime -= dt;
      if (this.remainingTime <= 0) return this.fail('Time expired');
    }
    let done = false;
    switch (objective.kind) {
      case 'reach': case 'escape': done = reachedTarget && (!objective.vehicleKind || (snapshot.inVehicle && snapshot.vehicleKind === objective.vehicleKind && snapshot.vehicleColor === objective.vehicleColor)); break;
      case 'enter-kind': done = snapshot.inVehicle && snapshot.vehicleKind === objective.vehicleKind && (!objective.vehicleColor || snapshot.vehicleColor === objective.vehicleColor); break;
      case 'lose-wanted': done = snapshot.wantedLevel === 0; break;
      case 'defeat': this.progress = snapshot.hostileDefeated; done = this.progress >= (objective.required ?? 1); break;
      case 'collect': done = snapshot.collectedItem && reachedTarget; break;
      case 'checkpoints': done = this.progress >= (objective.required ?? 1); break;
      case 'choice': done = false; break;
    }
    if (!done) return {};
    return this.advance();
  }

  registerCheckpoint(): MissionUpdate {
    if (this.objective?.kind !== 'checkpoints' || this.state !== 'active') return {};
    this.progress += 1;
    return this.progress >= (this.objective.required ?? 1) ? this.advance() : { advanced: true };
  }

  choose(id: MissionChoice['id']): MissionUpdate {
    const objective = this.objective;
    if (!this.active || this.state !== 'active' || objective?.kind !== 'choice') return {};
    const choice = objective.choices?.find((option) => option.id === id);
    if (!choice) return {};
    const missionId = this.active.id; const update = this.advance();
    return { ...update, choice: { missionId, choice } };
  }

  private advance(): MissionUpdate {
    if (!this.active) return {};
    this.objectiveIndex += 1; this.progress = 0;
    if (this.objectiveIndex >= this.active.objectives.length) {
      const completed = this.active; this.completed.add(completed.id); this.state = 'complete'; this.active = undefined;
      return { completed };
    }
    this.remainingTime = this.objective?.timeLimit ?? 0;
    return { advanced: true };
  }
}
