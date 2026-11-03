import { once } from 'node:events';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PassThrough, Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { AppConfigService } from 'src/config/config.service';
import { GameSocketProxyService } from './game-socket-proxy.service';
import { RoomRuntimeService } from './room-runtime.service';

jest.setTimeout(15_000);

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );

const open = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

const message = (
  ws: WebSocket,
): Promise<{ data: RawData; isBinary: boolean }> =>
  new Promise((resolve) =>
    ws.once('message', (data, isBinary) => resolve({ data, isBinary })),
  );

const closeCode = (ws: WebSocket): Promise<number> =>
  new Promise((resolve) => ws.once('close', (code) => resolve(code)));

const rejectStatus = (url: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => reject(new Error('upgrade unexpectedly accepted')));
    ws.once('error', reject);
  });

/**
 * Waits until the code reaches a condition on its own.
 *
 * Sleeping for a guessed duration passes on a fast machine and fails on a slow
 * one. Yielding with `setImmediate` keeps the loop out of wall-clock time while
 * still letting socket events land, and the deadline turns a hang into a
 * readable failure instead of a Jest timeout.
 */
const waitFor = async (
  condition: () => boolean,
  description: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('GameSocketProxyService', () => {
  let httpServer: Server;
  let httpPort: number;
  let upstream: WebSocketServer;
  let upstreamPort: number;
  let getRuntime: jest.Mock;
  let runtimes: RoomRuntimeService;
  let config: AppConfigService;
  let proxy: GameSocketProxyService;
  const clients: WebSocket[] = [];

  const connect = (roomId = '7', suffix = '') => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${httpPort}/rooms/${roomId}/game/ws${suffix}`,
    );
    clients.push(ws);
    return ws;
  };

  /** How many proxied pairs the service currently holds. */
  const tracked = (): number =>
    (proxy as unknown as { totalConnections(): number }).totalConnections();

  beforeEach(async () => {
    httpServer = createServer();
    getRuntime = jest.fn();
    runtimes = { getRuntime } as unknown as RoomRuntimeService;
    config = {
      godotRuntime: {
        bindAddress: '127.0.0.1',
        wsMaxClientsPerRoom: 1,
        wsMaxTotal: 10,
      },
    } as unknown as AppConfigService;
    proxy = new GameSocketProxyService({} as HttpAdapterHost, runtimes, config);
    proxy.attach(httpServer);
    httpPort = await listen(httpServer);

    upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(upstream, 'listening');
    upstreamPort = (upstream.address() as AddressInfo).port;
    upstream.on('connection', (socket) =>
      socket.on('message', (data, isBinary) =>
        socket.send(data, { binary: isBinary }),
      ),
    );
  });

  afterEach(async () => {
    for (const client of clients) {
      client.terminate();
    }
    clients.length = 0;
    proxy.detach();
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const socket of upstream.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('proxies text and binary messages and accepts a trailing slash', async () => {
    getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
    const ws = connect('7', '/?x=1');
    await open(ws);

    ws.send('hello');
    const echoedText = await message(ws);
    expect(echoedText.isBinary).toBe(false);
    expect(Buffer.from(echoedText.data as Buffer).toString()).toBe('hello');

    const bytes = Buffer.from([1, 2, 3]);
    ws.send(bytes);
    const echoed = await message(ws);
    expect(echoed.isBinary).toBe(true);
    expect(Buffer.from(echoed.data as Buffer)).toEqual(bytes);
    ws.close();
  });

  it('closes a frame larger than maxPayload with 1009', async () => {
    getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
    const ws = connect();
    await open(ws);

    ws.send(Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(closeCode(ws)).resolves.toBe(1009);
  });

  it('returns 404 for any other upgrade path', async () => {
    await expect(
      rejectStatus(`ws://127.0.0.1:${httpPort}/rooms/7/game`),
    ).resolves.toBe(404);
  });

  it('handles a socket error while rejecting an upgrade', () => {
    const socket = new PassThrough() as unknown as Duplex;
    const destroy = jest.spyOn(socket, 'destroy');
    (
      proxy as unknown as {
        reject(socket: Duplex, status: number): void;
      }
    ).reject(socket, 404);

    expect(() => socket.emit('error', new Error('reset'))).not.toThrow();
    expect(destroy).toHaveBeenCalled();
  });

  it('returns 503 when the room runtime is not running', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    getRuntime.mockReturnValue({ state: 'starting', port: upstreamPort });
    try {
      await expect(
        rejectStatus(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`),
      ).resolves.toBe(503);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/room 7.*not running/i),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('enforces the per-room connection cap', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
    const first = connect();
    await open(first);

    try {
      await expect(
        rejectStatus(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`),
      ).resolves.toBe(503);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/room 7.*limit/i),
      );
    } finally {
      warn.mockRestore();
      first.close();
    }
  });

  it('enforces the global connection cap', async () => {
    const limitedProxy = new GameSocketProxyService(
      {} as HttpAdapterHost,
      runtimes,
      {
        godotRuntime: {
          bindAddress: '127.0.0.1',
          wsMaxClientsPerRoom: 1,
          wsMaxTotal: 1,
        },
      } as unknown as AppConfigService,
    );
    const limitedServer = createServer();
    limitedProxy.attach(limitedServer);
    const limitedPort = await listen(limitedServer);

    try {
      getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
      const first = new WebSocket(
        `ws://127.0.0.1:${limitedPort}/rooms/7/game/ws`,
      );
      clients.push(first);
      await open(first);

      await expect(
        rejectStatus(`ws://127.0.0.1:${limitedPort}/rooms/8/game/ws`),
      ).resolves.toBe(503);
      first.close();
    } finally {
      limitedProxy.detach();
      limitedProxy.onModuleDestroy();
      limitedServer.closeAllConnections?.();
      await new Promise<void>((resolve) =>
        limitedServer.close(() => resolve()),
      );
    }
  });

  it('closes the client with 1011 when the upstream refuses and frees the slot', async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise((resolve) => dead.close(resolve));
    getRuntime
      .mockReturnValueOnce({ state: 'running', port: deadPort })
      .mockReturnValue({ state: 'running', port: upstreamPort });

    const failing = connect();
    await expect(closeCode(failing)).resolves.toBe(1011);

    const retry = connect();
    await expect(open(retry)).resolves.toBeUndefined();
    retry.close();
  });

  it('closes and untracks a client before the upstream handshake completes', async () => {
    const blackhole = createServer(() => undefined);
    const blackholePort = await listen(blackhole);
    getRuntime
      .mockReturnValueOnce({ state: 'running', port: blackholePort })
      .mockReturnValue({ state: 'running', port: upstreamPort });

    const stuck = connect();
    await open(stuck);
    stuck.close();
    // The per-room cap is one client, so the retry below only succeeds once
    // this pair is released — that release is what the test is about.
    await waitFor(() => tracked() === 0, 'the aborted pair to be untracked');

    const retry = connect();
    await expect(open(retry)).resolves.toBeUndefined();
    retry.close();

    blackhole.closeAllConnections?.();
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  });

  it('does not log an upstream error when the client aborts first', async () => {
    const blackhole = createServer(() => undefined);
    // The proxy terminates its half-open upstream when the client leaves, so
    // the server seeing that connection close is the point after which an
    // upstream error would already have been logged.
    const upstreamClosed = new Promise<void>((resolve) => {
      blackhole.once('connection', (socket) =>
        socket.once('close', () => resolve()),
      );
    });
    const blackholePort = await listen(blackhole);
    getRuntime.mockReturnValue({ state: 'running', port: blackholePort });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    try {
      const client = connect();
      await open(client);
      client.close();
      await upstreamClosed;

      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(/upstream failed/i),
      );
    } finally {
      warn.mockRestore();
      blackhole.closeAllConnections?.();
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  });

  it('propagates a client close to the upstream', async () => {
    getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
    const upstreamClosed = new Promise<number>((resolve) => {
      upstream.once('connection', (socket) =>
        socket.once('close', (code) => resolve(code)),
      );
    });
    const upstreamConnected = new Promise<void>((resolve) => {
      upstream.once('connection', () => resolve());
    });

    const client = connect();
    await open(client);
    await upstreamConnected;
    client.send('ping');
    await message(client);
    client.close(1000, 'bye');

    await expect(upstreamClosed).resolves.toBe(1000);
  });
});
