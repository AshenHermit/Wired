# Этап 1. Проверка Godot runtime и игрового протокола — результаты

Дата: 2026-10-28. Ветка: `working-on-godot-rooms`.
Статус: критерий готовности выполнен.

## Итог

Локальный headless-процесс Godot принимает игровой Web-клиент через
`WebSocketMultiplayerPeer` на выделенном порту, завершает прикладное
подтверждение (одноразовый билет) и отправляет клиенту игровые события,
подтверждаемые сервером (`WIRED_EVENT_ACK`). Проверено и нативным
Godot-клиентом, и собранным Web-экспортом в браузере Chrome.

## Окружение

- Godot `4.5.1.stable.custom_build.f62fdbde1` (Windows x86_64).
- Исполняемый файл: `C:\Users\hermit\gamedev\godot-wired\godot\bin\godot.windows.editor.dev.x86_64.exe`.
  Для перехвата stdout нужен вариант `...console.exe`: обычный exe
  отвязывается от консоли, и логи процесса не читаются из pipe.
- Проект: `packages/server/godot_project/_wired` (корень Godot-проекта),
  игровое содержимое — во вложенном `_wired/`.

## Точные аргументы запуска

Сервер комнаты:

```
godot.windows.editor.dev.x86_64.console.exe \
  --headless --path packages/server/godot_project/_wired \
  --server --port 19110 --room web-demo --bind 127.0.0.1
```

Переменная окружения `WIRED_GAME_TICKET_SECRET` обязательна.

Клиент (нативная проверка):

```
godot.windows.editor.dev.x86_64.console.exe \
  --headless --path packages/server/godot_project/_wired \
  --url ws://127.0.0.1:19110 --ticket <ticket> --room web-demo
```

Web-клиент получает те же значения из query string:
`index.html?ws=ws://127.0.0.1:19110&ticket=<ticket>&room=web-demo`.

Важные ограничения запуска:

- Прикладные аргументы нельзя отделять `--`: после `--` они не попадают в
  `OS.get_cmdline_args()`. Godot молча игнорирует незнакомые аргументы,
  поэтому `--server --port ...` без разделителя безопасно.
- Перед первым запуском проект нужно импортировать:
  `godot --headless --path . --import`, иначе main scene UID не разрешается
  (`Unrecognized UID`). Каталог `.godot/` в git не попадает.
- Готовность сервера определяется по строке
  `WIRED_SERVER_READY room=... port=... bind=...` в stdout.
- Коды завершения: `0` — штатный выход; `2` — не задан
  `WIRED_GAME_TICKET_SECRET`; `3` — не удалось занять порт.
- На Windows процесс нужно запускать именно через `pnpm`/из каталога
  `packages/server`, если используются относительные пути проекта.

## Формат адреса

- Локально: `ws://127.0.0.1:<port>`; сервер по умолчанию слушает
  `127.0.0.1`, поэтому снаружи машины порт недоступен.
- Порт выделяется на комнату (диапазон `GODOT_ROOM_PORT_START`–
  `GODOT_ROOM_PORT_END`, по умолчанию 19100–19199), проверяется пробным
  `listen` и передаётся процессу аргументом `--port`.
- Браузеру на локальном этапе отдаётся тот же `ws://127.0.0.1:<port>`.
  В production клиент не должен получать внутренний порт процесса: он
  получает публичный `wss://<host>/<путь комнаты>`, а reverse proxy
  маршрутизирует upgrade на внутренний порт.

## Прикладной handshake

WebSocket-соединение само по себе не допускает клиента в игру.

1. После `connected_to_server` клиент отправляет `cli_hello` с
   `{protocol, ticket, room, name}`.
2. Сервер проверяет версию протокола (`PROTOCOL_VERSION = 1`), комнату и
   билет; до этого peer находится в `_pending` и не имеет `player_id`.
3. Билет: `<exp_unix>.<nonce_hex>.<hmac_sha256_hex>`, HMAC считается по
   строке `<room>:<exp>:<nonce>`, ключ — `WIRED_GAME_TICKET_SECRET`.
   Проверяются срок действия, длина nonce и подпись (constant-time).
4. Nonce одноразовый: повторное использование даёт `ticket_reused`.
   Один билет — одно подключение; при reconnect/reload нужен новый билет.
5. Неподтверждённый peer отключается через `AUTH_TIMEOUT_SEC = 10`.
6. До подтверждения любые игровые RPC (`cli_ready`, `cli_game_action`,
   `cli_ack_event`) отклоняются: `WIRED_RPC_DENIED`, игрок не создаётся.
7. После `srv_auth_ok` сервер назначает `player_id`, отправляет
   `world_state` и `player_joined`; клиент подтверждает каждое событие с
   `seq` через `cli_ack_event` (`WIRED_EVENT_ACK`).
8. При отказе сервер отправляет `srv_auth_error(reason)` и принудительно
   закрывает соединение. Клиент сохраняет причину и показывает
   `Authentication failed: <reason>`, а не общее «Disconnected».

Причины отказа: `malformed`, `expired`, `bad_nonce`, `hmac_init_failed`,
`bad_signature`, `ticket_reused`, `auth_timeout`, `wrong_room`,
`bad_protocol`.

Транспорт билета в прототипе — query string. Это только для локальной
проверки: в production билет должен выдаваться backend по authenticated
HTTP и передаваться в игру без попадания в URL/историю браузера.

## Результаты проверок

Нативный прогон `node scripts/godot-multiplayer-probe.mjs` — 21/21:

- запуск headless-сервера, строка готовности, штатный выход;
- два клиента получают разные `player_id` (1 и 2);
- широковещательный `player_joined` доходит до уже подключённого клиента;
- повторные и параллельные запросы одной комнаты переиспользуют один
  процесс и один порт, дубликаты не запускаются;
- отказ по повторному (`ticket_reused`), просроченному (`expired`) и
  поддельному (`bad_signature`) билету;
- игровое действие до подтверждения отклонено, игрок не создан;
- отключение клиента → `WIRED_PLAYER_LEFT` и событие остальным;
- отключение сервера → `WIRED_CLIENT_SERVER_DISCONNECTED`;
- перезапуск на том же зарезервированном порту;
- коды завершения 2 (нет секрета) и 3 (порт занят).

Браузерный прогон (Web-экспорт, Chrome):

- страница отдаётся с COOP `same-origin` / COEP `require-corp`,
  `crossOriginIsolated === true`, потоки WASM работают;
- клиент 1: `Authenticated as player 1`, события `world_state`,
  `player_joined`, `player_ready`, сервер подтвердил `seq=1..3`;
- клиент 2: `Authenticated as player 2`, видит уже подключённого игрока 1,
  клиент 1 получает `player_joined`/`player_ready` для игрока 2;
- закрытие вкладки → `WIRED_PLAYER_LEFT`, остальные получают событие;
- reload с тем же билетом → `Authentication failed: ticket_reused`;
- reload с новым билетом → `Authenticated as player 3`.

## Web-экспорт

- Пресет `Web` в `export_presets.cfg`: `export_filter="all_resources"`,
  `exclude_filter="build/*, .godot/*"`, `variant/thread_support=true`,
  `progressive_web_app/ensure_cross_origin_isolation_headers=true`,
  `export_path="build/web/index.html"`.
- Команда:
  `godot --headless --path . --export-release "Web" "build/web/index.html"`.
  Каталог назначения должен существовать заранее.
- Размер сборки: `index.wasm` ~37 МБ, `index.js` ~350 КБ,
  `index.pck` ~26 КБ. `build/` в git не попадает.
- Для кастомной сборки Godot шаблоны ищутся в
  `%APPDATA%\Godot\export_templates\4.5.1.stable` (без суффикса
  `custom_build`); официальные шаблоны `4.5.stable` нужно скопировать в
  этот каталог. Это локальная настройка машины, не часть репозитория.
- Для потоков нужны COOP/COEP на странице игры. Локальный статический
  сервер `scripts/serve-godot-web.mjs` выставляет COOP `same-origin`,
  COEP `require-corp`, CORP `same-origin`, правильные MIME для
  `.wasm`/`.pck` и `Cache-Control: no-store`.
- Текущий `Cross-Origin-Resource-Policy: same-origin` подходит для
  прямой навигации. Если игра будет встраиваться iframe с другого origin,
  понадобится CORP `cross-origin` (или отдача игры с того же origin через
  rewrite).
- WebSocket не подпадает под COEP; ограничение касается только загрузки
  самой страницы/потоков.

## Ограничения Godot 4.5.1

- `HMACContext.start(HashingContext.HASH_SHA256, key)` — сначала тип хэша,
  затем ключ; метода `create()` нет.
- `--` перед прикладными аргументами скрывает их от
  `OS.get_cmdline_args()`.
- Проект требует импорта до запуска (UID сцен).
- Web-экспорт с потоками требует COOP/COEP и корректных MIME; без этого
  движок не стартует.
- Произвольный WebSocket-клиент (не Godot) не может говорить по
  RPC-протоколу Godot; проверки протокола выполняются Godot-клиентами.

## Production-направление (не реализовано на этом этапе)

- Страница по HTTPS подключается к `wss://<host>/<путь комнаты>`.
- Reverse proxy терминирует TLS и маршрутизирует WebSocket upgrade по
  комнате на внутренний `127.0.0.1:<port>` процесса.
- Клиент не знает внутренний порт и не обращается к нему напрямую.
- Билет выдаёт backend после проверки пользователя и членства в комнате;
  TTL короткий, nonce одноразовый.
- При выходе последнего подтверждённого игрока запускается таймер простоя
  процесса; при новом подключении таймер сбрасывается.
- На proxy/origin уровне нужны проверка `Origin` при upgrade и лимиты
  частоты попыток подключения.

## Продолжение после Этапа 1

Этап 2 реализовал в backend in-memory реестр Godot runtime, single-flight
запуск процесса на комнату, назначение порта, выдачу одноразового ticket
внутри сервиса, отслеживание авторизованных peers, таймер простоя и штатное
завершение с сохранением состояния. Результаты unit-тестов и текущие детали
описаны в плане `docs/superpowers/plans/2026-10-28-godot-multiplayer-foundation.md`.

Остаётся для этапа интеграции Game (этап 3):

- Публичный HTTP endpoint для получения подключения поверх
  `RoomRuntimeService` ещё нужно добавить; сам сервис пока не является
  доступным браузеру API.
- Endpoint должен аутентифицировать пользователя, проверить комнату/тип и
  правило доступа, затем возвращать только runtime endpoint и краткоживущий
  ticket. Секрет подписи и внутренние сведения процесса клиенту не выдаются.
- Браузерный Web export пока принимает `ws`, `ticket` и `room` через query
  string. Для интеграции следует перенести ticket в прикладной handshake
  через проверенный frontend↔Godot bridge, не помещая его в URL/history.
- Web export нужно включить в локальный и deploy frontend workflow с
  корректными MIME, COOP/COEP и same-origin URL; `build/web` — генерируемый,
  неотслеживаемый артефакт.
- Origin checks и rate limits для внешнего reverse proxy остаются задачей
  production-инфраструктуры; они не заменяются проверкой ticket в Godot.

## Артефакты

- `packages/server/godot_project/_wired/_wired/scripts/network/network.gd` —
  транспорт, handshake, RPC, проверки допуска.
- `packages/server/godot_project/_wired/_wired/scripts/network/ticket.gd` —
  проверка HMAC-билета.
- `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd` —
  разбор аргументов/query string, запуск сервера или клиента.
- `packages/server/godot_project/_wired/_wired/scenes/main.tscn` — сцена с
  `Main/Net` и UI.
- `packages/server/godot_project/_wired/export_presets.cfg` — пресет Web.
- `packages/server/scripts/godot-multiplayer-probe.mjs` — нативные проверки
  (`pnpm --filter server probe:multiplayer`, нужен `GODOT_RUNTIME_PATH`).
- `packages/server/scripts/serve-godot-web.mjs` — статическая раздача
  Web-сборки с COOP/COEP.
