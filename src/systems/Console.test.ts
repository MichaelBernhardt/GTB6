import { describe, expect, it } from 'vitest';
import { CHEAT_CASH, commandIsCheat, GIVE_WEAPON_IDS, HELP_LINES, heatAfterStarDrop, parseCommand, parseCoordinate, parseTimeToken, runConsoleCommand, tokenize, type ConsoleCommand, type ConsoleHost } from './Console';

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
    expect(parseCommand('Teflon')).toEqual({ kind: 'teflon' });
    expect(parseCommand('teflon on').kind).toBe('error'); // a toggle takes no arguments
  });

  it('parses spawn with kinds and the bakkie alias', () => {
    expect(parseCommand('spawn superbike')).toEqual({ kind: 'spawn', vehicle: 'superbike' });
    expect(parseCommand('spawn bakkie')).toEqual({ kind: 'spawn', vehicle: 'van' });
    expect(parseCommand('spawn taxi')).toEqual({ kind: 'spawn', vehicle: 'taxi' });
    expect(parseCommand('spawn cab').kind).toBe('error');
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
    for (const bad of ['give', 'give stim 0', 'give stim lots', 'give pistol 2', 'give ammo 5']) expect(parseCommand(bad).kind, bad).toBe('error');
    // Unknown items are no longer parse errors — they route to the feature grant seam, whose HOST
    // answers "nothing in the game is called that" (see the grant tests below).
    expect(parseCommand('give spaceship')).toEqual({ kind: 'give-feature', item: 'spaceship', count: 1 });
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

  it('parses mission list, jump-start and complete', () => {
    expect(parseCommand('mission')).toEqual({ kind: 'mission-list' });
    expect(parseCommand('mission 7')).toEqual({ kind: 'mission-start', index: 7 });
    expect(parseCommand('Mission Complete')).toEqual({ kind: 'mission-complete' }); // tokenizer lowercases
    for (const bad of ['mission complete now', 'mission done', 'mission 0', 'mission -1', 'mission two']) {
      expect(parseCommand(bad).kind, bad).toBe('error');
    }
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
    missionList: () => ['mission:list'],
    missionStart: (index) => `mission:${index}`,
    missionComplete: () => 'mission:complete',
    setTimerate: (rate) => `timerate:${rate}`,
    toggleFps: () => 'fps',
    togglePerfChart: () => 'perfchart',
    spawn: (kind) => `spawn:${kind}`,
    giveCash: (amount) => `cash:${amount}`,
    dropStar: () => 'star',
    toggleSirens: () => 'sirens toggled', toggleShedding: () => 'eskom', toggleTeflon: () => 'teflon toggled',
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
    feature: (args) => [`feature:${args.join(' ') || 'list'}`],
    giveFeatureItem: (item, count) => [`grant:${item}:${count}`],
    toggleOpenSesame: () => 'sesame toggled',
    cheatUsed: () => undefined, // the chokepoint has its own describe below
  };

  it('routes parsed commands to host handlers and echoes their feedback', () => {
    expect(runConsoleCommand('set time 0800', host)).toEqual(['time:8']);
    expect(runConsoleCommand('vroomvroom', host)).toEqual(['spawn:superbike']);
    expect(runConsoleCommand('ritchierich', host)).toEqual([`cash:${CHEAT_CASH}`]);
    expect(runConsoleCommand('unwanted', host)).toEqual(['star']);
    expect(runConsoleCommand('shedding', host)).toEqual(['eskom']);
    expect(runConsoleCommand('nomoresirens', host)).toEqual(['sirens toggled']);
    expect(runConsoleCommand('teflon', host)).toEqual(['teflon toggled']);
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
    expect(runConsoleCommand('mission', host)).toEqual(['mission:list']);
    expect(runConsoleCommand('mission 3', host)).toEqual(['mission:3']);
    expect(runConsoleCommand('mission complete', host)).toEqual(['mission:complete']);
    expect(runConsoleCommand('mission zero', host)[0]).toMatch(/Usage: mission/);
    expect(runConsoleCommand('mission 0', host)[0]).toMatch(/Usage: mission/);
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

describe('the new grant commands and opensesame', () => {
  it('parses give lockpick (with the plural alias) as a counted host item', () => {
    expect(parseCommand('give lockpick')).toEqual({ kind: 'give-item', item: 'lockpick', count: 1 });
    expect(parseCommand('give lockpicks 3')).toEqual({ kind: 'give-item', item: 'lockpick', count: 3 });
    expect(parseCommand('give lockpick 0').kind).toBe('error');
  });

  it('routes unknown give items to the feature grant seam instead of erroring', () => {
    expect(parseCommand('give tyres')).toEqual({ kind: 'give-feature', item: 'tyres', count: 1 });
    expect(parseCommand('give tyres 2')).toEqual({ kind: 'give-feature', item: 'tyres', count: 2 });
    expect(parseCommand('give zol 5')).toEqual({ kind: 'give-feature', item: 'zol', count: 5 });
    expect(parseCommand('give tyres nope').kind).toBe('error');
    expect(parseCommand('give tyres 0').kind).toBe('error');
  });

  it('parses opensesame as a no-argument cheat word', () => {
    expect(parseCommand('opensesame')).toEqual({ kind: 'opensesame' });
    expect(parseCommand('OpenSesame')).toEqual({ kind: 'opensesame' });
    expect(parseCommand('opensesame now').kind).toBe('error');
  });
});

describe('the cheat classification (default is CHEAT; exemptions are deliberate)', () => {
  // Every command kind the console can produce, with its ruled classification. A kind someone adds
  // without updating this table fails the exhaustiveness check below — and defaults to cheat in the
  // code, which is the safe direction.
  const RULINGS: Record<ConsoleCommand['kind'], boolean> = {
    // exempt: read-only, cosmetic, or a named save mechanic
    'noop': false, 'error': false, 'help': false, 'fps': false, 'perfchart': false, 'map': false,
    'save': false, 'reload': false, 'busy': false, 'tp-list': false, 'mission-list': false,
    // cheats — including mapnpcs (unearned information advantage) and shedding (the owner's own
    // ruling: a toggle is a cheat by virtue of the direction that helps)
    'mapnpcs': true, 'shedding': true, 'nomoresirens': true, 'teflon': true, 'unwanted': true,
    'cash': true, 'spawn': true, 'ghost': true, 'set-time': true, 'set-timerate': true,
    'set-busy': true, 'set-peds': true, 'set-cars': true, 'set-pos': true, 'tp-coords': true,
    'tp-name': true, 'skyfall': true, 'give-weapon': true, 'give-ammo': true, 'give-armour': true,
    'give-item': true, 'give-feature': true, 'opensesame': true, 'drunk': true,
    'mission-start': true, 'feature': true, // 'feature' WITH args; the bare list is special-cased below
    // mission-complete skips the playing — a cheat by the owner's default rule, even when used for
    // testing; that the tester's save gets flagged is intended.
    'mission-complete': true,
  };

  it('classifies every command kind, most of them as cheats', () => {
    const inputs: Record<ConsoleCommand['kind'], string> = {
      'noop': ' ', 'error': 'wololo', 'help': 'help', 'fps': 'fps', 'perfchart': 'perfchart',
      'map': 'map', 'save': 'save', 'reload': 'reload', 'busy': 'busy', 'tp-list': 'tp list',
      'mission-list': 'mission', 'mapnpcs': 'mapnpcs', 'shedding': 'shedding',
      'nomoresirens': 'nomoresirens', 'teflon': 'teflon', 'unwanted': 'unwanted',
      'cash': 'ritchierich', 'spawn': 'spawn taxi', 'ghost': 'ghost', 'set-time': 'set time 1200',
      'set-timerate': 'set timerate 2', 'set-busy': 'set busy 300', 'set-peds': 'set peds 10',
      'set-cars': 'set cars 10', 'set-pos': 'set x 100', 'tp-coords': 'tp 10 10',
      'tp-name': 'tp sandton', 'skyfall': 'skyfall', 'give-weapon': 'give rpg',
      'give-ammo': 'give ammo', 'give-armour': 'give armour', 'give-item': 'give lockpick',
      'give-feature': 'give tyres', 'opensesame': 'opensesame', 'drunk': 'drunk',
      'mission-start': 'mission 1', 'feature': 'feature interiors leave',
      'mission-complete': 'mission complete',
    };
    for (const [kind, ruled] of Object.entries(RULINGS)) {
      const command = parseCommand(inputs[kind as ConsoleCommand['kind']]);
      expect(command.kind, `input for ${kind} parsed as ${command.kind}`).toBe(kind);
      expect(commandIsCheat(command), kind).toBe(ruled);
    }
  });

  it('exempts the bare feature listing but not feature commands', () => {
    expect(commandIsCheat(parseCommand('feature'))).toBe(false);
    expect(commandIsCheat(parseCommand('feature interiors doors'))).toBe(true);
  });

  it('treats any UNKNOWN future kind as a cheat by default', () => {
    expect(commandIsCheat({ kind: 'some-command-added-next-month' } as unknown as ConsoleCommand)).toBe(true);
  });
});

describe('the cheat chokepoint in runConsoleCommand', () => {
  const marks: string[] = [];
  const host = new Proxy({}, {
    get: (_target, prop) => prop === 'cheatUsed'
      ? () => { marks.push('mark'); }
      : () => (prop === 'feature' || prop === 'teleportList' || prop === 'missionList' || prop === 'giveFeatureItem' ? [] : 'ok'),
  }) as ConsoleHost;

  it('marks cheats before dispatch and leaves exempt commands unmarked', () => {
    marks.length = 0;
    runConsoleCommand('help', host); runConsoleCommand('save', host); runConsoleCommand('reload', host);
    runConsoleCommand('map', host); runConsoleCommand('fps', host); runConsoleCommand('busy', host);
    expect(marks).toHaveLength(0);
    runConsoleCommand('shedding', host);
    expect(marks).toHaveLength(1);
    runConsoleCommand('opensesame', host);
    runConsoleCommand('give tyres 2', host);
    runConsoleCommand('mapnpcs', host);
    runConsoleCommand('tp 10 10', host);
    runConsoleCommand('mission complete', host);
    expect(marks).toHaveLength(6);
    // a malformed command runs nothing and marks nothing
    runConsoleCommand('give tyres zero', host);
    expect(marks).toHaveLength(6);
  });
});

