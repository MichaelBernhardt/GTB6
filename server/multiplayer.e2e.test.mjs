import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryProfileStore } from './profile-store.mjs';
import { attachMultiplayer, PROTOCOL_VERSION } from './multiplayer.mjs';

/** Full-wire exercise of protocol v3: real sockets against attachMultiplayer, fake game clock, real timers. */
const clock = { value: 1_000_000 };
let http; let attached; let port;

class Client {
  constructor(name) {
    this.name = name; this.messages = []; this.socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer`);
    this.socket.on('message', (raw) => this.messages.push(JSON.parse(String(raw))));
    this.seq = 0;
  }
  async hello() {
    await new Promise((resolve) => this.socket.on('open', resolve));
    this.socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: this.name }));
    this.welcome = await this.expect((message) => message.type === 'welcome');
    this.epoch = 1;
    return this;
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  report(pose) { this.send({ type: 'state', seq: (this.seq += 1), epoch: this.epoch, heading: 0, locomotion: 'walk', aiming: false, ...pose }); }
  // Deadlines are generous on purpose: CI runners share cores with parallel suites and can starve
  // the 100ms snapshot timer for seconds — this run's assertions are eventually-consistent, not timing tests.
  async expect(match, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${this.name} never received the expected message`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  latestSnapshot() { return [...this.messages].reverse().find((message) => message.type === 'snapshot'); }
  close() { this.socket.close(); }
}

beforeAll(async () => {
  http = createServer();
  attached = await attachMultiplayer(http, { store: new MemoryProfileStore(), now: () => clock.value });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = http.address().port;
});
afterAll(async () => { await attached.close(); await new Promise((resolve) => http.close(resolve)); });

describe('multiplayer wire protocol v3', () => {
  it('runs the full loop: reports propagate, rewound fire kills, respawn teleports the victim only', async () => {
    const alice = await new Client('Alice').hello();
    const bob = await new Client('Bob').hello();
    clock.value += 3000; // spawn protection over

    // Alice reports honest movement; Bob's snapshots show her there.
    const home = alice.welcome.spawn;
    alice.report({ x: home.x, y: 0, z: home.z - 2 });
    await bob.expect((message) => message.type === 'snapshot' && message.players.some((player) => player.id === alice.welcome.playerId && Math.abs(player.z - (home.z - 2)) < 0.05));

    // Bob walks into pistol range of Alice through the validator, one honest report per fake second.
    const bobSpawn = bob.welcome.spawn;
    const bobStop = { x: home.x + 20, z: home.z - 2 };
    const distance = Math.hypot(bobStop.x - bobSpawn.x, bobStop.z - bobSpawn.z);
    const steps = Math.ceil(distance / 12);
    for (let step = 1; step <= steps; step += 1) {
      clock.value += 1000;
      const pose = { x: bobSpawn.x + (bobStop.x - bobSpawn.x) * (step / steps), y: 0, z: bobSpawn.z + (bobStop.z - bobSpawn.z) * (step / steps) };
      bob.report(pose);
      // A fixed sleep races the fake clock: on a loaded runner several reports can queue, then all
      // arrive at one fake timestamp and correctly exhaust the movement allowance. A snapshot is
      // the protocol-level acknowledgement that this report was processed before time advances.
      await bob.expect((message) => message.type === 'snapshot' && message.players.some((player) =>
        player.id === bob.welcome.playerId && Math.abs(player.x - pose.x) < 0.05 && Math.abs(player.z - pose.z) < 0.05));
    }

    // Bob shoots the Alice he is rendering: straight -x from 20 m out, stamped with his rendered tick.
    const seenTick = bob.latestSnapshot().tick;
    const aimLength = Math.hypot(20, 0.4);
    const aim = [-20 / aimLength, -0.4 / aimLength, 0];
    for (let shot = 0; shot < 3; shot += 1) {
      bob.send({ type: 'fire', seq: shot + 1, direction: aim, tick: seenTick });
      if (shot < 2) { await bob.expect((message) => message.type === 'combat' && message.kind === 'hit' && message.targetId === alice.welcome.playerId, 10_000); bob.messages.length = 0; clock.value += 400; }
    }
    await bob.expect((message) => message.type === 'combat' && message.kind === 'kill' && message.targetId === alice.welcome.playerId);

    // The respawn teleport reaches Alice alone, with the next epoch; her old-epoch reports are dead on arrival.
    clock.value += 3200;
    const teleport = await alice.expect((message) => message.type === 'teleport');
    expect(teleport.epoch).toBe(2);
    expect(teleport.to).toBeUndefined(); // routing detail, not protocol surface
    alice.report({ x: teleport.x, y: 0, z: teleport.z - 1 }); // still epoch 1: ignored
    alice.epoch = teleport.epoch;
    alice.report({ x: teleport.x, y: 0, z: teleport.z - 1 });
    await alice.expect((message) => message.type === 'snapshot' && message.players.some((player) => player.id === alice.welcome.playerId && player.health === 100 && Math.abs(player.z - (teleport.z - 1)) < 0.05));
    await bob.expect((message) => message.type === 'combat' && message.kind === 'respawn' && message.actorId === alice.welcome.playerId);

    alice.close(); bob.close();
  }, 120_000);
});
