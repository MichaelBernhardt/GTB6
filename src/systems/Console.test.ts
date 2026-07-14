import { describe, expect, it } from 'vitest';
import { CHEAT_CASH, GIVE_WEAPON_IDS, HELP_LINES, heatAfterStarDrop, parseCommand, parseCoordinate, parseTimeToken, runConsoleCommand, tokenize, type ConsoleHost } from './Console';

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
    expect(parseCommand('save')).toEqual({ kind: 'save' });
    expect(parseCommand('save now').kind).toBe('error'); // save takes no arguments
    expect(parseCommand('mapnpcs')).toEqual({ kind: 'mapnpcs' });
    expect(parseCommand('mapnpcs on').kind).toBe('error'); // no-arg toggle
    expect(parseCommand('reload')).toEqual({ kind: 'reload' });
    expect(parseCommand('reload now').kind).toBe('error'); // no-arg command
    expect(parseCommand('   ')).toEqual({ kind: 'noop' });
  });

  it('maps cheat words to their actions', () => {
    expect(parseCommand('bakkie')).toEqual({ kind: 'spawn', vehicle: 'van' });
    expect(parseCommand('pedalpedal')).toEqual({ kind: 'spawn', vehicle: 'bicycle' });
    expect(parseCommand('VroomVroom')).toEqual({ kind: 'spawn', vehicle: 'superbike' });
    expect(parseCommand('ritchierich')).toEqual({ kind: 'cash', amount: CHEAT_CASH });
    expect(parseCommand('unwanted')).toEqual({ kind: 'unwanted' });
    expect(parseCommand('shedding')).toEqual({ kind: 'shedding' });
    expect(parseCommand('NoMoreSirens')).toEqual({ kind: 'nomoresirens' });
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
    expect(parseCommand('set timerate 0')).toEqual({ kind: 'set-timerate', rate: 0 });
    expect(parseCommand('set timerate 10')).toEqual({ kind: 'set-timerate', rate: 10 });
    expect(parseCommand('set timerate 2.5')).toEqual({ kind: 'set-timerate', rate: 2.5 });
    expect(parseCommand('set timerate -3')).toEqual({ kind: 'error', message: expect.stringContaining('Invalid rate') });
    for (const bad of ['set time 2400', 'set time 1260', 'set time 12:00', 'set time noon', 'set time 120', 'set time', 'set volume 3']) {
      expect(parseCommand(bad).kind, bad).toBe('error');
    }
  });

  it('parses busy levels with auto restoring 100%', () => {
    expect(parseCommand('set busy 300')).toEqual({ kind: 'set-busy', percent: 300 });
    expect(parseCommand('SET BUSY 100')).toEqual({ kind: 'set-busy', percent: 100 });
    expect(parseCommand('set busy auto')).toEqual({ kind: 'set-busy', percent: 100 });
    for (const bad of ['set busy', 'set busy lots', 'set busy -50', 'set busy 3x']) expect(parseCommand(bad).kind, bad).toBe('error');
  });

  it('parses ped and car target pins with auto clearing them', () => {
    expect(parseCommand('set peds 60')).toEqual({ kind: 'set-peds', count: 60 });
    expect(parseCommand('set cars 0')).toEqual({ kind: 'set-cars', count: 0 });
    expect(parseCommand('set peds auto')).toEqual({ kind: 'set-peds' });
    expect(parseCommand('set cars auto')).toEqual({ kind: 'set-cars' });
    for (const bad of ['set peds', 'set cars many', 'set peds -3', 'set cars 1.5']) expect(parseCommand(bad).kind, bad).toBe('error');
  });

  it('shows crowd state via bare busy but not with arguments', () => {
    expect(parseCommand('busy')).toEqual({ kind: 'busy' });
    expect(parseCommand('busy 300').kind).toBe('error');
  });

  it('parses teleports: coordinates, names, the list, and malformed halves', () => {
    expect(parseCommand('tp 10 -20')).toEqual({ kind: 'tp-coords', x: 10, z: -20 });
    expect(parseCommand('tp -3.5 200.25')).toEqual({ kind: 'tp-coords', x: -3.5, z: 200.25 });
    expect(parseCommand('tp list')).toEqual({ kind: 'tp-list' });
    expect(parseCommand('tp sandton')).toEqual({ kind: 'tp-name', name: 'sandton' });
    expect(parseCommand('TP Jozi Arms')).toEqual({ kind: 'tp-name', name: 'jozi arms' });
    expect(parseCommand('tp 12 north')).toEqual({ kind: 'tp-name', name: '12 north' }); // only a full coordinate pair is a coordinate jump
    expect(parseCommand('tp').kind).toBe('error');
    expect(parseCommand('tp 100').kind).toBe('error'); // one lonely coordinate
  });

  it('parses skyfall with and without a target name', () => {
    expect(parseCommand('skyfall')).toEqual({ kind: 'skyfall', name: undefined });
    expect(parseCommand('skyfall zoo lake')).toEqual({ kind: 'skyfall', name: 'zoo lake' });
  });

  it('parses give for weapons, ammo, armour and counted items', () => {
    for (const id of GIVE_WEAPON_IDS) expect(parseCommand(`give ${id}`)).toEqual({ kind: 'give-weapon', weapon: id });
    expect(parseCommand('give ammo')).toEqual({ kind: 'give-ammo' });
    expect(parseCommand('give armour')).toEqual({ kind: 'give-armour' });
    expect(parseCommand('give armor')).toEqual({ kind: 'give-armour' }); // both spellings land
    expect(parseCommand('give parachute')).toEqual({ kind: 'give-item', item: 'parachute', count: 1 });
    expect(parseCommand('give stim 3')).toEqual({ kind: 'give-item', item: 'stim', count: 3 });
    for (const bad of ['give', 'give fists', 'give stim 0', 'give stim lots', 'give pistol 2', 'give ammo 5', 'give spaceship']) expect(parseCommand(bad).kind, bad).toBe('error');
  });

  it('parses the drunk command with an optional 0-100 level', () => {
    expect(parseCommand('drunk')).toEqual({ kind: 'drunk' });
    expect(parseCommand('drunk 60')).toEqual({ kind: 'drunk', level: 60 });
    expect(parseCommand('drunk 0')).toEqual({ kind: 'drunk', level: 0 });
    for (const bad of ['drunk 101', 'drunk -5', 'drunk plastered', 'drunk 50 60']) expect(parseCommand(bad).kind, bad).toBe('error');
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

describe('parseCoordinate', () => {
  it('accepts signed decimals and rejects everything else', () => {
    expect(parseCoordinate('12')).toBe(12);
    expect(parseCoordinate('-260')).toBe(-260);
    expect(parseCoordinate('3.75')).toBe(3.75);
    expect(parseCoordinate('north')).toBeUndefined();
    expect(parseCoordinate('12,5')).toBeUndefined();
    expect(parseCoordinate('--3')).toBeUndefined();
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
    setTimerate: (rate) => `timerate:${rate}`,
    toggleFps: () => 'fps',
    togglePerfChart: () => 'perfchart',
    spawn: (kind) => `spawn:${kind}`,
    giveCash: (amount) => `cash:${amount}`,
    dropStar: () => 'star',
    toggleSirens: () => 'sirens toggled', toggleShedding: () => 'eskom',
    setBusy: (percent) => `busy:${percent}`,
    setPedTarget: (count) => `peds:${count ?? 'auto'}`,
    setCarTarget: (count) => `cars:${count ?? 'auto'}`,
    busyInfo: () => 'crowd',
    openMap: () => 'map-open',
    toggleMapNpcs: () => 'mapnpcs toggled',
    save: () => 'saved',
    ghost: () => 'ghost toggled',
    setPosition: (axis, value) => `pos:${axis}:${value}`,
    reload: () => 'reloaded',
    teleport: (x, z) => `tp:${x},${z}`,
    teleportNamed: (name) => `tpn:${name}`,
    teleportList: () => ['place one', 'place two'],
    skyfall: (name) => `skyfall:${name ?? 'here'}`,
    giveWeapon: (id) => `weapon:${id}`,
    giveAmmo: () => 'ammo-max',
    giveArmour: () => 'armoured',
    giveItem: (item, count) => `item:${item}:${count}`,
    setInebriation: (level) => `drunk:${level ?? 'max'}`,
  };

  it('routes parsed commands to host handlers and echoes their feedback', () => {
    expect(runConsoleCommand('set time 0800', host)).toEqual(['time:8']);
    expect(runConsoleCommand('vroomvroom', host)).toEqual(['spawn:superbike']);
    expect(runConsoleCommand('ritchierich', host)).toEqual([`cash:${CHEAT_CASH}`]);
    expect(runConsoleCommand('unwanted', host)).toEqual(['star']);
    expect(runConsoleCommand('shedding', host)).toEqual(['eskom']);
    expect(runConsoleCommand('nomoresirens', host)).toEqual(['sirens toggled']);
    expect(runConsoleCommand('fps', host)).toEqual(['fps']);
    expect(runConsoleCommand('mapnpcs', host)).toEqual(['mapnpcs toggled']);
    expect(runConsoleCommand('reload', host)).toEqual(['reloaded']);
    expect(runConsoleCommand('help', host)).toEqual(HELP_LINES);
    expect(runConsoleCommand('', host)).toEqual([]);
    expect(runConsoleCommand('wololo', host)[0]).toContain('Eish');
  });

  it('routes the crowd commands', () => {
    expect(runConsoleCommand('set busy 300', host)).toEqual(['busy:300']);
    expect(runConsoleCommand('set busy auto', host)).toEqual(['busy:100']);
    expect(runConsoleCommand('set peds 60', host)).toEqual(['peds:60']);
    expect(runConsoleCommand('set peds auto', host)).toEqual(['peds:auto']);
    expect(runConsoleCommand('set cars 40', host)).toEqual(['cars:40']);
    expect(runConsoleCommand('busy', host)).toEqual(['crowd']);
    expect(runConsoleCommand('map', host)).toEqual(['map-open']);
    expect(runConsoleCommand('save', host)).toEqual(['saved']);
  });

  it('routes ghost mode and per-axis position sets', () => {
    expect(runConsoleCommand('ghost', host)).toEqual(['ghost toggled']);
    expect(runConsoleCommand('set x 300', host)).toEqual(['pos:x:300']);
    expect(runConsoleCommand('set y -12.5', host)).toEqual(['pos:y:-12.5']);
    expect(runConsoleCommand('set z 0', host)).toEqual(['pos:z:0']);
    expect(runConsoleCommand('set x', host)[0]).toContain('Usage');
    expect(runConsoleCommand('set y north', host)[0]).toContain('Invalid');
  });

  it('routes teleports, skyfall and the give family', () => {
    expect(runConsoleCommand('tp 15 -30', host)).toEqual(['tp:15,-30']);
    expect(runConsoleCommand('tp jozi arms', host)).toEqual(['tpn:jozi arms']);
    expect(runConsoleCommand('tp list', host)).toEqual(['place one', 'place two']);
    expect(runConsoleCommand('skyfall', host)).toEqual(['skyfall:here']);
    expect(runConsoleCommand('skyfall sandton', host)).toEqual(['skyfall:sandton']);
    expect(runConsoleCommand('give rpg', host)).toEqual(['weapon:rpg']);
    expect(runConsoleCommand('give ammo', host)).toEqual(['ammo-max']);
    expect(runConsoleCommand('give armour', host)).toEqual(['armoured']);
    expect(runConsoleCommand('give parachute 2', host)).toEqual(['item:parachute:2']);
    expect(runConsoleCommand('give stim', host)).toEqual(['item:stim:1']);
    expect(runConsoleCommand('drunk 70', host)).toEqual(['drunk:70']);
    expect(runConsoleCommand('drunk', host)).toEqual(['drunk:max']);
  });
});
