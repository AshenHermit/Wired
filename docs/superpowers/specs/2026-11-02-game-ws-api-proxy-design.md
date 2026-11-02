# WebSocket через API-роут вместо локального порта

Дата: 2026-11-02
Статус: реализовано

## Зачем

Сейчас браузер получает от `POST /rooms/:id/game/connection` адрес
`ws://127.0.0.1:<port>`, где `<port>` — порт из диапазона
`GODOT_ROOM_PORT_START..GODOT_ROOM_PORT_END` (по умолчанию 19100–19199),
на котором слушает native-рантайм Godot комнаты. Это работает только когда
браузер и бэкенд на одной машине.

При деплое в Docker/облако наружу должен торчать один порт API. Открывать
диапазон 19100–19199 и маршрутизировать upgrade на конкретный порт комнаты
нельзя: порт выделяется динамически, а nginx не умеет строить upstream по
пути без Lua/OpenResty.

Решение: NestJS принимает WebSocket-upgrade на `wss://api.<домен>/rooms/<id>/game/ws`
и проксирует его на локальный `ws://127.0.0.1:<port>` этой комнаты. Наружу
порты не выходят, nginx уже умеет проксировать upgrade на vhost `api.*`.

## Цели

- Браузер подключается к игре по обычному публичному адресу API, без портов.
- Диапазон портов рантаймов остаётся внутренним (`127.0.0.1`), в Docker не
  публикуется.
- Тикет-модель не меняется: тикет по-прежнему передаётся первым RPC
  `cli_hello`, а не в URL; проверяет его Godot.
- Дефолтная локальная разработка тоже идёт через прокси, чтобы этот путь
  тестировался без отдельной настройки.
- `GODOT_ROOM_PUBLIC_WS_BASE` остаётся явным override для нестандартных
  доменов/префиксов и обязателен в production.

## Не цели

- Не меняем Godot-проект, протокол `cli_hello`, формат тикета и
  `GameTicketService`.
- Не делаем единый мультиплексирующий WS-сервер Godot на все комнаты.
- Не чиним остальные пробелы Docker-деплоя (наличие runtime-бинарника,
  export-шаблонов, `game_export/web`, Node 22 в образе). Прокси решает только
  транспорт.
- Не добавляем авторизацию на сам upgrade: аутентификация остаётся в
  `cli_hello` (single-use ticket, 5 с на handshake).

## Ограничения

- `WebSocketMultiplayerPeer` в браузере не умеет custom headers, поэтому
  `Authorization` на upgrade недоступен. Тикет в URL запрещён текущей
  моделью (URL попадает в логи/историю).
- Godot принимает TCP/WS-соединение до проверки тикета и закрывает его через
  `AUTH_TIMEOUT_SEC = 5`, если `cli_hello` не пришёл.
- `GODOT_ROOM_BIND` по умолчанию `127.0.0.1`; прокси ходит в рантайм внутри
  того же контейнера.
- Экспорт запускается в same-origin iframe; WS не подпадает под COEP, но
  страница должна оставаться `crossOriginIsolated` — это уже обеспечено.
- `GODOT_ROOM_PUBLIC_WS_BASE` в production обязателен (существующая проверка
  в `RoomRuntimeConfiguration.validate`).

## Рассмотренные подходы

1. **WS-прокси в Nest (`ws`, `noServer`)** — выбран. Полный контроль над
   жизненным циклом соединения, лимитами, close-кодами и тестами. Тикет не
   трогаем. Одна новая зависимость `ws`.
2. **`http-proxy` на upgrade** — меньше кода, но «тупой» туннель: сложнее
   ограничивать соединения на комнату, аккуратно закрывать обе стороны и
   тестировать.
3. **Единый WS-сервер Godot на все комнаты** — убирает порты, но требует
   переделки рантайма, реестра и протокола. Вне рамок задачи.

## Как это работает

### Публичный адрес

`RoomRuntimeConfiguration.buildEndpoint(config, roomId, port)`:

- если задан `GODOT_ROOM_PUBLIC_WS_BASE` — подставить `{room}` (и `{port}`,
  если шаблон ещё портовый, для обратной совместимости);
- иначе вывести адрес из `config.apiUrl`: `http` → `ws`, `https` → `wss`,
  обрезать хвостовой `/` и добавить `/rooms/<roomId>/game/ws`.

Вывод из `apiUrl` — это **локальный дефолт для разработки**, а не общий
fallback для деплоя. `GODOT_ROOM_API_URL` по контракту — адрес бэкенда,
видимый локальному рантайму Godot (loopback). В production адрес обязан
задаваться через `GODOT_ROOM_PUBLIC_WS_BASE`; `backend.Dockerfile` уже
выставляет `NODE_ENV=production`, поэтому compose-деплой без переменной
падает с явной ошибкой конфигурации, а не отдаёт браузеру loopback. Если
кто-то запускает `start:prod` без `NODE_ENV`, это остаётся операторской
ошибкой — в `AGENTS.md` фиксируем требование.

Примеры:

- dev, `GODOT_ROOM_API_URL` по умолчанию `http://127.0.0.1:3000` →
  `ws://127.0.0.1:3000/rooms/42/game/ws`;
- prod, `GODOT_ROOM_PUBLIC_WS_BASE=wss://api.example.com/rooms/{room}/game/ws`
  → `wss://api.example.com/rooms/42/game/ws`.

Валидация:

- production требует `GODOT_ROOM_PUBLIC_WS_BASE`;
- шаблон без `{room}` и без `{port}` — ошибка конфигурации (все комнаты
  получили бы один адрес);
- в production шаблон обязан содержать `{room}`: `{port}`-only снова отдаёт
  браузеру внутренний порт, то есть ровно то, что прокси должен убрать.
  `{port}`-only остаётся допустимым только вне production как ручной
  escape hatch;
- в production шаблон обязан начинаться с `wss://` (TLS терминируется
  nginx), вне production допускается `ws://`.

`GameRoomConnection.endpoint` остаётся строкой; frontend, `shell.html` и
Godot не меняются. Shell уже принимает `wss?://`.

### Маршрут

`GET` + `Upgrade` на `/rooms/<id>/game/ws`, где `<id>` — числовой id комнаты
(как в `@Controller('rooms/:roomId/game')`). Query-строка игнорируется.
Путь с префиксом `/api` не используется: публичный адрес — это vhost `api.*`,
где Nest слушает в корне.

Несовпавшие upgrade-запросы уничтожаются (`socket.destroy()`), потому что
других WS-маршрутов в приложении нет. Любой будущий WS-маршрут должен
регистрироваться через тот же сервис.

### Сервис `GameSocketProxyService`

Файл `packages/server/src/godot-game/game-socket-proxy.service.ts`.

Реализует `OnApplicationBootstrap` и `OnModuleDestroy`:

- в `onApplicationBootstrap` берёт `HttpAdapterHost.httpAdapter.getHttpServer()`
  и вешает единственный обработчик `upgrade`;
- в `onModuleDestroy` снимает обработчик и закрывает все проксируемые пары
  кодом `1001`.

Обработка upgrade:

1. Разобрать URL, проверить метод `GET` и регулярку пути.
2. Взять `RoomRuntimeService.getRuntime(roomId)`; требовать
   `state === 'running'` и `port`. Рантайм не запускается из прокси: клиент
   уже вызвал `POST /connection`, а если комната успела остановиться по
   idle — соединение закрывается, клиент запрашивает тикет заново.
3. Проверить лимиты: активные прокси-соединения на комнату
   (`GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM`, по умолчанию 32) и всего
   (`GODOT_ROOM_WS_MAX_TOTAL`, по умолчанию 512). При превышении — ответ
   `503` и закрытие сокета.
4. Принять upgrade через `WebSocketServer({ noServer: true, maxPayload: 8 MiB })`.
5. Открыть исходящий `WebSocket` на `ws://<bind|127.0.0.1>:<port>`.
6. Перекладывать сообщения в обе стороны без изменений, сохраняя
   `binary`-флаг. Пока upstream не открыт, входящие сообщения буферизуются
   (короткий массив), затем отправляются.
7. Пробрасывать close в обе стороны; коды `1005`/`1006` нормализуются
   (`1000` для штатного закрытия, `1011` для ошибки upstream). Ошибка
   upstream закрывает клиента кодом `1011`.
8. Хранить пары в `Map<roomId, Set<...>>` для лимитов и корректного
   shutdown.

`maxPayload` — 8 MiB: Godot ставит `NETWORK_BUFFER_SIZE = 4 MiB` на
inbound/outbound, плюс запас на протокол.

### Ошибки и наблюдаемость

- Логировать `warn` только на отказы (нет рантайма, лимит, ошибка upstream),
  без тикета и содержимого сообщений.
- На upgrade-отказы до принятия соединения писать минимальный HTTP-ответ
  (`400`, `404`, `503`) и уничтожать сокет.
- Метрик и отдельного health-эндпоинта не добавляем.

### Безопасность

- Upgrade-маршрут не аутентифицирован, но бесполезен без single-use тикета:
  Godot отклоняет `cli_hello` с неверной подписью/nonce и закрывает
  неаутентифицированное соединение через 5 с.
- `Origin` в v1 не проверяем: тикет уже защищает от cross-site hijacking.
  Проверка `Origin` против `SITE_HOST` — возможное продолжение, но требует
  отдельного решения по доменам (frontend и api на разных хостах).
- Внутренние порты, pid и секреты в ответах и логах не появляются.

### Абуз upgrade-маршрута

Маршрут не аутентифицирован, а капы 32/512 считают и анонимные соединения,
которые Godot закроет только через 5 с. Цикл ~7 conn/s может на 5 секунд
занять все слоты комнаты. Решено оставить только общие капы и принять этот
риск: per-IP учёт, `trust proxy` и `limit_conn` в nginx в эту итерацию не
входят. Вернуться к вопросу, если появятся жалобы на недоступность комнат.

## Правки по файлам

- `packages/server/package.json` — добавить `ws`, dev-зависимость `@types/ws`.
- `packages/server/src/godot-game/game-socket-proxy.service.ts` — новый сервис.
- `packages/server/src/godot-game/godot-game.module.ts` — зарегистрировать
  провайдер.
- `packages/server/src/config/config.ts` — `wsMaxClientsPerRoom`,
  `wsMaxTotal` (env с дефолтами).
- `packages/server/src/godot-game/room-runtime.types.ts` — обновить комментарий
  к `publicWsBaseUrl`.
- `packages/server/src/godot-game/room-runtime.configuration.ts` —
  `buildEndpoint` (вывод из `apiUrl`), валидация шаблона.
- `docker-compose.yml` — прокинуть в backend `WIRED_GAME_TICKET_SECRET`
  (новый ключ в корневом `.env`, секрет нельзя вывести) и вычислить
  `GODOT_ROOM_PUBLIC_WS_BASE` из `COMMON_DOMAIN`:
  `wss://api.${COMMON_DOMAIN}/rooms/{room}/game/ws`. Это совпадает с
  `config.site.apiDomain` и vhost `api.*` в nginx; отдельный операторский
  ключ не нужен. Для нестандартного адреса строку в compose меняют вручную.
- `AGENTS.md` — описать прокси и новые env.
- `docs/superpowers/specs/2026-11-02-game-ws-api-proxy-design.md` — этот файл.

Nginx менять не нужно: vhost `api.*` уже прокидывает `Upgrade`/`Connection`
и держит `proxy_read_timeout 86400s`.

## Тесты

- `game-socket-proxy.service.spec.ts`: реальный `http.Server` + fake
  `RoomRuntimeService` + реальный upstream `WebSocketServer` на эфемерном
  порту. Проверить: text/binary эхо, проброс close, 404 для неизвестного
  пути, 503 когда рантайм не `running`, лимит на комнату, отказ upstream.
- `room-runtime.configuration.spec.ts`: вывод адреса из `http`/`https`
  `apiUrl`, шаблон с `{room}`, обратная совместимость с `{port}`, ошибка на
  шаблон без плейсхолдеров, production-требование.
- Обновить ожидания в `room-runtime.service.spec.ts` / `game-room.*.spec.ts`,
  если они фиксируют старый `ws://127.0.0.1:<port>`.
- Ручная проверка: `pnpm dev:server` + frontend, Game tab подключается по
  `ws://127.0.0.1:3000/rooms/<id>/game/ws`; в логах нет порта наружу.

## Что решает builder

- Точная форма буфера до открытия upstream (массив сообщений достаточно).
- Нужен ли отдельный env для `maxPayload` (по умолчанию — нет).
- Формат HTTP-ответа на отказ до upgrade (достаточно статусной строки).
- Добавлять ли `Origin`-проверку сейчас (по дизайну — нет).
- Конкретные значения дефолтов `GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM` (32) и
  `GODOT_ROOM_WS_MAX_TOTAL` (512), если нагрузка покажет другие.
