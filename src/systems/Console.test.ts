import { describe, expect, it } from 'vitest';
import { CHEAT_CASH, HELP_LINES, heatAfterStarDrop, parseCommand, parseTimeToken, runConsoleCommand, tokenize, type ConsoleHost } from './Console';

describe('console tokenizer', () => {
  it('lowercases and collapses whitespace', () => {
    expect(tokenize('  SET   Time  1200 ')).toEqual(['set', 'time', '1200']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('console parser', () => {
  it('parses plain commands', () => {
    expect(parseCommand('help')).toEqual({ kind: 'help' });
    expect(parseCommand('fps')).toEqual({ kind: 'fps' });
    expect(parseCommand('   ')).toEqual({ kind: 'noop' });
  });

  it('maps cheat words to their actions', () => {
    expect(parseCommand('bakkie')).toEqual({ kind: 'spawn', vehicle: 'van' });
    expect(parseCommand('pedalpedal')).toEqual({ kind: 'spawn', vehicle: 'bicycle' });
    expect(parseCommand('VroomVroom')).toEqual({ kind: 'spawn', vehicle: 'superbike' });
    expect(parseCommand('ritchierich')).toEqual({ kind: 'cash', amount: CHEAT_CASH });
    expect(parseCommand('unwanted')).toEqual({ kind: 'unwanted' });
    expect(parseCommand('shedding')).toEqual({ kind: 'shedding' });
  });

  it('parses spawn with kinds and the bakkie alias', () => {
    expect(parseCommand('spawn superbike')).toEqual({ kind: 'spawn', vehicle: 'superbike' });
    expect(parseCommand('spawn bakkie')).toEqual({ kind: 'spawn', vehicle: 'van' });
    expect(parseCommand('spawn taxi')).toEqual({ kind: 'spawn', vehicle: 'taxi' });
    expect(parseCommand('spawn spaceship').kind).toBe('error');
    expect(parseCommand('spawn').kind).toBe('error');
  });

  it('validates set time input', () => {
    expect(parseCommand('set time 1200')).toEqual({ kind: 'set-time', hour: 12 });
    expect(parseCommand('set time 0000')).toEqual({ kind: 'set-time', hour: 0 });
    expect(parseCommand('set time 2359')).toEqual({ kind: 'set-time', hour: 23 + 59 / 60 });
    for (const bad of ['set time 2400', 'set time 1260', 'set time 12:00', 'set time noon', 'set time 120', 'set time', 'set volume 3']) {
      expect(parseCommand(bad).kind, bad).toBe('error');
    }
  });

  it('rejects unknown input with an eish and a help hint', () => {
    const result = parseCommand('gimme money');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') { expect(result.message).toContain('Eish, unknown command: gimme money'); expect(result.message).toContain('help'); }
  });

  it('does not treat cheat words with arguments as cheats', () => {
    expect(parseCommand('bakkie now').kind).toBe('error');
  });
});

describe('parseTimeToken', () => {
  it('converts HHMM to fractional hours within bounds', () => {
    expect(parseTimeToken('0630')).toBeCloseTo(6.5);
    expect(parseTimeToken('2359')).toBeCloseTo(23.9833, 3);
    expect(parseTimeToken('2400')).toBeUndefined();
    expect(parseTimeToken('0960')).toBeUndefined();
    expect(parseTimeToken('12')).toBeUndefined();
    expect(parseTimeToken('abcd')).toBeUndefined();
  });
});

describe('heatAfterStarDrop', () => {
  it('sheds exactly one 20-point band and floors at zero', () => {
    expect(heatAfterStarDrop(100)).toBe(80);
    expect(heatAfterStarDrop(45)).toBe(25);
    expect(heatAfterStarDrop(20)).toBe(0);
    expect(heatAfterStarDrop(15)).toBe(0);
    expect(heatAfterStarDrop(0)).toBe(0);
  });
});

describe('runConsoleCommand', () => {
  const host: ConsoleHost = {
    setTime: (hour) => `time:${hour}`,
    toggleFps: () => 'fps',
    spawn: (kind) => `spawn:${kind}`,
    giveCash: (amount) => `cash:${amount}`,
    dropStar: () => 'star',
    toggleShedding: () => 'eskom',
  };

  it('routes parsed commands to host handlers and echoes their feedback', () => {
    expect(runConsoleCommand('set time 0800', host)).toEqual(['time:8']);
    expect(runConsoleCommand('vroomvroom', host)).toEqual(['spawn:superbike']);
    expect(runConsoleCommand('ritchierich', host)).toEqual([`cash:${CHEAT_CASH}`]);
    expect(runConsoleCommand('unwanted', host)).toEqual(['star']);
    expect(runConsoleCommand('shedding', host)).toEqual(['eskom']);
    expect(runConsoleCommand('fps', host)).toEqual(['fps']);
    expect(runConsoleCommand('help', host)).toEqual(HELP_LINES);
    expect(runConsoleCommand('', host)).toEqual([]);
    expect(runConsoleCommand('wololo', host)[0]).toContain('Eish');
  });
});
