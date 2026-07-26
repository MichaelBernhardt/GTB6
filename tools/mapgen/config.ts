/**
 * Configuration for the Johannesburg OSM map pipeline (Phase 1, offline only).
 * All distances in the PROCESS section are real-world metres (pre-scale);
 * widths and TARGET_SIZE are game world units.
 */

/**
 * FETCH box — FROZEN. Every disk cache in tools/mapgen/cache/ is keyed by a query hash that
 * embeds these four numbers (overpass.ts:18, elevation.ts:74), so changing it invalidates the
 * 4.97 MB Overpass extract, the Cape extract, the SRTM grid and the station nodes, and forces a
 * slow (and rate-limited) network round trip. Crop with CROP_BBOX instead — there is no data
 * outside this box, so a crop can only ever shrink inward.
 */
export const BBOX = { south: -26.23, west: 27.97, north: -26.09, east: 28.09 } as const;

/**
 * CROP box — the extent that actually becomes the game world. MUST be a subset of BBOX.
 * Applied to the fetched vector data (process.ts `inBbox`) so the whole organify chain —
 * run-splitting, thinning, stub pruning, orbital ring, island bridging, dead-end resolution,
 * meander — runs over the cropped input and treats the new boundary exactly like the old one.
 * Set equal to BBOX for a no-op.
 *
 * Current value: 2/3 of the fetched linear extent in both axes (lat span 0.09333 deg of 0.14,
 * lon span 0.0800 deg of 0.12), shifted east so the CBD sits nearer the east edge and the
 * Killarney golf rings survive whole.
 */
export const CROP_BBOX = { south: -26.23, west: 27.986, north: -26.13667, east: 28.066 } as const;

if (
  CROP_BBOX.south < BBOX.south || CROP_BBOX.north > BBOX.north ||
  CROP_BBOX.west < BBOX.west || CROP_BBOX.east > BBOX.east
) {
  throw new Error(
    `CROP_BBOX must be a subset of the fetched BBOX (there is no data outside it): ` +
      `crop=${JSON.stringify(CROP_BBOX)} fetch=${JSON.stringify(BBOX)}`,
  );
}

/** Approximate centre of the Joburg CBD (Rissik & Commissioner area). */
export const CBD_CENTER = { lat: -26.205, lon: 28.043 } as const;

/** Residential streets are only fetched within this radius (m) of the CBD centre. */
export const RESIDENTIAL_RADIUS_M = 2000;

/** Douglas-Peucker simplification tolerance in metres. */
export const SIMPLIFY_TOLERANCE_M = 8;

/** Junction nodes closer than this (metres) are snapped together. */
export const SNAP_DISTANCE_M = 12;

/**
 * Disconnected sub-networks (islands) whose nearest node is within this
 * distance (metres) of the main component get bridged with a connector
 * segment instead of being dropped.
 */
export const BRIDGE_DISTANCE_M = 60;

/** Roads shorter than this (metres, whole polyline) are discarded as noise. */
export const MIN_ROAD_LENGTH_M = 25;

/** Water polygons smaller than this (square metres) are discarded. */
export const MIN_WATER_AREA_M2 = 4000;

/**
 * Target square footprint (game units). The real bbox is fitted inside, aspect preserved.
 * 18000 is the true-parity scale on owner direction: it measures ~0.98 m/unit with the
 * coast+corridor graft — effectively "1 unit = 1 metre", so drive times and block sizes match
 * the real city (the previous 36000 was 0.49 m/u, exactly 2x oversized). ROAD_WIDTHS/
 * TRACK_WIDTHS and the runway/pier/taxiway *widths* stay game-scale (fixed) while the whole
 * layout is map-scale, and every metre-denominated feature below (corridor, runway/pier
 * LENGTHS, dam, ring, meanders) scales with the map automatically because it is converted
 * through fit.scale. A 2-unit-wide car still gets the same two-lane carriageway.
 */
/**
 * SCALE VARIANT. The crop controls HOW MUCH CITY; this controls HOW BIG EACH BLOCK FEELS.
 * They MULTIPLY — never quote one without the other.
 *   '075'    (default, the shipping variant): ~1.33 m/unit, blocks 75% the size of real Joburg
 *            relative to the fixed game-scale car.
 *   'parity' (the control): ~1.00 m/unit, "1 unit = 1 metre", same content, bigger blocks.
 * Override per build with MAPGEN_SCALE=parity npm run map:build.
 */
export const SCALE_VARIANT = (process.env.MAPGEN_SCALE ?? '075') as '075' | 'parity';
const SCALE_FACTOR = SCALE_VARIANT === 'parity' ? 1 : 0.75;

/**
 * Calibrated against the emitted `[process] fit: road bbox W x H m` line for THIS crop
 * (measured 11,773 m on the governing axis — clipping Dam Wal Road to the city span, so the
 * water can run off the map without dragging the fit with it, took 122 m off the old 11,895).
 * PARITY_TARGET_SIZE / metresPerUnit = the fit; TARGET_SIZE is read at only three places
 * (process.ts) and the whole graft/ring/meander chain works in projected metres, so
 * re-calibrating after a crop change is a one-shot: build, read the log line, set
 * PARITY_TARGET_SIZE = max(W,H) / 0.9914, rebuild. Hold metresPerUnit at ~1.322 across crops:
 * the crop decides how much city, this decides how big a block feels, and comparing two crops
 * is only meaningful if the block scale is identical in both.
 */
const PARITY_TARGET_SIZE = 11875;
export const TARGET_SIZE = Math.round(PARITY_TARGET_SIZE * SCALE_FACTOR);

/** Game-unit road widths per OSM highway class. */
export const ROAD_WIDTHS: Record<string, number> = {
  motorway: 24,
  motorway_link: 11,
  trunk: 18,
  trunk_link: 10,
  primary: 14,
  primary_link: 8,
  secondary: 11,
  secondary_link: 7,
  tertiary: 9,
  tertiary_link: 6,
  residential: 7,
};

/** Off-road tracks/trails (not part of the connected road graph). */
export const TRACK_WIDTHS: Record<string, number> = {
  track: 5,
  path: 3,
};

/** Landuse polygons smaller than this (square metres) are discarded. */
export const MIN_LANDUSE_AREA_M2 = 15_000;

/**
 * Density thinning ("guided by life, not true to life"): minor roads mostly running
 * parallel within THIN_COVERAGE_DISTANCE_M of an already-retained road are dropped, so
 * the ~70 m CBD grid decimates to a driveable pitch. Parody/anchor street names (the
 * names-overrides keys plus the list below) are never dropped.
 */
export const THIN_COVERAGE_DISTANCE_M = 55;
export const THIN_COVERAGE_FRACTION = 0.62;
export const THIN_SAMPLE_STEP_M = 20;
export const THIN_PARALLEL_COS = 0.8; // ~36 degrees
export const THIN_MAX_RANK = 3; // residential..secondary may be dropped; primary+ never
/** Post-thinning cleanup: dangling minor spurs shorter than this (m) are pruned. */
export const STUB_PRUNE_LENGTH_M = 80;
/** Anchor streets the game placements rely on that are not in names-overrides.json. */
export const PROTECTED_ROAD_NAMES = [
  'Albertina Sisulu Road',
  'Wemmer Jubilee Road',
  'Lilian Ngoyi Street',
  'Wanderers Street',
  'Anderson Street',
  'Von Weilligh Street',
] as const;

/** Boundary orbital: dangling endpoints near the crop edge are joined into one ring road. */
export const RING_BOUNDARY_MARGIN_M = 380;
export const RING_OFFSET_M = 220;
export const RING_CORNER_CHAMFER_M = 420;
export const RING_NAME = 'Egoli Orbital';
export const RING_KIND = 'trunk' as const;

/**
 * Set-back between the outermost roads and the world edge (game units). The roads keep the
 * true-parity TARGET_SIZE fit (1 unit ~= 1 m — do not shrink it, gameplay constants are
 * calibrated to it); instead the declared world square GROWS by this margin per side, so no
 * road runs along the very edge — the band gets border veld cover.
 */
export const EDGE_MARGIN_UNITS = Math.round(600 * SCALE_FACTOR);

/**
 * Border veld: organic scrub polygons filling the set-back band along the north, east and
 * south world edges (the west edge is ocean). Scrub is a GREEN_KIND in-game, so the band
 * grows dry veld grass and scattered trees — cover between the outer roads and the edge.
 */
export const BORDER_VELD_NAME = 'Randveld';
export const BORDER_VELD_DEPTH_MIN_M = 380;
export const BORDER_VELD_DEPTH_MAX_M = 1050;

/**
 * Coast loop links: the orbital opens into a C on the west side; these two connectors close
 * its open ends onto the coastal highway's ends, so the whole map is wrapped in one drivable
 * loop (no dead-ending ring or highway tips at the corners). Cape names, matching the graft.
 */
export const COAST_LOOP_LINKS = [
  { name: 'Middelbult Road', kind: 'primary', end: 'north' },
  { name: 'Oranjeville Road', kind: 'primary', end: 'south' },
] as const;

/**
 * Dead-end resolution (owner: clipped roads "just lead to nowhere"): dangling endpoint pairs
 * closer than DEADEND_JOIN_M are joined into loops; remaining ends within DEADEND_CONNECT_M
 * of another road get a T-connector; leftover dangling tails shorter than DEADEND_PRUNE_M
 * (or _MAJOR_M for primary and up) are truncated back to the last junction.
 */
export const DEADEND_JOIN_M = 560;
export const DEADEND_CONNECT_M = 300;
export const DEADEND_PRUNE_M = 450;
export const DEADEND_PRUNE_MAJOR_M = 160;
/** Roads allowed to end dead (quays, slipways, farm lanes, airport apron access). */
export const CUL_DE_SAC_NAMES = [
  'Deneys Quay',
  'Sloepbaai Road',
  'Aviator Avenue',
  'Melkweg',
  'Kraal Close',
] as const;

/**
 * CAPE EXTRACT — vestigial. The west edge used to be an Atlantic-style coastline grafted from
 * Cape Town's Sea Point -> Camps Bay seaboard; it is now the real Vaal Dam (VAAL_BBOX below), and
 * this extract survives only for its two beach polygons, which become the dam's resort strands.
 * The farmland corridor between the shore and the city block stays ("a little drive between them").
 */
export const CAPE_BBOX = { south: -33.93, west: 18.37, north: -33.87, east: 18.42 } as const;

/**
 * VAAL DAM — the real reservoir the map's west edge is cut from, ~70 km south of the city box.
 * A separate, tiny, one-off Overpass query (overpass.ts fetchVaal), cached and COMMITTED, so the
 * city extract / SRTM / stations / building caches stay valid and every build stays offline.
 *
 * The box covers the dam's north-west arm: Deneysville and Refengkgotso in the west, the dam wall,
 * Grooteiland mid-water, Vaal Marina in the east, Leboya Bay on the northern arm, and the
 * Groenpunt wastewater plant on the north-west shore.
 */
export const VAAL_BBOX = { south: -26.98, west: 27.95, north: -26.78, east: 28.35 } as const;
/**
 * VAAL NORTH SHORE — the *infrastructure* box, deliberately separate from VAAL_BBOX above.
 *
 * VAAL_BBOX/fetchVaal brings the water and a handful of point furniture. It brings no roads and no
 * buildings, which is why Deneysville, Refengkgotso, Misty Bay and Vaal Marina render as empty land
 * with district labels on them. This box is the second one-off query (overpass.ts fetchVaalShore)
 * that pulls the real north-shore ways: every highway class, buildings, leisure/tourism (marinas,
 * slipways, resorts, camp sites), beaches, landuse, amenities, waterways and place nodes.
 *
 * Widened past the "roughly (-26.93,28.05)-(-26.85,28.25)" brief so the named landmarks all land
 * inside it: Groenpunt (-26.8261,28.04), Middelbult (-26.8372,28.0494) and the Groenpunt wastewater
 * plant (-26.8188,28.0517) sit north-west of that box, and Vaal Marina (-26.8744,28.2311) sits on
 * its east lip. The area is sparsely mapped (~1000 highways, ~500 buildings) so the widening is
 * nearly free.
 */
export const VAAL_SHORE_BBOX = { south: -26.94, west: 28.0, north: -26.8, east: 28.27 } as const;
/** OSM relation id of the Vaal Dam water body (`natural=water` + `water=reservoir`, 44 outer rings,
 *  19 inner rings/islands). Pinned rather than bbox-matched: a bbox query drags in farm dams, and
 *  a stable id keeps the committed cache key stable. */
export const VAAL_WATER_RELATION = 253822;
/** Projection origin for the Vaal strip (mid-dam) — see vaal.ts for the -90 degree re-orientation. */
export const VAAL_ORIGIN = { lat: -26.9, lon: 28.15 } as const;
/**
 * The three anchors that cut the north-shore run out of the closed outer ring. GEOGRAPHIC, not
 * indices: the chained ring's starting vertex depends on member order, so an index would drift.
 *   START — the bay south-west of Deneysville (becomes the map's NORTH end, running off the west edge)
 *   MID   — up the northern arm past Leboya Bay (disambiguates which way round the ring to travel)
 *   END   — the shore east of Vaal Marina (becomes the map's SOUTH end)
 */
export const VAAL_SHORE_START = { lat: -26.923059, lon: 28.100699 } as const;
export const VAAL_SHORE_MID = { lat: -26.836396, lon: 28.198531 } as const;
export const VAAL_SHORE_END = { lat: -26.869243, lon: 28.286706 } as const;
/** Island rings smaller than this are sub-pixel at the fitted scale — Grooteiland has 281. */
export const VAAL_MIN_ISLAND_POINTS = 60;
/**
 * Rural corridor width between the Joburg west edge and the coastal strip (metres).
 * Metre-denominated, so it scales with the map: at the 36000 u footprint (~0.49 m/u) the 2700 m
 * corridor is a ~5500 u drive — the "little drive between them" grows proportionally with the
 * scale-up, exactly as intended.
 */
export const CORRIDOR_WIDTH_M = 2000;
/** Coastal road sits this far inland of the waterline. */
export const COAST_ROAD_SETBACK_M = 260;
/** The dam fill extends this far west of the shoreline (past the world edge — no far shore). */
export const OCEAN_EXTENT_M = 2600;
export const COASTAL_ROAD_NAME = 'Dam Wal Road';

/**
 * VAALPUNT DAM — the inland reservoir that replaces the ocean, cut from the REAL Vaal Dam
 * shoreline (tools/mapgen/vaal.ts fetches it; tools/mapgen/dam.ts fits it).
 *
 * Johannesburg is landlocked; an Atlantic seaboard was the single most immersion-breaking thing
 * on the map. The first replacement was synthetic — fBm bays plus three hand-placed notches — and
 * the owner's verdict on seeing the real thing was blunt: "Looks at the real Vaal, yes, it's quite
 * crenulated and distinctive. Perhaps we should get the poly from OSM." So the shore is now the
 * actual north-west arm of the Vaal: Deneysville and the 1938 dam wall at the top of the map, the
 * northern arm reaching east as a waterway, Grooteiland mid-water, the Misty Bay / Vaal Marina
 * shore below it, and the run leaving the world square at both ends.
 *
 * TWO HARD CONSTRAINTS ON THE SHAPE:
 *
 * 1. SINGLE-VALUED, x = f(z). src/world/beachfront.ts coastXAt() and src/world/City.ts
 *    coastlineXAt() both model the shore as a function of z. The real shoreline is not one, so
 *    dam.ts UNFOLDS it (backward-running stretches drift forward in proportion to their own
 *    length) rather than flattening it. Do not "fix" that by taking an easternmost crossing —
 *    that is what puts a ruler-straight line across every inlet mouth.
 *
 * 2. A LOBE, NOT A BAND. The water enters the west edge, bulges east and leaves the west edge
 *    again, so BOTH west corners of the world are dry land — the owner's "like the lake is
 *    pushing in from the left side, but never covers the full left extent". The band therefore
 *    ENDS inside the world square in z, which is only safe because the shore has already run west
 *    off the square by then (DAM_END_WEST_M); process.ts asserts it after the fit.
 */
export const DAM_NAME = 'Vaalpunt Dam';
/**
 * Sampling pitch for the shore ROAD only (m) — Dam Wal Road's running-max hull is walked on a
 * uniform grid because a road IS a smooth curve. The SHORELINE is emphatically not sampled on a
 * grid any more; see DAM_SHORE_TOLERANCE_M.
 */
export const DAM_SHORE_STEP_M = 35;
/**
 * THE CRENELLATION FIX (C1). The shore used to be simplified at 35 real metres and then RESAMPLED
 * onto an even 35 m pitch, which emitted 269 points with segment lengths of min 26 / median 29 /
 * max 109 units — very nearly uniform. That is what erased the crenellation the owner could not
 * see: a real shoreline is dense in bays and inlets and sparse along straights, and an even pitch
 * throws away precisely that distribution.
 *
 * Now the raw vertices are kept at a few real metres (below), the strip is fitted, and the
 * reduction happens AFTERWARDS in MAP metres as adaptive Douglas-Peucker — points survive where
 * the shore turns and are dropped only where it is genuinely straight.
 */
export const DAM_SOURCE_SIMPLIFY_M = 2;
/** Adaptive Douglas-Peucker tolerance on the FITTED shore, in map metres (~1 unit = 1.32 m).
 *  8 m is about 6 world units: finer than a car is long, so nothing a player can walk up to is
 *  straightened, while the open straights collapse to a handful of vertices. */
export const DAM_SHORE_TOLERANCE_M = 8;
/** Ceiling on emitted segment length (map metres). Subdivides STRAIGHTS only — the bays are
 *  already dense — so the beach cutter, the road hull and the runtime's per-z lookups always find
 *  a vertex nearby. Deliberately much coarser than the median segment, so it does not re-impose
 *  a uniform pitch. */
export const DAM_SHORE_MAX_SEG_M = 110;
/**
 * DE-TILT WINDOW (real metres of unfolded shore). The north shore between Grooteiland and Misty
 * Bay drifts 8.6 km across-shore over 28 km of walk — it is a diagonal. Fitted raw, that diagonal
 * saturates the tanh and becomes the entire shape (one broad open lobe); the drowned valleys, which
 * are 1-3 km excursions about it, disappear into the saturation. Subtracting the drift over this
 * window turns the same real geometry into a north-south coast with the valleys standing out as
 * arms reaching east. Keep it well above the longest arm you want (a window shorter than an arm
 * cancels that arm); 9 km keeps everything up to ~4 km of reach.
 */
export const DAM_DETREND_WINDOW_M = 14000;
/**
 * Unfold strength: minimum forward z advance per metre of real shoreline walked. 0 would leave
 * the shore multi-valued; 1 would stand every inlet on end. 0.32 leans the real inlets just
 * enough to make them functions of z while roughly doubling the strip's z extent, which is where
 * the fit's mild anisotropy comes from — bays keep their width, arms lean.
 */
export const DAM_UNFOLD_ALPHA = 0.40;
/**
 * How much of the shore's TRUE across-step z advance the unfold keeps while it is inventing forward
 * motion. Must stay below DAM_UNFOLD_ALPHA (dz >= -ds, so alpha*ds + tracking*dz > 0 exactly when
 * tracking < alpha) or the shore stops being a function of z. Zero — the old behaviour — makes the
 * side of a drowned valley an EXACT straight line, because a stretch with dz ~ 0 then advances by
 * alpha*ds alone and both mapped coordinates become linear in the same real coordinate. Measured:
 * the longest ruler-straight run in the emitted shore was 920 units at tracking 0.
 */
export const DAM_UNFOLD_TRACKING = 0.30;
/**
 * Across-shore reach budgets (m, each side of the mean shoreline), applied as a smooth tanh
 * soft-clip rather than a hard clamp. The real dam is ~320 km2 against this map's 168 km2 and its
 * northern arm alone reaches 10 km east of the mean shore, where the map's whole west band is
 * ~2 km wide. tanh is the identity to within 3% for a 200 m bay and asymptotic for the arm, so
 * the crenellation is untouched and only the one huge reach is compressed. A hard clamp would put
 * a flat wall across the arm instead.
 */
export const DAM_REACH_EAST_M = 2400;
export const DAM_REACH_WEST_M = 1900;
/**
 * ACROSS-SHORE GAIN — the control that turns the real drowned valleys into arms you can see.
 *
 * `unfoldToMonotoneZ` stands every backward-running stretch of the real shore on end, which
 * inflates the strip's z extent by roughly 2x (the exact factor is measured and logged per build)
 * while leaving the across-shore extent alone. A single uniform fit factor applied AFTER that is
 * therefore anisotropic: every bay comes out squashed by the inflation, which is why the previous
 * shore read as shallow scallops instead of flooded valleys. This gain multiplies the across-shore
 * residual back up. Setting it to the measured inflation makes the fit isotropic with the real dam
 * again; a little above that trades literal fidelity for legibility at map zoom.
 */
export const DAM_CROSS_SHORE_GAIN = 3.0;
/** Quantile of the real strip's across-shore coordinate that lands on the mean shoreline. */
export const DAM_SHORE_QUANTILE = 0.55;
/**
 * THE LOBE'S ENDS. Over the last DAM_END_RUNOUT_M of band the shoreline is pulled west until its
 * end vertex sits DAM_END_WEST_M west of the mean shore — past the world's west edge, so the two
 * horizontal caps that close the water polygon are entirely off-map and the corners north and
 * south of the lobe are land. The real crenellation rides on the ramp, so the run-out is curved
 * coastline leaving the frame, never a diagonal and never a cap.
 */
export const DAM_END_RUNOUT_M = 700;
/**
 * HOW FAR OUTSIDE THE WORLD SQUARE THE WATER POLYGON CLOSES (m). C4: the old closure ran two
 * dead-straight horizontal caps whose nearest ends were 425 m west of the square, in plain view
 * with void above them. The closure is now a continuously-curving sweep whose long straight runs
 * all sit at least this far outside the square on every side. 3,600 m is 2,600+ world units: at a
 * camera height of ~10 u a straight edge that far away subtends 0.2 degrees of depression — it is
 * ON the horizon, not below it — and FogExp2 at 0.00025 has taken ~45% of it as well.
 */
export const DAM_CLOSURE_MARGIN_M = 3600;
export const DAM_END_WEST_M = 3900;
/**
 * Height of the water's z-band, as a fraction of the CITY block's north-south span. 0.85 puts the
 * lobe across ~73% of the world square's height and leaves ~1,780 m (~1,350 units) of dry land in
 * each west corner. Raising it past ~0.95 closes the corners; process.ts fails the build if it
 * does, rather than shipping a sea.
 */
export const DAM_BAND_Z_FRACTION = 0.60;
/**
 * The shore ROAD (Dam Wal Road) spans the city block plus this margin, while the WATER stops
 * short of the world's north and south edges. Letting the road follow the full shore — including
 * the two west run-outs — would blow up the road bbox the fit is measured from and shrink the
 * city inside the world square by about a third.
 */
export const DAM_ROAD_MARGIN_M = 260;
/**
 * How far west of the corridor the shore road may fall back to when there is no waterline to
 * follow (m, west of the corridor's west edge). North and south of the lobe the west band is dry
 * veld all the way to the world edge; without this floor the road would chase the run-outs.
 */
export const DAM_ROAD_DRY_LINE_M = 400;
/** Mean shore set-back west of the corridor's west edge (m). */
export const DAM_SHORE_SETBACK_M = 40;
/**
 * Dam-shore settlements, north to south, at fractions of the CITY block's own span (t = 0 at its
 * north edge, 1 at its south) and placed ON the measured shoreline, so "on land, in the world" is
 * true by construction. Cape names are gone: this is a landlocked Highveld reservoir, and every
 * name below is either a real place on the Vaal Dam (Deneysville, Refengkgotso, Groenpunt, Leboya
 * Bay, Manten Marine, Anchor Creek) or an Afrikaans coinage in the same register.
 *
 * Deneysville and Refengkgotso are deliberately adjacent, as they really are: Deneysville is the
 * yacht-club town, Refengkgotso is the township beside it with no formalised public water access
 * at all. That contrast is the sharpest social fact about the real dam and it is free level design.
 *
 * beachfront.ts hangs its second venue arc on 'Leboya Baai' BY NAME (and beachfront.test.ts
 * asserts it) — rename the two together or the venue strip silently relocates to a fallback.
 */
export const DAM_SHORE_DISTRICTS = [
  // Deneysville is NOT here any more: the real place node arrives with the real street grid from
  // the north-shore extract (vaalshore.ts), and two of it is one too many. Refengkgotso stays
  // synthetic — the real township sits on a stretch of shore this strip does not cut, so it would
  // map into open water — but it keeps its defining adjacency to Deneysville and, as in life, it
  // gets no marina, no slipway and no water frontage of its own.
  { name: 'Refengkgotso', t: 0.19 },
  { name: 'Manten Marina', t: 0.28 },
  { name: 'Anker Baai', t: 0.38 },
  { name: 'Vaalpunt', t: 0.50 },
  { name: 'Leboya Baai', t: 0.62 }, // beachfront.ts hangs its second venue arc on this one BY NAME
  { name: 'Groenpunt', t: 0.74 },
  { name: 'Sonsakker', t: 0.86 },
] as const;
/** Set back inland of the waterline (m): grass shore, then the settlement, then the shore road. */
export const DAM_SHORE_DISTRICT_SETBACK_M = 330;
/**
 * RESORT BEACHES (m). Two only, both small, both at a real Vaal resort — Misty Bay in Vaal Marina
 * and Leboya Bay on the northern arm. The rest of the shoreline gets the drawdown strand instead
 * (pale grit and a high-water mark), which is what a reservoir that swung from near-empty in 2025
 * to over 102% in 2026 actually looks like. The runtime uses each beach polygon's z-span to decide
 * where the shore ribbon turns golden, and mapRender draws the polygon itself, so both have to be
 * ON LAND at the waterline.
 */
export const BEACH_LENGTH_M = 260;
export const BEACH_DEPTH_M = 85;
/** No beach vertex may come closer than this to the waterline (m) — keeps the sand out of the water. */
export const BEACH_MIN_CLEARANCE_M = 12;
/** Backland villages in the farmland corridor, not shore settlements. Both are real Vaal places. */
export const CORRIDOR_DISTRICTS = [
  { name: 'Oranjedorp', t: 0.20, fromWest: 620 },
  { name: 'Metsimaholo', t: 0.62, fromWest: 1380 },
] as const;
/** Water surface elevation (m ASL). The Highveld sits at ~1700 m; a reservoir is not at 0. */
export const DAM_LEVEL_M = 1480;
/**
 * GROOTEILAND — way 6139539, the ~3 km island the annual Round the Island race circles, and the
 * owner asked for it by name. It is a real inner ring of the water relation, so it arrives with
 * the shoreline and needs no synthesis; it lands mid-water between the town and the marina,
 * exactly where it really sits, and it is what stops the player seeing the whole lake at once.
 */
export const DAM_ISLAND_NAME = 'Grooteiland';
/**
 * Nudge the islands west (m). The tanh that squeezes the 10 km northern arm into a 2 km band
 * squeezes the 1.4 km channel behind Grooteiland with it, and the island ends up touching the
 * shore. This restores a boat-width of water on its landward side.
 */
export const DAM_ISLAND_WEST_NUDGE_M = 280;
/**
 * THE SEWAGE WORKS. The single most topical detail available about the real Vaal: untreated
 * sewage from the Emfuleni works has been going into the river for years, and in 2026 the
 * municipal manager is in court on five counts of serious environmental pollution over it. OSM
 * carries the plant itself (way 667893482, on the northern shore above Groenpunt), so the map
 * gets settling ponds, a chlorine contact tank and an outfall on the shore — a reason for one
 * stretch of water to be grim and the rest pristine.
 */
export const SEWAGE_WORKS_NAME = 'Groenpunt Vuilwaterwerke';
/**
 * THE REAL NORTH-SHORE GRAFT (C2). Deneysville, Refengkgotso, Misty Bay, Vaal Marina and the
 * marinas arrive as REAL OSM geometry pushed through the shoreline's own transform. These are the
 * only knobs; everything else is decided by the data.
 */
/** Smallest real landuse polygon worth carrying across (m2). Below this it is a garden. */
export const VAAL_SHORE_MIN_AREA_M2 = 9_000;
/** Fraction of the water band at each end that the graft stays clear of. The band ends run WEST
 *  off the world square, so anything sited there ships off-map. */
export const VAAL_SHORE_BAND_INSET = 0.055;
/** How far west of the mean shoreline the graft may reach (m). Inside the water's own westward
 *  excursions, so a street can never be emitted past the world edge. */
export const VAAL_SHORE_WEST_REACH_M = 900;
/** How far inland a waterfront POI / building / place node is nudged when the mapped shore lands
 *  east of it (m). The shore is a de-tilted, gain-scaled fit, so a real jetty node misses it by
 *  tens of metres; dropping those loses both yacht clubs, the aquatic club and NSRI Station 22. */
export const VAAL_SHORE_ASHORE_M = 30;
/** Grafted components smaller than this many nodes are left to the dead-end pass rather than given
 *  their own link road (a two-node driveway does not need a trunk connection). */
export const VAAL_SHORE_MIN_COMPONENT = 6;
/** Longest link road allowed between a grafted town and the rest of the network (m). Beyond this
 *  the fragment is left for the connectivity pass to bridge or drop — a 1 km straight spoke across
 *  open veld to reach three houses is worse than not having the three houses. */
export const VAAL_SHORE_MAX_LINK_M = 620;
/** Cap on a grafted settlement's building density (buildings/km2). The Joburg CBD measures 244 in
 *  this pipeline; a dam village that out-densities the CBD masses like Braamfontein. */
export const VAAL_SHORE_MAX_DENSITY = 170;
/** Real Vaal streets with no OSM name, and the link roads that tie the towns to Dam Wal Road. */
export const VAAL_SHORE_UNNAMED_ROAD = 'Dampad';
export const VAAL_SHORE_LINK_ROAD = 'Dorpsaansluiting';
/**
 * MISTY BAY. The owner named it — "Misty bay has some resorts and sandy beaches, hence the choice"
 * — and OpenStreetMap does not have it: a live `nwr["name"~"Misty",i]` over a box far larger than
 * the dam returns zero elements. The place is unmistakably there in the geometry (118 piers, 32
 * private service roads and the Harbour Town Vaal Dam estate within 2 km) but it carries no label,
 * so the label is ours, pinned to the coordinate rather than to any OSM id.
 */
export const MISTY_BAY_NAME = 'Misty Bay';
export const MISTY_BAY_LATLON = { lat: -26.888104, lon: 28.192121 } as const;
/**
 * Where down the CITY block's z span the works sits (0 = north edge, 1 = south). MUST be inside
 * the water band (roughly 0.08..0.92 at DAM_BAND_Z_FRACTION 0.85) — buildDamShore throws otherwise,
 * because outside the band `shoreXNear` returns the run-out end of the shore, which is past the
 * world's west edge, and the whole works quietly ships off-map (0.07 did exactly that).
 *
 * 0.16 puts it on the northern shore between Deneysville and Refengkgotso, which is the real
 * arrangement on the Vaal — the works discharges beside the township, not beside the yacht club —
 * and, measured, it is where Dam Wal Road still hugs the bank, so the yard sits one road-width
 * inland of the water rather than stranded mid-corridor (at 0.30 the dam's northern arm pushes the
 * road ~900 units east and the works went with it).
 */
export const SEWAGE_WORKS_Z_FRACTION = 0.16;
/** Works footprint (m): inland set-back of the fence, then its size along/across the shore. */
export const SEWAGE_WORKS_INLAND_M = 150;
export const SEWAGE_WORKS_LENGTH_M = 320;
export const SEWAGE_WORKS_DEPTH_M = 210;
/** Settling ponds inside the fence: rows x cols of rectangles, each this size (m). */
export const SEWAGE_POND_ROWS = 2;
export const SEWAGE_POND_COLS = 3;
export const SEWAGE_POND_W_M = 74;
export const SEWAGE_POND_D_M = 62;

/**
 * Pre-smoothing window for the shore ROAD only (m). The raw crenellated polyline still drives the
 * water polygon and the terrain; the road cuts across the bay mouths on causeways, which is what
 * a real dam-shore road does — and stops the deep arms folding the offset road.
 */
export const DAM_ROAD_PRESMOOTH_M = 240;
/** Corridor connector roads (creative geography, hence the in-game names straight away). */
export const CORRIDOR_LINKS = [
  { name: 'Madiba Meander', kind: 'trunk' },
  { name: 'Rooibos Route', kind: 'secondary' },
] as const;
export const FRONTAGE_ROAD_NAME = 'Plaaspad';
/** Renamed to "Ouma se Padstal" via names-overrides.json. */
export const PADSTAL_NAME = 'Padstal';
export const HARBOUR_DISTRICT_NAME = 'Deneys Quay';

/**
 * Organic curvature applied to the synthetic roads (owner: "far too straight ... a bit more
 * meandering and organic"). Perpendicular fBm offset (amplitude in METRES; 1 unit ~= 3.75 m,
 * so the orbital's ~220 m ≈ 59 u sits in the requested ±40-80 u band), tapered to zero at
 * every junction attachment point, then Chaikin-smoothed. Keyed by road name.
 */
export interface MeanderSpec {
  amplitude: number;
  wavelength: number;
  octaves: number;
  step: number;
  taper: number;
  chaikin: number;
  /** Interior junctions ride the meander (see meander.ts) — for roads whose interior
   *  junctions are all their own spur/frontage attachments. */
  movePins?: boolean;
}
/**
 * Amplitudes and wavelengths are ~0.66x the pre-crop values: they are denominated in METRES,
 * but the ring perimeter they ride on dropped to ~68% with the crop, so leaving them alone
 * turns the orbital's wobble from 3.2% of a side into 4.7% and it reads as a scribble.
 */
export const MEANDER_SPECS: Record<string, MeanderSpec> = {
  'Egoli Orbital': { amplitude: 260, wavelength: 1300, octaves: 3, step: 90, taper: 260, chaikin: 2, movePins: true },
  Plaaspad: { amplitude: 105, wavelength: 1060, octaves: 2, step: 80, taper: 170, chaikin: 2, movePins: true },
  'Madiba Meander': { amplitude: 105, wavelength: 1390, octaves: 2, step: 100, taper: 280, chaikin: 1 },
  'Rooibos Route': { amplitude: 90, wavelength: 1250, octaves: 2, step: 100, taper: 280, chaikin: 1 },
  Melkweg: { amplitude: 65, wavelength: 925, octaves: 2, step: 90, taper: 160, chaikin: 1 },
  'Kraal Close': { amplitude: 65, wavelength: 925, octaves: 2, step: 90, taper: 160, chaikin: 1 },
  'Middelbult Road': { amplitude: 110, wavelength: 1120, octaves: 2, step: 90, taper: 240, chaikin: 2 },
  'Oranjeville Road': { amplitude: 110, wavelength: 1120, octaves: 2, step: 90, taper: 240, chaikin: 2 },
};
/** Synthetic-road polylines shorter than this many vertices are spurs, not the spine — left straight. */
export const MEANDER_MIN_VERTICES = 5;

/** Regional airport in the southern farmland corridor. Base name is parodied via overrides. */
export const AIRPORT_NAME = 'OR Tambourine Field';
export const AIRPORT_ACCESS_ROAD_NAME = 'Aviator Avenue';
/**
 * Runway length (metres). Metre-denominated, so it scales with the map: at ~0.49 m/u the 1250 m
 * runway is ~2550 u long (up from ~425 u at the old 6000 footprint) — the runway *width* stays
 * game-scale (14 u, set in process.ts), so planes get a long, proportionate strip rather than a
 * postage stamp on the enlarged map.
 */
export const AIRPORT_RUNWAY_LENGTH_M = 1250;
/**
 * ~105 deg: the runway lies ALONG the (now 2000 m) corridor rather than across it. At the old
 * 0.32 rad the 1250 m strip needs 1186 m of x and does not fit once the 320 m apron offset is
 * added; at 1.84 it needs 334 m.
 */
export const AIRPORT_RUNWAY_BEARING_RAD = 1.84;
/**
 * Where the airport sits down the city's north-south span (0 = north edge, 1 = south edge).
 * MEASURED, not chosen: the real Vaal's northern arm reaches ~2 km east into the corridor between
 * t=0.25 and t=0.70, and at 0.5 the aerodrome boundary sat 100 units INSIDE the waterline with the
 * apron on the beach. 0.84 is the southern slot where the shoreline is furthest west — 475 units of
 * clear ground east of Dam Wal Road — and it puts the strip back "in the southern farmland", which
 * is what its own name says. Re-measure with the shore profile if the water ever moves.
 */
export const AIRPORT_Z_FRACTION = 0.84;

/** Yacht club slipway + jetty on the dam's northern arm (distinct from Deneys Quay near the CBD). */
export const PORT_NAME = 'Vaalpunt Slipway';
export const PORT_ACCESS_ROAD_NAME = 'Sloepbaai Road';
export const PORT_PIER_LENGTH_M = 620;

/** Reservoir / dam near the NE suburb edge (premium water tier, organic shoreline). */
export const LAKE_NAME = 'Egoli Dam';
/** Shrunk from 720 m: at the cropped bounds the old radius overlapped Killarney golf. */
export const LAKE_RADIUS_M = 520;
export const LAKESIDE_TRACK_NAME = 'Dam wal';

/** Elevation grid resolution (cols x rows over the bbox). */
export const ELEVATION_COLS = 96;
export const ELEVATION_ROWS = 96;

/** Open elevation API (SRTM 90 m) — batched, cached, polite. */
export const ELEVATION_ENDPOINT = 'https://api.opentopodata.org/v1/srtm90m';
export const ELEVATION_BATCH_SIZE = 100;
export const ELEVATION_REQUEST_INTERVAL_MS = 1100;

/** Overpass endpoints: primary, then a politely-used mirror fallback. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

export const OVERPASS_USER_AGENT = 'groot-theft-bakkie-mapgen/1.0 (offline map pipeline; contact repo owner)';

/** Landmark name patterns fetched from OSM (case-insensitive regex, anchored by Overpass). */
export const LANDMARK_NAME_REGEX =
  'Ponte Tower|Ponte City|Hillbrow Tower|Constitution Hill|FNB Stadium|Soccer City';

/** Landmarks must match this exactly (or be stations) — filters out matches like "Soccer City ticket office". */
export const LANDMARK_CANONICAL = /^(ponte tower|ponte city|hillbrow tower|constitution hill|fnb stadium|soccer city)$/i;

/** Default district radius (metres) when only a place node is available. */
export const DISTRICT_RADIUS_M = 700;
