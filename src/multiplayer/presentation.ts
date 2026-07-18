import type { HotBakkieState, NetPlayer, NetVehicle } from './protocol';

export interface OnlineTarget { x: number; z: number; label: string; color: string }
export interface OnlineObjective {
  missionName: string;
  text: string;
  progress?: number;
  required?: number;
  remainingSeconds?: number;
  target?: OnlineTarget;
}
export function rankOnlinePlayers(players: readonly NetPlayer[]): NetPlayer[] {
  return [...players].sort((left, right) => right.runs - left.runs || right.kills - left.kills || left.deaths - right.deaths || left.name.localeCompare(right.name));
}

export function hotBakkieObjective(hot: HotBakkieState | undefined, players: readonly NetPlayer[], vehicles: readonly NetVehicle[], selfId?: string): OnlineObjective | undefined {
  if (!hot) return undefined;
  const bakkie = vehicles.find((vehicle) => vehicle.isHot);
  const bakkieTarget = bakkie ? { x: bakkie.x, z: bakkie.z, label: 'Hot Bakkie', color: '#ef8d32' } : undefined;
  const remainingSeconds = hot.phase === 'waiting' ? undefined : hot.remainingTime;
  if (hot.phase === 'waiting') return { missionName: 'HOT BAKKIE RUN', text: 'Waiting for the first runner to join.' };
  if (hot.phase === 'countdown') return { missionName: `HOT BAKKIE · ROUND ${hot.round}`, text: `Get to the bakkie — ${hot.route} starts now-now.`, remainingSeconds, target: bakkieTarget };
  if (hot.phase === 'cooldown') {
    const winner = players.find((player) => player.id === hot.winner)?.name;
    return { missionName: 'HOT BAKKIE RUN', text: winner ? `${winner} delivered it. Next bakkie is being found.` : 'Run over. Another bakkie is being found.', remainingSeconds };
  }
  if (hot.carrier === selfId && hot.currentCheckpoint) {
    const delivery = hot.currentCheckpoint.delivery;
    return {
      missionName: `HOT BAKKIE · ${hot.route}`,
      text: delivery ? `Stop inside ${hot.currentCheckpoint.label} below 29 km/h.` : `Drive checkpoint ${hot.progress + 1}: ${hot.currentCheckpoint.label}.`,
      progress: hot.progress, required: hot.total, remainingSeconds,
      target: { x: hot.currentCheckpoint.x, z: hot.currentCheckpoint.z, label: hot.currentCheckpoint.label, color: delivery ? '#66e39b' : '#f5c451' },
    };
  }
  if (hot.carrier) {
    const carrier = players.find((player) => player.id === hot.carrier)?.name ?? 'The carrier';
    return { missionName: `HOT BAKKIE · ${hot.route}`, text: `Chase ${carrier}, take the bakkie, finish the route.`, progress: hot.progress, required: hot.total, remainingSeconds, target: bakkieTarget ? { ...bakkieTarget, color: '#ef5548' } : undefined };
  }
  return { missionName: `HOT BAKKIE · ${hot.route}`, text: 'Claim the marked bakkie and run the route.', progress: hot.progress, required: hot.total, remainingSeconds, target: bakkieTarget };
}
