# План рефакторинга и исправлений: `working-on-game-multiplayer-api`

> **For agentic workers:** REQUIRED SUB-SKILL: используйте superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации ветка-за-веткой. Шаги используют синтаксис чекбоксов (`- [ ]`).

**Goal:** Исправить критические/важные дефекты и разложить «god-файлы» из ревью, не меняя поведение продукта, так, чтобы работу можно было вести шестью параллельными субагентами в отдельных ветках.

**Architecture:** Ревью (`code-review-working-on-game-multiplayer-api.md`) разбито на 6 независимых тематических веток с **непересекающимися наборами файлов**. Каждая ветка — один субагент, работающий в собственном git worktree. Пересечений по файлам нет, поэтому ветки сливаются в любом порядке; есть только рекомендация по порядку интеграции (безопасность первой).

**Tech Stack:** NestJS 11 + TypeORM/Postgres (сервер), Godot 4.8-beta2 GDScript (рантайм), Next.js 16 / React 19 (фронтенд), Jest (сервер), Vitest (фронтенд).

**Spec:** `docs/superpowers/reviews/code-review-working-on-game-multiplayer-api.md` — план аргументирует от этого документа; исполнитель читает оба.

## Global Constraints

- **Язык ревью и копирайтов — русский**; соответствуй языку и UTF-8 редактируемого файла.
- **Conventional Commits** (`feat:`, `fix:`, `refactor(server):`, `chore:`).
- **TDD**: сначала падающий тест, потом минимальный код, потом зелёный прогон, потом коммит. Каждая задача заканчивается независимо проверяемым результатом.
- **Серверные тесты**: `pnpm --filter server exec jest <name>` (rootDir `packages/server/src`, `*.spec.ts`); весь набор — `pnpm --filter server test`. Сейчас зелёные: 31 suite / 314 тестов.
- **Фронтенд-тесты**: `pnpm --filter frontend test` (Vitest + jsdom); один файл — `pnpm --filter frontend exec vitest run <Name>`.
- **Godot**: не менять `config/features` (`"4.8"`); runtime/editor — 4.8-beta2; после правок GDScript прогонять `pnpm export:game` как smoke-проверку.
- **Не сужать enum `GAME_ROOMS_TYPES`** и не удалять legacy `"ts-game"` без DB-плана (`DB_SYNC=1`, старые строки существуют).
- **Не трогать shared-контракты без правок** в `packages/shared/src/api/types.ts` + серверных DTO/entity (если ветка меняет API-контракт).
- **Каждая ветка работает в своём worktree** (см. ниже), не в общем рабочем дереве.

## Review Focus

Входные классы/режимы отказа, которые ревью подразумевает, но отдельные тесты веток могут не покрыть. Каждая строка ниже привязана к тесту в своей ветке.

1. **Анонимный вызов runtime-эндпоинта с чужим `(roomId, packageId)`** → должен вернуть 401/403, а не подписанный токен (Ветка 1).
2. **`EPIPE` при записи в stdin процесса, вышедшего между `state === 'running'` и `write`** → событие `error` поглощено, процесс Nest жив (Ветка 2).
3. **`kill -9` родителя** → дочерний Godot-процесс убит (process-group/kill-on-parent), порт освобождён (Ветка 2).
4. **Late-join с принудительно проваленным прелоадом на двух клиентах** → игрок приходит через `MultiplayerSpawner`, а не одноразовый `add_child`-снапшот (Ветка 5).
5. **Hot-reload пакета при живых игроках** → компоненты игроков пересобраны, мир не «смешанный» (Ветка 5).

---

## Карта веток и параллелизма

| # | Ветка | Домен | Файлы | Блокирует? |
|---|-------|-------|-------|------------|
| 1 | `fix/scripting-packages-access-control` | authz + rate-limit runtime-раздачи | только `scripting-packages/*` (controller + новые guard/limiter) | нет |
| 2 | `fix/godot-process-lifecycle` | жизненный цикл процессов | только `godot-game/room-runtime*`, `node-runtime-process.factory.ts`, `room-runtime.registry.ts` | нет |
| 3 | `refactor/package-delivery` | доставка/сборка артефактов | `package-delivery.service.ts`, `package-storage.service.ts`, `package-revisions.service.ts`, `package-runtime-references.ts`, `scripting-packages.service.ts` | нет |
| 4 | `fix/package-sync-room-status` | синхронизация и статус комнаты | `package-sync.service.ts`, `game-room.service.ts`, `game-room.rate-limiter.ts` | нет |
| 5 | `fix/gdscript-runtime-correctness` | Godot-рантайм | `_wired/_wired/scripts/**` (packages_manager, players_manager, main_scene, dynamic_world_container, package_reloader, network, package_registry) | нет |
| 6 | `fix/frontend-editor-bridge` | фронтенд + bridge | `frontend/src/app/room/[room_code]/(godot)/**`, `frontend/src/api/services/godot-game.ts` | нет |

**Ключевое свойство:** наборы файлов шести веток попарно не пересекаются — субагенты не конфликтуют при мерже. Единственная «зависимость» — общий spec (ревью) и конвенции из Global Constraints.

**Изоляция:** каждая ветка реализуется в собственном git worktree (skill `using-git-worktrees`), чтобы шесть субагентов не мешали друг другу в общем дереве. Перед стартом: `git worktree add -b <ветка> ../wired-<ветка>`.

**Порядок интеграции (рекомендация):** 1 → 2 → 4 → 3 → 6 → 5. Безопасность (1) и доступность (2) первыми, чтобы их мержи не зависели от рефакторинга; 5 последней, так как требует ручной 2-клиентской проверки. Любой другой порядок тоже корректен (файлы не пересекаются).

---

## Ветка 1: `fix/scripting-packages-access-control`

**Цель:** закрыть обход авторизации на runtime-эндпоинтах пакетов и ограничить неавторизованную запись на диск (критические пункты 1–2 ревью).

**Файлы:**
- Modify: `packages/server/src/scripting-packages/scripting-packages.controller.ts` (эндпоинты `runtime-manifest` ~193-200 и `runtime-files` ~206-250)
- Create: `packages/server/src/scripting-packages/guards/room-membership.guard.ts`
- Create: `packages/server/src/scripting-packages/artifact-build.rate-limiter.ts`
- Test: `packages/server/src/scripting-packages/scripting-packages.controller.spec.ts`, новые `*.spec.ts` для guard и limiter

**Interfaces:**
- Consumes: `RoomService` (read-only, проверка членства пользователя в комнате), существующий `UseAuthGuard` (паттерн из других контроллеров).
- Produces: `RoomMembershipGuard` (декоратор, проверяет `req.user` ∈ room и `packageId` принадлежит комнате); `ArtifactBuildRateLimiter` (ключ `(packageId, revision, roomId)`), подключаемый к runtime-эндпоинтам.

**Задачи:**

### Задача 1.1: Guard членства в комнате

- [ ] **Шаг 1:** Написать падающий тест `room-membership.guard.spec.ts`: для запроса, где пользователь не член комнаты → `ForbiddenException`; где `packageId` не принадлежит комнате → `ForbiddenException`; где валидно → пропуск.
- [ ] **Шаг 2:** Запустить `pnpm --filter server exec jest room-membership.guard.spec` → FAIL.
- [ ] **Шаг 3:** Реализовать `RoomMembershipGuard` в `guards/room-membership.guard.ts`, проверяющий членство пользователя в комнате и принадлежность пакета комнате (источник правды — guard, а не сервис).
- [ ] **Шаг 4:** Запустить тест → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 1.2: Включить guard на runtime-эндпоинтах

- [ ] **Шаг 1:** Добавить тест в `scripting-packages.controller.spec.ts`: анонимный вызов `runtime-manifest`/`runtime-files` → 401; авторизованный не-член → 403 (при исправлении `@UseAuthGuard` + `@UseGuards(RoomMembershipGuard)`).
- [ ] **Шаг 2:** Запустить → FAIL (сейчас эндпоинты без guard).
- [ ] **Шаг 3:** Добавить `@UseAuthGuard()` и `@UseGuards(RoomMembershipGuard)` к `runtime-manifest` и `runtime-files` в `scripting-packages.controller.ts`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 1.3: Rate-limit сборки артефакта

- [ ] **Шаг 1:** Тест `artifact-build.rate-limiter.spec.ts`: превышение лимита на `(packageId, revision, roomId)` → отказ до истечения окна; разные ключи независимы.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** Реализовать `ArtifactBuildRateLimiter` (in-memory, конфиг `limit`/`windowMs` из env-ключей `WIRED_ARTIFACT_BUILD_RATE_LIMIT`/`_WINDOW_MS`, default 10/60000) и подключить его до вызова `ensureArtifact` в `runtime-manifest`/`runtime-files`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 1.4: TOCTOU между stat и readStream

- [ ] **Шаг 1:** Тест в `scripting-packages.controller.spec.ts`: файл удалён между `resolveRuntimeFile` и `createReadStream` → управляемый 404/503, а не сырой поток с ошибкой.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `scripting-packages.controller.ts:231-242` открыть дескриптор через `createReadStream` с обработкой `error` (или `fs.open` + поток), чтобы TOCTOU давал корректный ответ.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

---

## Ветка 2: `fix/godot-process-lifecycle`

**Цель:** устранить осиротевшие Godot-процессы и unhandled `error` на stdio, плюс почистить коллекции сессий (критические пункты 3–4, важные пункты о `sessions`/`activeByRoom`/«орфан в штатном flow»).

**Файлы:**
- Modify: `packages/server/src/godot-game/node-runtime-process.factory.ts` (spawn без process-group)
- Modify: `packages/server/src/godot-game/room-runtime.session.ts` (stdio `error`, `performStop`, idle)
- Modify: `packages/server/src/godot-game/room-runtime.service.ts` (чистка `sessions`/`activeByRoom`)
- Modify: `packages/server/src/godot-game/room-runtime.registry.ts` (мёртвая коллекция)
- Test: `packages/server/src/godot-game/room-runtime.service.spec.ts`, `room-runtime.session` specs, новый `node-runtime-process.factory.spec.ts`

**Interfaces:**
- Consumes: execa `child_process`, `RoomRuntimeSession` (методы `attachLines`, `performStop`, `sendCommand`), `RoomRuntimeService`.
- Produces: spawn с `detached: true` + process-group и kill-on-parent; `stream.on('error', …)` no-op логгеры; удаление/связывание `RoomRuntimeRegistry`; сброс `activeByRoom` при stop.

**Задачи:**

### Задача 2.1: process-group и kill-on-parent

- [ ] **Шаг 1:** Тест `node-runtime-process.factory.spec.ts`: `spawn` вызывает execa с `detached: true` (process group) и переданным `cleanup`/kill-обработчиком родителя; при kill родителя группа получает сигнал.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `node-runtime-process.factory.ts:22-32` спавнить с `detached: true` и регистрировать kill process-group на `SIGTERM`/`SIGINT`/`exit` родителя (kill-on-parent-death через PID группы, `process.kill(-pid)`).
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 2.2: `error`-обработчики на stdio

- [ ] **Шаг 1:** Тест в session-spec: эмуляция `EPIPE`/`write after end` на `child.stdin` → событие `error` обработано, исключение не пробрасывается в process.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `room-runtime.session.ts` к `attachLines` (293-309) добавить no-op `stream.on('error', log)`, а в `sendCommand` (404-419) — повторную проверку `state` и обработчик `error` на stdin.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 2.3: чистка сессий и «орфан в штатном flow»

- [ ] **Шаг 1:** Тест в `room-runtime.service.spec.ts`: после `stop` запись удаляется из `sessions`/`activeByRoom`; если graceful+force-kill не уложились — статус `failed`, но порт помечен свободным, процесс получил kill.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `room-runtime.service.ts` (и `room-runtime.session.ts:650-659` `performStop`) гарантировать удаление записи при остановке, принудительный kill при провале graceful, и освобождение порта независимо от `isActive()`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 2.4: `RoomRuntimeRegistry` — удалить или связать

- [ ] **Шаг 1:** Проверить использования `registry.get/list` (сейчас не вызываются).
- [ ] **Шаг 2:** Либо удалить `room-runtime.registry.ts` и его регистрацию в `godot-game.module.ts`, либо связать его с `RoomRuntimeService` так, чтобы `sessions`/`activeByRoom` жили в одном месте (выбор — по результату шага 1; зафиксировать в коммит-сообщении).
- [ ] **Шаг 3:** `pnpm --filter server build` → PASS (typecheck).
- [ ] **Шаг 4:** Commit.

### Задача 2.5: Мёртвый код и дублирование в godot-game

- [ ] **Шаг 1:** Удалить неиспользуемые `room_starting` (объявлен, не выбрасывается) и `forceKilled`/`exitSignal` (пишутся, не читаются) из `room-runtime.session.ts`/`room-runtime.types.ts`.
- [ ] **Шаг 2:** Дедуплицировать `safeName` (`room-runtime.configuration.ts:176`, `room-runtime.log.ts:72`) в один общий хелпер.
- [ ] **Шаг 3:** Поправить комментарий `AUTH_TIMEOUT_SEC = 5` против текста «10s auth timeout» (`room-runtime.session.ts:16-17,207-210`) на согласованный.
- [ ] **Шаг 4:** `pnpm --filter server build` + `pnpm --filter server exec jest room-runtime` → PASS.
- [ ] **Шаг 5:** Commit.

---

## Ветка 3: `refactor/package-delivery`

**Цель:** разложить 903-строчный `package-delivery.service.ts`, устранить недетерминизм артефактов, утечки памяти при сборке и осиротевшие каталоги (важные пункты ревью + «что вынести»).

**Файлы:**
- Modify: `packages/server/src/scripting-packages/package-delivery.service.ts`
- Create: `packages/server/src/scripting-packages/package-closure-resolver.ts`
- Modify: `packages/server/src/scripting-packages/package-storage.service.ts`
- Modify: `packages/server/src/scripting-packages/package-revisions.service.ts`
- Modify: `packages/server/src/scripting-packages/package-runtime-references.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts`
- Test: `package-delivery.service.spec.ts`, `package-storage.service.spec.ts`, `package-revisions.service.spec.ts`, `package-runtime-references.spec.ts`

**Interfaces:**
- Consumes: `PackageClosureResolver` (новый), `PackageStorageService`, `PackageRevisionsService`, `package-runtime-references.ts`.
- Produces: `PackageClosureResolver` с методами `resolveClosure(...)`, `computeArtifactKeys(...)`, граф обратных ссылок; стабилизированная семантика выбора версий зависимостей; GC осиротевших каталогов при удалении пакета/комнаты.

**Задачи:**

### Задача 3.1: Выделить `PackageClosureResolver`

- [ ] **Шаг 1:** Портировать существующие тесты из `package-delivery.service.spec.ts`, покрывающие замыкание/граф/ключи (~`package-delivery.service.ts:422-588`), в `package-closure-resolver.spec.ts` без изменения их ожиданий.
- [ ] **Шаг 2:** Запустить → FAIL (класса ещё нет).
- [ ] **Шаг 3:** Создать `package-closure-resolver.ts`, перенеся `resolveClosure`, `computeArtifactKeys`, `buildReverseReferenceGraph` и DFS; сервис начинает импортировать его (чистый перенос, поведение то же).
- [ ] **Шаг 4:** `pnpm --filter server exec jest package-closure-resolver package-delivery` → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 3.2: Детерминизм версий зависимостей

- [ ] **Шаг 1:** Тест: два вызова сборки одного `(packageId, revision)` с изменившимся «latest published» зависимостью дают **разные** `artifactKey` (фиксирует текущий баг) — затем инвертировать на ожидание **одинакового** ключа.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `package-closure-resolver.ts` закрепить версии зависимостей, записанные на момент публикации ревизии (а не «latest» на момент сборки) — по `package-delivery.service.ts:590-606`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 3.3: Память — потоковая сборка и точечные чтения

- [ ] **Шаг 1:** Тесты производительности/поведения не требуют полноразмерных фикстур; проверить: `resolveClosure` не держит полные байты closure (428-475), `loadLatestPublishedRevisions` читает только `revision`+`files` нужных ревизий, а не все.
- [ ] **Шаг 2:** Реализовать инкрементальные чтения и ограничение выборки (без изменения публичного API).
- [ ] **Шаг 3:** `pnpm --filter server exec jest package-delivery` → PASS.
- [ ] **Шаг 4:** Commit.

### Задача 3.4: GC осиротевших каталогов при удалении

- [ ] **Шаг 1:** Тест в `package-storage.service.spec.ts`: удаление пакета удаляет `revisions/<n>` и `runtime/v1/...` с диска (сейчас чистится только строка БД — `scripting-packages.service.ts:165-171`).
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** Реализовать рекурсивное удаление каталогов пакета при удалении; заодно удалить мёртвый `discardPublished`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 3.5: `publishing`-guard для нескольких инстансов

- [ ] **Шаг 1:** Тест: пометка «publishing» должна быть видимой другим инстансам (интерфейс — БД-флаг/`advisory lock`, а не процесс-локальная переменная `package-revisions.service.ts:41`).
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** Заменить процесс-локальный `publishing` на персистентную пометку ревизии (столбец/`pg_advisory_lock`), сохранив API сервиса.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 3.6: `package-runtime-references.ts` — backslash-валидация и `queue.shift`

- [ ] **Шаг 1:** Тесты: path с `\` (Windows-разделитель) отклоняется; переписывание ссылок линеаризовано (индекс вместо `shift()`).
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** Добавить проверку backslash в валидацию путей и заменить `queue.shift()` (`:251`) на указатель/индекс.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 3.7: Мёртвый код в `scripting-packages.service.ts`

- [ ] **Шаг 1:** Удалить `publishedRevisionExists` и 6 неиспользуемых экспортов из `scripting-packages.service.ts` (перечислены в ревью), не ломая публичный API контроллера.
- [ ] **Шаг 2:** `pnpm --filter server build` + `pnpm --filter server exec jest scripting-packages.service` → PASS.
- [ ] **Шаг 3:** Commit.

---

## Ветка 4: `fix/package-sync-room-status`

**Цель:** устранить N+1 с 100 мс поллингом, двойной mint тикета, несброшенный `peers` и застревание статуса (важные пункты ревью + «что вынести»).

**Файлы:**
- Modify: `packages/server/src/godot-game/package-sync.service.ts`
- Modify: `packages/server/src/godot-game/game-room.service.ts`
- Modify: `packages/server/src/godot-game/game-room.rate-limiter.ts`
- Test: `package-sync.service.spec.ts`, `game-room.service.spec.ts`, `game-room.rate-limiter.spec.ts`

**Interfaces:**
- Consumes: `package-sync.types.ts` (модели `records`/`peers`), `GameRoomService`.
- Produces: пакетная выборка ревизий (`IN`/`GROUP BY`); сброс `peers` при рестарте runtime; однократный mint тикета; поведение rate-limiter, задокументированное для single-instance.

**Задачи:**

### Задача 4.1: Устранить N+1 в `getStatuses`/`reconcileRoom`

- [ ] **Шаг 1:** Тест: `getStatuses` для N пакетов делает один пакетный запрос ревизий (мок репозитория считает обращения), а не N `findOne`.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `package-sync.service.ts:128-155,161-198` заменить per-package `revisions.findOne` на `find` с `IN` по `packageId` и группировку по последнему revision.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 4.2: Сброс `peers` при рестарте runtime

- [ ] **Шаг 1:** Тест: после `stop`/рестарта runtime `aggregateState` не требует `ready` от мёртвых peers, статус не застревает на `applied`.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `package-sync.service.ts:70` очищать `peers` при рестарте runtime (хук на stop/start сессии).
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 4.3: Один mint тикета на соединение

- [ ] **Шаг 1:** Тест в `game-room.service.spec.ts`: `getConnection`+`refreshConnection` на одно соединение минтит ровно один тикет (сейчас два — `:86-90`).
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** Переписать на «ensure session + wait + mint один раз»; убрать побочный `stop('handshake_window_expired')`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 4.4: Rate-limiter — задокументировать/подготовить к scale

- [ ] **Шаг 1:** Проверить `game-room.rate-limiter.ts:19,38`; добавить комментарий/интерфейс, что in-memory валиден только для одного инстанса, либо вынести за injectable-интерфейс для будущего shared-бэкенда (без изменения поведения).
- [ ] **Шаг 2:** `pnpm --filter server exec jest game-room.rate-limiter` → PASS.
- [ ] **Шаг 3:** Commit.

### Задача 4.5: Извлечь `SyncRecordStore`/`DispatchScheduler`/`StatusReporter`

- [ ] **Шаг 1:** Перенести хранение `records`/`peers` из `package-sync.service.ts` (607 строк) в `SyncRecordStore`, ретрай-логику — в `DispatchScheduler`, агрегацию статуса — в `StatusReporter`, сохранив публичный API сервиса (существующие `package-sync.service.spec.ts` остаются зелёными).
- [ ] **Шаг 2:** Убрать бессмысленную `Number.isInteger(Number(roomId))` (всегда истинна — id из числового PK) в `getStatuses`/`reconcileRoom`.
- [ ] **Шаг 3:** `pnpm --filter server exec jest package-sync` → PASS.
- [ ] **Шаг 4:** Commit (допустимо 3 коммита по одному извлечению).

---

## Ветка 5: `fix/gdscript-runtime-correctness`

**Цель:** исправить hot-reload живых игроков, late-join через `MultiplayerSpawner`, утечки ссылок/нонсов и разложить `packages_manager.gd` (критические пункты 5–6, важные пункты + «что вынести» в GDScript).

**Файлы (база `packages/server/godot_project/_wired/_wired/scripts/`):**
- Modify: `global/packages_manager.gd` (1067 строк; извлечение + lock cleanup)
- Create: `global/package_manifest.gd`, `global/asset_deriver.gd`, `global/artifact_store.gd` (извлечения)
- Modify: `global/players_manager.gd` (late-join spawner, ref-утечки, hot-reload)
- Modify: `world/dynamic_world_container.gd` (`_spawn_record`, ref-утечки)
- Modify: `main_scene.gd` (hot-reload пересборка живых игроков)
- Modify: `global/package_reloader.gd` (мёртвый — интегрировать/удалить)
- Modify: `network/network.gd` (nonce leak)
- Modify: `global/package_registry.gd` (лексикографическая сортировка)
- Test: Godot-тесты (существующий 1100-строчный тест packages_manager) + smoke `pnpm export:game`

**Interfaces:**
- Consumes: `StaticWorldContainer`, `DynamicWorldContainer`, `MultiplayerSpawner`, `package_entry_loader.gd`.
- Produces: `PackageManifest` (парсинг/валидация), `AssetDeriver` (`_derive_*`/`_build_asset_derivations`), `ArtifactStore` (`_stage_files`/`_swap_revision`/`_prune_revisions`/`_remove_tree`); пересборка живых компонентов при `package_applied`; late-join через spawner.

**Задачи (порядок важен внутри ветки — общие файлы):**

### Задача 5.1: Late-join через `MultiplayerSpawner` (критично)

- [ ] **Шаг 1:** Разобрать `players_manager.gd:192` и `dynamic_world_container.gd:253` — сейчас `add_child` мимо spawner, `MultiplayerSynchronizer` без net-ID (`main_scene.gd:511-517`).
- [ ] **Шаг 2:** Перевести добавление отремонтированных игроков/сущностей на `MultiplayerSpawner.spawn` (или назначить корректный `name`/owner перед `add_child`), чтобы узлы жили в репликации, а не получали одноразовый снапшот.
- [ ] **Шаг 3:** Прогнать существующие Godot-тесты; зафиксировать результат.
- [ ] **Шаг 4:** Commit. (Финальная 2-клиентская проверка — в общей интеграции.)

### Задача 5.2: Hot-reload пересборка живых игроков (критично)

- [ ] **Шаг 1:** В `main_scene.gd:171-176` `_apply_registered_package` пересоздаёт static/pending, но не живых игроков и живые динамические сущности.
- [ ] **Шаг 2:** Добавить пересборку компонентов заспавненных игроков и живых сущностей (переиспользовать `_rebuild_components` из `players_manager.gd:232-240`, сейчас доступную только из `apply_snapshot`).
- [ ] **Шаг 3:** Godot-тест: после `package_applied` с живым игроком — компоненты игрока соответствуют новой версии пакета.
- [ ] **Шаг 4:** Commit.

### Задача 5.3: Извлечь `PackageManifest` / `AssetDeriver` / `ArtifactStore`

- [ ] **Шаг 1:** Перенести парсинг/валидацию манифеста, `_derive_*`/`_build_asset_derivations` и `_stage_files`/`_swap_revision`/`_prune_revisions`/`_remove_tree` из `packages_manager.gd` в три новых файла, сохранив публичный API (1100-строчный тест должен остаться зелёным).
- [ ] **Шаг 2:** Запустить Godot-тесты → PASS.
- [ ] **Шаг 3:** Commit (возможны 3 отдельных коммита по одному извлечению).

### Задача 5.4: Lock cleanup и утечки ссылок/нонсов

- [ ] **Шаг 1:** В `packages_manager.gd:371` освобождать lock при ошибке в `_sync_package` (сейчас обрыв корутины блокирует пакет до `APPLY_LOCK_TIMEOUT_MS`).
- [ ] **Шаг 2:** Чистить `_spawned`/`_entities` во всех ветках (`players_manager.gd:269`, `dynamic_world_container.gd:132`), не только server-only; чистить `_used_nonces` (`network.gd:63,222`).
- [ ] **Шаг 3:** Godot-тесты → PASS.
- [ ] **Шаг 4:** Commit.

### Задача 5.5: Мёртвый `PackageReloader` и мелочи

- [ ] **Шаг 1:** Подтвердить, что `PackageReloader` (312 строк) мёртв: все корни помечаются `_wired_registered`, `_collect_roots_under` их пропускает (`package_reloader.gd:160-164`).
- [ ] **Шаг 2:** Интегрировать нужную логику в контейнеры или удалить `package_reloader.gd`; удалить рефлексию `_capture_state`/`_copy_value_only`/`_is_value_only`.
- [ ] **Шаг 3:** Исправить лексикографическую сортировку `package_id` как строк (`package_registry.gd:112-113`) на числовую; убрать тестовый seam `_sync_order` за флаг/DI.
- [ ] **Шаг 4:** `pnpm export:game` как smoke → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 5.6: Упростить `_spawn_record` и вынести константы протокола

- [ ] **Шаг 1:** Развести `_spawn_record` (`dynamic_world_container.gd:407-439`) на два конструктора (плоская и explicit форма payload) вместо слияния в одном методе с erase/re-add.
- [ ] **Шаг 2:** Вынести stringly-typed ключи протокола (`"player_id"`, `"spawn_data"`, `"local_only"` и метаданные `_wired_package_id`/`_wired_registered`/`_wired_source_entity_id`) в общий файл констант, используемый 5 файлами сети; дедуплицировать `_as_vector2/3`.
- [ ] **Шаг 3:** Godot-тесты → PASS.
- [ ] **Шаг 4:** Commit.

---

## Ветка 6: `fix/frontend-editor-bridge`

**Цель:** исправить non-null `getEngine`, `replaceCanvas` мутацию DOM, несброшенные таймеры и разложить `use-room-packages.ts` (критические пункты 7–8, важные пункты + «что вынести» во фронтенде).

**Файлы (база `frontend/src/app/room/[room_code]/(godot)/`):**
- Modify: `use-room-packages.ts` (900 строк)
- Modify: `GodotEditorInstance.tsx`
- Modify: `godot-packages-fs.ts`
- Modify: `editor-bridge.ts`
- Modify: `GameTab.tsx`
- Modify: `PackagesTab.tsx`
- Modify: `frontend/src/api/services/godot-game.ts`
- Test: `use-room-packages.test.tsx`, `GodotEditor.test.tsx`, `editor-bridge.test.ts`, `GameTab.test.tsx`, `PackagesTab.test.tsx`, `godot-packages-fs.test.ts`

**Interfaces:**
- Consumes: `EditorBridgeClient` (`window.__wiredEditorBridge`), `godot-packages-fs.ts`, `package-sync.ts`.
- Produces: `useEditorBridge` (транспорт/reconnect), reducer для `entries`/`actions` вместо прямых мутаций `packagesRef`; защищённый `getEngine`; отменяемые таймеры.

**Задачи:**

### Задача 6.1: Убрать non-null `getEngine`

- [ ] **Шаг 1:** Тест в `use-room-packages.test.tsx`: `engineRef.current` == null между `prepareReplace` и `copyToFS` → выбрасывается `GodotFsError`, а не сырой `TypeError`; staging не остаётся наполовину записанным.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `use-room-packages.ts:541` заменить `getEngine: () => engineRef.current!.editor` на проверку с `GodotFsError`; убрать бесполезную проверку в `godot-packages-fs.ts:240-245` или перенести проверку до вызова `getEngine()`.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 6.2: `replaceCanvas` — не мутировать DOM под React

- [ ] **Шаг 1:** Тест в `GodotEditor.test.tsx`: повторный `onExit`/`setCanvas` не оставляет «пустой» canvas и не ломает `canvasRef`.
- [ ] **Шаг 2:** Запустить → FAIL.
- [ ] **Шаг 3:** В `GodotEditorInstance.tsx:146-176` заменить `replaceChild` на React-managed подход (ключ/состояние для пересоздания canvas, либо переиспользование существующего узла); удалить `clearPersistence`/`focus`/`lastScale`, если не используются.
- [ ] **Шаг 4:** Запустить → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 6.3: Отменяемые таймеры и детект «мёртвого» iframe

- [ ] **Шаг 1:** Тест `editor-bridge.test.ts`: `waitForEditorBridge` (120 с цепочка `setTimeout`, `:163-183`) отменяется при unmount.
- [ ] **Шаг 2:** Реализовать очистку таймера.
- [ ] **Шаг 3:** В `GameTab.tsx` добавить heartbeat/детект молчаливо упавшего iframe (сейчас полл обновляет только `players`, хост навсегда в `ready`).
- [ ] **Шаг 4:** `pnpm --filter frontend exec vitest run editor-bridge GameTab` → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 6.4: Разложить `use-room-packages.ts` и дедуплицировать обработчики

- [ ] **Шаг 1:** Вынести `useEditorBridge` (транспорт/reconnect) из `use-room-packages.ts`.
- [ ] **Шаг 2:** Заменить двойную бухгалтерию (`packagesRef.current` мутируется до проверки `request !== requestRef.current`, `:392,426`) на reducer.
- [ ] **Шаг 3:** Дедуплицировать три `handleDownload/Remove/Emit` с «confirm → retry force» в `PackagesTab.tsx` в одну фабрику.
- [ ] **Шаг 4:** `pnpm --filter frontend exec vitest run use-room-packages PackagesTab` → PASS.
- [ ] **Шаг 5:** Commit.

### Задача 6.5: Унифицировать путь к бэкенду

- [ ] **Шаг 1:** Вынести зашитый `/api` из `frontend/src/api/services/godot-game.ts:13` и переписывание `baseUrl` в одно место (например, `variables.ts`/общий префикс).
- [ ] **Шаг 2:** `pnpm --filter frontend build` → PASS.
- [ ] **Шаг 3:** Commit.

### Задача 6.6: Каскад `OnEditorExit` и фазовая машина `GameTab`

- [ ] **Шаг 1:** Упростить каскад `OnEditorExit → Execute` с переприсваиванием `this.OnEditorExit = null` (`GodotEditorInstance.tsx:189-217`) на линейный flow (рабочий сейчас, но запутанный).
- [ ] **Шаг 2:** Перевести фазовую машину `GameTab.tsx` (8 фаз + 4 зеркальных ref) на `useReducer`.
- [ ] **Шаг 3:** Заменить `decodeBase64` через `atob` (строковый двойник для бинарников) на буферный путь там, где это бинарные данные.
- [ ] **Шаг 4:** `pnpm --filter frontend exec vitest run GodotEditor GameTab` → PASS.
- [ ] **Шаг 5:** Commit.

---

## Интеграция и приёмка

1. **Мержи по порядку:** 1 → 2 → 4 → 3 → 6 → 5 (или любой — файлы не пересекаются). После каждого мержа — `pnpm build` (рекурсивный: server + frontend).
2. **Полный серверный прогон:** `pnpm --filter server test` → 31+ suite зелёные.
3. **Полный фронтенд-прогон:** `pnpm --filter frontend test` → все Vitest-файлы зелёные.
4. **Godot smoke:** `pnpm export:game` (нужен 4.8-beta2 runtime + templates) → экспорт собирается.
5. **Ручная 2-клиентская проверка (обязательна для Ветки 5):** два клиента в комнате, принудительно проваленный прелоад у одного → late-join игрок реплицируется (споун/деспоун видны обоим); hot-reload пакета при живом игроке → компоненты пересобраны у всех.
6. **Опционально:** `WIRED_GODOT_INTEGRATION=1 GODOT_RUNTIME_PATH=<godot-console.exe> pnpm --filter server exec jest room-runtime.integration --runInBand`.

**Критерий готовности ветки:** свой тестовый набор зелёный, `pnpm --filter server build`/`pnpm --filter frontend build` без ошибок, Conventional Commit-сообщения, не затронуты файлы других веток (`git diff --name-only origin/main...HEAD` ограничен своим списком).

---

## Обнаружено при исполнении (интеграционные блокеры)

Эти пункты выявлены субагентами в процессе работы и требуют решения **на этапе интеграции** (не внутри одной ветки, так как затрагивают файлы нескольких веток).

### Интеграция 1: сервисный credential для нативного Godot-рантайма (Ветки 1 ↔ 2 ↔ 5)

Ветка 1 включила `@UseAuthGuard` на `runtime-manifest`/`runtime-files`. Но нативный Godot-рантайм запрашивает эти маршруты «голым» `http.request(base_url + path)` без заголовка `Authorization` (`packages_manager.gd:267,638,929`). Сейчас серверный рантайм получит 401, и доставка пакетов в рантайм сломается.

**Требуется:** выдать рантайму сервисный credential при спавне и отправлять его в GDScript.
- Сервер (Ветка 2 / `godot-game`): генерировать короткоживущий service-JWT (или подписанный заголовок из `WIRED_GAME_TICKET_SECRET`), прокидывать в env процесса при spawn.
- GDScript (Ветка 5, `packages_manager.gd`): добавлять `Authorization: Bearer <service-token>` во все запросы к `runtime-manifest`/`runtime-files`.
- Контроллер (Ветка 1): принять service-credential как валидную альтернативу пользовательскому JWT/членству комнаты для runtime-вызовов.
- Проверка: полный прогон `pnpm export:game` + запуск комнаты, в логах рантайма нет 401 при загрузке пакетов.

**Решение по умолчанию, если credential не делаем:** оставить runtime-маршруты без `@UseAuthGuard`, но защитить их подписанным read-URL токеном (уже есть в `package-read-url.service.ts`) и room-scoped проверкой `packageId→room`, без требования пользовательского JWT. Тогда Ветка 1 должна быть скорректирована (убрать `@UseAuthGuard` с runtime-маршрутов, оставить `RoomMembershipGuard`-эквивалент для room/package scope). Выбор фиксируется при слиянии.

### Интеграция 2: хвосты синхронизации (Ветки 4 → 2)

Ветка 4 оставила в файлах Ветки 2 (`godot-game`) три небольших хвоста:
- `RoomRuntimeService.refreshConnection` больше не используется продакшн-кодом (только собственным спеком) — удалить в Ветке 2 при интеграции (или оставить с пометкой deprecated).
- Сброс `peers` сейчас срабатывает только на старте (`onRuntimeReady`). Для симметрии добавить stop-hook через `RuntimeObserver` (`room-runtime.types.ts` + `room-runtime.service.ts`); функционально статус уже размораживается reset-ом на старте, поэтому это не блокер.
- `stop('handshake_window_expired')` в `room-runtime.session.ts` остался, но путь двойного `reserveConnection`, который его провоцировал, удалён. После слияния убедиться, что он не срабатывает ложно (иначе `handshake_window_expired` будет гасить живую сессию).

### Интеграция 3: `room_starting` и `refreshConnection` (Ветки 2 ↔ 4)

- **`room_starting`**: Ветка 2 не смогла удалить его, т.к. он объявлен в `room-runtime.errors.ts` и используется в `Record<RoomRuntimeErrorCode, …>`-картах `game-room.service.ts` (файл Ветки 4). После слияния Ветки 4 удалить `room_starting` из union и обновить карты в `game-room.service.ts` (одна согласованная правка на обе ветки).
- **`refreshConnection`**: Ветка 4 подтвердила, что `RoomRuntimeService.refreshConnection` больше не используется продакшн-кодом. Удалить его (и спек) в `room-runtime.service.ts` при интеграции.

### Интеграция 4: мёртвые экспорты фронтенда и проверка на Postgres (Ветка 3)

- **6 неиспользуемых экспортов** (`listScriptingPackages`, `getScriptingPackage`, `updateScriptingPackage`, `deleteScriptingPackage`, `listPackageRevisions`, `getRevisionManifest`) находятся в **`frontend/src/api/services/scripting-packages.ts`**, а не в серверном сервисе. Ветка 3 их не трогала (фронтенд вне её скоупа). Удалить отдельной мелкой правкой на этапе интеграции.
- **`DISTINCT ON` и `pg_try_advisory_lock`** проверены только юнит-тестами с моками. На интеграции прогнать против живого Postgres (опубликовать пакет, удалить пакет, параллельная публикация двух инстансов), иначе риск, что SQL-синтаксис/поведение БД разойдётся с моками.
- `pnpm --filter server lint` в worktree даёт ~1.4k ложных `Delete ␍` из-за `core.autocrlf=true`; как гейт не использовать, проверять `prettier --check` на своих файлах.
