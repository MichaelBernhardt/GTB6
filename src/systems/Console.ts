import { VEHICLE_SPECS, WEAPONS, type VehicleKind, type WeaponId } from '../config';

export const CHEAT_CASH = 1_000_000;
export const STAR_HEAT = 20; // one wanted star spans 20 heat points

export type ConsoleCommand =
  | { kind: 'noop' }
  | { kind: 'help' }
  | { kind: 'fps' }
  | { kind: 'set-time'; hour: number }
  | { kind: 'set-timerate'; rate: number }
  | { kind: 'set-busy'; percent: number }
  | { kind: 'set-peds'; count?: number } // undefined = back to the time-of-day table
  | { kind: 'set-cars'; count?: number }
  | { kind: 'set-pos'; axis: 'x' | 'y' | 'z'; value: number }
  | { kind: 'ghost' }
  | { kind: 'busy' }
  | { kind: 'map' }
  | { kind: 'save' }
  | { kind: 'spawn'; vehicle: VehicleKind }
  | { kind: 'cash'; amount: number }
  | { kind: 'unwanted' }
  | { kind: 'shedding' }
  | { kind: 'nomoresirens' }
  | { kind: 'tp-coords'; x: number; z: number }
  | { kind: 'tp-name'; name: string }
  | { kind: 'tp-list' }
  | { kind: 'skyfall'; name?: string }
  | { kind: 'give-weapon'; weapon: WeaponId }
  | { kind: 'give-ammo' }
  | { kind: 'give-armour' }
  | { kind: 'give-item'; item: 'parachute' | 'stim'; count: number }
  | { kind: 'error'; message: string };

/** Game wires these in; the console never imports Game. Each handler returns its console feedback line. */
export interface ConsoleHost {
  setTime(hour: number): string;
  setTimerate(rate: number): string;
  toggleFps(): string;
  spawn(kind: VehicleKind): string;
  giveCash(amount: number): string;
  dropStar(): string;
  toggleShedding(): string;
  toggleSirens(): string;
  setBusy(percent: number): string;
  setPedTarget(count?: number): string;
  setCarTarget(count?: number): string;
  busyInfo(): string;
  openMap(): string;
  save(): string;
  ghost(): string;
  setPosition(axis: 'x' | 'y' | 'z', value: number): string;
  teleport(x: number, z: number): string;
  teleportNamed(name: string): string;
  teleportList(): string[];
  skyfall(name?: string): string;
  giveWeapon(id: WeaponId): string;
  giveAmmo(): string;
  giveArmour(): string;
  giveItem(item: 'parachute' | 'stim', count: number): string;
}

const KINDS = Object.keys(VEHICLE_SPECS) as VehicleKind[];
const SPAWN_ALIAS: Record<string, VehicleKind> = { bakkie: 'van' }; // the Hilux Bakkie ships under kind "van"
export const GIVE_WEAPON_IDS = WEAPONS.filter((spec) => !spec.melee).map((spec) => spec.id);

const CHEAT_WORDS: Record<string, ConsoleCommand> = {
  bakkie: { kind: 'spawn', vehicle: 'van' },
  pedalpedal: { kind: 'spawn', vehicle: 'bicycle' },
  vroomvroom: { kind: 'spawn', vehicle: 'superbike' },
  ritchierich: { kind: 'cash', amount: CHEAT_CASH },
  unwanted: { kind: 'unwanted' },
  shedding: { kind: 'shedding' },
  nomoresirens: { kind: 'nomoresirens' },
};

export const HELP_LINES = [
  'help — this list',
  'tp <x> <z> | tp <name> — teleport; tp list shows every named place',
  'skyfall [name] — drop from skydive altitude (W/S pitch, A/D steer, SPACE deploys a carried chute)',
  `give <${GIVE_WEAPON_IDS.join('|')}> — grant a weapon (or top up its ammo)`,
  'give ammo — fully stock every owned weapon',
  'give armour — strap on full body armour',
  'give parachute [n] · give stim [n] — stock inventory items',
  'set time <HHMM> — jump the clock (e.g. set time 1200)',
  'set timerate <n> — day/night speed (1 = normal, 0 freezes time)',
  'set busy <10-1000> — crowd level in percent (100 = normal; scales every nearby zone; clears peds/cars pins)',
  'set peds <n|auto> — pin the pedestrian target for the area around you (auto = per-zone by district)',
  'set cars <n|auto> — pin the traffic target for the area around you (auto = per-zone by district)',
  'busy — show the current nearby crowd targets and live counts',
  'set x|y|z <n> — move the player along one axis (pair with ghost to hold altitude)',
  'map — open the city map (or press M)',
  'save — save the current game to this browser',
  'ghost — free-fly test mode: wheel = altitude, gravity off, clip through everything',
  'fps — toggle the performance display (shows X/Y/Z position)',
  `spawn <kind> — drop a vehicle ahead: ${KINDS.join(', ')}, bakkie`,
  'cheats — bakkie · pedalpedal · vroomvroom · ritchierich · unwanted · shedding · nomoresirens',
];

export function tokenize(input: string): string[] { return input.trim().toLowerCase().split(/\s+/).filter(Boolean); }

/** Non-negative whole number; undefined when malformed. */
export function parseCount(token: string): number | undefined { return /^\d+$/.test(token) ? Number(token) : undefined; }

/** Signed decimal for teleport coordinates; undefined when malformed. */
export function parseCoordinate(token: string): number | undefined { return /^-?\d+(\.\d+)?$/.test(token) ? Number(token) : undefined; }

/** HHMM (0000–2359) → fractional hour for the day/night clock; undefined when malformed. */
export function parseTimeToken(token: string): number | undefined {
  if (!/^\d{4}$/.test(token)) return undefined;
  const hours = Number(token.slice(0, 2)); const minutes = Number(token.slice(2));
  return hours <= 23 && minutes <= 59 ? hours + minutes / 60 : undefined;
}

/** Dropping exactly one star: shed one 20-point band, never below zero. */
export function heatAfterStarDrop(heat: number): number { return Math.max(0, heat - STAR_HEAT); }

export function parseCommand(input: string): ConsoleCommand {
  const [head, ...rest] = tokenize(input);
  if (!head) return { kind: 'noop' };
  const cheat = CHEAT_WORDS[head];
  if (cheat && rest.length === 0) return cheat;
  if (head === 'help' && rest.length === 0) return { kind: 'help' };
  if (head === 'fps' && rest.length === 0) return { kind: 'fps' };
  if (head === 'busy' && rest.length === 0) return { kind: 'busy' };
  if (head === 'map' && rest.length === 0) return { kind: 'map' };
  if (head === 'save' && rest.length === 0) return { kind: 'save' };
  if (head === 'ghost' && rest.length === 0) return { kind: 'ghost' };
  if (head === 'set') {
    const [key, value] = rest;
    if (key === 'x' || key === 'y' || key === 'z') {
      if (!value) return { kind: 'error', message: `Usage: set ${key} <coord> — moves the player's ${key} (use ghost to hold altitude)` };
      const coord = parseCoordinate(value);
      return coord === undefined ? { kind: 'error', message: `Invalid ${key} "${value}" — use a number like 300 or -120.5.` } : { kind: 'set-pos', axis: key, value: coord };
    }
    if (key === 'busy') {
      if (!value) return { kind: 'error', message: 'Usage: set busy <percent> (100 = normal, e.g. set busy 300)' };
      if (value === 'auto') return { kind: 'set-busy', percent: 100 };
      const percent = parseCount(value);
      return percent === undefined ? { kind: 'error', message: `Invalid busy level "${value}" — use a percent like 300, or auto.` } : { kind: 'set-busy', percent };
    }
    if (key === 'peds' || key === 'cars') {
      const kind = key === 'peds' ? 'set-peds' as const : 'set-cars' as const;
      if (!value) return { kind: 'error', message: `Usage: set ${key} <count|auto>` };
      if (value === 'auto') return { kind };
      const count = parseCount(value);
      return count === undefined ? { kind: 'error', message: `Invalid count "${value}" — use a whole number, or auto.` } : { kind, count };
    }
    if (key === 'timerate') {
      if (!value) return { kind: 'error', message: 'Usage: set timerate <n> (1 = normal, 0 = freeze time, up to 120)' };
      const rate = parseCoordinate(value);
      return rate === undefined || rate < 0 ? { kind: 'error', message: `Invalid rate "${value}" — use a number ≥ 0 (0 freezes time, 1 = normal).` } : { kind: 'set-timerate', rate };
    }
    if (key !== 'time' || !value) return { kind: 'error', message: 'Usage: set time <HHMM> · set timerate <n> · set busy <percent> · set peds <n|auto> · set cars <n|auto> · set x|y|z <n>' };
    const hour = parseTimeToken(value);
    return hour === undefined ? { kind: 'error', message: `Invalid time "${value}" — use HHMM between 0000 and 2359.` } : { kind: 'set-time', hour };
  }
  if (head === 'spawn') {
    const token = rest[0];
    if (!token) return { kind: 'error', message: `Usage: spawn <kind> — kinds: ${KINDS.join(', ')}, bakkie` };
    const vehicle = SPAWN_ALIAS[token] ?? (KINDS.includes(token as VehicleKind) ? (token as VehicleKind) : undefined);
    return vehicle ? { kind: 'spawn', vehicle } : { kind: 'error', message: `Eish, unknown vehicle: ${token}. Kinds: ${KINDS.join(', ')}, bakkie.` };
  }
  if (head === 'tp') {
    if (rest.length === 0) return { kind: 'error', message: 'Usage: tp <x> <z> · tp <name> · tp list' };
    if (rest.length === 1 && rest[0] === 'list') return { kind: 'tp-list' };
    const [first, second] = rest;
    const x = first !== undefined ? parseCoordinate(first) : undefined;
    const z = second !== undefined ? parseCoordinate(second) : undefined;
    if (rest.length === 2 && x !== undefined && z !== undefined) return { kind: 'tp-coords', x, z };
    if (rest.length === 1 && x !== undefined) return { kind: 'error', message: 'Teleport needs both coordinates: tp <x> <z>.' };
    return { kind: 'tp-name', name: rest.join(' ') };
  }
  if (head === 'skyfall') return { kind: 'skyfall', name: rest.length > 0 ? rest.join(' ') : undefined };
  if (head === 'give') {
    const usage = `Usage: give <${GIVE_WEAPON_IDS.join('|')}> · give ammo · give armour · give parachute [n] · give stim [n]`;
    const [what, countToken, extra] = rest;
    if (!what || extra !== undefined) return { kind: 'error', message: usage };
    if (what === 'ammo') return countToken === undefined ? { kind: 'give-ammo' } : { kind: 'error', message: usage };
    if (what === 'armour' || what === 'armor') return countToken === undefined ? { kind: 'give-armour' } : { kind: 'error', message: usage };
    if (what === 'parachute' || what === 'stim') {
      const count = countToken === undefined ? 1 : parseCount(countToken);
      return count === undefined || count < 1 ? { kind: 'error', message: `Invalid count "${countToken}" — use a whole number of at least 1.` } : { kind: 'give-item', item: what, count };
    }
    if ((GIVE_WEAPON_IDS as string[]).includes(what)) return countToken === undefined ? { kind: 'give-weapon', weapon: what as WeaponId } : { kind: 'error', message: usage };
    return { kind: 'error', message: `Eish, can't give "${what}". ${usage}` };
  }
  return { kind: 'error', message: `Eish, unknown command: ${input.trim()}. Type "help" for the list.` };
}

export function runConsoleCommand(input: string, host: ConsoleHost): string[] {
  const command = parseCommand(input);
  switch (command.kind) {
    case 'noop': return [];
    case 'help': return HELP_LINES;
    case 'error': return [command.message];
    case 'fps': return [host.toggleFps()];
    case 'save': return [host.save()];
    case 'set-time': return [host.setTime(command.hour)];
    case 'set-timerate': return [host.setTimerate(command.rate)];
    case 'set-busy': return [host.setBusy(command.percent)];
    case 'set-peds': return [host.setPedTarget(command.count)];
    case 'set-cars': return [host.setCarTarget(command.count)];
    case 'set-pos': return [host.setPosition(command.axis, command.value)];
    case 'ghost': return [host.ghost()];
    case 'busy': return [host.busyInfo()];
    case 'map': return [host.openMap()];
    case 'spawn': return [host.spawn(command.vehicle)];
    case 'cash': return [host.giveCash(command.amount)];
    case 'unwanted': return [host.dropStar()];
    case 'shedding': return [host.toggleShedding()];
    case 'nomoresirens': return [host.toggleSirens()];
    case 'tp-coords': return [host.teleport(command.x, command.z)];
    case 'tp-name': return [host.teleportNamed(command.name)];
    case 'tp-list': return host.teleportList();
    case 'skyfall': return [host.skyfall(command.name)];
    case 'give-weapon': return [host.giveWeapon(command.weapon)];
    case 'give-ammo': return [host.giveAmmo()];
    case 'give-armour': return [host.giveArmour()];
    case 'give-item': return [host.giveItem(command.item, command.count)];
  }
}
