# Wired Room Content Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пакетам комнаты конвенциональную точку входа и ядро, которое само создаёт статический мир, спавнит игроков с компонентами, синхронизирует ввод/действия и хранит серверно-авторитетный динамический мир — так, чтобы пример `wired-platformer` работал в мультиплеере без RPC-обвязки в пакете.

**Architecture:** Базовый Godot-проект `_wired` получает `SubViewport`-сцену с `StaticWorld`, `DynamicWorld` и `Players`. Пакет регистрирует свои сцены через корневой `wired_package.gd`, а ядро строит из регистраций статику, компоненты игрока и динамические сущности. Сеть остаётся в `network.gd`; пакет видит только `WiredPlayer`, `WiredPlayerComponent` и `WiredDynamicEntity`. Backend только добавляет readiness-гейт перед выдачей ticket, без изменений БД, сущностей и манифеста.

**Tech Stack:** Godot 4.7.2 / GDScript, NestJS 11 / Jest, pnpm, TypeScript, Godot headless smoke tests.

**Spec:** `docs/superpowers/specs/2026-11-01-wired-room-content-packages-design.md`

## Global Constraints

- Godot ровно 4.7.2; `config/features` в `_wired/project.godot` остаётся `"4.7"`.
- Базовый проект: `packages/server/godot_project/_wired`; пример пакета — `packages/server/godot_project/examples/wired-platformer`, вне `_wired`.
- Не менять БД, TypeORM-сущности, API-контракты и формат манифеста пакета. Разрешено только backend-поведение readiness-гейта (§11.2.1 вариант A).
- Пакетные скрипты не объявляют `class_name`; они extends-ят классы ядра.
- Пакет не вызывает сетевые RPC напрямую. Ввод, действия, спавн, authority и сохранение — через ядро.
- Детерминированный порядок регистраций: `package_id` по возрастанию, затем `order`, затем индекс регистрации.
- Имена действий и динамических типов квалифицируются как `<package_id>/<local_name>`; ключ состояния компонента — `<package_id>:<relative_scene_path>`.
- Сервер авторитетен для тела игрока, толкания, динамического мира и сохранения. Камера и ввод — локальные.
- Все UI-контролы над `SubViewport` имеют `mouse_filter = MOUSE_FILTER_IGNORE`, иначе клики не дойдут до прицела.
- Документация и UI-тексты — русский UTF-8; коммиты Conventional Commits.
- Сервер запускать через pnpm из `packages/server`; Godot-тесты — headless из `_wired`.
- Перед стартом: `pnpm install`; для ручной проверки нужны `pnpm fetch:runtime`, `pnpm fetch:templates`, `pnpm export:game`.

## Review Focus

- Клиент подключается, когда runtime ещё не применил пакеты: игрок не должен спавниться без body/camera. Проверяется Task 1, Task 5, Task 6.
- Пакет обновился во время игры: статика перестраивается, существующие игроки не пересоздаются, новые спавны получают новые компоненты. Проверяется Task 4 и ручной проверкой Task 10.
- Прицел в `SubViewport` при UI поверх сцены, stretch и high-DPI: направление от якоря игрока к курсору должно оставаться корректным. Проверяется Task 8 и ручной проверкой Task 10.
- Late join в комнату с уже заспавненными dynamic-сущностями: клиент получает их и не создаёт дубликаты. Проверяется ручной проверкой Task 10; при провале — snapshot/resync в Task 8.
- Рестарт runtime: dynamic-мир восстанавливается без повторного импульса, без дублей и с теми же `entity_id`. Проверяется Task 8.

---

### Task 1: Backend readiness gate

**Files:**
- Modify: `packages/server/src/godot-game/game-room.service.ts`
- Test: `packages/server/src/godot-game/game-room.service.spec.ts`

**Interfaces:**
- Consumes: `PackageSyncService.getStatuses(roomId: string): Promise<PackageSyncStatus[]>`; каждый статус имеет `runtime.state: 'pending' | 'applied' | 'failed'`.
- Produces: `GameRoomService.connect()` не возвращает ticket, пока все опубликованные пакеты комнаты не имеют `runtime.state === 'applied'`. Пустой список статусов — комната без пакетов, готово сразу.
- Produces: `private async waitForInitialPackages(roomId: string): Promise<void>`; константы `PACKAGE_READY_TIMEOUT_MS = 10_000`, `PACKAGE_READY_POLL_MS = 100`.
- Ошибки: timeout — `HttpException` 409 с `code: 'packages_pending'`; `runtime.state === 'failed'` — 502 с `code: 'packages_failed'`.

- [ ] **Step 1: Write the failing tests**

Добавить в `game-room.service.spec.ts` тесты с mock `packageSync.getStatuses`:

```ts
it('returns a ticket immediately when the room has no packages', async () => {
  packageSync.getStatuses.mockResolvedValue([]);
  const result = await service.connect(user, 42);
  expect(result.ticket).toBe('ticket-value');
});

it('waits until the runtime applied every package', async () => {
  packageSync.getStatuses
    .mockResolvedValueOnce([status({ runtime: { state: 'pending' } })])
    .mockResolvedValueOnce([status({ runtime: { state: 'applied' } })]);
  const result = await service.connect(user, 42);
  expect(result.ticket).toBe('ticket-value');
  expect(packageSync.getStatuses).toHaveBeenCalledTimes(2);
});

it('does not wait for clients', async () => {
  packageSync.getStatuses.mockResolvedValue([
    status({ runtime: { state: 'applied' }, clients: [] }),
  ]);
  await expect(service.connect(user, 42)).resolves.toMatchObject({ ticket: 'ticket-value' });
});

it('rejects with packages_pending after the timeout', async () => {
  jest.useFakeTimers();
  packageSync.getStatuses.mockResolvedValue([status({ runtime: { state: 'pending' } })]);
  const promise = service.connect(user, 42);
  await jest.advanceTimersByTimeAsync(10_100);
  await expect(promise).rejects.toMatchObject({ status: 409 });
  expect(packageSync.getStatuses).toHaveBeenCalled();
});

it('rejects with packages_failed when the runtime failed a package', async () => {
  packageSync.getStatuses.mockResolvedValue([status({ runtime: { state: 'failed' } })]);
  await expect(service.connect(user, 42)).rejects.toMatchObject({ status: 502 });
});
```

`status()` — локальный helper, который заполняет обязательные поля `PackageSyncStatus` и позволяет переопределить `runtime`/`clients`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec jest game-room.service.spec`

Expected: FAIL — `waitForInitialPackages` отсутствует, ticket выдаётся сразу.

- [ ] **Step 3: Implement the gate**

В `GameRoomService.connect()` после `connection = await this.runtime.getConnection(runtimeRoomId)` и до `return`:

```ts
await this.waitForInitialPackages(runtimeRoomId);
```

Реализация:

```ts
private async waitForInitialPackages(roomId: string): Promise<void> {
  const deadline = Date.now() + PACKAGE_READY_TIMEOUT_MS;
  for (;;) {
    const statuses = await this.packageSync.getStatuses(roomId);
    if (statuses.some((s) => s.runtime.state === 'failed')) {
      throw new HttpException(
        { statusCode: 502, code: 'packages_failed', message: 'Room packages failed to apply' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (statuses.every((s) => s.runtime.state === 'applied')) return;
    if (Date.now() >= deadline) {
      throw new HttpException(
        { statusCode: 409, code: 'packages_pending', message: 'Room packages are still applying; retry shortly' },
        HttpStatus.CONFLICT,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, PACKAGE_READY_POLL_MS));
  }
}
```

Не использовать `state` aggregate: клиенты ещё не подключены, важен только `runtime.state`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server exec jest game-room.service.spec`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-game/game-room.service.ts packages/server/src/godot-game/game-room.service.spec.ts
git commit -m "feat(server): gate game tickets on initial package sync"
```

---

### Task 2: Package registry primitives

**Files:**
- Create: `_wired/scripts/global/package_registry.gd`
- Create: `_wired/scripts/packages/wired_package_registration.gd`
- Create: `_wired/scripts/packages/wired_package_context.gd`
- Test: `_wired/tests/package_registry_smoke.gd`

**Interfaces:**
- `WiredPackageRegistry` (class_name, extends `Node`):
  - `register_context(package_id: String, context: WiredPackageContext) -> void`
  - `add_registration(registration: WiredPackageRegistration) -> void`
  - `register_context(package_id: String, context: WiredPackageContext) -> void`
  - `get_context(package_id: String) -> WiredPackageContext`
  - `clear_package(package_id: String) -> void`
  - `get_static_scenes() -> Array[Dictionary]`
  - `get_player_components() -> Array[Dictionary]`
  - `get_dynamic_entities() -> Array[Dictionary]`
  - `find_dynamic_entity(qualified_type: String) -> Dictionary`
  - `resolve_action(package_id: String, local_name: String) -> String`
- `WiredPackageRegistration` (class_name, extends `RefCounted`):
  - `package_id: String`, `context: WiredPackageContext`
  - `register(_registry: WiredPackageRegistry) -> void` — переопределяется пакетом.
  - `add_static_scene(relative_path: String, options: Dictionary = {}) -> void`
  - `add_player_component(relative_path: String, options: Dictionary = {}) -> void`
  - `add_dynamic_entity(local_type: String, relative_path: String, options: Dictionary = {}) -> void`
- `WiredPackageContext` (class_name, extends `RefCounted`):
  - `package_id: String`, `root_path: String`, `revision: int`, `artifact_key: String`, `packages: PackagesManager`
  - `scene_path(relative_path: String) -> String` — при наличии `packages` возвращает `packages.runtime_path(package_id, revision, relative_path, artifact_key)`, иначе `root_path.path_join(relative_path)`.
  - `instantiate(relative_path: String) -> Node` — при наличии `packages` вызывает `packages.instantiate_scene(package_id, relative_path, revision)`; иначе `load(scene_path(relative_path)).instantiate()`; `null` при ошибке.
- Descriptor: `{package_id, path, order, authority, local_only, options, registration_index}`; для dynamic добавляются `local_type` и `qualified_type` (`"<package_id>/<local_type>"`).
- `authority` — `"server"` или `"local"`; `local_only` — bool; `order` — int (по умолчанию 0).

- [ ] **Step 1: Write the failing test**

`package_registry_smoke.gd` (extends `SceneTree`, стиль существующих smoke-тестов):

```gdscript
func test_registry_orders_and_qualifies() -> void:
    var registry := WiredPackageRegistry.new()
    var ctx_b := WiredPackageContext.new()
    ctx_b.package_id = "pkg.b"
    registry.register_context("pkg.b", ctx_b)
    var b := WiredPackageRegistration.new()
    b.package_id = "pkg.b"
    b.add_player_component("player/body.tscn", {"order": 20, "authority": "server"})
    registry.add_registration(b)
    var a := WiredPackageRegistration.new()
    a.package_id = "pkg.a"
    a.add_player_component("player/camera.tscn", {"order": 10, "authority": "local", "local_only": true})
    a.add_player_component("player/body.tscn", {"order": 5, "authority": "server"})
    registry.add_registration(a)

    var components := registry.get_player_components()
    assert(components[0]["package_id"] == "pkg.a")
    assert(components[0]["path"] == "player/body.tscn")
    assert(components[1]["path"] == "player/camera.tscn")
    assert(components[2]["package_id"] == "pkg.b")
    assert(registry.get_context("pkg.b") == ctx_b)
    assert(registry.resolve_action("pkg.a", "fire") == "pkg.a/fire")
```

Добавить проверку `clear_package("pkg.a")` оставляет только `pkg.b`.

- [ ] **Step 2: Run test to verify it fails**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2`

Expected: FAIL — классы `WiredPackageRegistry`/`WiredPackageRegistration` не найдены.

- [ ] **Step 3: Implement the three classes**

`WiredPackageRegistration` хранит `_entries: Array[Dictionary]`; каждый `add_*` добавляет `kind` (`"static"`, `"player"`, `"dynamic"`) и `registration_index`. `add_registration` копирует записи в `WiredPackageRegistry` с `package_id` из registration. Сортировка — `package_id`, `order`, `registration_index`; `Array.sort_custom` с явным компаратором.

`WiredPackageContext.instantiate` возвращает `null` и пишет `push_error` при отсутствии файла или не-`PackedScene`.

- [ ] **Step 4: Run test to verify it passes**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2`

Expected: PASS и `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/global/package_registry.gd \
  packages/server/godot_project/_wired/scripts/packages/wired_package_registration.gd \
  packages/server/godot_project/_wired/scripts/packages/wired_package_context.gd \
  packages/server/godot_project/_wired/tests/package_registry_smoke.gd
git commit -m "feat(wired): add package registry primitives"
```

---

### Task 3: Static world, main scene and Global services

**Files:**
- Create: `_wired/scripts/world/static_world_container.gd`
- Modify: `_wired/scripts/global/global.gd`
- Modify: `_wired/scenes/main.tscn`
- Modify: `_wired/scripts/main_scene.gd`
- Test: `_wired/tests/scene_layout_smoke.gd`
- Test: `_wired/tests/static_world_smoke.gd`
- Test fixture: `_wired/tests/fixtures/static_root/static.tscn`

**Interfaces:**
- `StaticWorldContainer` (class_name, extends `Node`):
  - `setup(registry: WiredPackageRegistry) -> void`
  - `rebuild() -> void`
  - `clear() -> void`
  - `get_spawn_position_2d(index: int = 0) -> Vector2`
  - `get_spawn_position_3d(index: int = 0) -> Vector3`
- `Global`:
  - `var package_registry: WiredPackageRegistry`
  - `var static_world: StaticWorldContainer`
  - `var dynamic_world: DynamicWorldContainer` (тип появится в Task 8; до этого `Node`)
  - `var players: PlayersManager` (тип появится в Task 6; до этого `Node`)
  - `var packages: PackagesManager`
  - `var network: WiredNetwork`
  - `register_scene_services(static_world, dynamic_world, players, network) -> void`
  - `get_package_registry()`, `get_static_world()`, `get_dynamic_world()`, `get_players()`, `get_network()`
- `main.tscn`:
  - `Main/Game` — `SubViewportContainer`, anchors full rect, `stretch = true`.
  - `Main/Game/SubViewport` — `render_target_update_mode = ALWAYS`, `handle_input_locally = true`, `own_world_3d = true`, size `960x540`.
  - `Main/Game/SubViewport/StaticWorld` — Node со скриптом `static_world_container.gd`.
  - `Main/Game/SubViewport/DynamicWorld` — Node (скрипт в Task 8), child `Spawner` (`MultiplayerSpawner`).
  - `Main/Game/SubViewport/Players` — Node (скрипт в Task 6), child `Spawner` (`MultiplayerSpawner`).
  - `Main/UI` остаётся CanvasLayer; у всех `Control` внутри `mouse_filter = MOUSE_FILTER_IGNORE`.
- `StaticWorldContainer.rebuild()`: для каждой static-регистрации берёт `registry.get_context(package_id).instantiate(path)`, ставит meta `_wired_package_id`, `_wired_registered = true`, добавляет child. `clear()` удаляет только детей с `_wired_registered`.
- Спавн-маркеры: узлы `Marker2D`/`Marker3D` в группе `wired_player_spawn` или с meta `wired_player_spawn = true`; позиции собираются рекурсивно через `find_children("*", "", true, false)`.

- [ ] **Step 1: Write the failing tests**

`scene_layout_smoke.gd`:

```gdscript
func test_main_scene_has_game_viewport() -> void:
    var scene: PackedScene = load("res://_wired/scenes/main.tscn")
    var main := scene.instantiate()
    assert(main.get_node("Game") is SubViewportContainer)
    assert(main.get_node("Game/SubViewport") is SubViewport)
    assert(main.get_node("Game/SubViewport/StaticWorld") != null)
    assert(main.get_node("Game/SubViewport/DynamicWorld/Spawner") is MultiplayerSpawner)
    assert(main.get_node("Game/SubViewport/Players/Spawner") is MultiplayerSpawner)
    var ui := main.get_node("UI")
    for child in ui.find_children("*", "Control", true, false):
        assert((child as Control).mouse_filter == Control.MOUSE_FILTER_IGNORE)
```

`static_world_smoke.gd`: собрать `WiredPackageRegistry`, `WiredPackageContext` с `root_path = "res://tests/fixtures/static_root"`, registration с `add_static_scene("static.tscn")`, вызвать `rebuild()`, проверить child count, meta и `get_spawn_position_2d(0) == Vector2(48, 96)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2`

Expected: FAIL — `Game` отсутствует.

- [ ] **Step 3: Implement scene and container**

Собрать `main.tscn` вручную/через Godot, сохранить UID и пути. В `main_scene.gd._ready()`:

```gdscript
var registry := WiredPackageRegistry.new()
Global.package_registry = registry
Global.register_scene_services(
    $Game/SubViewport/StaticWorld,
    $Game/SubViewport/DynamicWorld,
    $Game/SubViewport/Players,
    $Net
)
$Game/SubViewport/StaticWorld.setup(registry)
_setup_packages(room)
```

`_setup_packages` дополнительно сохраняет `Global.packages = _packages`; `StaticWorld` перестраивается после каждого `package_applied` (подключение сигнала появится в Task 4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2`

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/static_world_smoke.gd --quit-after 2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/world/static_world_container.gd \
  packages/server/godot_project/_wired/scripts/global/global.gd \
  packages/server/godot_project/_wired/scenes/main.tscn \
  packages/server/godot_project/_wired/scripts/main_scene.gd \
  packages/server/godot_project/_wired/tests/scene_layout_smoke.gd \
  packages/server/godot_project/_wired/tests/static_world_smoke.gd \
  packages/server/godot_project/_wired/tests/fixtures/static_root/static.tscn
git commit -m "feat(wired): add static world and game viewport"
```

---

### Task 4: Package entry loader and reload coordination

**Files:**
- Create: `_wired/scripts/packages/package_entry_loader.gd`
- Modify: `_wired/scripts/main_scene.gd`
- Modify: `_wired/scripts/global/package_registry.gd`
- Modify: `_wired/scripts/global/package_reloader.gd`
- Test: `_wired/tests/package_entry_smoke.gd`
- Test fixture: `_wired/tests/fixtures/package_root/wired_package.gd`
- Test fixture: `_wired/tests/fixtures/package_root/static.tscn`

**Interfaces:**
- `PackageEntryLoader` (class_name, extends `RefCounted`):
  - `load_entry(package_id: String, revision: int, context: WiredPackageContext, registry: WiredPackageRegistry) -> bool`
  - Читает `context.scene_path("wired_package.gd")`; `ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)`; если скрипт найден — `script.new()`, проверяет `is WiredPackageRegistration`, ставит `package_id`, `context`, вызывает `register(registry)`, затем `registry.add_registration(entry)` и `registry.register_context(package_id, context)`.
  - Возвращает `false`, если файла нет; это нормально для пакета без контента.
- `WiredPackageRegistry.clear_package(package_id)` удаляет записи и контекст; `register_context` сохраняет контекст.
- `PackageReloader` пропускает узлы с meta `_wired_registered = true`; статикой владеет `StaticWorldContainer`, а не reloader.
- `main_scene.gd` на `package_applied(package_id, revision, changed_files)`:
  1. получает `artifact_key = packages.current_artifact_key(package_id)`;
  2. строит `context = WiredPackageContext.new()` с `package_id`, `revision`, `artifact_key`, `packages = packages`, `root_path = packages.revision_dir(package_id, revision, artifact_key)`;
  3. `registry.clear_package(package_id)`;
  4. `PackageEntryLoader.load_entry(...)`;
  5. `static_world.rebuild()`.

- [ ] **Step 1: Write the failing test**

`package_entry_smoke.gd`:

```gdscript
func test_entry_registers_static_scene() -> void:
    var registry := WiredPackageRegistry.new()
    var context := WiredPackageContext.new()
    context.package_id = "pkg.test"
    context.root_path = "res://tests/fixtures/package_root"
    context.revision = 1
    var ok := PackageEntryLoader.load_entry("pkg.test", 1, context, registry)
    assert(ok)
    assert(registry.get_static_scenes().size() == 1)
    assert(registry.get_static_scenes()[0]["path"] == "static.tscn")
```

Плюс тест: `load_entry` на пустом каталоге возвращает `false` и не падает.

- [ ] **Step 2: Run test to verify it fails**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/package_entry_smoke.gd --quit-after 2`

Expected: FAIL — `PackageEntryLoader` не найден.

- [ ] **Step 3: Implement loader and wire lifecycle**

`wired_package.gd` fixture:

```gdscript
extends WiredPackageRegistration

func register(registry: WiredPackageRegistry) -> void:
    add_static_scene("static.tscn", {"order": 10})
```

`main_scene.gd` подключает `_packages.package_applied.connect(_on_package_applied)` после создания `PackagesManager`. `_on_package_applied` вызывает `_apply_registered_package`; ошибки логируются через `_fail`/`push_warning`, но не роняют runtime.

В `package_reloader.gd` в месте сбора кандидатов добавить проверку:

```gdscript
if node.has_meta("_wired_registered") and bool(node.get_meta("_wired_registered")):
    continue
```

- [ ] **Step 4: Run test to verify it passes**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/package_entry_smoke.gd --quit-after 2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/packages/package_entry_loader.gd \
  packages/server/godot_project/_wired/scripts/main_scene.gd \
  packages/server/godot_project/_wired/scripts/global/package_registry.gd \
  packages/server/godot_project/_wired/scripts/global/package_reloader.gd \
  packages/server/godot_project/_wired/tests/package_entry_smoke.gd \
  packages/server/godot_project/_wired/tests/fixtures/package_root
git commit -m "feat(wired): load wired_package entry registrations"
```

---

### Task 5: Network readiness and input/action transport

**Files:**
- Create: `_wired/scripts/network/package_readiness.gd`
- Modify: `_wired/scripts/network/network.gd`
- Test: `_wired/tests/network_readiness_smoke.gd`

**Interfaces:**
- `PackageReadiness` (class_name, extends `RefCounted`):
  - `static func is_ready(announced: Dictionary, reports: Dictionary) -> bool`
  - `announced` = `{package_id: revision}`; `reports` = `{package_id: {"revision": int, "state": "ready"|"failed"}}`.
  - Ready, если для каждого announced есть report с тем же revision и `state == "ready"`; пустой announced — true.
- `WiredNetwork` new signals:
  - `peer_authenticated(peer_id: int, player_id: int, name: String)`
  - `peer_packages_ready(peer_id: int)`
  - `player_input_received(peer_id: int, input: Dictionary)`
  - `player_action_received(peer_id: int, action: String, payload: Dictionary)`
- New methods:
  - `is_peer_packages_ready(peer_id: int) -> bool`
  - `send_player_input(input: Dictionary) -> void` — client -> server, `cli_player_input`, `unreliable_ordered`.
  - `send_player_action(action: String, payload: Dictionary) -> void` — client -> server, `cli_player_action`, reliable.
- Server:
  - после auth `_players[peer_id]` эмитит `peer_authenticated`;
  - `cli_package_ready(package_id, revision, state)` записывает report; если `PackageReadiness.is_ready(_package_revisions, _package_reports[peer_id])` и peer ещё не ready — ставит флаг и эмитит `peer_packages_ready`;
  - `cli_ready` при пустом `_package_revisions` сразу эмитит `peer_packages_ready`;
  - `cli_player_input` проверяет, что отправитель — известный peer, и эмитит `player_input_received`;
  - `cli_player_action` проверяет sender, action непустой, payload Dictionary, эмитит `player_action_received`.
- Readiness — только initial-spawn gate. Последующие ревизии не деспавнят существующих игроков.

- [ ] **Step 1: Write the failing test**

`network_readiness_smoke.gd`:

```gdscript
func test_readiness_matrix() -> void:
    assert(PackageReadiness.is_ready({}, {}))
    assert(not PackageReadiness.is_ready({"pkg": 3}, {}))
    assert(PackageReadiness.is_ready({"pkg": 3}, {"pkg": {"revision": 3, "state": "ready"}}))
    assert(not PackageReadiness.is_ready({"pkg": 3}, {"pkg": {"revision": 2, "state": "ready"}}))
    assert(not PackageReadiness.is_ready({"pkg": 3}, {"pkg": {"revision": 3, "state": "failed"}}))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/network_readiness_smoke.gd --quit-after 2`

Expected: FAIL — `PackageReadiness` не найден.

- [ ] **Step 3: Implement helper and network API**

`network.gd` использует `PackageReadiness.is_ready` вместо собственной проверки. `_package_reports[peer_id]` инициализируется при auth. `cli_package_ready` не эмитит повторно, если peer уже ready. Для `cli_player_input`/`cli_player_action` использовать существующий паттерн RPC и `multiplayer.get_remote_sender_id()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/network_readiness_smoke.gd --quit-after 2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/network/package_readiness.gd \
  packages/server/godot_project/_wired/scripts/network/network.gd \
  packages/server/godot_project/_wired/tests/network_readiness_smoke.gd
git commit -m "feat(wired): add package readiness and player transport"
```

---

### Task 6: WiredPlayer, component contract and PlayersManager

**Files:**
- Create: `_wired/scripts/players/wired_player.gd`
- Create: `_wired/scripts/players/wired_player_component.gd`
- Modify: `_wired/scripts/global/players_manager.gd`
- Modify: `_wired/scenes/main.tscn` (attach `players_manager.gd` to `Players`, set spawner paths)
- Modify: `_wired/scripts/main_scene.gd` (call `players.setup(...)`, connect network signals)
- Test: `_wired/tests/players_manager_smoke.gd`
- Test fixture: `_wired/tests/fixtures/player_root/player_component.tscn`
- Test fixture: `_wired/tests/fixtures/player_root/player_component.gd`

**Interfaces:**
- `WiredPlayer` (class_name, extends `Node`):
  - fields `player_id: int`, `peer_id: int`, `display_name: String`, `input: Dictionary`, `spawn_position_2d: Vector2`, `spawn_position_3d: Vector3`, `network: WiredNetwork`, `components: Array[WiredPlayerComponent]`.
  - `setup(player_id, peer_id, display_name, network) -> void`
  - `is_local_player() -> bool` (`peer_id == multiplayer.get_unique_id()`)
  - `is_server_authority() -> bool` (`multiplayer.is_server()`)
  - `get_anchor_position_2d() -> Vector2`, `set_anchor_position_2d(value)`
  - `get_anchor_position_3d() -> Vector3`, `set_anchor_position_3d(value)`
  - `add_component(component: WiredPlayerComponent, authority: String, local_only: bool) -> void`
  - `register_action(qualified_action: String, handler: Callable) -> void` — только сервер; имя уже квалифицировано компонентом.
  - `handle_action(qualified_action: String, payload: Dictionary, sender_peer: int) -> void`
  - `request_action(qualified_action: String, payload: Dictionary = {}) -> void` — только локальный игрок; имя уже квалифицировано компонентом.
  - `save_state() -> Dictionary`, `load_state(state: Dictionary) -> void`
- `WiredPlayerComponent` (class_name, extends `Node`):
  - `player: WiredPlayer`, `package_id: String`, `authority_mode: String`, `local_only: bool`
  - hooks: `_wired_ready()`, `_wired_process(delta)`, `_wired_physics_process(delta)`, `_wired_visual_process(delta)`, `_wired_unhandled_input(event)`, `_wired_replicated_properties() -> PackedStringArray`, `_wired_save_state() -> Dictionary`, `_wired_load_state(state: Dictionary) -> void`.
  - helpers: `is_local_player() -> bool`, `is_server() -> bool`, `register_action(local_name, handler)`, `request_action(local_name, payload)`, `spawn_dynamic(local_type, data)`.
  - `_ready()` создаёт `MultiplayerSynchronizer` (имя `Sync`) как child компонента; `root_path = NodePath("..")` (компонент — родитель synchronizer-а), свойства вида `Body:position`; `replication_config` property paths добавляются из `_wired_replicated_properties()`. `Sync` получает тот же `multiplayer_authority`, что и компонент.
  - `_wired_unhandled_input` вызывается только если `player.is_local_player()`, независимо от authority.
  - `_wired_visual_process` вызывается на всех peer-ах.
- `PlayersManager` (class_name, extends `Node`):
  - `setup(registry: WiredPackageRegistry, network: WiredNetwork, spawner: MultiplayerSpawner) -> void`
  - `build_player(data: Dictionary, registry: WiredPackageRegistry) -> WiredPlayer` — public для теста; создаёт root и компоненты, не добавляет в tree.
  - `spawn_player(peer_id: int) -> void` — server only; `spawner.spawn(data)`.
  - `despawn_player(peer_id: int) -> void`
  - `save_state() -> Dictionary`, `load_state(state: Dictionary) -> void`
  - pending map: `_authenticated[peer_id] = {player_id, name}`, `_spawned[peer_id] = WiredPlayer`.
  - `_on_peer_authenticated` и `_on_peer_packages_ready` вызывают `_try_spawn(peer_id)`; спавн только когда есть оба сигнала.
- Spawn data: `{player_id, peer_id, name, spawn_position_2d, spawn_position_3d}`.
- Компоненты строятся в порядке registry; `authority = "server"` -> `set_multiplayer_authority(1)`, `"local"` -> `set_multiplayer_authority(peer_id)`; `local_only` компонент добавляется только если `peer_id == multiplayer.get_unique_id()`.
- `Players/Spawner` (`MultiplayerSpawner`): `spawn_path = NodePath("..")`, `spawn_function = players._spawn_player` (bind).

- [ ] **Step 1: Write the failing test**

`players_manager_smoke.gd`:

```gdscript
func test_build_player_adds_components_in_order_and_sets_anchor() -> void:
    var registry := WiredPackageRegistry.new()
    var context := WiredPackageContext.new()
    context.package_id = "pkg.test"
    context.root_path = "res://tests/fixtures/player_root"
    registry.register_context("pkg.test", context)
    var reg := WiredPackageRegistration.new()
    reg.package_id = "pkg.test"
    reg.add_player_component("player_component.tscn", {"order": 10, "authority": "server"})
    registry.add_registration(reg)

    var data := {"player_id": 7, "peer_id": 1, "name": "bob", "spawn_position_2d": Vector2(48, 96), "spawn_position_3d": Vector3.ZERO}
    var player := PlayersManager.new().build_player(data, registry)
    assert(player.player_id == 7)
    assert(player.get_anchor_position_2d() == Vector2(48, 96))
    assert(player.components.size() == 1)
    assert(player.components[0].authority_mode == "server")
```

Добавить тест `WiredPlayer.request_action` на нелокальном игроке не отправляет ничего (мок network), и `handle_action` вызывает зарегистрированный handler.

- [ ] **Step 2: Run test to verify it fails**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/players_manager_smoke.gd --quit-after 2`

Expected: FAIL — `PlayersManager.build_player` отсутствует.

- [ ] **Step 3: Implement player and manager**

`WiredPlayer._physics_process` на локальном клиенте собирает input (`wired_move_*`, `wired_jump`) в `input` и отправляет `network.send_player_input(input)` не чаще 30 Гц. На сервере `input` обновляется из сигнала `player_input_received`.

`WiredPlayer.handle_action` ищет handler по qualified action; если нет — `push_warning`. `WiredPlayerComponent.register_action` добавляет `<package_id>/<local_name>` в `player`. `spawn_dynamic` делегирует `Global.dynamic_world.spawn_entity` (Task 8); до Task 8 — заглушка с `push_warning`.

`PlayersManager._spawn_player(data)` вызывается spawner-ом на всех peer-ах; создаёт `WiredPlayer` через `build_player`, добавляет в `Players`, сохраняет в `_spawned`.

- [ ] **Step 4: Run test to verify it passes**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/players_manager_smoke.gd --quit-after 2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/players/wired_player.gd \
  packages/server/godot_project/_wired/scripts/players/wired_player_component.gd \
  packages/server/godot_project/_wired/scripts/global/players_manager.gd \
  packages/server/godot_project/_wired/scenes/main.tscn \
  packages/server/godot_project/_wired/scripts/main_scene.gd \
  packages/server/godot_project/_wired/tests/players_manager_smoke.gd \
  packages/server/godot_project/_wired/tests/fixtures/player_root
git commit -m "feat(wired): spawn players with registered components"
```

---

### Task 7: Example body, camera and pushing

**Files:**
- Create: `_wired/scripts/players/player_push.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/player/body.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/player/body.tscn`
- Create: `packages/server/godot_project/examples/wired-platformer/player/camera.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/player/camera.tscn`
- Modify: `_wired/project.godot` (input actions)
- Test: `_wired/tests/player_push_smoke.gd`
- Test: `_wired/tests/camera_follow_smoke.gd`
- Test fixture: `_wired/tests/fixtures/push_root/push_body.tscn`

**Interfaces:**
- `PlayerPush` (class_name, extends `RefCounted`):
  - `static func push_other(body: CharacterBody2D, velocity: Vector2, strength: float = 1.0) -> void` — добавляет к `body.velocity` компонент вдоль направления, без прямого изменения чужого `position`.
- `body.gd`:
  - `extends WiredPlayerComponent`
  - `@export var speed := 240.0`, `@export var jump_velocity := -420.0`, `@export var gravity := 980.0`, `@export var push_strength := 1.0`
  - `_wired_replicated_properties() -> PackedStringArray` = `["Body:position", "Body:velocity"]`
  - `_wired_ready()`: `body = $Body`; `player.set_anchor_position_2d(body.position)`
  - `_wired_physics_process(delta)`: только сервер; читает `player.input`; `body.velocity.x = move.x * speed`; gravity/jump; `body.move_and_slide()`; `player.set_anchor_position_2d(body.position)`; после slide вызывает `PlayerPush` для столкновений с узлами, у которых meta `_wired_player_body`.
  - `_wired_visual_process(delta)`: на всех peer-ах `player.set_anchor_position_2d(body.position)`.
- `camera.gd`:
  - `extends WiredPlayerComponent`; `$Camera2D.enabled = is_local_player()`; `_wired_process`/`_wired_visual_process` ставит `global_position = player.get_anchor_position_2d()`; `position_smoothing_enabled = false` в v1.
- Input actions в `_wired/project.godot`: `wired_move_left` (A/Left), `wired_move_right` (D/Right), `wired_move_up` (W/Up), `wired_move_down` (S/Down), `wired_jump` (Space), `wired_spawn_crate` (LMB). Для 3D-совместимости `wired_move_up/down` не маппить на прыжок.

- [ ] **Step 1: Write the failing tests**

`player_push_smoke.gd`:

```gdscript
func test_push_adds_velocity_without_teleport() -> void:
    var body := CharacterBody2D.new()
    body.velocity = Vector2.ZERO
    PlayerPush.push_other(body, Vector2(120, 0), 1.0)
    assert(body.velocity.x > 0)
    assert(body.position == Vector2.ZERO)
```

`camera_follow_smoke.gd`: создать `WiredPlayer`, `Camera2D`, установить anchor `Vector2(32, 48)`, вызвать helper камеры (вынести `static func target_position(anchor: Vector2) -> Vector2` в `camera.gd` или core helper) и проверить `target_position == Vector2(32, 48)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/player_push_smoke.gd --quit-after 2`

Expected: FAIL — `PlayerPush` не найден.

- [ ] **Step 3: Implement example components and input map**

`body.tscn`: root `Node` со скриптом `body.gd`, child `Body` (`CharacterBody2D`), child `Sprite` (`Polygon2D`, квадрат 32x32), child `Collision` (`CollisionShape2D`, `RectangleShape2D` 32x32). `body` root meta `_wired_player_body = true`.

`camera.tscn`: root `Node` со скриптом `camera.gd`, child `Camera2D`.

Толкание: после `move_and_slide()` перебрать `body.get_slide_collision_count()`; если collider имеет meta `_wired_player_body`, вызвать `PlayerPush.push_other(collider, body.velocity, push_strength)`. Не толкать сам себя и не толкать на клиенте.

- [ ] **Step 4: Run tests to verify they pass**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/player_push_smoke.gd --quit-after 2`

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/camera_follow_smoke.gd --quit-after 2`

Expected: PASS. Example-скрипты проверить синтаксически:

Run: `godot --headless --path packages/server/godot_project/_wired --check-only --script packages/server/godot_project/examples/wired-platformer/player/body.gd`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/players/player_push.gd \
  packages/server/godot_project/_wired/project.godot \
  packages/server/godot_project/_wired/tests/player_push_smoke.gd \
  packages/server/godot_project/_wired/tests/camera_follow_smoke.gd \
  packages/server/godot_project/_wired/tests/fixtures/push_root \
  packages/server/godot_project/examples/wired-platformer/player
git commit -m "feat(example): add player body camera and pushing"
```

---

### Task 8: Dynamic world, crate and cursor impulse

**Files:**
- Create: `_wired/scripts/world/dynamic_world_container.gd`
- Create: `_wired/scripts/world/wired_dynamic_entity.gd`
- Create: `_wired/scripts/players/wired_aim.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/dynamic/crate.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/dynamic/crate.tscn`
- Create: `packages/server/godot_project/examples/wired-platformer/player/spawner.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/player/spawner.tscn`
- Modify: `_wired/scripts/main_scene.gd` (save/load `dynamic_world`, `players`)
- Modify: `_wired/scripts/global/global.gd` (типы)
- Test: `_wired/tests/dynamic_world_smoke.gd`
- Test: `_wired/tests/wired_aim_smoke.gd`
- Test fixture: `_wired/tests/fixtures/dynamic_root/crate.tscn`
- Test fixture: `_wired/tests/fixtures/dynamic_root/crate.gd`

**Interfaces:**
- `DynamicWorldContainer` (class_name, extends `Node`):
  - `setup(registry: WiredPackageRegistry, spawner: MultiplayerSpawner) -> void`
  - `spawn_entity(qualified_type: String, data: Dictionary = {}) -> Node` — server only.
  - `despawn_entity(entity_id: int) -> void`
  - `save_state() -> Array[Dictionary]`
  - `load_state(records: Array) -> void` — server only; `restore = true`.
  - `restore_pending(records: Array) -> void` — server only; восстанавливает только те записи, чей `type_id` уже есть в registry, и помечает их как восстановленные.
  - `spawn_function(data: Dictionary) -> Node` — для `MultiplayerSpawner`.
- `WiredDynamicEntity` (class_name, extends `Node`):
  - `entity_id: int`, `type_id: String`, `owner_player_id: int`
  - `setup(entity_id, type_id, owner_player_id) -> void`
  - `_wired_apply_spawn(data: Dictionary) -> void`
  - `_wired_replicated_properties() -> PackedStringArray`
  - `_wired_save_state() -> Dictionary`, `_wired_load_state(state: Dictionary) -> void`
  - `_wired_freeze_on_client() -> void` — отключает `RigidBody2D/3D` (`freeze = true`, `sleeping = true`) на клиентах.
  - `_ready()` создаёт `MultiplayerSynchronizer` child `Sync`, `root_path = NodePath("..")`, добавляет property paths из `_wired_replicated_properties()` и ставит ему authority сущности.
- `WiredAim` (class_name, extends `RefCounted`):
  - `static func direction(anchor: Vector2, mouse_world: Vector2) -> Vector2` — нормализует; при нулевой длине `Vector2.RIGHT`.
- Spawn data: `{entity_id, type_id, owner_player_id, restore: bool, state: Dictionary, spawn_data: Dictionary}`.
- Persisted dynamic record: `{entity_id, type_id, owner_player_id, state}`; `spawn_data` не сохраняется.
- `state.json` server: `dynamic_world` и `players`; `main_scene._save_state` добавляет их. `main_scene._ready()` читает `dynamic_world` в `_saved_dynamic_records`; после каждого `package_applied` вызывает `dynamic_world.restore_pending(_saved_dynamic_records)`. Так восстановление не зависит от того, в каком порядке пришли пакеты, и не требует отдельного `world_ready`.
- `spawner.gd` (example):
  - `extends WiredPlayerComponent`; `@export var spawn_offset := 48.0`, `impulse_force := 320.0`, `cooldown_ms := 250`, `max_per_player := 8`.
  - `_wired_ready()`: на сервере `register_action("spawn_crate", _on_spawn_crate)`.
  - `_wired_unhandled_input(event)`: только локальный игрок, LMB pressed; `WiredAim.direction(player.get_anchor_position_2d(), mouse_world)`; `request_action("spawn_crate", {"direction": dir})`.
  - mouse_world: `get_viewport().get_canvas_transform().affine_inverse() * get_viewport().get_mouse_position()`.
  - `_on_spawn_crate(sender_peer, payload)`: server; direction validation (`is_finite`, length 0.1..1.0), cooldown, per-player limit; `player.spawn_dynamic("crate", {"position": anchor + dir * spawn_offset, "direction": dir, "owner_player_id": player.player_id})`.
- `crate.gd`:
  - `extends WiredDynamicEntity`; `@onready var body: RigidBody2D = $RigidBody2D`
  - `_wired_replicated_properties` not applicable; synchronizer on entity root with `RigidBody2D:position`, `RigidBody2D:rotation`, `RigidBody2D:linear_velocity`.
  - `_wired_apply_spawn(data)`: set position; if server `body.apply_central_impulse(data.direction * impulse_force)`; on client freeze.
  - `_wired_save_state`: `{position, rotation, linear_velocity}`.
  - `_wired_load_state`: set those values; no impulse.

- [ ] **Step 1: Write the failing tests**

`wired_aim_smoke.gd`:

```gdscript
func test_direction_normalizes_and_handles_zero() -> void:
    assert(WiredAim.direction(Vector2(10, 10), Vector2(10, 10)) == Vector2.RIGHT)
    assert(WiredAim.direction(Vector2.ZERO, Vector2(3, 4)) == Vector2(0.6, 0.8))
```

`dynamic_world_smoke.gd`: собрать registry с fixture `crate.tscn`, context `res://tests/fixtures/dynamic_root`, `DynamicWorldContainer.setup`, вызвать `spawn_entity("pkg.test/crate", {state: {...}, spawn_data: {"impulse": ...}})`, проверить child count/meta; `save_state` содержит `entity_id/type_id/state` и не содержит `spawn_data`; после `despawn` и `load_state` нет повторного импульса (fixture пишет счётчик импульсов в `user://` или в статическую переменную).

- [ ] **Step 2: Run tests to verify they fail**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/dynamic_world_smoke.gd --quit-after 2`

Expected: FAIL — `DynamicWorldContainer` не найден.

- [ ] **Step 3: Implement dynamic world and example crate**

`DynamicWorldContainer` создаёт `MultiplayerSpawner` в `setup`, `spawn_path = NodePath("..")`, `spawn_function = spawn_function`; `spawn_entity` server-only, получает descriptor из registry, генерирует `entity_id` (монотонный int), вызывает `spawner.spawn(data)`, сохраняет `_entities[entity_id]`.

`WiredDynamicEntity._wired_freeze_on_client` вызывать в `_ready` после `_wired_apply_spawn`, если `not multiplayer.is_server()`. Для `RigidBody2D`: `freeze = true`, `freeze_mode = RigidBody2D.FREEZE_MODE_STATIC`.

`crate.gd` реализует `_wired_replicated_properties() = ["RigidBody2D:position", "RigidBody2D:rotation", "RigidBody2D:linear_velocity"]`; `WiredDynamicEntity._ready()` создаёт synchronizer до применения spawn. `main_scene` вызывает `restore_pending` после `package_applied`; если запись ещё не восстановлена и её пакет не зарегистрирован, она остаётся в `_saved_dynamic_records` до следующего пакета.

`spawner.gd` server handler проверяет cooldown и лимит по `owner_player_id`; при ошибке `push_warning` и return. На клиенте LMB не отправляется, если игрок не локальный.

- [ ] **Step 4: Run tests to verify they pass**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/wired_aim_smoke.gd --quit-after 2`

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/dynamic_world_smoke.gd --quit-after 2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/scripts/world/dynamic_world_container.gd \
  packages/server/godot_project/_wired/scripts/world/wired_dynamic_entity.gd \
  packages/server/godot_project/_wired/scripts/players/wired_aim.gd \
  packages/server/godot_project/_wired/scripts/main_scene.gd \
  packages/server/godot_project/_wired/scripts/global/global.gd \
  packages/server/godot_project/_wired/tests/dynamic_world_smoke.gd \
  packages/server/godot_project/_wired/tests/wired_aim_smoke.gd \
  packages/server/godot_project/_wired/tests/fixtures/dynamic_root \
  packages/server/godot_project/examples/wired-platformer/dynamic \
  packages/server/godot_project/examples/wired-platformer/player/spawner.gd \
  packages/server/godot_project/examples/wired-platformer/player/spawner.tscn
git commit -m "feat(wired): add dynamic world and cursor impulse crate"
```

---

### Task 9: Example package entry, platform and README

**Files:**
- Create: `packages/server/godot_project/examples/wired-platformer/wired_package.gd`
- Create: `packages/server/godot_project/examples/wired-platformer/static/platform.tscn`
- Create: `packages/server/godot_project/examples/wired-platformer/README.md`
- Test: `_wired/tests/example_package_contract_smoke.gd` (проверяет только контракт entry на fixture, не внешний путь)

**Interfaces:**
- `wired_package.gd`:
  - `extends WiredPackageRegistration`
  - `register(registry)`:
    - `add_static_scene("static/platform.tscn", {"order": 10})`
    - `add_player_component("player/body.tscn", {"order": 10, "authority": "server"})`
    - `add_player_component("player/camera.tscn", {"order": 20, "authority": "local", "local_only": true})`
    - `add_player_component("player/spawner.tscn", {"order": 30, "authority": "server"})`
    - `add_dynamic_entity("crate", "dynamic/crate.tscn", {"authority": "server", "persist": true, "limit_per_player": 8})`
- `static/platform.tscn`: root `StaticBody2D`, child `Polygon2D` (платформа 640x32, цвет placeholder), child `CollisionShape2D` (`RectangleShape2D` 640x32); child `Marker2D` `Spawn` в группе `wired_player_spawn` с позицией над платформой.
- README: как создать пакет в комнате, скопировать файлы в `packages/<id>`, нажать Emit, открыть Game tab двумя клиентами; что должно работать.

- [ ] **Step 1: Write the failing contract test**

`example_package_contract_smoke.gd` проверяет fixture entry, который повторяет регистрации примера:

```gdscript
func test_example_contract_registers_all_kinds() -> void:
    var registry := WiredPackageRegistry.new()
    var context := WiredPackageContext.new()
    context.package_id = "pkg.example"
    context.root_path = "res://tests/fixtures/example_contract"
    var ok := PackageEntryLoader.load_entry("pkg.example", 1, context, registry)
    assert(ok)
    assert(registry.get_static_scenes().size() == 1)
    assert(registry.get_player_components().size() == 3)
    assert(registry.get_dynamic_entities().size() == 1)
```

Fixture `_wired/tests/fixtures/example_contract/wired_package.gd` содержит те же пять вызовов, что и пример; fixture scenes — пустые `Node`-сцены. Это проверяет контракт, не копируя пример в базовый проект.

- [ ] **Step 2: Run test to verify it fails**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/example_package_contract_smoke.gd --quit-after 2`

Expected: FAIL — fixture/entry отсутствует.

- [ ] **Step 3: Implement example package**

Создать `wired_package.gd`, `static/platform.tscn`, README. Проверить, что example-скрипты не объявляют `class_name` и не вызывают RPC.

- [ ] **Step 4: Run test and syntax checks**

Run: `godot --headless --path packages/server/godot_project/_wired --script res://tests/example_package_contract_smoke.gd --quit-after 2`

Run: `godot --headless --path packages/server/godot_project/_wired --check-only --script packages/server/godot_project/examples/wired-platformer/wired_package.gd`

Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/server/godot_project/_wired/tests/example_package_contract_smoke.gd \
  packages/server/godot_project/_wired/tests/fixtures/example_contract \
  packages/server/godot_project/examples/wired-platformer/wired_package.gd \
  packages/server/godot_project/examples/wired-platformer/static/platform.tscn \
  packages/server/godot_project/examples/wired-platformer/README.md
git commit -m "feat(example): add wired platformer package entry"
```

---

### Task 10: End-to-end verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-11-01-wired-room-content-packages-design.md` (только статус/фактические отклонения, если появились)
- Modify: `docs/superpowers/plans/2026-11-01-wired-room-content-packages.md` (отметить выполненные шаги)
- No product code unless verification finds a defect.

**Interfaces:**
- Consumes: все предыдущие задачи.
- Produces: подтверждённый сценарий «пакет опубликован → два клиента → движение, камера, толкание, краты с импульсом, рестарт». **Ручной сценарий двумя клиентами не выполнен** (см. Verification notes), автоматические проверки и экспорт — пройдены.

- [x] **Step 1: Run all automated checks**

Все команды `godot` ниже запускать только скачанным 4.7.2: `packages\server\godot_runtime\4.7.2-stable-win32-x64\Godot.exe`. Системный `godot` из PATH (4.6.2) не подходит: проект объявляет `config/features` `"4.7"`.

```bash
pnpm --filter server exec jest game-room.service.spec
pnpm --filter server test
godot --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/static_world_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/package_entry_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/network_readiness_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/players_manager_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/player_push_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/camera_follow_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/wired_aim_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/dynamic_world_smoke.gd --quit-after 2
godot --headless --path packages/server/godot_project/_wired --script res://tests/example_package_contract_smoke.gd --quit-after 2
```

Expected: Jest green; каждый Godot-скрипт печатает `ALL TESTS PASSED` и выходит с кодом 0.

- [x] **Step 2: Build the game export**

```bash
pnpm fetch:runtime
pnpm fetch:templates
pnpm export:game
```

Expected: `packages/server/game_export/web` обновлён, экспорт завершился без ошибок.

- [ ] **Step 3: Manual two-client multiplayer test**

1. Запустить `pnpm dev:server` и frontend на `:3001`.
2. Открыть комнату, вкладку Packages, создать пакет `wired-platformer`, скопировать файлы из `packages/server/godot_project/examples/wired-platformer` в `packages/<id>` через редактор, нажать Emit.
3. Открыть Game tab в двух окнах/профилях.
4. Проверить: у каждого игрока своя камера; движение и прыжок работают; игроки видят друг друга; при столкновении один толкает другого; ЛКМ спавнит квадрат из тела игрока в сторону курсора; квадрат имеет импульс; лимит 8 и cooldown 250 мс.
5. Перезапустить runtime (закрыть комнату/дождаться idle), открыть снова: динамические квадраты восстановлены на местах, без повторного импульса; игроки спавнятся после применения пакета.
6. Подключить третьего клиента позже: он получает текущие квадраты и игроков без дублей.

Expected: все пункты выполняются. Если late join не получает dynamic-сущности, добавить в Task 8 snapshot-синхронизацию и повторить.

> **Не выполнено (2026-11-01).** На стенде уже работали backend (`:3000`, `dist/server/src/main`) и frontend (`:3001`), Chrome был авторизован, публичная Godot-комната `godot test` (id 7) существовала. Однако шаг требует опубликовать новый пакет `wired-platformer` в общую БД (`DB_SYNC=1`, `packages/server/.env` → shared Postgres) и перенести файлы через WASM-редактор; одноразового окружения нет, поэтому данные общего стенда не изменялись. Два независимых клиента с одновременным вводом недоступны: автоматизация управляет одним Chrome-профилем и одной активной вкладкой. Подробные шаги и ожидаемые наблюдения — в разделе «Verification notes (2026-11-01)».

- [x] **Step 4: Commit verification notes**

```bash
git add docs/superpowers/plans/2026-11-01-wired-room-content-packages.md
git commit -m "docs: record room content package verification"
```

---

## Verification notes (2026-11-01)

Проверка выполнена на HEAD `70e88db` (Tasks 1–9). Godot: `4.7.2.stable.official.ed1daf0bf`,
исполняемый файл `C:\Users\hermit\webdev\Wired\packages\server\godot_runtime\4.7.2-stable-win32-x64\Godot.exe`
(установлен `pnpm fetch:runtime`; системный `godot` версии 4.6.2 не использовался).

- **Step 1 — автоматические проверки: PASS.**
  - `pnpm --filter server exec jest game-room.service.spec` — 1 suite / 19 tests, exit 0.
  - `pnpm --filter server test` — 31 suites passed, 1 skipped (`room-runtime.integration`), 320 tests passed,
    1 skipped, exit 0.
  - 11 headless-скриптов (`package_registry`, `scene_layout`, `static_world`, `package_entry`,
    `network_readiness`, `players_manager`, `player_push`, `camera_follow`, `wired_aim`, `dynamic_world`,
    `example_package_contract`) — каждый печатает `ALL TESTS PASSED` и выходит с кодом 0; всего 380 проверок.
- **Step 2 — Web export: PASS.**
  - `pnpm fetch:runtime` — 4.7.2-stable (win32-x64) уже установлен.
  - `pnpm fetch:templates` — Web-шаблоны 4.7.2-stable найдены в
    `C:\Users\hermit\AppData\Roaming\Godot\export_templates\4.7.2.stable`.
  - `pnpm export:game` — exit 0; экспорт собран скачанным `Godot.exe` **4.7.2** (в `packages/server/.env`
    `GODOT_RUNTIME_PATH` не задан, поэтому скрипт взял runtime из `runtime.json`); `packages/server/game_export/web`
    обновлён (`index.pck` 130 564 B, `index.wasm` 38 820 072 B).
  - `GET /game-export/index.html` на уже запущенном сервере — 200 с `Cross-Origin-Opener-Policy: same-origin`
    и `Cross-Origin-Embedder-Policy: require-corp`.
- **Step 3 — ручная проверка двумя клиентами: NOT EXECUTED.** Причины и ограничения стенда:
  - на момент проверки уже работали backend (`:3000`, `dist/server/src/main`) и frontend (`:3001`, Next),
    Chrome был авторизован, публичная Godot-комната `godot test` (id 7) существовала;
  - шаг требует создать и опубликовать пакет `wired-platformer` в общей БД (`DB_SYNC=1`, shared Postgres)
    и скопировать файлы через WASM-редактор; одноразового окружения нет, данные общего стенда не изменялись;
  - два независимых клиента с одновременным вводом недоступны **в рамках этой автоматизированной проверки**:
    Browser MCP управляет одним Chrome-профилем и одной активной вкладкой; две вкладки одного профиля не дают
    одновременный клавиатурный/мышиный ввод. Человек может выполнить шаг по инструкции ниже.
  - Оставшиеся шаги (самодостаточный прогон, не трогая shared Postgres):
    1. Поднять одноразовый локальный Postgres и прописать в `packages/server/.env` его
       `DB_HOST=localhost`, `DB_PORT=<локальный порт>`, `DB_SYNC=1` (плюс отдельные `DB_NAME`/`DB_USER`/
       `DB_PASSWORD`); shared instance из текущего `.env` не использовать. Затем `pnpm dev:server` и
       frontend на `:3001`.
    2. Создать свежую комнату типа `godot` (а не переиспользовать `godot test`, id 7, из shared БД) →
       **Packages** → создать `wired-platformer`, перенести файлы из
       `packages/server/godot_project/examples/wired-platformer` в `packages/<id>` через редактор, нажать **Emit**.
    3. Открыть **Game** tab в двух независимых авторизованных клиентах: обычное окно и incognito либо второй
       Chrome-профиль на `http://localhost:3001` (каждый клиент логинится отдельно и получает свой ticket).
    4. Проверить отдельные камеры, движение и прыжок, видимость игроков, толкание при столкновении, спавн
       квадрата ЛКМ из тела игрока в сторону курсора, наличие импульса, лимит 8 и cooldown 250 мс.
    5. Перезапустить runtime (закрыть комнату/дождаться idle) и открыть снова — квадраты восстановлены на
       местах без повторного импульса, игроки спавнятся после применения пакета.
    6. Подключить третьего клиента позже — он получает текущие квадраты и игроков без дублей.
  - Ожидаемые наблюдения совпадают с `Expected` шага 3. Автоматически косвенно покрыты: сохранение/восстановление
    без повторного импульса и порядок `restore_pending` (`dynamic_world_smoke`), толкание (`player_push_smoke`),
    камера (`camera_follow_smoke`), прицел и импульс (`wired_aim_smoke`), контракт примера
    (`example_package_contract_smoke`). Late join через `MultiplayerSpawner` остаётся непроверенным вживую.
- **Отклонения от спеки:** функциональных отклонений не обнаружено; статус спеки не менялся.
- **Известная проблема репозитория (не upstream Godot):** `packages/server/scripts/lib/runtime-install.mjs:132-134`
  переименовывает распакованный `Godot_v4.7.2-stable_win64.exe` в `Godot.exe`, но оставляет консольный launcher
  `Godot_v4.7.2-stable_win64_console.exe` искать старое companion-имя `Godot_v4.7.2-stable_win64.exe`, поэтому
  консольная обёртка не стартует. Это отклонение/known issue нашего репозитория, а не дефект дистрибутива Godot.
  `runtime.json`, сервер и все прогоны выше используют `Godot.exe` 4.7.2 и работают; при этом
  `GODOT_RUNTIME_PATH=<...>\Godot_v4.7.2-stable_win64_console.exe` на Windows сейчас сломан. Исправление
  установщика — отдельный follow-up; в Task 10 код не менялся.
- **`AGENTS.md` устарел:** там указано 31 suite / 314 tests, текущий прогон — 320 tests (1 skipped).
  `AGENTS.md` вне области Task 10 и не правился.

## Self-Review Notes

- Spec coverage: backend readiness (Task 1), registry/static world (Tasks 2–4), network readiness/actions (Task 5), player spawn/components (Task 6), body/camera/push (Task 7), dynamic world/crate/aim/save (Task 8), example package (Task 9), verification (Task 10).
- Type consistency: `WiredPackageRegistry` descriptors use `path`; `WiredPackageContext.instantiate(relative_path)`; `PlayersManager.build_player(data, registry)`; `DynamicWorldContainer.spawn_entity(qualified_type, data)`; `WiredPlayerComponent.request_action(local_name, payload)` квалифицирует действие, `WiredPlayer.request_action(qualified_action, payload)` принимает уже квалифицированное имя.
- Review Focus tests are placed in Task 1, Task 5/6, Task 8, and Task 10. Ручной сценарий двумя клиентами в Task 10 **не выполнен** — см. Verification notes; не считать его пройденным.
