import { VEHICLE_SPECS, type VehicleKind } from '../config';

export const CHEAT_CASH = 1_000_000;
export const STAR_HEAT = 20; // one wanted star spans 20 heat points

export type ConsoleCommand =
  | { kind: 'noop' }
  | { kind: 'help' }
  | { kind: 'fps' }
  | { kind: 'set-time'; hour: number }
  | { kind: 'set-busy'; percent: number }
  | { kind: 'set-peds'; count?: number } // undefined = back to the time-of-day table
  | { kind: 'set-cars'; count?: number }
  | { kind: 'busy' }
  | { kind: 'spawn'; vehicle: VehicleKind }
  | { kind: 'cash'; amount: number }
  | { kind: 'unwanted' }
  | { kind: 'shedding' }
  | { kind: 'error'; message: string };

/** Game wires these in; the console never imports Game. Each handler returns its console feedback line. */
export interface ConsoleHost {
  setTime(hour: number): string;
  toggleFps(): string;
  spawn(kind: VehicleKind): string;
  giveCash(amount: number): string;
  dropStar(): string;
  toggleShedding(): string;
  setBusy(percent: number): string;
  setPedTarget(count?: number): string;
  setCarTarget(count?: number): string;
  busyInfo(): string;
}

const KINDS = Object.keys(VEHICLE_SPECS) as VehicleKind[];
const SPAWN_ALIAS: Record<string, VehicleKind> = { bakkie: 'van' }; // the Hilux Bakkie ships under kind "van"

const CHEAT_WORDS: Record<string, ConsoleCommand> = {
  bakkie: { kind: 'spawn', vehicle: 'van' },
  pedalpedal: { kind: 'spawn', vehicle: 'bicycle' },
  vroomvroom: { kind: 'spawn', vehicle: 'superbike' },
  ritchierich: { kind: 'cash', amount: CHEAT_CASH },
  unwanted: { kind: 'unwanted' },
  shedding: { kind: 'shedding' },
};

export const HELP_LINES = [
  'help — this list',
  'set time <HHMM> — jump the clock (e.g. set time 1200)',
  'set busy <10-1000> — crowd level in percent (100 = normal; clears peds/cars pins)',
  'set peds <n|auto> — pin the pedestrian target (auto = time-of-day table)',
  'set cars <n|auto> — pin the traffic target (auto = time-of-day table)',
  'busy — show the current crowd targets and live counts',
  'fps — toggle the performance display',
  `spawn <kind> — drop a vehicle ahead: ${KINDS.join(', ')}, bakkie`,
  'cheats — bakkie · pedalpedal · vroomvroom · ritchierich · unwanted · shedding',
];

export function tokenize(input: string): string[] { return input.trim().toLowerCase().split(/\s+/).filter(Boolean); }

/** Non-negative whole number; undefined when malformed. */
export function parseCount(token: string): number | undefined { return /^\d+$/.test(token) ? Number(token) : undefined; }

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
  if (head === 'set') {
    const [key, value] = rest;
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
    if (key !== 'time' || !value) return { kind: 'error', message: 'Usage: set time <HHMM> · set busy <percent> · set peds <n|auto> · set cars <n|auto>' };
    const hour = parseTimeToken(value);
    return hour === undefined ? { kind: 'error', message: `Invalid time "${value}" — use HHMM between 0000 and 2359.` } : { kind: 'set-time', hour };
  }
  if (head === 'spawn') {
    const token = rest[0];
    if (!token) return { kind: 'error', message: `Usage: spawn <kind> — kinds: ${KINDS.join(', ')}, bakkie` };
    const vehicle = SPAWN_ALIAS[token] ?? (KINDS.includes(token as VehicleKind) ? (token as VehicleKind) : undefined);
    return vehicle ? { kind: 'spawn', vehicle } : { kind: 'error', message: `Eish, unknown vehicle: ${token}. Kinds: ${KINDS.join(', ')}, bakkie.` };
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
    case 'set-time': return [host.setTime(command.hour)];
    case 'set-busy': return [host.setBusy(command.percent)];
    case 'set-peds': return [host.setPedTarget(command.count)];
    case 'set-cars': return [host.setCarTarget(command.count)];
    case 'busy': return [host.busyInfo()];
    case 'spawn': return [host.spawn(command.vehicle)];
    case 'cash': return [host.giveCash(command.amount)];
    case 'unwanted': return [host.dropStar()];
    case 'shedding': return [host.toggleShedding()];
  }
}
