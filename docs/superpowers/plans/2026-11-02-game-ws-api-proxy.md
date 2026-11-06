# WebSocket через API-роут — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Браузер подключается к native-рантайму Godot комнаты через `wss://api.<домен>/rooms/<id>/game/ws`, а NestJS проксирует upgrade на внутренний `ws://127.0.0.1:<port>`.

**Architecture:** `GameSocketProxyService` вешает единственный `upgrade`-обработчик на HTTP-сервер Nest, проверяет путь `/rooms/<id>/game/ws`, находит запущенный рантайм комнаты, принимает соединение через `ws` и открывает исходящий `ws://127.0.0.1:<port>`, перекладывая сообщения в обе стороны. `RoomRuntimeConfiguration.buildEndpoint` перестаёт отдавать сырой порт: в dev выводит адрес из `GODOT_ROOM_API_URL`, в production требует явный `GODOT_ROOM_PUBLIC_WS_BASE`.

**Tech Stack:** NestJS 11 (Express), `ws` 8, Jest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-02-game-ws-api-proxy-design.md`

## Global Constraints

- Godot-проект, протокол `cli_hello`, формат тикета и `GameTicketService` не меняются.
- Тикет никогда не попадает в URL, логи или query-строку: его по-прежнему отправляет клиент первым RPC.
- Внутренние порты (`GODOT_ROOM_PORT_START..END`, по умолчанию 19100–19199) не выходят за пределы backend-контейнера.
- В production `GODOT_ROOM_PUBLIC_WS_BASE` обязателен, должен начинаться с `wss://` и содержать `{room}`.
- `GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM` = 32, `GODOT_ROOM_WS_MAX_TOTAL` = 512.
- Per-IP лимиты, `trust proxy`, `limit_conn` и проверка `Origin` в эту итерацию не входят.
- `maxPayload` = 8 MiB; отдельный env для него не добавляем.
- Серверные тесты: `pnpm --filter server test` (Jest, `rootDir` `packages/server/src`, `*.spec.ts`).
- Prettier: single quotes, trailing commas. Conventional Commits.

## Review Focus

- Upgrade на `/rooms/7/game/ws/` или `/rooms/7/game/ws?x=1` должен работать, а любой другой путь — закрываться сразу, не оставляя висящий сокет.
- Рантайм комнаты в состоянии `starting`, `stopping` или `failed` не должен проксироваться: клиент получает `503` и повторяет запрос тикета.
- Отказ upstream после принятия клиента не должен навсегда занимать слот: клиент закрывается `1011`, запись удаляется из реестра.
- Обрыв клиента до открытия upstream не должен оставлять исходящее соединение или занятый слот.
- Text и binary сообщения должны доходить без изменения типа, а кадр больше `maxPayload` — закрывать соединение, а не ронять процесс.

---

### Task 1: Адрес игры без порта

**Files:**
- Modify: `packages/server/src/godot-game/room-runtime.configuration.ts:52-98,146-164`
- Modify: `packages/server/src/godot-game/room-runtime.types.ts:40-44`
- Modify: `packages/server/src/config/config.interface.ts:39-43` (только комментарий)
- Test: `packages/server/src/godot-game/room-runtime.configuration.spec.ts`

**Interfaces:**
- Consumes: `GodotRuntimeConfig.apiUrl` (`http://127.0.0.1:<PORT>` в dev), `GodotRuntimeConfig.publicWsBaseUrl`.
- Produces: `RoomRuntimeConfiguration.buildEndpoint(config: GodotRuntimeConfig, roomId: string, port: number): string`; `validate(config)` бросает `RoomRuntimeError` с кодом `config`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `room-runtime.configuration.spec.ts`:

```ts
const production = new RoomRuntimeConfiguration({
  isProduction: true,
} as unknown as AppConfigService);

it('derives the API WebSocket route from apiUrl outside production', () => {
  expect(configuration.buildEndpoint(config, '42', 19100)).toBe(
    'ws://127.0.0.1:4123/rooms/42/game/ws',
  );
});

it('keeps a base path and upgrades https to wss', () => {
  expect(
    configuration.buildEndpoint(
      { ...config, apiUrl: 'https://api.example.com/wired/' },
      '42',
      19100,
    ),
  ).toBe('wss://api.example.com/wired/rooms/42/game/ws');
});

it('interpolates room and port in an explicit public base', () => {
  expect(
    configuration.buildEndpoint(
      { ...config, publicWsBaseUrl: 'wss://games.example/godot/{room}?p={port}' },
      '42',
      19100,
    ),
  ).toBe('wss://games.example/godot/42?p=19100');
});

it('rejects a public base without placeholders', () => {
  expect(() =>
    configuration.validate({
      ...config,
      publicWsBaseUrl: 'wss://games.example/godot',
    }),
  ).toThrow(/placeholder|\{room\}/i);
});

it('rejects a port-only public base in production', () => {
  expect(() =>
    production.validate({
      ...config,
      publicWsBaseUrl: 'wss://games.example/godot?p={port}',
    }),
  ).toThrow(/room/i);
});

it('requires a wss public base in production', () => {
  expect(() =>
    production.validate({
      ...config,
      publicWsBaseUrl: 'ws://games.example/rooms/{room}/game/ws',
    }),
  ).toThrow(/wss/i);
});

it('still requires a public base in production', () => {
  expect(() =>
    production.validate({ ...config, publicWsBaseUrl: '' }),
  ).toThrow(/GODOT_ROOM_PUBLIC_WS_BASE/);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter server exec jest room-runtime.configuration --runInBand`

Expected: FAIL — текущий `buildEndpoint` возвращает `ws://127.0.0.1:19100`, валидация не проверяет шаблон.

- [ ] **Step 3: Реализовать `buildEndpoint` и валидацию**

В `room-runtime.configuration.ts`:

```ts
buildEndpoint(
  config: GodotRuntimeConfig,
  roomId: string,
  port: number,
): string {
  const template = config.publicWsBaseUrl;
  if (template) {
    return template
      .split('{room}')
      .join(encodeURIComponent(roomId))
      .split('{port}')
      .join(String(port));
  }
  return this.deriveEndpoint(config.apiUrl, roomId);
}

private deriveEndpoint(apiUrl: string, roomId: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new RoomRuntimeError('config', `Invalid GODOT_ROOM_API_URL ${apiUrl}`);
  }
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else {
    throw new RoomRuntimeError(
      'config',
      `GODOT_ROOM_API_URL must be http(s), got ${url.protocol}`,
    );
  }
  url.search = '';
  url.hash = '';
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = `${base}/rooms/${encodeURIComponent(roomId)}/game/ws`;
  return url.toString();
}
```

В `validate(config)` после проверки `isProduction` добавить:

```ts
if (config.publicWsBaseUrl) {
  if (!/^wss?:\/\//.test(config.publicWsBaseUrl)) {
    throw new RoomRuntimeError(
      'config',
      'GODOT_ROOM_PUBLIC_WS_BASE must start with ws:// or wss://',
    );
  }
  if (
    !config.publicWsBaseUrl.includes('{room}') &&
    !config.publicWsBaseUrl.includes('{port}')
  ) {
    throw new RoomRuntimeError(
      'config',
      'GODOT_ROOM_PUBLIC_WS_BASE must contain the {room} placeholder',
    );
  }
  if (this.configService.isProduction) {
    if (!config.publicWsBaseUrl.startsWith('wss://')) {
      throw new RoomRuntimeError(
        'config',
        'GODOT_ROOM_PUBLIC_WS_BASE must use wss:// in production',
      );
    }
    if (!config.publicWsBaseUrl.includes('{room}')) {
      throw new RoomRuntimeError(
        'config',
        'GODOT_ROOM_PUBLIC_WS_BASE must contain {room} in production; a port-only base leaks internal ports',
      );
    }
  }
}
```

Обновить комментарии в `room-runtime.types.ts` и `config.interface.ts`: `publicWsBaseUrl` — публичный шаблон с `{room}` (и опциональным `{port}` для legacy), пусто — адрес выводится из `apiUrl` только вне production.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter server exec jest room-runtime.configuration --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-game/room-runtime.configuration.ts packages/server/src/godot-game/room-runtime.configuration.spec.ts packages/server/src/godot-game/room-runtime.types.ts packages/server/src/config/config.interface.ts
git commit -m "feat(server): expose the game socket through an API route"
```

---

### Task 2: WS-прокси в Nest

**Files:**
- Modify: `packages/server/package.json` (dependencies)
- Modify: `packages/server/src/config/config.interface.ts:26-46`
- Modify: `packages/server/src/config/config.ts:62-99`
- Modify: `packages/server/src/godot-game/room-runtime.types.ts:11-46`
- Create: `packages/server/src/godot-game/game-socket-proxy.service.ts`
- Modify: `packages/server/src/godot-game/godot-game.module.ts:20-46`
- Test: `packages/server/src/godot-game/game-socket-proxy.service.spec.ts`

**Interfaces:**
- Consumes: `RoomRuntimeService.getRuntime(roomId: string): RoomRuntimeInfo | null`; `AppConfigService.godotRuntime` с полями `bindAddress`, `wsMaxClientsPerRoom`, `wsMaxTotal`.
- Produces: `GameSocketProxyService.attach(server: http.Server): void`, `detach(): void`, `handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void`; `onApplicationBootstrap()`/`onModuleDestroy()`.

- [ ] **Step 1: Добавить зависимости и настройки**

```bash
pnpm --filter server add ws
pnpm --filter server add -D @types/ws
```

В `config.interface.ts` в `godotRuntime` добавить:

```ts
/** Concurrent proxied game sockets allowed per room. */
wsMaxClientsPerRoom: number;
/** Concurrent proxied game sockets allowed for the whole backend. */
wsMaxTotal: number;
```

В `config.ts` после `publicWsBaseUrl`:

```ts
wsMaxClientsPerRoom: intFromEnv('GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM', 32),
wsMaxTotal: intFromEnv('GODOT_ROOM_WS_MAX_TOTAL', 512),
```

В `GodotRuntimeConfig` (`room-runtime.types.ts`) добавить те же два поля с комментариями. Обновить фикстуры `room-runtime.configuration.spec.ts` и `createService` в `room-runtime.service.spec.ts` значениями `32` и `512`.

- [ ] **Step 2: Написать падающий тест прокси**

Создать `game-socket-proxy.service.spec.ts`. Каркас:

```ts
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer } from 'ws';
import { AppConfigService } from 'src/config/config.service';
import { GameSocketProxyService } from './game-socket-proxy.service';
import { RoomRuntimeService } from './room-runtime.service';

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

const message = (ws: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> =>
  new Promise((resolve) => ws.once('message', (data, isBinary) => resolve({ data, isBinary })));

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
```

В `beforeEach`: поднять `httpServer = createServer()`, создать `const getRuntime = jest.fn();` и `const runtimes = { getRuntime } as unknown as RoomRuntimeService;` (отдельная ссылка нужна, чтобы `mockReturnValue` не терял тип), `config = { godotRuntime: { bindAddress: '127.0.0.1', wsMaxClientsPerRoom: 1, wsMaxTotal: 10 } } as unknown as AppConfigService`, `proxy = new GameSocketProxyService({} as HttpAdapterHost, runtimes, config)`, `proxy.attach(httpServer)`, `httpPort = await listen(httpServer)`. Поднять upstream:

```ts
upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(upstream, 'listening');
upstreamPort = (upstream.address() as AddressInfo).port;
upstream.on('connection', (socket) =>
  socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary })),
);
```

В `afterEach` закрыть клиентов, `proxy.detach()`, `httpServer.closeAllConnections?.()`, `httpServer.close()`, `upstream.close()`. Лимит `wsMaxClientsPerRoom: 1` выбран намеренно: тесты на освобождение слота после отказа upstream и после обрыва клиента проверяют именно повторное подключение.

Тесты (имена и ключевые ожидания):

```ts
it('proxies text and binary messages and accepts a trailing slash', async () => {
  getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws/?x=1`);
  await open(ws);
  ws.send('hello');
  await expect(message(ws)).resolves.toMatchObject({ data: 'hello', isBinary: false });
  const bytes = Buffer.from([1, 2, 3]);
  ws.send(bytes);
  const echoed = await message(ws);
  expect(echoed.isBinary).toBe(true);
  expect(Buffer.from(echoed.data as Buffer)).toEqual(bytes);
  ws.close();
});

it('closes a frame larger than maxPayload with 1009', async () => {
  getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`);
  await open(ws);
  ws.send(Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(closeCode(ws)).resolves.toBe(1009);
});

it('returns 404 for any other upgrade path', async () => {
  await expect(rejectStatus(`ws://127.0.0.1:${httpPort}/rooms/7/game`)).resolves.toBe(404);
});

it('returns 503 when the room runtime is not running', async () => {
  getRuntime.mockReturnValue({ state: 'starting', port: upstreamPort });
  await expect(rejectStatus(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`)).resolves.toBe(503);
});

it('enforces the per-room connection cap', async () => {
  getRuntime.mockReturnValue({ state: 'running', port: upstreamPort });
  const first = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`);
  await open(first);
  await expect(rejectStatus(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`)).resolves.toBe(503);
  first.close();
});

it('closes the client with 1011 when the upstream refuses and frees the slot', async () => {
  const dead = createServer();
  const deadPort = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  getRuntime
    .mockReturnValueOnce({ state: 'running', port: deadPort })
    .mockReturnValue({ state: 'running', port: upstreamPort });

  const failing = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`);
  await expect(closeCode(failing)).resolves.toBe(1011);

  const retry = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`);
  await expect(open(retry)).resolves.toBeUndefined();
  retry.close();
});

it('closes and untracks a client before the upstream handshake completes', async () => {
  const blackhole = createServer(() => undefined);
  const blackholePort = await listen(blackhole);
  getRuntime
    .mockReturnValueOnce({ state: 'running', port: blackholePort })
    .mockReturnValue({ state: 'running', port: upstreamPort });

  const stuck = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`);
  await open(stuck);
  stuck.close();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const retry = new WebSocket(`ws://127.0.0.1:${httpPort}/rooms/7/game/ws`);
  await expect(open(retry)).resolves.toBeUndefined();
  retry.close();
  blackhole.close();
});
```

Добавить тест `enforces the global cap`: пересоздать `GameSocketProxyService` с `wsMaxTotal: 1` (per-room оставить 1), открыть соединение для комнаты `7`, затем проверить, что комната `8` получает `503`. Добавить тест `closes both sides when either side closes`: клиент закрывается кодом `1000`, upstream получает `close`.

- [ ] **Step 3: Убедиться, что тест падает**

Run: `pnpm --filter server exec jest game-socket-proxy --runInBand`

Expected: FAIL — модуль `./game-socket-proxy.service` не существует.

- [ ] **Step 4: Реализовать `GameSocketProxyService`**

Экспортируемые константы и сигнатуры:

```ts
const ROUTE = /^\/rooms\/(\d{1,10})\/game\/ws\/?$/;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 5_000;

@Injectable()
export class GameSocketProxyService
  implements OnApplicationBootstrap, OnModuleDestroy {
  attach(server: http.Server): void;
  detach(): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}
```

Требования к телу:

- `onApplicationBootstrap` берёт `this.adapterHost.httpAdapter.getHttpServer()` и вызывает `attach`; `onModuleDestroy` вызывает `detach`, затем закрывает все пары кодом `1001` и `wss.close()`.
- `attach` сохраняет сервер и вешает `server.on('upgrade', this.upgradeHandler)`; `detach` снимает обработчик (`server.off`).
- `handleUpgrade`: если `req.method !== 'GET'` или путь не совпал — `reject(socket, 404)`. Рантайм: `const info = this.runtimes.getRuntime(roomId)`; если `!info || info.state !== 'running' || !info.port` — `reject(socket, 503)`. Лимиты: `this.connections.get(roomId)?.size` против `config.godotRuntime.wsMaxClientsPerRoom` и суммарный размер против `wsMaxTotal`; при превышении — `reject(socket, 503)`.
- `reject(socket, status)`: записать `HTTP/1.1 <status> <text>\r\nConnection: close\r\nContent-Length: 0\r\n\r\n` и `socket.destroy()`.
- Принять upgrade через `this.wss.handleUpgrade(req, socket, head, (client) => this.pipe(client, roomId, info.port))`, где `this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })`.
- `pipe`: создать `const upstream = new WebSocket(this.targetUrl(port), { maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS })`; завести запись в `Map<string, Set<{ client; upstream }>>`; буферизовать сообщения клиента, пока upstream `CONNECTING` (массив `{ data, isBinary }`), на `open` отправить очередь и очистить; после `open` перекладывать сразу. Обратное направление — так же. Сохранять `binary`-флаг.
- `targetUrl(port)`: host = `!bindAddress || bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress`; вернуть `ws://${host}:${port}`.
- Закрытия: `client.on('close', (code) => upstream.readyState === WebSocket.CONNECTING ? upstream.terminate() : upstream.close(normalizeClose(code, 1000)))`; `upstream.on('close', (code) => client.close(normalizeClose(code, 1011)))`. `normalizeClose` заменяет `1005`, `1006`, `1015` и `0` на fallback. Ошибка upstream: `logger.warn`, `client.close(1011, 'upstream error')`. Ошибка клиента: `upstream.terminate()`. На любом `close`/`error` удалять пару из `Map` (и удалять пустой Set).
- Не логировать тикет и содержимое сообщений.

Зарегистрировать `GameSocketProxyService` в `providers` `godot-game.module.ts`.

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter server exec jest game-socket-proxy room-runtime --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/config packages/server/src/godot-game
git commit -m "feat(server): proxy game websockets through the API"
```

---

### Task 3: Docker Compose и документация

**Files:**
- Modify: `docker-compose.yml:23-36`
- Modify: `AGENTS.md` (раздел Architecture facts, список runtime knobs)
- Modify: `docs/superpowers/specs/2026-11-02-game-ws-api-proxy-design.md` (статус: реализовано, если нужно)

**Interfaces:**
- Consumes: env `COMMON_DOMAIN`, `WIRED_GAME_TICKET_SECRET` из корневого `.env`.
- Produces: backend-контейнер с `WIRED_GAME_TICKET_SECRET` и `GODOT_ROOM_PUBLIC_WS_BASE=wss://api.${COMMON_DOMAIN}/rooms/{room}/game/ws`.

- [ ] **Step 1: Прокинуть env в compose**

В `services.backend.environment` добавить:

```yaml
      - WIRED_GAME_TICKET_SECRET=${WIRED_GAME_TICKET_SECRET}
      # Game sockets use the same public API vhost; the room id is in the path.
      - GODOT_ROOM_PUBLIC_WS_BASE=wss://api.${COMMON_DOMAIN}/rooms/{room}/game/ws
```

`{room}` не является подстановкой Compose (нет `$`), поэтому остаётся литералом. `COMMON_DOMAIN` уже передаётся в backend.

- [ ] **Step 2: Обновить AGENTS.md**

В «Architecture facts that bite» добавить пункт:

> Game WebSocket upgrades go through the backend at `/rooms/<id>/game/ws` and are proxied to the room's loopback runtime port; the browser never receives `19100–19199`. `GODOT_ROOM_PUBLIC_WS_BASE` must be `wss://api.<domain>/rooms/{room}/game/ws` in production (compose derives it from `COMMON_DOMAIN`), and `WIRED_GAME_TICKET_SECRET` must be set in the root `.env` for compose.

В список runtime knobs добавить `GODOT_ROOM_PUBLIC_WS_BASE`, `GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM`, `GODOT_ROOM_WS_MAX_TOTAL`.

- [ ] **Step 3: Проверить конфигурацию Compose**

Run: `docker compose config --quiet`

Expected: exit code 0, без предупреждений о неопределённых переменных. Если Docker недоступен — вручную проверить, что `${COMMON_DOMAIN}` подставляется, а `{room}` остаётся как есть.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml AGENTS.md docs/superpowers/specs/2026-11-02-game-ws-api-proxy-design.md
git commit -m "chore: wire the game WebSocket proxy into compose"
```

---

### Task 4: Полная проверка

**Files:** нет новых.

- [ ] **Step 1: Серверные тесты**

Run: `pnpm --filter server test`

Expected: все suites зелёные, включая новые `game-socket-proxy` и обновлённый `room-runtime.configuration`; `room-runtime.integration` пропущен без `WIRED_GODOT_INTEGRATION`.

- [ ] **Step 2: Сборка и типы**

Run: `pnpm --filter server build`

Expected: exit code 0, `dist/server/src/main.js` обновлён.

- [ ] **Step 3: Линт**

Run: `pnpm --filter server lint`

Expected: exit code 0 (команда автофиксит; повторный запуск не меняет файлы).

- [ ] **Step 4: Ручная проверка локально**

1. `pnpm dev:server`
2. `pnpm --filter frontend dev -- -p 3001`
3. Открыть Game tab. В DevTools → Network → WS должно быть подключение к `ws://127.0.0.1:3000/rooms/<id>/game/ws`, а не к `:191xx`.
4. В логах backend не должно быть `191xx` в ответах браузеру.

- [ ] **Step 5: Commit, если автофикс линта что-то изменил**

```bash
git add -A
git commit -m "chore(server): apply lint fixes"
```
