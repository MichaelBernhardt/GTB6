import { Vector3 } from 'three';
import type { GameSnapshot, WorldTarget } from '../types';

export type ObjectiveKind = 'reach' | 'enter-kind' | 'checkpoints' | 'lose-wanted' | 'defeat' | 'collect' | 'escape';
export interface MissionObjective {
  text: string;
  kind: ObjectiveKind;
  target?: WorldTarget;
  vehicleKind?: string;
  vehicleColor?: number;
  required?: number;
  timeLimit?: number;
}
export interface MissionDefinition { id: string; name: string; contact: string; intro: string; reward: number; start: WorldTarget; objectives: MissionObjective[]; }
export type MissionState = 'available' | 'active' | 'failed' | 'complete';

const target = (x: number, y: number, z: number, label: string, color = '#f5c451'): WorldTarget => ({ position: new Vector3(x, y, z), label, color });

export const MISSIONS: MissionDefinition[] = [
  {
    id: 'delivery-run', name: 'Delivery Run', contact: 'Mara Velez', reward: 900,
    intro: 'Fresh produce, three kitchens, no excuses. Take my yellow Cielo and beat the lunch rush.',
    start: target(-100, 0, 230, 'Mara'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Enter Mara\'s yellow Cielo' },
      { kind: 'checkpoints', text: 'Make the three deliveries', required: 3, timeLimit: 145 },
      { kind: 'reach', vehicleKind: 'compact', vehicleColor: 0xf1c232, text: 'Return the Cielo to Mercado', target: target(-100, 0, 230, 'Mercado garage') },
    ],
  },
  {
    id: 'hot-property', name: 'Hot Property', contact: 'Nico Sol', reward: 1500,
    intro: 'A red Veloce is parked downtown. Bring it clean to my beach garage after the heat fades.',
    start: target(200, 0, 180, 'Nico'), objectives: [
      { kind: 'enter-kind', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Steal the red Veloce downtown' },
      { kind: 'lose-wanted', text: 'Lose the SCPD pursuit' },
      { kind: 'reach', vehicleKind: 'sport', vehicleColor: 0xd83a40, text: 'Deliver the Veloce to Costa Azul', target: target(265, 0, -245, 'Beach garage') },
    ],
  },
  {
    id: 'dockside-signal', name: 'Dockside Signal', contact: 'Inez Calder', reward: 2200,
    intro: 'The Breakwater crew stole a radio key. Clear their dock, recover it, and bring it to the park kiosk.',
    start: target(-200, 0, -36, 'Inez'), objectives: [
      { kind: 'reach', text: 'Travel to the Breakwater docks', target: target(-258, 0, -225, 'Breakwater docks') },
      { kind: 'defeat', text: 'Defeat the dock guards', required: 3 },
      { kind: 'collect', text: 'Recover the radio key', target: target(-270, 0, -262, 'Radio key') },
      { kind: 'escape', text: 'Escape the dock perimeter', target: target(22, 0, -160, 'Safe route') },
      { kind: 'reach', text: 'Return to Inez at Cordova Commons', target: target(-42, 0, 18, 'Park kiosk') },
    ],
  },
];

export interface MissionUpdate { advanced?: boolean; completed?: MissionDefinition; failed?: string; }

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
    }
    if (!done) return {};
    return this.advance();
  }

  registerCheckpoint(): MissionUpdate {
    if (this.objective?.kind !== 'checkpoints' || this.state !== 'active') return {};
    this.progress += 1;
    return this.progress >= (this.objective.required ?? 1) ? this.advance() : { advanced: true };
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
