# Game Design

## Pillars

1. **Fast traversal**: every district is reachable quickly, and the vehicle roster changes route choice without requiring simulation-grade controls.
2. **Readable consequence**: crime immediately changes audio, wanted stars, police presence, and civilian behavior.
3. **Compact variety**: five visually and spatially distinct districts share a small road network instead of padding play time with distance.
4. **Complete jobs**: each mission has a contact, premise, multiple objective states, failure or pursuit pressure, payoff, and persistent completion.

## San Cordova

San Cordova is a warm coastal trade city rebuilding around old port infrastructure. Downtown sits between the residential east and industrial west. Cordova Commons provides a central landmark, while Costa Azul opens the southern edge into beach and water.

The player begins on the north side with enough cash to establish state feedback but no authored identity or borrowed franchise character. Contacts are original:

- **Mara Velez**, a produce distributor who teaches driving and checkpoint routing.
- **Nico Sol**, a beach mechanic who introduces vehicle theft and pursuit escape.
- **Inez Calder**, a civic radio operator whose job combines travel, combat, retrieval, and return.

## Mission flow

### Delivery Run

The first job teaches contact interaction, a marked car, arcade driving, the radar, time pressure, sequential checkpoints, and vehicle return. The 145-second timer is generous enough to recover from one collision while still rewarding route reading. Reward: `$900`.

### Hot Property

The player identifies and steals a red Veloce. Entry raises the wanted state to at least level two. The garage objective remains gated until heat reaches zero, making escape a mechanic rather than incidental flavor. Reward: `$1,500`.

### Dockside Signal

The industrial waterfront becomes a combat space. Three hostile guards switch to pursuit behavior, gunfire creates citywide consequence, and the key requires explicit collection. The escape gate prevents immediate mission completion inside the encounter, followed by a return to the park kiosk. Reward: `$2,200`.

All failed timed jobs retain their definition and can be restarted with `E`. Completed mission ids are persisted and their contact markers are removed.

## Handling roles

- **Cielo Compact**: balanced speed, fast steering, approachable durability.
- **Veloce R**: highest acceleration and top speed, lower durability, responsive at speed.
- **Porto Utility**: slow, durable, wide, and deliberately heavy steering.
- **SCPD Interceptor**: pursuit-biased speed, acceleration, durability, siren, and alternating lightbar.

Driving is velocity-and-heading arcade handling. Reverse is limited, steering authority grows once moving, high speed slightly reduces steering, coasting applies drag, and the handbrake sharply damps speed for rapid corner setup.

## Wanted tuning

Heat is continuous from `0-100` and displayed as one to five stars in 20-point bands. Gunfire, occupied vehicle theft, and attacks on police add different severities. A sighting resets cooldown. Once unseen beyond a level-dependent grace period, heat decays increasingly quickly. Pursuit count escalates to four active interceptors, spawned roughly 105-150 world units away.

## Failure and recovery

Health reaching zero produces a three-second death state, clears pursuit, restores health, and respawns at the saved north checkpoint. Disabled vehicles retain damage but can be exited. `F` places the active vehicle on the nearest road axis and aligns its heading, preventing unrecoverable orientation or trapping.

## Presentation

The visual direction uses solid coastal colors, sharp low-poly silhouettes, warm daylight, fog, minimal glass strips, reusable street props, and high-contrast mission color. The interface avoids debug framing: information sits at screen edges, with a circular road radar, centered objective strip, contextual prompts, and strong mission feedback.
