#!/usr/bin/env node
/**
 * Stage 1 probe for the Godot multiplayer runtime.
 *
 * Verifies, against a real headless Godot process:
 *   - launch args / readiness / exit codes / stdout conventions;
 *   - one reserved port per room, single-flight for concurrent requests;
 *   - WebSocketMultiplayerPeer transport (peer_connected/peer_disconnected);
 *   - application handshake with a short-lived, single-use HMAC ticket;
 *   - gameplay RPCs are denied before authentication;
 *   - the client acknowledges a server-authoritative event.
 *
 * Usage (from packages/server):
 *   GODOT_RUNTIME_PATH="C:\...\godot.windows.editor.dev.x86_64.console.exe" \
 *     node scripts/godot-multiplayer-probe.mjs
 *
 * Optional env:
 *   GODOT_RUNTIME_PROJECT_PATH  default: godot_project/_wired
 *   GODOT_ROOM_PORT_START/END   default: 19100/19199
 *
 * Uses only Node built-ins (Node >= 22), no extra dependencies.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const PROJECT_PATH =
  process.env.GODOT_RUNTIME_PROJECT_PATH ??
  path.resolve(SERVER_ROOT, 'godot_project', '_wired');
const RUNTIME_PATH = process.env.GODOT_RUNTIME_PATH ?? process.argv[2] ?? '';
const PORT_START = Number(process.env.GODOT_ROOM_PORT_START ?? 19100);
const PORT_END = Number(process.env.GODOT_ROOM_PORT_END ?? 19199);
const SECRET = randomBytes(32).toString('hex');
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wired-probe-'));

if (!RUNTIME_PATH) {
  console.error(
    'GODOT_RUNTIME_PATH is not set. Point it at the Godot console executable.',
  );
  process.exit(1);
}

let failures = 0;
const results = [];
function check(ok, label, details = '') {
  results.push({ ok, label, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${details ? `  (${details})` : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mintTicket(room, { ttlSec = 60, secret = SECRET, nonce } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const value = nonce ?? randomBytes(16).toString('hex');
  const mac = createHmac('sha256', secret)
    .update(`${room}:${exp}:${value}`)
    .digest('hex');
  return `${exp}.${value}.${mac}`;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function allocatePort() {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in ${PORT_START}-${PORT_END}`);
}

const children = new Set();

function spawnRuntime(proc, args, env = {}) {
  const logFile = path.join(LOG_DIR, `${proc.label}.log`);
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(
    RUNTIME_PATH,
    ['--headless', '--path', PROJECT_PATH, ...args],
    {
      cwd: PROJECT_PATH,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  children.add(child);
  const onData = (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      proc.logs.push(trimmed);
      out.write(`${trimmed}\n`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    proc.exited = true;
    proc.exitCode = code;
    children.delete(child);
    out.end();
  });
  proc.child = child;
  proc.logFile = logFile;
  return child;
}

async function waitFor(proc, test, label, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = proc.logs.find(test);
    if (hit) return hit;
    if (proc.exited) {
      throw new Error(
        `${label}: process exited (code ${proc.exitCode})\n${proc.logs.join('\n')}`,
      );
    }
    await sleep(40);
  }
  throw new Error(
    `timeout waiting for ${label}\n--- log tail ---\n${proc.logs.slice(-25).join('\n')}`,
  );
}

const runtimes = new Map(); // room -> { room, port, readyPromise, logs, ... }

function getRuntime(room) {
  const existing = runtimes.get(room);
  if (existing && !existing.exited) return existing.readyPromise;
  if (existing) runtimes.delete(room);
  const rt = { room, logs: [], status: 'starting' };
  rt.readyPromise = (async () => {
    const port = await allocatePort();
    rt.port = port;
    rt.label = `server-${room}-${port}`;
    spawnRuntime(rt, ['--server', '--port', String(port), '--room', room], {
      WIRED_GAME_TICKET_SECRET: SECRET,
    });
    const readyLine = await waitFor(
      rt,
      (l) => l.includes('WIRED_SERVER_READY'),
      'WIRED_SERVER_READY',
    );
    if (rt.exited) throw new Error(`runtime exited: ${rt.exitCode}`);
    if (!readyLine.includes(`port=${port}`)) {
      throw new Error(`readiness port mismatch: ${readyLine}`);
    }
    rt.status = 'running';
    return rt;
  })().catch((error) => {
    runtimes.delete(room);
    throw error;
  });
  runtimes.set(room, rt);
  return rt.readyPromise;
}

async function startClient(room, ticket, { extraArgs = [], timeoutMs = 10_000 } = {}) {
  const rt = await getRuntime(room);
  const proc = {
    logs: [],
    label: `client-${room}-${randomBytes(3).toString('hex')}`,
  };
  spawnRuntime(proc, [
    '--url',
    `ws://127.0.0.1:${rt.port}`,
    '--ticket',
    ticket,
    '--room',
    room,
    ...extraArgs,
  ]);
  return { rt, proc };
}

async function stop(proc) {
  if (proc.child && !proc.exited) {
    proc.child.kill();
    await Promise.race([waitForExit(proc), sleep(3000)]);
  }
}

function waitForExit(proc) {
  if (proc.exited) return Promise.resolve();
  return new Promise((resolve) => proc.child.once('exit', resolve));
}

async function main() {
  console.log(`runtime: ${RUNTIME_PATH}`);
  console.log(`project: ${PROJECT_PATH}`);
  console.log(`logs:    ${LOG_DIR}\n`);

  // 1. Readiness and one port per room.
  const roomA = `probe-a-${randomBytes(2).toString('hex')}`;
  const roomB = `probe-b-${randomBytes(2).toString('hex')}`;
  const [a1, a2, a3] = await Promise.all([
    getRuntime(roomA),
    getRuntime(roomA),
    getRuntime(roomA),
  ]);
  check(a1 === a2 && a2 === a3, 'concurrent requests share one runtime');
  check(a1.port >= PORT_START && a1.port <= PORT_END, 'reserved port in range', String(a1.port));
  check(a1.child.pid > 0, 'runtime process is alive', `pid ${a1.child.pid}`);
  const b = await getRuntime(roomB);
  check(b.port !== a1.port, 'different rooms get different ports', `${a1.port} vs ${b.port}`);
  const again = await getRuntime(roomA);
  check(again.port === a1.port && again.child.pid === a1.child.pid, 'repeated request reuses runtime');

  // 2. Valid client: handshake + server event + ack.
  const ticket1 = mintTicket(roomA);
  const c1 = await startClient(roomA, ticket1);
  await waitFor(c1.proc, (l) => l.includes('WIRED_CLIENT_AUTH_OK'), 'client auth ok');
  const eventLine = await waitFor(
    c1.proc,
    (l) => l.includes('WIRED_CLIENT_EVENT') && l.includes('world_state'),
    'client world_state',
  );
  await waitFor(c1.proc, (l) => l.includes('WIRED_CLIENT_ACK_SENT'), 'client ack sent');
  check(true, 'client completed handshake');
  check(eventLine.includes(`"room":"${roomA}"`), 'world_state carries the room', eventLine.slice(0, 120));
  const ack = await waitFor(
    a1,
    (l) => l.includes('WIRED_EVENT_ACK') && l.includes('seq=1'),
    'server event ack',
  );
  check(true, 'server confirmed the game event', ack);

  // 3. Second client: distinct player, existing client sees join broadcast.
  const ticket2 = mintTicket(roomA);
  const c2 = await startClient(roomA, ticket2);
  await waitFor(c2.proc, (l) => l.includes('WIRED_CLIENT_AUTH_OK'), 'second client auth');
  const p1 = a1.logs.filter((l) => l.includes('WIRED_AUTH_OK'));
  check(p1.length === 2, 'server admitted two players', `${p1.length} admissions`);
  check(
    p1[0] !== p1[1],
    'players got distinct identities',
    p1.map((l) => l.match(/player=(\d+)/)?.[1]).join(','),
  );
  await waitFor(
    c1.proc,
    (l) => l.includes('player_joined'),
    'first client saw player_joined',
  );
  check(true, 'server broadcast reached the first client');

  // 4. Ticket reuse is rejected and the connection closed.
  const reused = await startClient(roomA, ticket1);
  await waitFor(
    reused.proc,
    (l) => l.includes('WIRED_CLIENT_AUTH_ERROR') && l.includes('ticket_reused'),
    'reused ticket rejected',
  );
  check(true, 'one-time ticket cannot be reused');
  await waitFor(
    a1,
    (l) => l.includes('WIRED_AUTH_REJECTED') && l.includes('reason=ticket_reused'),
    'server ticket_reused',
  );
  await stop(reused.proc);

  // 5. Expired and forged tickets are rejected.
  const expired = await startClient(roomA, mintTicket(roomA, { ttlSec: -1 }));
  await waitFor(
    expired.proc,
    (l) => l.includes('WIRED_CLIENT_AUTH_ERROR') && l.includes('expired'),
    'expired ticket rejected',
  );
  check(true, 'expired ticket rejected');
  await stop(expired.proc);

  const forged = await startClient(roomA, mintTicket(roomA, { secret: 'wrong-secret' }));
  await waitFor(
    forged.proc,
    (l) => l.includes('WIRED_CLIENT_AUTH_ERROR') && l.includes('bad_signature'),
    'forged ticket rejected',
  );
  check(true, 'forged ticket rejected');
  await stop(forged.proc);

  // 6. Gameplay RPC before authentication is denied and creates no player.
  const beforeCount = a1.logs.filter((l) => l.includes('WIRED_AUTH_OK')).length;
  const unauth = await startClient(roomA, mintTicket(roomA), {
    extraArgs: ['--probe-no-hello', '--probe-action'],
  });
  await waitFor(
    a1,
    (l) => l.includes('WIRED_ACTION_REJECTED') && l.includes('reason=not_authenticated'),
    'unauthenticated action rejected',
  );
  const afterCount = a1.logs.filter((l) => l.includes('WIRED_AUTH_OK')).length;
  check(afterCount === beforeCount, 'unauthenticated action created no player');
  check(
    a1.logs.some((l) => l.includes('WIRED_RPC_DENIED')),
    'server answered the denied RPC',
  );
  await stop(unauth.proc);

  // 7. Disconnect of an admitted client is reported.
  await stop(c2.proc);
  await waitFor(a1, (l) => l.includes('WIRED_PLAYER_LEFT'), 'player left on disconnect');
  check(true, 'server observed client disconnect');

  // 8. Server disconnect reaches the client.
  await stop(a1);
  await waitFor(
    c1.proc,
    (l) => l.includes('WIRED_CLIENT_SERVER_DISCONNECTED'),
    'client saw server disconnect',
  );
  check(true, 'client observed server disconnect');
  await stop(c1.proc);

  const revived = await getRuntime(roomA);
  check(
    revived.child.pid !== a1.child.pid && revived.port === a1.port,
    'runtime restarts after stop on the same reserved port',
  );

  // 9. Exit codes for misconfiguration.
  const noSecret = { logs: [], label: 'no-secret' };
  spawnRuntime(noSecret, ['--server', '--port', String(revived.port), '--room', roomA]);
  await waitForExit(noSecret);
  check(noSecret.exitCode === 2, 'server exits with 2 when ticket secret is missing', String(noSecret.exitCode));

  const blockerPort = await allocatePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(blockerPort, '127.0.0.1', resolve));
  const busy = { logs: [], label: 'busy-port' };
  spawnRuntime(busy, ['--server', '--port', String(blockerPort), '--room', roomA], {
    WIRED_GAME_TICKET_SECRET: SECRET,
  });
  await waitForExit(busy);
  blocker.close();
  check(busy.exitCode === 3, 'server exits with 3 when the port is taken', String(busy.exitCode));

  for (const rt of runtimes.values()) await stop(rt);

  console.log('\n--- summary ---');
  console.log(`${results.length - failures}/${results.length} checks passed`);
  if (failures > 0) {
    console.log(`\nlogs: ${LOG_DIR}`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(`\nPROBE ERROR: ${error.message}`);
  for (const rt of runtimes.values()) await stop(rt);
  for (const child of children) child.kill();
  process.exit(1);
});
