# Architecture

## Runtime composition

`src/Game.ts` is the composition root. It owns the Three.js scene and renderer, constructs each system once, forwards a bounded delta time, and translates results between systems. Systems do not import `Game`, which keeps dependency direction one-way.

The main frame is:

1. Read edge-triggered and held input.
2. Update an enter/exit transition, the player controller, or the active vehicle.
3. Simulate nearby population and police.
4. Update wanted cooldown, combat effects, collisions, and mission objectives.
5. Persist periodically.
6. Smooth the camera, animate the world marker, update DOM/canvas UI, and render.

Delta time is clamped to 50 ms to prevent tab restoration from producing physics spikes.

## Module ownership

### Core

- `InputManager` normalises keyboard, pointer lock, mouse delta, and button edges.
- `CameraController` provides a smoothed orbit/chase camera and samples city collision along the camera boom.
- `AudioManager` owns browser audio unlock and synthesises effects with Web Audio oscillators.
- `SaveManager` validates, defaults, migrates by version, and serialises persistent state.
- `GameRules` contains rendering-independent damage and economy rules.

### World and entities

- `City` deterministically generates the named non-grid road network, sampled lane and sidewalk paths, reserved park parcels, road-aware district infill, layered buildings, landmarks, waterfront facilities, parking, and rectangle collision volumes.
- `BuildingArchitecture` turns each parcel envelope into one of thirteen structural families. It owns district-specific massing, gabled geometry, setbacks, wings, bridges, crowns, facade structure, fire escapes, porches, dormers, sawtooth roofs, loading docks, pipes, and tanks while `City` retains a conservative rectangular gameplay collider.
- `UrbanInfrastructure` owns the repeated streetscape layer: instanced broadleaf and palm vegetation, shrubs, road-facing outer-curb lighting, furniture, transit shelters, regulatory and street-name signs, plus independently phased animated signal heads. `City` exposes road-surface clearance and dedicated roadside points so props cannot occupy carriageways or cross-road overlaps; curbs are clipped against every road and tactile paving marks signalized corners.
- `Player` owns procedural character geometry, grounded movement, jump/gravity, health, and walk animation.
- `Vehicle` owns a typed handling specification, arcade integration, world collision, damage, wheel animation, lights, and player/AI control modes.
- `Pedestrian` owns appearance, health, procedural gait, and walk/idle/flee/hostile/down state transitions.

### Gameplay systems

- `PopulationSystem` creates and recycles traffic and pedestrians and exposes targets to interaction/combat.
- `CombatSystem` owns ammunition, reload/fire cadence, camera raycasts, damage application, muzzle light, and impact effects.
- `WantedSystem` is pure heat/escalation/cooldown logic.
- `PoliceSystem` maintains pursuit unit count by wanted level and spawns only at distant road positions.
- `MissionSystem` is a data-driven objective sequencer. It consumes a plain `GameSnapshot` and produces advancement, failure, or completion events.
- `ShopSystem` builds the physical shop frontages (weapons counter, detailer, garage, hot dog stand), their glowing entry pads, and minimap icons. Pricing and purchase gating are pure functions in `core/ShopRules`; `Game` applies the results to `Economy`, `CombatSystem`, `WantedSystem`, and the save file.

### UI

`UIManager` exclusively owns the DOM overlay. It renders the HUD from an immutable state-shaped argument and draws a rotated canvas radar from positions supplied by `Game`. It communicates menu actions through callbacks.

## Collision model

San Cordova uses an intentionally predictable horizontal-plane model. Buildings and containers expose XZ rectangle bounds. Player and vehicle motion first resolves X, then Z, which permits sliding along walls. Vehicles reflect and reduce speed on impact. Vehicle-to-vehicle response separates bodies, damps speed, and applies damage behind a cooldown so contact does not damage every frame.

Character Y motion is separate and grounded at world height zero. The current ramp is visual; full heightfield suspension is outside the compact physics model.

## State boundaries

Pure state with automated tests:

- wanted heat and cooldown
- economy changes and damage calculation
- save defaults, malformed input, round-trip, and reset (including the garage slot)
- shop purchase resolution, detailer pricing, and vendor healing
- mission objective progression, timing, restart, and reward metadata
- vehicle configuration roles

Runtime state is intentionally local to its owner. Cross-system events are small return objects (`ShotResult`, `MissionUpdate`) instead of a global event bus.

## Extending missions

Add a `MissionDefinition` to `MISSIONS` with a unique id, contact metadata, reward, start target, and ordered objectives. Existing objective kinds cover position, vehicle, timed checkpoint, wanted, combat, collection, and escape gates. A new rule should be added as an objective kind and evaluated only against a `GameSnapshot` so tests remain renderer independent.
