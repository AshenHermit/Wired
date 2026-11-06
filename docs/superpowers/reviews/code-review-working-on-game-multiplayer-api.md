# Code Review: `working-on-game-multiplayer-api`

- **Дата:** 2026-11-01
- **Ветка:** `working-on-game-multiplayer-api`
- **Диапазон:** `1be8de5..7933e5c` (merge-base с `origin/main` → HEAD ветки)
- **Объём:** 1051 файл, +42 798 / −110 618 строк
- **Ревью разбито на 4 независимых домена:** сервер `godot-game`, сервер `scripting-packages`, GDScript-рантайм, фронтенд + shared-типы.

## Объём изменений

Ветка (1051 файл, +42 798 / −110 618 строк) делает три крупные вещи: убирает Phaser, мигрирует на Godot 4.8-beta2, и строит Godot-only мультиплеер — NestJS-сервер спавнит нативный Godot-процесс на комнату, выдаёт одноразовые тикеты, раздаёт опубликованные скрипт-пакеты в рантайм через подписанные read-URL, а клиентский Godot Web-экспорт работает в iframe через bridge.

---

## Сильные стороны

- **Чистое разделение фасад/сессия** в `godot-game`: `RoomRuntimeService` — только порт/тикеты, вся машина состояний процесса — в `RoomRuntimeSession`; single-flight спавн корректен (`room-runtime.service.ts:154-200`).
- **Path traversal закрыт в два слоя** (`package-path.ts:28-91,117-130`) + regex `artifactKey` `/^[0-9a-f]{64}$/`; HMAC для read-URL через `timingSafeEqual` с привязкой к room/package/revision (`package-read-url.service.ts:35-74`).
- **Атомарная публикация ревизий** (staging + `rename` + verify + откат, `package-storage.service.ts:117-158`) и crash-safe сборка артефакта (`package-delivery.service.ts:799-881`).
- **Целостность загрузки пакетов в Godot**: сверка size+sha256 до записи на диск, атомарный swap с откатом, изоляция closure через `artifact_key` в имени директории (`packages_manager.gd:472-479,608-669,815-843`).
- **Защита от гонок во фронтенде**: сверка `attemptAtStart !== attempt` после каждого `await`, `sentAttemptRef`, `disposedRef` в `GameTab.tsx`; корреляция запрос/ответ по id в `editor-bridge.ts`.
- **Хорошее тестовое покрытие**: 809 строк тестов на delivery, 669 на room-runtime, 1100 на packages_manager.

---

## Критические проблемы

### 1. Обход авторизации на runtime-эндпоинтах пакетов

`scripting-packages.controller.ts:193-200` (`runtime-manifest`) и `:206-250` (`runtime-files`) **не имеют `@UseAuthGuard`**. `getRuntimeManifest` выдаёт подписанный `download.token`, а `runtimeFile` требует только этот токен. `assertValidRoom` (`package-delivery.service.ts:212-220`) проверяет лишь «комната с таким id существует» — ни принадлежность пакета комнате, ни доступность/приватность комнаты. Комментарий в коде (`:207-211`) прямо признаёт это.

**Почему это важно:** room-id и package-id — числовые первичные ключи (перечислимы). Анонимный вызывающий, зная два целых числа, получает подписанный токен и скачивает файлы пакета любой существующей комнаты. Эндпоинт интернет-доступен: фронт проксирует `/api/*`, а Godot-рантайм ходит напрямую на `base_url` бэкенда (`packages_manager.gd:929`).

**Нюанс, который стоит проговорить явно:** файлы *опубликованных* пакетов и так отдаются без auth через `getRevisionFile`/`getManifest` (`:147-186`) — похоже, это осознанная модель «публичного маркетплейса». Тогда утечка содержимого пакетов — не баг, а фича. Но два момента остаются проблемой: (а) room-scoped раздача не проверяет принадлежность пакета комнате, и (б) см. п. 2 — она же форсирует запись на диск без авторизации.

### 2. Неавторизованная запись на диск (amplification)

Каждый вызов `runtime-manifest` → `ensureArtifact` → `buildArtifact` (`package-delivery.service.ts:151-171,383-402`) при промахе пишет полный артефакт. Анонимный клиент может триггерить сборку+запись для произвольных `(packageId, revision, roomId)`, вызывая неограниченный рост `<PACKAGES_FILES_DIR>/<packageId>/runtime/v1/<roomId>/...`. Нет ни rate-limit, ни авторизации, ни проверки «этот пакет принадлежит этой комнате».

### 3. Осиротевшие Godot-процессы при жёсткой смерти Node

`node-runtime-process.factory.ts:22-32` спавнит execa без process-group и без kill-on-parent-death; единственная очистка — graceful-путь `onModuleDestroy → shutdownAll` (`room-runtime.service.ts:148-150`). SIGKILL / OOM-killer / `uncaughtException` → дочерние Godot висят вечно и держат порты из `GODOT_ROOM_PORT_START/END` (по умолчанию 100). Следующий старт бэкенда упирается в `No free port in range` (`:176-182`). Штатный `docker kill` / `kill -9` превращается в деградацию до полного отказа игрового функционала.

### 4. Нет `error`-обработчиков на stdio → падение всего Nest

`attachLines` вешает только `'data'` на stdout/stderr (`room-runtime.session.ts:293-309`), `sendCommand` пишет в stdin под `try/catch` (`:404-419`). Но `EPIPE`/«write after end» на `child.stdin` — **асинхронное** событие `'error'`, которое `try/catch` не ловит; между проверкой `state === 'running'` (`:406`) и `write` процесс мог выйти. Событие `'error'` без подписчика = `uncaughtException` и падение всего процесса. Лечится no-op `stream.on('error', log)`.

### 5. Hot-reload пакета не пересобирает живых игроков/сущности

После `package_applied` сервер в `_apply_registered_package` пересоздаёт только static-мир (`main_scene.gd:171-172`) и pending dynamic (`:175-176`), но **не трогает** компоненты уже заспавненных игроков и живые динамические сущности. `_rebuild_components` (`players_manager.gd:232-240`) достижим только из `apply_snapshot` (client-side). После обновления пакета мир смешанный: новый static + старые скрипты игроков/сущностей в памяти.

### 6. Late-join репарация идёт мимо `MultiplayerSpawner`

`apply_snapshot` добавляет узлы через `add_child` (`players_manager.gd:192`, `dynamic_world_container.gd:253`), а не через spawner. `MultiplayerSynchronizer` создаётся в `_ready`, но без спауна через spawner у узла нет net-ID в `SceneMultiplayer` — риск, что отремонтированный игрок/сущность получит только одноразовое состояние из снапшота и **не будет жить в репликации**. Сам код признаёт это («sync net IDs are discarded», `main_scene.gd:511-517`), а реальная двухклиентская проверка ещё не закрыта (`players_manager.gd:45`). Требует прогона двух клиентов с принудительно проваленным прелоадом.

### 7. `getEngine` с non-null assertion в `use-room-packages.ts:541`

`getEngine: () => engineRef.current!.editor` — если экземпляр редактора обнулён между `prepareReplace` и циклом `copyToFS` (рестарт движка по `onExit`), бросается сырой `TypeError`, не пойманный как `EditorBridgeError`/`GodotFsError`. Проверка `if (!engine)` в `replaceContents` (`godot-packages-fs.ts:240-245`) бесполезна — `getEngine()` уже упал до неё. Staging-запись может остаться наполовину записанной.

### 8. `replaceCanvas` мутирует DOM под React (`GodotEditorInstance.tsx:146-176`)

`onExit` делает `from.parentNode?.replaceChild(out, from)`, заменяя canvas, которым владеет React. После этого `canvasRef.current` указывает на оторванный узел, а React при следующем рендере пересоздаст свой canvas — движок продолжит рисовать в старый («пустой» canvas при рестарте редактора). Наследуется из официального шаблона, но требует минимум явной документации и проверки повторного `setCanvas`.

---

## Важные проблемы

- **N+1 в БД × 100 мс поллинг.** `getStatuses`/`reconcileRoom` делают `packages.find` + по одному `revisions.findOne` на пакет (`package-sync.service.ts:128-155,161-198`), а `waitForInitialPackages` поллит каждые 100 мс до 10 с (`game-room.service.ts:136-165`) → ~600 запросов на вход в комнату с 5 пакетами. Нужен один запрос с `IN`/`GROUP BY` или кэш последнего revision.
- **`peers`-сет не сбрасывается при рестарте runtime** (`package-sync.service.ts:70`) → `aggregateState` требует `ready` от мёртвых peers, статус пакета застревает на `applied`.
- **`sessions`/`activeByRoom` никогда не чистятся** (`room-runtime.service.ts`, `room-runtime.registry.ts:7,20`); `registry.get/list` вообще не вызываются — мёртвая коллекция. После выхода runtime статус остаётся `stopped` навсегда вместо `idle`.
- **Двойной mint тикета** на одно соединение (`game-room.service.ts:86-90`): `getConnection` минтит №1, `refreshConnection` — №2, первый выбрасывается (и побочно может запустить `stop('handshake_window_expired')`).
- **Орфан даже в штатном flow**: если graceful+force-kill не уложились, `performStop` ставит `failed`, процесс жив и держит порт (`room-runtime.session.ts:650-659`), а `shutdownAll` фильтрует только `isActive()`.
- **Удаление пакета оставляет осиротевшие каталоги** (`scripting-packages.service.ts:165-171`): чистится только строка БД, ревизии каскадно уходят, но `revisions/<n>` и `runtime/v1/...` остаются на диске; `discardPublished` — мёртвый код.
- **Отсоединение/удаление комнаты не чистит `runtime/v1/<roomId>`** — `pruneArtifacts` трогает только конкретную собираемую ревизию (`package-delivery.service.ts:713-727,735-786`), retention в 3 не срабатывает.
- **TOCTOU** между `resolveRuntimeFile` (stat) и `createReadStream` (`controller.ts:231-242`): prune может удалить каталог в промежутке.
- **Недетерминизм артефакта корня**: зависимости берутся по «latest published» на момент сборки (`package-delivery.service.ts:590-606`), т.е. один `(packageId, revision)` может собраться в разный `artifactKey` — противоречит заявленной «immutable revisions».
- **Память**: `resolveClosure` держит байты всего closure в памяти (`:428-475`); `loadLatestPublishedRevisions` читает `files` (jsonb) всех ревизий на каждую публикацию; `buildReverseReferenceGraph` парсит каждый текстовый файл — O(все ревизии × файлы) на publish.
- **`publishing`-guard процесс-локальный** (`package-revisions.service.ts:41`) — не защищает от двух инстансов.
- **Утечки ссылок на клиенте Godot**: `_spawned`/`_entities` чистятся только в server-only ветках (`players_manager.gd:269`, `dynamic_world_container.gd:132`); `_used_nonces` не чистится (`network.gd:63,222`).
- **Lock не освобождается при ошибке** в `_sync_package` (`packages_manager.gd:371`): engine-ошибка обрывает корутину без cleanup, пакет блокируется до `APPLY_LOCK_TIMEOUT_MS`.
- **`use-room-packages.ts` (900 строк) — двойная бухгалтерия**: `packagesRef.current` мутируется до проверки `request !== requestRef.current` (`:392,426`); хрупко.
- **`waitForEditorBridge` не отменяется на unmount** (`editor-bridge.ts:163-183`): 120-секундная цепочка `setTimeout` тикает после размонтирования.
- **`GameTab.tsx` нет детекта «мёртвого» iframe**: полл обновляет только `players`; если движок в iframe упал молча, хост навсегда в `ready`. Нет heartbeat.

---

## Мелкие замечания

- Мёртвый код: `room_starting` (объявлен, не выбрасывается), `forceKilled`/`exitSignal` (пишутся, не читаются), `discardPublished`, `publishedRevisionExists`, 6 неиспользуемых экспортов в `scripting-packages.ts`.
- Дублирование: `safeName` в двух местах (`room-runtime.configuration.ts:176`, `room-runtime.log.ts:72`); `_as_vector2/3` в трёх файлах; паттерн «createRecord + set + dispatch» в `package-sync.service.ts` (три места); три `handleDownload/Remove/Emit` с одинаковым «confirm → retry force» в `PackagesTab.tsx`.
- `Number.isInteger(Number(roomId))` в `getStatuses`/`reconcileRoom` — всегда истинна (id приходит из числового PK).
- Комментарий `AUTH_TIMEOUT_SEC = 5` против текста «10s auth timeout» (`room-runtime.session.ts:16-17,207-210`).
- Лексикографическая сортировка `package_id` как строк (`package_registry.gd:112-113`) против docstring «ascending»; `queue.shift()` O(n²) (`package-runtime-references.ts:251`).
- Rate limiter в памяти (`game-room.rate-limiter.ts:19,38`) валиден только для одного инстанса.
- `decodeBase64` через `atob` — строковый двойник для больших бинарников.

---

## Ответы на вопросы

### Что можно сократить / удалить

- **`PackageReloader` (312 строк) фактически мёртв в боевом потоке**: все корни помечаются `_wired_registered` и `_collect_roots_under` их пропускает целиком (`package_reloader.gd:160-164`); пересекается с `StaticWorldContainer.rebuild()`. Интегрировать в контейнеры или удалить.
- **Мёртвые символы**: `room_starting`, `forceKilled`, `exitSignal`, `discardPublished`, `publishedRevisionExists`, `RoomRuntimeRegistry.get/list`, 6 экспортов `scripting-packages.ts`, `clearPersistence`/`focus`/`lastScale` в `GodotEditorInstance.tsx`.
- **Двойной mint тикета** (`game-room.service.ts:86-90`) — сократить до «ensure + wait + mint один раз».
- **`_sync_order`** (`packages_manager.gd:83,470`) — тестовый seam в горячем пути; убрать за флаг/DI.

### Что вынести в отдельные скрипты/классы/компоненты

- **`PackageSyncService` (607 строк)** → `SyncRecordStore` (мапы `records`/`peers`), `DispatchScheduler` (retry), `StatusReporter` (агрегация).
- **`package-delivery.service.ts` (903 строки)** → вынести `PackageClosureResolver` (~250 строк замыкание/граф/ключи `:422-588`, включая `computeArtifactKeys` и DFS) — самая хрупкая часть.
- **`packages_manager.gd` (1067 строк, 5 ответственностей)** → минимум три извлечения: `PackageManifest` (парсинг/валидация), `AssetDeriver` (`_derive_*`/`_build_asset_derivations`), `ArtifactStore` (`_stage_files`/`_swap_revision`/`_prune_revisions`/`_remove_tree`).
- **`use-room-packages.ts` (900 строк)** → `use-editor-bridge.ts` (транспорт/reconnect), reducer для `entries`/`actions` вместо прямых мутаций ref, сервисный слой для действий.
- **Сетевой протокол** в GDScript stringly-typed `Dictionary`-контракт (`"player_id"`, `"spawn_data"`, `"local_only"`…) размазан по 5 файлам — собрать в общие константы/типы; метаданные `_wired_package_id`/`_wired_registered`/`_wired_source_entity_id` — в константы.
- **Унифицировать путь к бэкенду** во фронтенде: `/api` зашит строкой в `godot-game.ts:13`, axios ходит напрямую — вынести `API_PREFIX`/переписывание `baseUrl` в одно место (`variables.ts`).

### Что излишне сложно

- `_spawn_record` (`dynamic_world_container.gd:407-439`) — слияние двух форм payload (плоской и explicit) в одном методе с erase/re-add; развести два конструктора.
- `package_reloader._capture_state/_copy_value_only/_is_value_only` (`:222-278`) — глубокая рефлексия по свойствам при сомнительной ценности (см. пункт про мёртвый reloader).
- Каскад `OnEditorExit → Execute` с переприсваиванием `this.OnEditorExit = null` внутри стрелки (`GodotEditorInstance.tsx:189-217`) — рабочий, но запутанный.
- `GameTab.tsx` фазовую машину (8 фаз + 4 зеркальных ref) — кандидат на `useReducer`.

### Что будет трудно поддерживать

- **`packages_manager.gd` / `package-delivery.service.ts` / `use-room-packages.ts` / `package-sync.service.ts`** — четыре «god-файла» по 600–1100 строк, каждый смешивает 4–5 ролей. Это главный источник будущих регрессий.
- **Несброшенные коллекции** (`peers`, `sessions`, `activeByRoom`, `_spawned`, `_used_nonces`) — со временем дают трудно диагностируемые «статус застрял / память растёт».
- **Недетерминизм артефактов** (latest-dependency семантика) — будущий разработчик будет считать ревизии воспроизводимыми, а это не так.
- **Двойная бухгалтерия состояния** (`packagesRef` + `setPackages`) в хуке пакетов.

### Слабые места архитектуры

1. **Авторизация не является сквозной**: большая часть контроллеров под guard'ом, но runtime-путь раздачи контента — нет. Модель доступа к приватным комнатам в runtime-эндпоинтах отсутствует.
2. **Управление жизненным циклом процессов** рассчитано только на graceful-сценарий; нет защиты от `kill -9` (supervisor/restart-policy/process-group).
3. **Горизонтальное масштабирование не заложено**: rate-limiter, `publishing`-guard, in-memory кэши — всё процесс-локальное.
4. **Retention/GC артефактов частичный**: чистится только «новейшие 3» в узком prune-окне; удаление пакета/комнаты не чистит диск.
5. **Протокол рантайма stringly-typed** на стыке сервер↔Godot — без общих контрактов легко рассинхронизировать.

### Потенциальные баги (что реально «выстрелит»)

- Исчерпание диапазона портов после `kill -9` → отказ игрового функционала.
- Падение всего Nest-процесса из-за unhandled `error` на stdio при записи в мёртвый stdin.
- «Мир смешался» после hot-reload пакета с живыми игроками.
- Игрок/сущность после late-join не реплицируется (одноразовый снапшот, без синхронизации).
- Staging/артефактные каталоги растут бесконечно (удаление пакета, смена комнаты, crash между `mkdir` и `rename`).
- Застревание статуса пакета на `applied` после рестарта runtime (несброшенные `peers`).
- Пустой canvas / падение записи при рестарте редактора во фронтенде.

---

## Вердикт

**С правками — merge без исправления критических пунктов не рекомендуется.**

Реальными блокерами перед merge считаю:

- **П.1–2** (auth-bypass + неавторизованная запись на диск на runtime-эндпоинтах) — напрямую меняют модель доступа;
- **П.3–4** (осиротевшие процессы → исчерпание портов; unhandled `error` → падение сервера) — источники недоступности;
- **П.6** (late-join мимо `MultiplayerSpawner`) — требует доказательного закрытия двухклиентским прогоном, иначе споун/деспаун нельзя считать корректным.

П.5 (hot-reload живых игроков), П.7–8 (frontend non-null / replaceCanvas) — «важно, но не блокеры MVP», как и вся группа жизненного цикла (чистка `sessions`/`peers`/каталогов, N+1, двойной mint). Архитектурная база при этом крепкая: целостность загрузки, path-валидация, HMAC, атомарная публикация и защита от гонок сделаны на высоком уровне.
