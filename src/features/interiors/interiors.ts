/**
 * Building interiors — the lazy body. Nothing in this directory is imported statically anywhere;
 * registry.ts's `load()` is the only reference, so it ships as its own async chunk and boot never
 * fetches it. See src/features/README.md.
 *
 * The shape of one visit:
 *   walk onto a doorstep -> E -> fade -> the room is BUILT (never before) on a flat plot a few
 *   hundred metres away -> walk around it -> E on the mat -> fade -> back on the exact paving slab
 *   you left, facing the same way, in the same street with the same people in it.
 *
 * Why a plot and not the building: see the header of ./stage.ts. The short version is that a
 * procedural building is one solid collider per massing tier and a feature cannot add or remove a
 * collider, so a room can be neither inside one nor floating above the terrain.
 *
 * This feature pushes ZERO colliders. Containment is its own clamp, run from update() after
 * Player.update and before updateCamera in the same frame, which means dispose() genuinely removes
 * every trace — the append-only collider list that would otherwise leave invisible walls behind
 * never learns this room existed.
 */
import * as THREE from 'three';
import type { FeatureGameApi, FeatureHudEntry, FeatureSystem, InteractionDescriptor } from '../types';
import { PLAYER } from '../../config';
import { doorNear, interiorDoors, type InteriorDoor, type InteriorsSave } from '../interiors.state';
import { buildDoorways, buildInterior, toLocal, toWorld, type BuiltDoorways, type BuiltInterior } from './build';
import { generateInterior, type InteriorLayout } from './grammar';
import { findStagePlot, type StagePlot } from './stage';

/** How long the screen sits black over the swap. Matches UIManager.screenFade's 620 ms feel. */
const FADE_MS = 260;
/** Standing this close to the mat offers the way out. */
const EXIT_RADIUS = 1.6;
/** If anything else in the game (death, a checkpoint reload, a cheat teleport) moves the player
 *  further than this from the plot, the room lets go rather than yanking them back. */
const ABANDON_DISTANCE = 60;

interface Visit {
  door: InteriorDoor;
  layout: InteriorLayout;
  built: BuiltInterior;
  plot: StagePlot;
  /** Room heading: the door's INWARD yaw, so local +z is "further into the building". */
  heading: number;
  /** Exactly where the player stood outside, restored on the way out. */
  origin: THREE.Vector3;
  fixture?: ReturnType<FeatureGameApi['spawnFixture']>;
  /** Previous local position, for the axis-separated furniture clamp. */
  last: { x: number; z: number };
}

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem {
  const saved = state as InteriorsSave | undefined;
  const visited = new Set<string>(saved?.visited ?? []);
  const plots = new Map<string, StagePlot | undefined>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let visit: Visit | undefined;
  let phase = 0;
  /** A fade is running and a swap is already scheduled. Without this, two E presses inside the
   *  260 ms fade queue two installs and you end up standing in two rooms at once. */
  let swapping = false;
  let disposed = false;
  let overlay: HTMLDivElement | undefined;

  // ---- the fade. The feature API has no screenFade(), so the feature owns one element and takes
  // it away again in dispose(). #fade is z-index 90; this sits just under it and over the HUD.
  const showFade = (on: boolean): void => {
    if (typeof document === 'undefined') return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'interior-fade';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:89;background:#05070a;opacity:0;pointer-events:none;transition:opacity .22s';
      document.body.append(overlay);
    }
    overlay.style.opacity = on ? '1' : '0';
  };
  const after = (ms: number, run: () => void): void => {
    const handle = setTimeout(() => { timers.delete(handle); if (!disposed) run(); }, ms);
    timers.add(handle);
  };

  // Something to walk up to. Built once, the moment the chunk lands — the eager `approach` ring is
  // all a player has before that, which is the honest cost of a lazy feature.
  const doorways: BuiltDoorways = buildDoorways(interiorDoors(), (x, z) => api.surfaceHeightAt(x, z));
  api.scene.add(doorways.group);

  const plotFor = (door: InteriorDoor): StagePlot | undefined => {
    if (!plots.has(door.id)) plots.set(door.id, findStagePlot(door, (x, z) => api.surfaceHeightAt(x, z)));
    return plots.get(door.id);
  };

  // ---- entering / leaving -----------------------------------------------------------------------

  const install = (door: InteriorDoor, plot: StagePlot): void => {
    const layout = generateInterior(door);
    const heading = door.heading + Math.PI; // local +z runs away from the street, into the building
    const built = buildInterior(layout, plot, heading);
    api.scene.add(built.group);
    const origin = api.playerPosition().clone();
    const mat = toWorld(plot, heading, 0, -layout.depth / 2 + 0.85);
    const player = api.playerPosition();
    player.set(mat.x, plot.y, mat.z);
    visit = { door, layout, built, plot, heading, origin, last: { x: 0, z: -layout.depth / 2 + 0.85 } };
    if (layout.fixture) {
      const spot = toWorld(plot, heading, layout.fixture.x, layout.fixture.z);
      visit.fixture = api.spawnFixture(spot.x, spot.z, layout.fixture.name);
    }
    api.analytics('entered', { detail: layout.kind });
    if (!visited.has(door.id)) {
      visited.add(door.id);
      api.earn(layout.find);
      api.notify(layout.name, `${layout.findLine} +R${layout.find}`, true);
      api.analytics('first_visit', { detail: layout.kind, value: layout.find });
    }
    else api.notify(layout.name, layout.blurb, true);
    api.persist();
  };

  const enter = (door: InteriorDoor, instant = false): string => {
    if (visit) return 'failed:already-inside';
    if (swapping) return 'failed:mid-fade';
    const plot = plotFor(door);
    if (!plot) { api.notify(door.name, 'The door is jammed — nowhere to put the room.', false); api.analytics('no_plot', { detail: door.id }); return 'failed:no-plot'; }
    if (instant) { install(door, plot); return 'ok'; }
    swapping = true;
    showFade(true);
    after(FADE_MS, () => { install(door, plot); swapping = false; after(90, () => showFade(false)); });
    return 'ok';
  };

  /** Tear the room down. `restore` is false when the world already moved the player somewhere else. */
  const close = (restore: boolean): void => {
    if (!visit) return;
    const current = visit;
    visit = undefined;
    if (current.fixture) api.removeFixture(current.fixture);
    current.built.dispose();
    if (restore) api.playerPosition().copy(current.origin);
    api.analytics('left', { detail: current.layout.kind });
  };

  const leave = (instant = false): string => {
    if (!visit) return 'failed:not-inside';
    if (instant) { swapping = false; close(true); api.persist(); return 'ok'; }
    if (swapping) return 'failed:mid-fade';
    swapping = true;
    showFade(true);
    after(FADE_MS, () => { close(true); swapping = false; api.persist(); after(90, () => showFade(false)); });
    return 'ok';
  };

  // ---- containment ------------------------------------------------------------------------------

  /** Axis-separated clamp in room-local space: the room's walls, then every solid piece of
   *  furniture, exactly the shape City.clampMove uses so it feels identical to the street. */
  const clamp = (current: Visit): void => {
    const player = api.playerPosition();
    const local = toLocal(current.plot, current.heading, player.x, player.z);
    const halfW = current.layout.width / 2 - PLAYER.radius;
    const halfD = current.layout.depth / 2 - PLAYER.radius;
    let x = Math.max(-halfW, Math.min(halfW, local.x));
    let z = Math.max(-halfD, Math.min(halfD, local.z));
    const blocked = (px: number, pz: number): boolean => current.layout.props.some((prop) =>
      prop.solid
      && Math.abs(px - prop.x) < prop.w / 2 + PLAYER.radius
      && Math.abs(pz - prop.z) < prop.d / 2 + PLAYER.radius
      && prop.h > 0.05);
    if (blocked(x, current.last.z)) x = current.last.x;
    if (blocked(x, z)) z = current.last.z;
    current.last = { x, z };
    const world = toWorld(current.plot, current.heading, x, z);
    player.set(world.x, current.plot.y, world.z);
  };

  // ---- interaction rungs -------------------------------------------------------------------------

  const rungs: InteractionDescriptor[] = [
    {
      id: 'interiors:leave', order: 44, context: 'foot',
      test: (ctx) => {
        if (!visit) return undefined;
        const local = toLocal(visit.plot, visit.heading, ctx.position.x, ctx.position.z);
        if (Math.hypot(local.x, local.z + visit.layout.depth / 2 - 0.85) > EXIT_RADIUS) return undefined;
        return { prompt: 'E  Step outside', act: () => { leave(); } };
      },
    },
    {
      id: 'interiors:door', order: 50, context: 'foot',
      test: (ctx) => {
        if (visit) return undefined;
        const door = doorNear(ctx.position.x, ctx.position.z);
        if (!door) return undefined;
        return { prompt: `E  Go inside · ${door.name}`, act: () => { enter(door); } };
      },
    },
  ];

  // ---- the system --------------------------------------------------------------------------------

  return {
    update: (dt) => {
      // The pad discs pulse whether or not anyone is inside — that is how a door gets noticed.
      phase += dt;
      const pulse = 0.42 + Math.sin(phase * 2.6) * 0.16;
      for (const disc of doorways.discs) { (disc.material as THREE.MeshBasicMaterial).opacity = pulse; disc.rotation.y += dt * 0.9; }
      const current = visit;
      if (!current) return;
      const player = api.playerPosition();
      // Death, a checkpoint reload or a console teleport all move the player without telling us.
      // Let go rather than dragging them back into a room the game has already left.
      if (Math.hypot(player.x - current.plot.x, player.z - current.plot.z) > ABANDON_DISTANCE) { close(false); showFade(false); return; }
      clamp(current);
      // Load shedding reaches inside: the lamps sink with the grid, the dim fill does not, so the
      // door is always findable.
      const power = 1 - api.blackout();
      for (const lamp of current.built.lamps) lamp.intensity = 12 * power;
      for (const entry of current.built.powered) entry.material.emissiveIntensity = entry.base * power;
    },

    hud: (): FeatureHudEntry[] | undefined => visit ? [{ id: 'interiors:where', label: visit.layout.eyebrow, value: visit.layout.name }] : undefined,

    interactions: () => rungs,

    serialize: () => ({ visited: [...visited] }),

    restore: (next) => {
      const incoming = next as InteriorsSave | undefined;
      visited.clear();
      for (const id of incoming?.visited ?? []) visited.add(id);
      close(false);
    },

    command: (args) => {
      const [verb, target] = args;
      if (!verb || verb === 'doors') return interiorDoors().map((door) => `${door.id} — ${door.name} @ ${door.x.toFixed(0)},${door.z.toFixed(0)}${visited.has(door.id) ? ' (visited)' : ''}`);
      if (verb === 'where') return visit ? [`Inside ${visit.layout.name} (${visit.layout.kind}) on a plot at ${visit.plot.x.toFixed(0)},${visit.plot.z.toFixed(0)}`] : ['Outside.'];
      if (verb === 'plot') {
        return interiorDoors().map((door) => {
          const plot = plotFor(door);
          return plot ? `${door.id}: plot ${plot.x.toFixed(0)},${plot.z.toFixed(0)} — ${Math.hypot(plot.x - door.x, plot.z - door.z).toFixed(0)}u from the door` : `${door.id}: NO PLOT`;
        });
      }
      if (verb === 'leave') return [leave() === 'ok' ? 'Stepping out.' : 'Not inside anything.'];
      if (verb === 'enter') {
        const door = interiorDoors().find((entry) => entry.id === target) ?? interiorDoors()[0];
        if (!door) return ['No doors derived from this map.'];
        // Console entry warps you to the doorstep first, so the exit puts you somewhere sane.
        api.playerPosition().set(door.x, api.surfaceHeightAt(door.x, door.z), door.z);
        return [enter(door) === 'ok' ? `Entering ${door.name}.` : `Could not enter ${door.name}.`];
      }
      return ['feature interiors [doors|plot|enter <id>|leave|where]'];
    },

    /** Machine playthrough. `run` walks the whole loop for one door without a human: stand on the
     *  step, go in, prove the room contains you, come out, prove you are back on the same slab. */
    qa: (action, args) => {
      const doors = interiorDoors();
      if (action === 'doors') return doors.map((door) => door.id).join(',') || 'none';
      if (action === 'status') return visit ? `inside:${visit.door.id}` : 'outside';
      if (action === 'leave') return leave(true);
      if (action === 'enter' || action === 'run') {
        const wanted = typeof args.door === 'string' ? args.door : undefined;
        const door = doors.find((entry) => entry.id === wanted) ?? doors[0];
        if (!door) return 'stuck:no-doors';
        if (visit) leave(true);
        const player = api.playerPosition();
        player.set(door.x, api.surfaceHeightAt(door.x, door.z), door.z);
        const outside = player.clone();
        if (!doorNear(player.x, player.z)) return 'failed:doorstep-out-of-ring';
        const entered = enter(door, true);
        if (entered !== 'ok') return entered;
        if (action === 'enter') return 'ok';
        const current = visit as Visit | undefined;
        if (!current) return 'failed:no-visit';
        if (!current.built.group.parent) return 'failed:room-not-in-scene';
        // Shove the player at each wall a metre past it and confirm the clamp holds them in.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const push = toWorld(current.plot, current.heading, dx * (current.layout.width / 2 + 1), dz * (current.layout.depth / 2 + 1));
          player.set(push.x, current.plot.y, push.z);
          clamp(current);
          const local = toLocal(current.plot, current.heading, player.x, player.z);
          if (Math.abs(local.x) > current.layout.width / 2 + 0.01 || Math.abs(local.z) > current.layout.depth / 2 + 0.01) return `failed:escaped-${dx}-${dz}`;
        }
        // Back to the mat, and out the way we came.
        const mat = toWorld(current.plot, current.heading, 0, -current.layout.depth / 2 + 0.85);
        player.set(mat.x, current.plot.y, mat.z);
        const offer = rungs[0]!.test({ context: 'foot', position: player, vehicle: undefined, hour: api.hour() });
        if (!offer) return 'failed:no-exit-prompt';
        offer.act();
        leave(true); // the prompt path fades; the driver needs the swap to have happened by now
        if (visit) return 'failed:still-inside';
        if (player.distanceTo(outside) > 0.01) return `failed:returned-${player.distanceTo(outside).toFixed(2)}u-away`;
        return 'ok';
      }
      return `stuck:unknown-action:${action}`;
    },

    dispose: () => {
      disposed = true; swapping = false;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      close(false);
      doorways.dispose();
      overlay?.remove();
      overlay = undefined;
    },
  };
}
