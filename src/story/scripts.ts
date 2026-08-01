import type { WeaponId } from '../config';
import type { MapPt } from '../world/mapData';
import type { PlacedSite } from '../world/placements';
import {
  CANDICE_VAN_SPOT, DELIVERY_STOPS, EVIDENCE_VAN_SPOT, GENNY_ROUND_STOPS, GTI_SPOT, HOSTILE_SPOTS,
  KELVIN_GATE_SPOT, PIER_SPOT, PORTIA_CAR_SPOT, QUARRY_SPAWN, RANK_STOPS, STASH_SPOTS, SUBSTATION_SPOT, TANKER_SPOT,
} from '../world/placements';

export const PORTIA_BAKKIE_COLOR = 0xd9a53b; // Portia's mustard bakkie — unique among the world's vans so "find MY bakkie" is findable
export const CANDICE_VAN_COLOR = 0x2e8b57; // bottle-green, matches her utility streetwear
export const QUARRY_COLOR = 0x6b4b2a; // the cable buyer's rust-brown bakkie
export const TANKER_COLOR = 0xb8621b; // the diesel bakkie's rusted orange (no tanker model exists — the copy says bakkie, honestly)
export const EVIDENCE_VAN_COLOR = 0xdfe3e6; // Sindi's boxy white evidence van

/** Hostile crew spawned when the mission enters an objective (or registers a specific checkpoint stop). */
export interface MissionWave { objective: number; checkpoint?: number; spots: MapPt[] }
/** A scripted vehicle: parked at `spawn` from `spawnObjective`; optionally drives off at `departObjective`
 *  toward `destination`; optionally set alight when `igniteObjective` begins (Paper Fire).
 *  `followCapSeconds`: after that much successful tailing the follow objective completes early with
 *  `followCapNote` — nobody tails a bakkie across a whole city for fun (owner playtest). */
export interface MissionQuarry { spawnObjective: number; departObjective?: number; kind: string; color: number; spawn: PlacedSite; destination?: MapPt; arriveRadius?: number; igniteObjective?: number; followCapSeconds?: number; followCapNote?: { title: string; detail: string } }
/** Showroom-style alarm: evaluated once when the objective begins — screams if the grid is up, dead if not. */
export interface MissionAlarm { objective: number; level: number; title: string; detail: string; silentTitle: string; silentDetail: string }

/**
 * Declarative per-mission runtime: everything Game.ts needs beyond the pure objective
 * list — checkpoint stop routes, the mission-critical vehicle to reset on restart,
 * hostile waves, tail quarries, grid/wanted/radio beats, diary payouts. Data only.
 */
export interface MissionScript {
  stops?: MapPt[];
  vehicle?: { color: number; spot: PlacedSite };
  waves?: MissionWave[];
  quarry?: MissionQuarry;
  /** Entering this objective trips the grid (forces a load-shedding start if the power is up). */
  forceBlackout?: number;
  /** Entering this objective brings JMPD heat. */
  wanted?: { objective: number; level: number };
  /** Entering this objective tops the player up to one parachute (Sipho keeps spares under the seat). */
  grantParachute?: number;
  alarm?: MissionAlarm;
  /** Radio-tone story beats when an objective begins. */
  radio?: Array<{ objective: number; title: string; detail: string }>;
  /** Riddle hint escalation on a per-objective clock; `reveal` drops a real blip (the final mercy). */
  hints?: Array<{ objective: number; afterSeconds: number; detail: string; reveal?: boolean }>;
  /** Spoken on completion (dialogue card): where every act-1 hook to the next rung lands. */
  outro?: Array<{ speaker: string; text: string }>;
  /** Run the Kelvin Yard security model every frame while this mission is active. */
  depot?: boolean;
  /** Grid Diary page granted when the mission completes. */
  diaryPage?: number;
  /** Felt payback beyond the base cash reward — a keepable/unlock most missions, celebrated on the
   *  MISSION PASSED card (owner: 'give them something in return for the work'). */
  rewards?: { weapon?: WeaponId; armour?: number; grantVehicle?: { kind: string; color: number }; standing?: number; note?: string };
  /** A deliberately long objective (the journey IS the mission): exempt from the ~1200u route cap.
   *  Rare and earned — never in act 1 (owner). */
  journeys?: number[];
  /** Effort tier — the harness enforces a route-distance band per mission (owner: distance must scale
   *  with the perceived goal). favour ~<=1000u, standard ~<=1800u, substantial ~<=2800u (event en
   *  route), journey unbounded (the sanctioned long hauls). Default: standard. */
  tier?: 'favour' | 'standard' | 'substantial' | 'journey';
}

const around = (point: MapPt, offsets: Array<[number, number]>): MapPt[] => offsets.map(([dx, dz]) => ({ x: point.x + dx, z: point.z + dz }));

export const MISSION_SCRIPTS: Readonly<Record<string, MissionScript>> = {
  // ---- On-ramp + Act 1 --------------------------------------------------------------
  // Round 4: favour -> standard. The owner doubled the drop spacing ("the current ones are too
  // close again"), and the harness-measured legs (1,475 / 1,665 / 1,711 m road) are standard-band drives.
  'delivery-run': { tier: 'standard',
    stops: DELIVERY_STOPS,
    vehicle: { color: PORTIA_BAKKIE_COLOR, spot: PORTIA_CAR_SPOT },
    rewards: { armour: 50, note: 'Auntie Portia sends you off with cash and her late husband\'s body armour' },
    forceBlackout: 1, // the opener's thesis, 90 seconds in: the grid dies around the player mid-drive
    radio: [
      { objective: 1, title: 'Auntie Portia', detail: 'Load shedding NOW? There was no shedding on the schedule, boet. Somebody\'s schedule, maybe.' },
      { objective: 2, title: 'Auntie Portia', detail: 'Second buyer paid short — says his genny subscription is due. EVERYONE\'S genny subscription is due. Since when is light a subscription, boet?' },
    ],
    outro: [
      { speaker: 'Auntie Portia', text: 'My bakkie, my couch money, AND you drove through that blackout like a taxi driver. Sharp. Keep the bakkie as long as you need it.' },
      { speaker: 'Auntie Portia', text: 'And take this — my late Sipho\'s vest. Everyone in this city pays twice for light now, and Vusi says there\'s cash in that. Pothole Street. Don\'t sign anything.' },
    ],
  },
  'hot-property': { tier: 'substantial',
    vehicle: { color: 0xd83a40, spot: GTI_SPOT },
    outro: [
      { speaker: 'Bra Vusi', text: 'Sweet. The buyer pays TRIPLE when the power\'s out, and never asks where cable comes from.' },
      { speaker: 'Bra Vusi', text: 'Take this — micro SMG, off the same truck as the cable. A man in this business shouldn\'t walk around with just his fists.' },
    ],
    rewards: { weapon: 'smg', note: 'Bra Vusi throws in a Micro SMG' },
  },
  'dockside-signal': { tier: 'substantial',
    waves: [{ objective: 1, spots: HOSTILE_SPOTS }],
    rewards: { weapon: 'shotgun', standing: 6, note: 'Candice arms her new enforcer — a pump shotgun, and the ranks know your name' },
    radio: [{ objective: 3, title: 'Candice', detail: 'What did you grab exactly? Ricardo says there\'s a paper stapled to my permit… a DIESEL roster. Wemmer moves fuel for somebody big.' }],
    outro: [
      { speaker: 'Candice', text: 'Depots, litres, dates. My little rank war is somebody\'s fuel empire, sweetie.' },
      { speaker: 'Candice', text: 'They call him the Genny King. If his diesel runs through MY ranks, I want to know everything. Keep your ears open.' },
    ],
  },
  'copper-wire-blues': { tier: 'standard', quarry: {
    // The buyer drives home to HIS yard — the Kelvin gate (the tail's payoff is first sight of it;
    // the player's own reach objective ends at a vantage kerb up the road, outside the fence ring).
    spawnObjective: 0, departObjective: 1, kind: 'van', color: QUARRY_COLOR, spawn: QUARRY_SPAWN, destination: KELVIN_GATE_SPOT, arriveRadius: 22,
    followCapSeconds: 45, // you tailed him, you didn't commute behind him
    followCapNote: { title: 'Bra Vusi', detail: 'He\'s turning into his yard up ahead — you clocked it? Pull in and have a look. Nice and easy.' },
    // Round 4: the mission used to end SILENTLY at a bare corner with no yard on it — the owner's
    // "waypoint goal with no purpose". The payoff now lands where the design always wanted it.
  },
  outro: [
    { speaker: 'Bra Vusi', text: 'A fenced yard on the industrial edge, guards on the gate, diesel drums to the roof. That\'s no cable buyer, boet — that\'s an EMPIRE.' },
    { speaker: 'Bra Vusi', text: 'They call the place Kelvin Yard. Word is the boss already knows a quiet driver found it. Don\'t be surprised if HE finds YOU.' },
  ] },
  'rank-cold-war': { tier: 'standard',
    stops: RANK_STOPS,
    vehicle: { color: CANDICE_VAN_COLOR, spot: CANDICE_VAN_SPOT },
    rewards: { armour: 50, standing: 8, note: 'Candice\'s ranks are yours to move through — respect, and a vest for the road' },
    waves: [
      { objective: 1, checkpoint: 0, spots: around(RANK_STOPS[0]!, [[7, 4], [-6, 6]]) },
      { objective: 1, checkpoint: 1, spots: around(RANK_STOPS[1]!, [[6, -5], [-7, 4], [4, 8]]) },
    ],
  },
  'last-coach-home': { tier: 'standard',
    radio: [{ objective: 0, title: 'Auntie Portia', detail: 'And if the rank boys give you attitude, tell them Portia sent you. They know me.' }],
  },
  'reading-signs': { tier: 'standard',
    diaryPage: 1,
    rewards: { standing: 4, note: 'Oupa Jakes nods — you can read this city now' },
    hints: [
      { objective: 0, afterSeconds: 90, detail: 'Think, laaitie. Which road ADMITS what broke your suspension?' },
      { objective: 0, afterSeconds: 210, detail: 'Ag fine — Pothole Street, south side of the circle, by the dip that eats cars.', reveal: true },
      { objective: 1, afterSeconds: 90, detail: 'The lane is NAMED for the dark. The city put it on a green sign and everything.' },
      { objective: 1, afterSeconds: 210, detail: 'Loadshed Lane, two blocks on. I\'m old, not patient.', reveal: true },
      { objective: 2, afterSeconds: 90, detail: 'What did offices send before email? This city still sends it.' },
      { objective: 2, afterSeconds: 210, detail: 'Fax Street. East side of your circle. Read faster next time.', reveal: true },
    ],
  },

  // ---- Act 2: "The Payroll" ---------------------------------------------------------
  'the-audition': { tier: 'substantial',
    vehicle: { color: TANKER_COLOR, spot: TANKER_SPOT },
    radio: [{ objective: 1, title: 'Solly', detail: 'Gently, my laaitie. That diesel is worth more than you are. For now.' }],
    outro: [{ speaker: 'Solly', text: 'Not a scratch. You\'re on the payroll now — take the bakkie, it\'s cartel property, which means it\'s yours until it isn\'t.' }],
    rewards: { armour: 100, note: 'The crew kits you out — full body armour on Solly\'s tab' },
  },
  // Round 4: standard -> substantial. The feeder moved to actual Ophirton (Booysens Road) — the
  // named-place lie was the defect, and the honest night drive is a substantial-band leg now.
  'pull-the-plug': { tier: 'substantial',
    forceBlackout: 2, // the breaker goes over: the grid dies around you
    wanted: { objective: 2, level: 2 },
    radio: [{ objective: 2, title: 'The city goes dark', detail: 'Every light you can see just died. Somewhere, a control room phone is ringing.' }],
  },
  'stage-fright': { tier: 'substantial',
    rewards: { grantVehicle: { kind: 'superbike', color: 0x1b1b1e }, note: 'Solly lets you keep a superbike off the showroom floor — pristine, in your garage, yours for good' },
    alarm: {
      objective: 1, level: 3,
      title: 'Showroom alarm', detail: 'The forecourt floodlights snap to you. The whole street hears it.',
      silentTitle: 'Dead quiet', silentDetail: 'The alarm pad is dark. Nothing squeals. Nothing sees.',
    },
  },
  'genny-round': { tier: 'standard',
    stops: GENNY_ROUND_STOPS,
    waves: [{ objective: 0, checkpoint: 2, spots: around(GENNY_ROUND_STOPS[2]!, [[6, 4], [-5, 6]]) }],
  },
  'paper-round': { tier: 'standard',
    diaryPage: 2,
    hints: [
      { objective: 0, afterSeconds: 120, detail: 'The big one, laaitie. Where every line meets and the whole city changes trains.' },
      { objective: 0, afterSeconds: 240, detail: 'Park Station. Right beside the platform. If you can throw a breaker you can read a station board.', reveal: true },
    ],
  },
  'the-wrong-train': { tier: 'journey',
    journeys: [1], // driving the consist to Crown IS the mission — the one earned long haul, with transport handed over
    radio: [{ objective: 1, title: 'Solly', detail: 'Crown Station siding. Stop it like you own it, because tonight you do.' }],
  },
  'crosswinds': { tier: 'journey', grantParachute: 0, journeys: [0, 1, 2], // the flight IS the mission — the one earned aviation setpiece (plane provided out at the strip)
    // Guidance, not geography (round 4): the Kite is 7km away and "fuelled on the apron" read as
    // nearby — the copy now routes the player by train, and this backstop repeats it in the field.
    hints: [{ objective: 0, afterSeconds: 120, detail: 'The apron is out at O.R. Tambourine, my friend. My licence can\'t fly, but the train still runs — Lughawe Halt, right by the airport fence.' }],
  },
  'two-fires': {},
  'paper-fire': { tier: 'standard',
    quarry: { spawnObjective: 0, kind: 'van', color: EVIDENCE_VAN_COLOR, spawn: EVIDENCE_VAN_SPOT, igniteObjective: 2 },
    wanted: { objective: 2, level: 2 },
  },
  'catch-them-cutting': { tier: 'substantial', // Ophirton retarget: Sindi's stakeout is a real cross-town night run now
    waves: [{ objective: 1, spots: around(SUBSTATION_SPOT, [[7, 5], [-6, 4], [5, -6]]) }],
  },

  // ---- Act 3: "Stage Six" -----------------------------------------------------------
  'dark-house': { tier: 'substantial', depot: true, radio: [
    { objective: 1, title: 'Burner phone', detail: 'Gate is a slab. Walk the OUTSIDE fence. Maintenance left one bent post behind the records office. Monday job, they said.' },
    { objective: 3, title: 'Burner phone', detail: 'Same bent fence. No heroics. Leave the way you came.' },
  ] },
  'long-live-the-king': { tier: 'standard',
    waves: [
      { objective: 1, spots: around(KELVIN_GATE_SPOT, [[8, 6], [-7, 8], [6, -7]]) },
      { objective: 2, spots: around(KELVIN_GATE_SPOT, [[10, 4], [-8, -6], [5, 9], [-4, 10]]) },
    ],
  },
  'carcass': { tier: 'substantial', journeys: [2], // the endgame loot sweep is a sanctioned late-arc loop
    stops: STASH_SPOTS,
    wanted: { objective: 0, level: 2 },
  },
  'the-switch': { tier: 'substantial', // Ophirton retarget: the finale dash crosses to the real feeder (timer re-measured: 800s holds at ~2.6km)
    waves: [
      { objective: 1, spots: around(SUBSTATION_SPOT, [[8, 5], [-7, 6], [6, -6], [-5, -7]]) },
      { objective: 2, spots: around(SUBSTATION_SPOT, [[9, 3], [-8, 5], [4, 9]]) },
    ],
  },

  // ---- Side pieces --------------------------------------------------------------------
  // Round 4: the run goes to the REAL Ouma se Padstal, far out west (~9km each way; the pin used to
  // sit in NE suburbia, 9.7km from the landmark the copy names). Timers raised 900 -> 1500s from the
  // measured route; the scenic out-and-back drive is the point.
  'padstal-run': { tier: 'journey', journeys: [0, 2] },
  // Round 4: substantial -> journey. The pin now sits at the REAL Vaalpunt Slipway on the dam
  // (~11km road from Candice) instead of a CBD kerb 9.6km from the place the copy names.
  'pier-pressure': { tier: 'journey', journeys: [0], waves: [{ objective: 1, spots: around(PIER_SPOT, [[5, 3]]) }] },
};
