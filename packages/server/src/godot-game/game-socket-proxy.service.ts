import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { AppConfigService } from 'src/config/config.service';
import { RoomRuntimeService } from './room-runtime.service';

const ROUTE = /^\/rooms\/(\d{1,10})\/game\/ws\/?$/;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 5_000;

const HTTP_REASONS: Record<number, string> = {
  404: 'Not Found',
  503: 'Service Unavailable',
};

const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

interface ProxyPair {
  roomId: string;
  client: WebSocket;
  upstream: WebSocket;
}

/**
 * Terminates browser game sockets on the backend and forwards them to the
 * room runtime's loopback port. The runtime port never reaches the browser.
 */
@Injectable()
export class GameSocketProxyService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GameSocketProxyService.name);
  private readonly connections = new Map<string, Set<ProxyPair>>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  private server: Server | null = null;

  private readonly upgradeHandler = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    this.handleUpgrade(req, socket, head);
  };

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly runtimes: RoomRuntimeService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined;
    if (!server) {
      this.logger.warn('HTTP server unavailable; game socket proxy disabled');
      return;
    }
    this.attach(server);
  }

  onModuleDestroy(): void {
    this.detach();
    const pairs = [...this.connections.values()].flatMap((set) => [...set]);
    for (const pair of pairs) {
      this.closeBoth(pair, 1001, 'server shutting down');
    }
    this.connections.clear();
    this.wss.close();
  }

  attach(server: Server): void {
    if (this.server === server) {
      return;
    }
    this.detach();
    this.server = server;
    server.on('upgrade', this.upgradeHandler);
  }

  detach(): void {
    this.server?.off('upgrade', this.upgradeHandler);
    this.server = null;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = this.pathname(req.url);
    const match = pathname === null ? null : ROUTE.exec(pathname);
    if (req.method !== 'GET' || !match) {
      this.reject(socket, 404);
      return;
    }

    const roomId = match[1];
    const info = this.runtimes.getRuntime(roomId);
    if (!info || info.state !== 'running' || !info.port) {
      this.reject(socket, 503);
      return;
    }

    const roomConnections = this.connections.get(roomId)?.size ?? 0;
    if (
      roomConnections >= this.config.godotRuntime.wsMaxClientsPerRoom ||
      this.totalConnections() >= this.config.godotRuntime.wsMaxTotal
    ) {
      this.reject(socket, 503);
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (client) => {
      this.pipe(client, roomId, info.port);
    });
  }

  private pathname(rawUrl: string | undefined): string | null {
    if (!rawUrl) {
      return null;
    }
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      return null;
    }
  }

  private totalConnections(): number {
    let total = 0;
    for (const set of this.connections.values()) {
      total += set.size;
    }
    return total;
  }

  private reject(socket: Duplex, status: number): void {
    if (socket.writable) {
      socket.write(
        `HTTP/1.1 ${status} ${HTTP_REASONS[status] ?? 'Error'}\r\n` +
          'Connection: close\r\nContent-Length: 0\r\n\r\n',
      );
    }
    socket.destroy();
  }

  private pipe(client: WebSocket, roomId: string, port: number): void {
    const upstream = new WebSocket(this.targetUrl(port), {
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
    });
    const pair: ProxyPair = { roomId, client, upstream };
    this.track(pair);

    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    let pendingBytes = 0;

    const release = (): void => {
      const set = this.connections.get(roomId);
      if (!set) {
        return;
      }
      set.delete(pair);
      if (set.size === 0) {
        this.connections.delete(roomId);
      }
    };

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      if (upstream.readyState !== WebSocket.CONNECTING) {
        return;
      }
      pendingBytes += this.rawDataLength(data);
      if (pendingBytes > MAX_PAYLOAD_BYTES) {
        this.logger.warn(`Game client ${roomId} exceeded the upstream buffer`);
        release();
        upstream.terminate();
        client.close(1011, 'upstream buffer overflow');
        return;
      }
      pending.push({ data, isBinary });
    });

    upstream.on('open', () => {
      for (const item of pending.splice(0)) {
        upstream.send(item.data, { binary: item.isBinary });
      }
      pendingBytes = 0;
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });

    client.on('close', (code) => {
      release();
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      } else if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(normalizeClose(code, 1000));
      }
    });

    client.on('error', () => {
      release();
      upstream.terminate();
    });

    upstream.on('close', (code) => {
      release();
      if (client.readyState === WebSocket.OPEN) {
        client.close(normalizeClose(code, 1011));
      }
    });

    upstream.on('error', (error) => {
      release();
      this.logger.warn(
        `Game socket upstream failed for room ${roomId}: ${error.message}`,
      );
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'upstream error');
      }
    });
  }

  private track(pair: ProxyPair): void {
    const set = this.connections.get(pair.roomId) ?? new Set<ProxyPair>();
    set.add(pair);
    this.connections.set(pair.roomId, set);
  }

  private targetUrl(port: number): string {
    const bind = this.config.godotRuntime.bindAddress;
    const host = !bind || bind === '0.0.0.0' ? '127.0.0.1' : bind;
    return `ws://${host}:${port}`;
  }

  private rawDataLength(data: RawData): number {
    if (Array.isArray(data)) {
      return data.reduce((total, chunk) => total + chunk.length, 0);
    }
    return data.byteLength;
  }

  private closeBoth(pair: ProxyPair, code: number, reason: string): void {
    if (pair.client.readyState === WebSocket.OPEN) {
      pair.client.close(code, reason);
    } else {
      pair.client.terminate();
    }
    if (pair.upstream.readyState === WebSocket.OPEN) {
      pair.upstream.close(code, reason);
    } else {
      pair.upstream.terminate();
    }
  }
}

function normalizeClose(code: number, fallback: number): number {
  if (!Number.isInteger(code) || code < 1000 || code > 4999) {
    return fallback;
  }
  if (code >= 1016 && code < 3000) {
    return fallback;
  }
  return RESERVED_CLOSE_CODES.has(code) ? fallback : code;
}
