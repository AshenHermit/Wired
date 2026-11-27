# Cura Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать пакет-библиотеку `cura_registry`: нейтральный слот кастомных записей в core, реестр prop/tool/category, панель на Q, `tool_manager` и расширяемый `hand_weapon` с встроенным spawner'ом.

**Architecture:** Core получает только generic `add_custom(kind, id, options)` с qualification и очисткой по пакету. Вся логика песочницы живёт в пакете `examples/cura_registry`: API регистрирует дескрипторы, `tool_manager` держит активный `hand_weapon` и маршрутизирует серверный action, а сам инструмент — player component со серверной логикой и клиентским вьюмоделем. Spawner — первый такой инструмент, `crate_prop_example` доказывает вызов библиотеки из чужого пакета.

**Tech Stack:** Godot 4.8-beta2, GDScript, headless smoke-тесты `SceneTree`; frontend/server/shared/БД не меняются.

**Spec:** `docs/superpowers/specs/2026-11-27-cura-registry-design.md`

## Global Constraints

- Godot строго 4.8-beta2. Все команды ниже из корня репозитория, `$GODOT`:
  ```powershell
  $GODOT = ".\packages\server\godot_runtime\4.8-beta2-win32-x64\Godot_v4.8-beta2_win64_console.exe"
  & $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/<name>.gd --quit-after 2
  ```
  Успех — `ALL TESTS PASSED` и exit code 0.
- В пакетных скриптах **запрещены** `class_name` и прямые RPC; только через `register_action`/`request_action`.
- Зависимости между пакетами пишутся как `res://packages/<slug>/...` и переписываются бэкендом; в smoke-тестах базового проекта таких путей нет, поэтому тесты используют копии-фикстуры в `tests/fixtures/cura_registry/` по образцу `example_package_contract_smoke.gd`. Фикстура и настоящий файл меняются в одной задаче. Реальные `res://packages/...` пути проверяются вручную после публикации.
- Идентификаторы записей квалифицируются как `<package_id>/<id>` (`WiredPackageRegistry.resolve_action`).
- Лимит `WiredPlayer.handle_action` — 20 actions/с на игрока; `cura_player` шлёт look ~15/с, поэтому темп стрельбы — **4 action/с** (debounce 0.25 с).
- Q регистрируется через `register_input_action` с `InputEventKey.physical_keycode = KEY_Q`; `project.godot` не трогаем.
- Серверный рейкаст: origin `player.get_anchor_position_3d() + Vector3(0, 1.6, 0)`, направление из реплицированных yaw/pitch `cura_player`, дистанция 64 м, маска — статика + динамические пропы (не игроки). Смещение спавна `normal * 0.05`. Клиентский `hit` сервером не используется.
- Группы: `cura_player_character`, `cura_registry_panel`, `cura_hand_weapon`. Список компонентов игрока — `player.components`.
- В core не добавляются имена `cura.*`: только generic ключи `KEY_ID`/`KEY_QUALIFIED_ID`.
- Русские комментарии/docs, UTF-8; идентификаторы и пути — английские. Коммиты — Conventional Commits.

## Review Focus

- Пакет выгрузился / обновился → кастомные записи этого пакета исчезли и восстановились, чужие не пострадали. Тест: `_test_custom_entries` в Task 1.
- Два пакета зарегистрировали одинаковый локальный `spawner` → квалифицированные id различны и не перезатирают друг друга. Тест: `_test_custom_entries_collision` в Task 1.
- Клик мыши до захвата указателя или при открытой панели → action не отправляется. Тест: `test_click_requires_capture_and_closed_panel` в Task 4.
- Игрок спамит ЛКМ → не более 4 `use_tool` action/с. Тест: `test_fire_rate_is_limited` в Task 4.
- Зарегистрированный инструмент выгрузился или его пакет обновился без повторной регистрации → менеджер не вызывает устаревший `wired_primary`, `active_tool_id` сбрасывается. Тест: `test_missing_weapon_disables_fire` в Task 4.

---

### Task 1: Generic custom entries в ядре реестра

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/wired_protocol.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/packages/wired_package_registration.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/package_registry.gd`
- Test: `packages/server/godot_project/_wired/tests/package_registry_smoke.gd`

**Interfaces:**
- Consumes: `WiredPackageRegistration._entries`, `WiredPackageRegistry.add_registration`, `_sorted_descriptors`, `_compare_descriptors`, `resolve_action`.
- Produces: `WiredProtocol.KEY_ID`, `KEY_QUALIFIED_ID`; `WiredPackageRegistration.add_custom(kind: String, local_id: String, options: Dictionary = {}) -> void`; `WiredPackageRegistry.get_entries(kind: String) -> Array[Dictionary]`, `find_entry(kind: String, qualified_id: String) -> Dictionary`; дескрипторы содержат `id`, `qualified_id`, `package_id`, `order`, `options`.

- [ ] **Step 1: Добавить падающие тесты**

В `_initialize()` добавить вызовы `_test_custom_entries()` и `_test_custom_entries_collision()`:

```gdscript
func _test_custom_entries() -> void:
	var registry := WiredPackageRegistry.new()
	var entry := WiredPackageRegistration.new()
	entry.package_id = "pkg.a"
	entry.add_custom("cura.tool", "spawner", {"order": 20, "label": "Toolgun"})
	entry.add_custom("cura.category", "tools", {"order": 10})
	registry.add_registration(entry)
	var tools := registry.get_entries("cura.tool")
	_check(tools.size() == 1, "one custom tool expected")
	_check(
		tools[0]["id"] == "spawner"
			and tools[0]["qualified_id"] == "pkg.a/spawner"
			and tools[0]["options"]["label"] == "Toolgun",
		"custom descriptor must carry id, qualified id and options",
	)
	_check(
		registry.find_entry("cura.tool", "pkg.a/spawner").get("qualified_id", "") == "pkg.a/spawner",
		"find_entry must resolve a qualified custom id",
	)
	_check(
		registry.get_entries("cura.category")[0]["id"] == "tools"
			and int(registry.get_entries("cura.category")[0]["order"]) == 10,
		"custom entries must use the existing deterministic sort",
	)
	_check(
		registry.get_player_components().is_empty()
			and registry.get_dynamic_entities().is_empty(),
		"custom entries must not leak into the four core lists",
	)
	registry.clear_package("pkg.a")
	_check(registry.get_entries("cura.tool").is_empty(), "clear_package must drop custom entries")
	registry.free()


func _test_custom_entries_collision() -> void:
	var registry := WiredPackageRegistry.new()
	var a := WiredPackageRegistration.new()
	a.package_id = "pkg.a"
	a.add_custom("cura.tool", "spawner", {})
	var b := WiredPackageRegistration.new()
	b.package_id = "pkg.b"
	b.add_custom("cura.tool", "spawner", {})
	registry.add_registration(a)
	registry.add_registration(b)
	var tools := registry.get_entries("cura.tool")
	_check(tools.size() == 2, "same local id in two packages must produce two entries")
	_check(
		tools[0]["qualified_id"] == "pkg.a/spawner"
			and tools[1]["qualified_id"] == "pkg.b/spawner",
		"custom ids must be qualified by package",
	)
	registry.free()
```

- [ ] **Step 2: Убедиться, что тест падает**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
```
Expected: FAIL — `add_custom`, `get_entries`, `find_entry` не существуют.

- [ ] **Step 3: Константы ключей**

В `wired_protocol.gd` рядом с `KEY_OPTIONS`:

```gdscript
const KEY_ID := "id"
const KEY_QUALIFIED_ID := "qualified_id"
```

- [ ] **Step 4: Хелпер регистрации**

В `wired_package_registration.gd`:

```gdscript
func add_custom(kind: String, local_id: String, options: Dictionary = {}) -> void:
	var entry := _entry(kind, "", options)
	entry[WiredProtocol.KEY_ID] = local_id
	_entries.append(entry)
```

Не добавлять новый `KIND_*`: `kind` — произвольная строка.

- [ ] **Step 5: qualification и геттеры реестра**

В `add_registration()` после существующей ветки `KIND_DYNAMIC`:

```gdscript
if descriptor.has(WiredProtocol.KEY_ID):
	descriptor[WiredProtocol.KEY_QUALIFIED_ID] = resolve_action(
		registration.package_id, str(descriptor.get(WiredProtocol.KEY_ID, ""))
	)
```

Добавить:

```gdscript
func get_entries(kind: String) -> Array[Dictionary]:
	return _sorted_descriptors(kind)

func find_entry(kind: String, qualified_id: String) -> Dictionary:
	for descriptor: Dictionary in get_entries(kind):
		if str(descriptor.get(WiredProtocol.KEY_QUALIFIED_ID, "")) == qualified_id:
			return descriptor
	return {}
```

Существующие `get_static_scenes()` и др. оставить как есть (можно сделать обёртками над `get_entries`).

- [ ] **Step 6: Прогнать тест**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
```
Expected: `PACKAGE_REGISTRY_SMOKE_OK`, `ALL TESTS PASSED`, exit 0.

- [ ] **Step 7: Commit**

```powershell
git add packages/server/godot_project/_wired/_wired/scripts/global/wired_protocol.gd packages/server/godot_project/_wired/_wired/scripts/packages/wired_package_registration.gd packages/server/godot_project/_wired/_wired/scripts/global/package_registry.gd packages/server/godot_project/_wired/tests/package_registry_smoke.gd
git commit -m "feat(wired): add generic custom entries to package registry"
```

---

### Task 2: API библиотеки `cura_registry`

**Files:**
- Create: `packages/server/godot_project/examples/cura_registry/api.gd`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/api.gd` (копия)
- Test: `packages/server/godot_project/_wired/tests/cura_registry_api_smoke.gd`

**Interfaces:**
- Consumes: Task 1 `add_custom`, `get_entries`, `WiredPackageContext.scene_path`.
- Produces: статические функции `Cura.register_category(registration: WiredPackageRegistration, local_id: String, options: Dictionary = {}) -> void`, `Cura.register_prop(registration, local_type: String, scene_path: String, options: Dictionary = {}) -> void`, `Cura.register_tool(registration, local_id: String, options: Dictionary = {}) -> void`, `Cura.resolve_path(package_id: String, relative_path: String) -> String`.

- [ ] **Step 1: Падающий smoke-тест**

Создать `cura_registry_api_smoke.gd` по образцу `fps_controller_smoke.gd`: хелпер `_example_path(relative)` через `ProjectSettings.globalize_path("res://").path_join("../examples/cura_registry")`, `load()` фикстурного `api.gd`. Проверки:

```gdscript
func test_register_prop_writes_both_descriptors() -> void:
	var reg := WiredPackageRegistration.new()
	reg.package_id = "pkg.crate"
	var api := load(_api_path())
	api.register_prop(reg, "crate", "dynamic/crate.tscn", {
		"category": "props", "label": "Wooden crate", "authority": "server", "persist": true,
	})
	var dynamics: Array = []  # собрать вручную из reg._entries по kind == "dynamic"
	var props: Array = []     # по kind == "cura.prop"
	_check(dynamics.size() == 1 and props.size() == 1, "prop must register two descriptors")
	_check(
		props[0]["id"] == "crate"
			and props[0]["options"]["dynamic_type"] == "crate"
			and props[0]["options"]["category"] == "props"
			and bool(props[0]["options"]["persist"]),
		"prop metadata must flow into the custom entry",
	)
	_check(str(dynamics[0]["path"]) == "dynamic/crate.tscn", "dynamic scene path preserved")


func test_category_and_tool_entries() -> void:
	var reg := WiredPackageRegistration.new()
	reg.package_id = "pkg.crate"
	var api := load(_api_path())
	api.register_category(reg, "props", {"label": "Props", "order": 10})
	api.register_tool(reg, "spawner", {"label": "Toolgun", "category": "tools"})
	# проверить по две записи kind "cura.category" / "cura.tool" и их options
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_registry_api_smoke.gd --quit-after 2
```
Expected: FAIL — `api.gd` не загружается / методы отсутствуют.

- [ ] **Step 3: Реализовать `api.gd`**

Сигнатуры ровно по Interfaces. `register_prop` вызывает `registration.add_dynamic_entity(local_type, scene_path, core_options)` с `authority` (по умолчанию `"server"`) и `persist`, затем `registration.add_custom("cura.prop", local_type, meta)`, где `meta` содержит `category`, `label`, `icon`, `order`, `tags`, `dynamic_type = local_type`, `persist`. `register_category`/`register_tool` пишут `"cura.category"`/`"cura.tool"`. `resolve_path` берёт `Global.get_package_registry().get_context(package_id).scene_path(relative_path)`. Скопировать файл в fixtures.

- [ ] **Step 4: Прогнать тест**

Run: тот же, что в Step 2. Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/cura_registry/api.gd packages/server/godot_project/_wired/tests/fixtures/cura_registry/api.gd packages/server/godot_project/_wired/tests/cura_registry_api_smoke.gd
git commit -m "feat(cura-registry): add registration API for props and tools"
```

---

### Task 3: Базовый скрипт `hand_weapon`

**Files:**
- Create: `packages/server/godot_project/examples/cura_registry/hand_weapon.gd`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/hand_weapon.gd` (копия)
- Test: `packages/server/godot_project/_wired/tests/cura_hand_weapon_smoke.gd`

**Interfaces:**
- Consumes: `WiredPlayerComponent`, Task 4 `manager.active_tool_id` (в тесте — stub).
- Produces: `hand_weapon.gd extends WiredPlayerComponent` без `class_name`; поля `@export var tool_id: String`, `@export var viewmodel_path: String`, `@export var requires_prop: bool = false`, `var manager: Node`; методы `wired_equip(ctx: Dictionary)`, `wired_unequip()`, `wired_primary(ctx: Dictionary)`, `wired_secondary(ctx: Dictionary)`, `wired_update(delta: float)`, `wired_visual_equip(active: bool)`, `wired_visual_update(delta: float, is_local: bool)`, `wired_save_state() -> Dictionary`, `wired_load_state(state: Dictionary)`. Базовый `_wired_visual_process` сам проверяет активность и вызывает `wired_visual_equip`/`wired_visual_update`.

- [ ] **Step 1: Падающий тест контракта**

В smoke-тесте через `load(abs path)` инстанцировать базовый скрипт и фикстурный скрипт-наследник с переопределённым `wired_primary` (записывает ctx) и `wired_visual_equip` (считает вызовы). Проверки:

```gdscript
func test_primary_receives_context() -> void:
	var weapon := _new_weapon()
	weapon.player = _stub_player()
	weapon.tool_id = "spawner"
	var ctx := {"hit": {"position": Vector3(1, 2, 3)}, "selected_prop": "pkg.crate/crate"}
	weapon.wired_primary(ctx)
	_check(weapon.last_ctx == ctx, "wired_primary must receive the server context")


func test_visual_hooks_follow_active_id() -> void:
	var weapon := _new_weapon()
	weapon.player = _stub_player()
	weapon.manager = _stub_manager_with_active("pkg.crate/spawner")
	weapon.tool_id = "spawner"
	weapon._wired_visual_process(0.016)
	_check(weapon.equip_calls == 1, "active weapon must be visually equipped once")
	weapon.manager.active_tool_id = ""
	weapon._wired_visual_process(0.016)
	_check(weapon.unequip_calls == 1, "inactive weapon must be visually unequipped")
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_hand_weapon_smoke.gd --quit-after 2
```
Expected: FAIL — скрипт/методы отсутствуют.

- [ ] **Step 3: Реализовать базовый скрипт**

`extends WiredPlayerComponent`. Все hooks по умолчанию пустые, `wired_save_state()` возвращает `{}`, `wired_load_state()` пустой. `_wired_save_state()`/`_wired_load_state()` делегируют в `wired_*`. `_wired_visual_process(delta)` сравнивает `manager.active_tool_id` с квалифицированным `package_id/tool_id` через экземпляр реестра (`resolve_action` не static: взять `Global.get_package_registry()`, при отсутствии — временный `WiredPackageRegistry.new()` с immediate `free()`); если `manager` null — неактивно. Вызывает `wired_visual_equip(true/false)` только при изменении и `wired_visual_update(delta, is_local_player())`, когда активно. `tool_id` в сцене — локальный (`"spawner"`), qualification делает менеджер. Скопировать в fixtures.

- [ ] **Step 4: Прогнать тест**

Run: как Step 2. Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/cura_registry/hand_weapon.gd packages/server/godot_project/_wired/tests/fixtures/cura_registry/hand_weapon.gd packages/server/godot_project/_wired/tests/cura_hand_weapon_smoke.gd
git commit -m "feat(cura-registry): add hand weapon base component"
```

---

### Task 4: `tool_manager` — активный инструмент и серверный action

**Files:**
- Create: `packages/server/godot_project/examples/cura_registry/tools/tool_manager.tscn`
- Create: `packages/server/godot_project/examples/cura_registry/tools/tool_manager.gd`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/tool_manager.tscn` + `.gd` (копии)
- Test: `packages/server/godot_project/_wired/tests/cura_tool_manager_smoke.gd`

**Interfaces:**
- Consumes: Task 1 `find_entry("cura.tool"/"cura.prop")`, `find_dynamic_entity`, `WiredPlayer.register_action/request_action`, `WiredPlayerComponent._wired_unhandled_input`; Task 3 `hand_weapon.wired_primary(ctx)`, `requires_prop`.
- Produces: `tool_manager.gd extends WiredPlayerComponent`, `const ACTION_USE := "use_tool"`, поля `selected_tool: String`, `selected_prop: String`, `active_tool_id: String`, `panel_open: bool`; методы `set_active(tool_id: String, prop_id: String) -> void`, `spawn_prop(qualified_type: String, position: Vector3) -> Node`, `server_raycast() -> Dictionary`, `now_msec() -> int`, `_on_use_tool(sender_peer: int, payload: Dictionary) -> void`. Персонаж ищется по группе `cura_player_character` и должен иметь `is_look_captured() -> bool`, `replicated_yaw`, `replicated_pitch`.

- [ ] **Step 1: Падающие тесты**

Stub `WiredPlayer`: `is_server_authority() == true`, `is_local_player() == true`, `register_action` (сохраняет handler), `request_action` (сохраняет payload), `components`, `get_anchor_position_3d()`. Stub weapon: наследует фикстурный `hand_weapon.gd`, в группе `cura_hand_weapon`, `package_id = "pkg.crate"`, `tool_id = "spawner"`, `requires_prop = true`, считает `wired_primary`. Stub персонажа — `Node` в группе `cura_player_character` со скриптом `var captured: bool`, `var replicated_yaw: float = 0.0`, `var replicated_pitch: float = 0.0`, `func is_look_captured() -> bool: return captured`; хелпер `_add_character(captured: bool) -> Node` добавляет его в дерево и возвращает. Inner class `StubManager extends "res://tests/fixtures/cura_registry/tool_manager.gd"` с `var clock_msec: int = 0`, `func now_msec() -> int: return clock_msec` и `var raycast_hit: Dictionary = {}`, `func server_raycast() -> Dictionary: return raycast_hit`. Проверки:

```gdscript
func test_click_requires_capture_and_closed_panel() -> void:
	var manager := _new_manager(true)  # is_server_authority() == true
	manager.player = _stub_player()
	_add_character(true)
	manager._wired_unhandled_input(_lmb_press())  # без экипированного инструмента
	_check(manager.player.sent_actions.is_empty(), "click without an equipped tool must not fire")
	manager.set_active("pkg.crate/spawner", "pkg.crate/crate")
	manager.panel_open = true
	manager._wired_unhandled_input(_lmb_press())
	_check(manager.player.sent_actions.is_empty(), "open panel must swallow clicks")
	manager.panel_open = false
	var character := _add_character(false)
	manager._wired_unhandled_input(_lmb_press())  # без захвата
	_check(manager.player.sent_actions.is_empty(), "uncaptured click must not fire")
	character.captured = true
	manager._wired_unhandled_input(_lmb_press())
	_check(manager.player.sent_actions.size() == 1, "captured click must fire")


func test_fire_rate_is_limited() -> void:
	var manager := StubManager.new()
	manager.player = _stub_player()
	manager.panel_open = false
	_add_character(true)
	manager.set_active("pkg.crate/spawner", "pkg.crate/crate")
	for i in 20:
		manager.clock_msec = i * 50
		manager._wired_unhandled_input(_lmb_press())
	_check(manager.player.sent_actions.size() == 4, "fire rate must stay at 4/s")


func test_missing_weapon_disables_fire() -> void:
	manager.set_active("pkg.crate/spawner", "pkg.crate/crate")
	manager.player.components.clear()
	manager._on_use_tool(2, {"tool": "pkg.crate/spawner", "prop": "pkg.crate/crate"})
	_check(weapon.primary_calls == 0, "unknown weapon must not be invoked")


func test_valid_action_dispatches_trusted_context() -> void:
	# зарегистрировать prop в stub registry, добавить weapon в player.components
	var manager := StubManager.new()
	manager.player = _stub_player()
	var hit := {"position": Vector3(1, 1, 1), "normal": Vector3(0, 1, 0)}
	manager.raycast_hit = hit
	manager._on_use_tool(2, {"tool": "pkg.crate/spawner", "prop": "pkg.crate/crate", "hit": Vector3(99, 99, 99)})
	_check(weapon.primary_calls == 1, "valid action must call wired_primary")
	_check(weapon.last_ctx["hit"] == hit, "client hit must never be used as the authoritative hit")
	manager.raycast_hit = {}
	manager._on_use_tool(2, {"tool": "pkg.crate/spawner", "prop": "pkg.crate/crate"})
	_check(weapon.primary_calls == 1, "no server hit means no use")
```

Дополнительно проверить в любом тесте с `set_active`: найденный weapon получил `manager == manager`, иначе `wired_visual_equip` никогда не сработает в реальной игре.

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_tool_manager_smoke.gd --quit-after 2
```
Expected: FAIL — менеджер не существует.

- [ ] **Step 3: Реализовать менеджер**

- `_wired_ready`: если `is_server()` → `register_action(ACTION_USE, _on_use_tool)`; если `is_local_player()` → найти панель в `player.components` по группе `cura_registry_panel`, подключиться к `prop_selected`/`tool_selected`.
- `_wired_unhandled_input`: только `is_local_player()`; LMB pressed; `not panel_open`; `active_tool_id` непустой (инструмент экипирован); `character.is_look_captured()` через группу `cura_player_character` (если персонажа нет — false); debounce 0.25 с; `request_action(ACTION_USE, {"tool": selected_tool, "prop": selected_prop, "hit": локальный raycast})`.
- `set_active`: вернуть `selected_tool`/`selected_prop`, найти weapon в `player.components` по group + qualification `resolve_action(weapon.package_id, weapon.tool_id)`, установить `active_tool_id`, выставить `weapon.manager = self` у найденного инструмента (и сбросить `manager` у снятого), иначе `hand_weapon._wired_visual_process` не увидит активный tool и вьюмодель не появится; на сервере вызвать `wired_unequip()` старого и `wired_equip(ctx)` нового.
- `_on_use_tool`: проверить `sender_peer == player.peer_id`, найти weapon по `payload.tool`, если `requires_prop` — проверить `find_entry("cura.prop", payload.prop)` и `find_dynamic_entity(payload.prop)`; построить `hit = server_raycast()` и при пустом `hit` **не вызывать** инструмент (spec: No hit → no use); иначе `ctx = {"player": player, "manager": self, "hit": hit, "selected_prop": payload.prop, "payload": payload}` и вызвать `wired_primary(ctx)`.
- `server_raycast()`: origin `player.get_anchor_position_3d() + Vector3(0, 1.6, 0)`, направление из `replicated_yaw`/`replicated_pitch` персонажа группы `cura_player_character`, `PhysicsDirectSpaceState3D.intersect_ray` с `max_distance = 64.0`, маска статика+динамика, исключить player bodies. Возвращать `{}` при промахе или отсутствии персонажа.
- `now_msec() -> int`:(base) `return Time.get_ticks_msec()`; единственный источник времени для debounce 0.25 с в `_wired_unhandled_input`, чтобы тест мог подменить часы.
- `spawn_prop`: `Global.dynamic_world.spawn_entity(qualified_type, {"position": position, "owner_player_id": player.peer_id})`.
- `_wired_replicated_properties()` → `["selected_tool", "selected_prop", "active_tool_id"]`; `_wired_save_state`/`_wired_load_state` хранят те же строки.
- Сцена: корень `Node3D` со скриптом; скопировать оба файла в fixtures.

- [ ] **Step 4: Прогнать тест**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_tool_manager_smoke.gd --quit-after 2
```
Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/cura_registry/tools packages/server/godot_project/_wired/tests/fixtures/cura_registry/tool_manager.tscn packages/server/godot_project/_wired/tests/fixtures/cura_registry/tool_manager.gd packages/server/godot_project/_wired/tests/cura_tool_manager_smoke.gd
git commit -m "feat(cura-registry): add tool manager with server-side dispatch"
```

---

### Task 5: Панель реестра на Q

**Files:**
- Create: `packages/server/godot_project/examples/cura_registry/ui/registry_panel.tscn`
- Create: `packages/server/godot_project/examples/cura_registry/ui/registry_panel.gd`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/registry_panel.tscn` + `.gd` (копии)
- Test: `packages/server/godot_project/_wired/tests/cura_registry_panel_smoke.gd`

**Interfaces:**
- Consumes: Task 1 `get_entries("cura.category"|"cura.prop"|"cura.tool")`, `WiredPlayerComponent.register_input_action`.
- Produces: `registry_panel.gd extends WiredPlayerComponent`, сигналы `prop_selected(qualified_type: String)`, `tool_selected(qualified_tool: String)`, `set_registry(registry: WiredPackageRegistry) -> void`, `rebuild() -> void`, `is_open() -> bool`, `toggle() -> void`.

- [ ] **Step 1: Падающий тест**

Stub registry с тремя вызовами `get_entries`: категория `props`, prop `pkg.crate/crate` (`options.order = 10`, `options.category = "props"`, `options.label = "Crate"`), tool `pkg.crate/spawner` (`options.order = 20`, `options.category = "tools"`, `options.label = "Toolgun"`). Так `select_item(0)` детерминированно выбирает prop. Проверки:

```gdscript
func test_panel_builds_categories_and_emits_selection() -> void:
	var panel := _new_panel()
	panel.player = _stub_player()
	panel.set_registry(_stub_registry())
	panel.rebuild()
	_check(panel.item_count() == 2, "panel must list one prop and one tool")
	var seen: Array = []
	panel.prop_selected.connect(func(value): seen.append(value))
	panel.select_item(0)
	_check(seen == ["pkg.crate/crate"], "selection must emit a qualified prop id")


func test_toggle_releases_and_restores_pointer() -> void:
	panel.toggle()
	_check(panel.is_open(), "first toggle must open")
	panel.toggle()
	_check(not panel.is_open(), "second toggle must close")
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_registry_panel_smoke.gd --quit-after 2
```
Expected: FAIL — панель не загружается.

- [ ] **Step 3: Реализовать панель**

- Корень `CanvasLayer`; `register_input_action("cura_panel", [InputEventKey with physical_keycode KEY_Q])` в `_wired_ready`; `is_action_just_pressed("cura_panel")` в `_wired_process`.
- `rebuild()` берёт `get_entries` из инжектированного реестра (в проде — `Global.get_package_registry()` в `_wired_ready`), группирует по `options.category`, сортирует по `order` затем `label`, неизвестные категории — в fallback.
- `toggle()`: открыть → `MOUSE_MODE_VISIBLE`, закрыть → вернуть `MOUSE_MODE_CAPTURED`, если до открытия был capture; на web использовать локальный флаг как в `cura_player`.
- `select_item(index)` испускает сигнал с `qualified_id` и закрывает панель; `package_applied` вызывает `rebuild()` через `call_deferred`.
- Скопировать оба файла в fixtures.

- [ ] **Step 4: Прогнать тест**

Run: как Step 2. Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/cura_registry/ui packages/server/godot_project/_wired/tests/fixtures/cura_registry/registry_panel.tscn packages/server/godot_project/_wired/tests/fixtures/cura_registry/registry_panel.gd packages/server/godot_project/_wired/tests/cura_registry_panel_smoke.gd
git commit -m "feat(cura-registry): add Q panel driven by registered entries"
```

---

### Task 6: Mount и accessors в `cura_player`

**Files:**
- Modify: `packages/server/godot_project/examples/cura_player/player/character.gd`
- Modify: `packages/server/godot_project/examples/cura_player/player/player_character.tscn`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_player/character.gd` (копия), `character_model_stub.gd`, `player_model_ready.tscn` (фикстуры для smoke-теста)
- Test: `packages/server/godot_project/_wired/tests/fps_controller_smoke.gd`

**Interfaces:**
- Consumes: существующий `arm_camera_container: SubViewport`, `is_look_captured()` flag, replicated yaw/pitch.
- Produces: `@export var tool_mount: Node3D`, `func equip_viewmodel(scene: PackedScene) -> Node`, `func clear_viewmodel() -> void`, `func get_first_person_camera() -> Camera3D`, `func is_look_captured() -> bool`.

- [ ] **Step 1: Падающие тесты**

Сцена `cura_player` ссылается на `res://packages/cura_player/...`, недоступный в базовом проекте, поэтому `_load_character()` в этом smoke подменяет только два `ext_resource` (скрипт → байт-идентичная фикстура, тяжёлый glb → лёгкая заглушка), сохраняя граф реальной сцены; иначе проверки молча пропускаются. Устаревшие ожидания smoke адаптируются под реальную структуру.

Добавить в `_run()` и реализовать:

```gdscript
func test_hand_weapon_mount_contract() -> void:
	var character := _load_character()
	if character == null:
		return
	_check(character.has_method("get_first_person_camera"), "character must expose its camera")
	_check(character.has_method("equip_viewmodel"), "character must accept a viewmodel")
	_check(character.has_method("clear_viewmodel"), "character must clear a viewmodel")
	_check(character.has_method("is_look_captured"), "character must expose capture state")
	_check(character.tool_mount != null, "tool_mount must be exported and wired")
	_check(
		character.tool_mount.get_parent() == character.arm_camera_container,
		"tool_mount must live inside arm_camera_container",
	)
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/fps_controller_smoke.gd --quit-after 2
```
Expected: FAIL — методов/экспорта нет.

- [ ] **Step 3: Реализовать контракт**

В `player_character.tscn` добавить `Node3D` с именем `ToolMount` внутри `arm_camera_container`. В `character.gd`: `@export var tool_mount: Node3D`, `@export var arm_camera_container: SubViewport` (если отсутствует), `get_first_person_camera()` returns `camera_container`/`Camera3D`, `equip_viewmodel(scene)` очищает предыдущий ребёнок и инстанцирует scene в `tool_mount`, `clear_viewmodel()` освобождает.children, `is_look_captured()` возвращает `_look_captured` с web-проверкой как в `look_is_active`. Не добавлять зависимость от скриптов `cura_registry`.

- [ ] **Step 4: Прогнать тест**

Run: как Step 2. Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/cura_player/player/character.gd packages/server/godot_project/examples/cura_player/player/player_character.tscn packages/server/godot_project/_wired/tests/fps_controller_smoke.gd
git commit -m "feat(cura-player): expose hand weapon mount and camera accessors"
```

---

### Task 7: Встроенный инструмент `spawner`

**Files:**
- Create: `packages/server/godot_project/examples/cura_registry/tools/spawner.tscn`
- Create: `packages/server/godot_project/examples/cura_registry/tools/spawner.gd`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/spawner.tscn` + `.gd` (копии)
- Test: `packages/server/godot_project/_wired/tests/cura_spawner_smoke.gd`

**Interfaces:**
- Consumes: Task 3 `hand_weapon`, Task 4 `ctx` и `manager.spawn_prop`.
- Produces: `spawner.gd extends hand_weapon.gd` (через `extends "res://packages/cura_registry/hand_weapon.gd"` в настоящем файле, через fixture-путь в тесте); `tool_id = "spawner"`, `requires_prop = true`, `wired_primary(ctx)` вызывает `ctx.manager.spawn_prop(ctx.selected_prop, ctx.hit.position + ctx.hit.normal * 0.05)`.

- [ ] **Step 1: Падающий тест**

```gdscript
func test_spawner_uses_trusted_hit() -> void:
	var weapon := _load_spawner()
	weapon.player = _stub_player()
	var manager := _stub_manager()  # записывает spawn_calls
	var ctx := {
		"manager": manager,
		"selected_prop": "pkg.crate/crate",
		"hit": {"position": Vector3(1, 2, 3), "normal": Vector3(0, 1, 0)},
	}
	weapon.wired_primary(ctx)
	_check(manager.spawn_calls.size() == 1, "spawner must spawn once")
	_check(
		manager.spawn_calls[0]["type"] == "pkg.crate/crate"
			and manager.spawn_calls[0]["position"].is_equal_approx(Vector3(1, 2.05, 3)),
		"spawn must use the trusted hit plus surface offset",
	)
	_check(weapon.requires_prop, "spawner requires a selected prop")
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_spawner_smoke.gd --quit-after 2
```
Expected: FAIL — сцена/скрипт не загружается.

- [ ] **Step 3: Реализовать spawner**

Сцена: корень `Node3D` со скриптом, дочерний `Node3D` с простым mesh-«пистолетом» как вьюмодель. `viewmodel_path` указывает на этот mesh. `wired_primary(ctx)` — ровно вызов по Interfaces, без обращения к `Global` напрямую. Скопировать файлы в fixtures.

- [ ] **Step 4: Прогнать тест**

Run: как Step 2. Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/cura_registry/tools/spawner.tscn packages/server/godot_project/examples/cura_registry/tools/spawner.gd packages/server/godot_project/_wired/tests/fixtures/cura_registry/spawner.tscn packages/server/godot_project/_wired/tests/fixtures/cura_registry/spawner.gd packages/server/godot_project/_wired/tests/cura_spawner_smoke.gd
git commit -m "feat(cura-registry): add spawner hand weapon"
```

---

### Task 8: Демо-пакет `crate_prop_example`

**Files:**
- Create: `packages/server/godot_project/examples/crate_prop_example/wired_package.gd`
- Create: `packages/server/godot_project/examples/crate_prop_example/dynamic/crate.tscn`
- Create: `packages/server/godot_project/examples/crate_prop_example/README.md`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/crate_entry.gd`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/wired_package.gd` (однострочный shim `extends "res://tests/fixtures/cura_registry/crate_entry.gd"`: `PackageEntryLoader` ищет entry только по имени `wired_package.gd`)
- Test: `packages/server/godot_project/_wired/tests/cura_prop_example_smoke.gd`

**Interfaces:**
- Consumes: Task 2 API, `WiredDynamicEntity`.
- Produces: entry, который вызывает `Cura.register_category(...)`, `Cura.register_prop(self, "crate", "dynamic/crate.tscn", {...})`; сцена `dynamic/crate.tscn` с root `RigidBody3D`, скриптом `extends WiredDynamicEntity`, box mesh/collision.

- [ ] **Step 1: Падающий тест**

`PackageEntryLoader.load_entry("pkg.crate", 1, context, registry)` на фикстурном `crate_entry.gd`, где вызов API идёт через фикстурный `api.gd` (absolute path), а не `res://packages/...`. Проверки:

```gdscript
func test_example_registers_cross_package_prop() -> void:
	var registry := WiredPackageRegistry.new()
	var context := WiredPackageContext.new()
	context.package_id = "pkg.crate"
	context.root_path = _fixture_root()
	_check(PackageEntryLoader.load_entry("pkg.crate", 1, context, registry), "entry must load")
	var entities := registry.get_dynamic_entities()
	var props := registry.get_entries("cura.prop")
	_check(entities.size() == 1 and props.size() == 1, "crate must be registered twice")
	_check(
		entities[0]["qualified_type"] == "pkg.crate/crate"
			and props[0]["qualified_id"] == "pkg.crate/crate",
		"both descriptors must share the qualified id",
	)
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_prop_example_smoke.gd --quit-after 2
```
Expected: FAIL — entry/сцена отсутствуют.

- [ ] **Step 3: Реализовать пакет**

`wired_package.gd` с `const Cura = preload("res://packages/cura_registry/api.gd")` и вызовами по Interfaces. `crate.tscn`: `RigidBody3D` + `BoxShape3D` + `MeshInstance3D` с кубом, rootscript `extends WiredDynamicEntity`, `mass = 1` (инлайн-скрипт в сцене допустим). README — минимальный пример вызова. Создать фикстурный entry `crate_entry.gd` с теми же вызовами, но `load(absolute api.gd)`, и однострочный shim `wired_package.gd`, его расширяющий, — loader требует именно это имя файла.

- [ ] **Step 4: Прогнать тест**

Run: как Step 2. Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/server/godot_project/examples/crate_prop_example packages/server/godot_project/_wired/tests/fixtures/cura_registry/crate_entry.gd packages/server/godot_project/_wired/tests/fixtures/cura_registry/wired_package.gd packages/server/godot_project/_wired/tests/cura_prop_example_smoke.gd
git commit -m "feat(examples): add crate prop package for cura registry"
```

---

### Task 9: Entry пакета `cura_registry`, README и интегральная проверка

**Files:**
- Create: `packages/server/godot_project/examples/cura_registry/wired_package.gd`
- Create: `packages/server/godot_project/examples/cura_registry/README.md`
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/library_entry.gd` (фикстура entry)
- Create: `packages/server/godot_project/_wired/tests/fixtures/cura_registry/library/wired_package.gd` (шима: `PackageEntryLoader` ищет entry только с именем `wired_package.gd`; корневой шим занят фикстурой Task 8)
- Test: `packages/server/godot_project/_wired/tests/cura_registry_api_smoke.gd` + все smoke-тесты + ручной сценарий в Game tab

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces: entry, регистрирующий `"cura.category"` `props`/`tools`, `spawner` tool, панель (`order 40`, `authority "local"`, `local_only true`), `tool_manager` (`order 50`, `authority "server"`), spawner weapon (`order 60`, `authority "server"`). README с двумя примерами: регистрация prop и регистрация своего hand weapon.

- [ ] **Step 1: Падающая проверка контракта entry**

Добавить в `cura_registry_api_smoke.gd` тест фикстурного entry (фикстура повторяет регистрации настоящего `wired_package.gd`):

```gdscript
func test_library_entry_registers_ui_and_server_components() -> void:
	# PackageEntryLoader на фикстурном entry
	var components := registry.get_player_components()
	_check(components.size() == 3, "panel, manager and spawner must be registered")
	_check(
		components[0]["path"] == "ui/registry_panel.tscn"
			and bool(components[0]["local_only"])
			and str(components[0]["authority"]) == "local",
		"panel must be local-only",
	)
	_check(
		components[1]["path"] == "tools/tool_manager.tscn"
			and str(components[1]["authority"]) == "server",
		"manager must be server-authority",
	)
	_check(str(components[2]["path"]) == "tools/spawner.tscn", "spawner weapon must be registered")
```

- [ ] **Step 2: Запустить, увидеть падение**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/cura_registry_api_smoke.gd --quit-after 2
```
Expected: FAIL.

- [ ] **Step 3: Написать entry и README**

`wired_package.gd` по Interfaces, `extends WiredPackageRegistration`, `register(registry)` только через `Cura.*` и `add_player_component`. Фикстура entry — `library_entry.gd` плюс шим `library/wired_package.gd`, потому что `PackageEntryLoader` ищет файл с именем `wired_package.gd`, а корневой шим занят фикстурой Task 8. README на русском: подключение зависимости, `register_prop`, `register_tool`, пример кастомного hand weapon, правила authority и группы, ограничение 4 action/с; сценарий ручной проверки в Game tab помечать как ожидающий проверки человеком (в изолированном ворктри паблишинг пакетов недоступен).

- [ ] **Step 4: Прогнать все smoke-тесты**

Run:
```powershell
$tests = @("package_registry_smoke", "cura_registry_api_smoke", "cura_hand_weapon_smoke", "cura_tool_manager_smoke", "cura_registry_panel_smoke", "fps_controller_smoke", "cura_spawner_smoke", "cura_prop_example_smoke")
foreach ($t in $tests) { & $GODOT --headless --path packages/server/godot_project/_wired --script "res://tests/$t.gd" --quit-after 2; if ($LASTEXITCODE -ne 0) { throw "FAILED: $t" } }
```
Expected: все тесты пишут `ALL TESTS PASSED`, exit 0.

- [ ] **Step 5: Ручная проверка в Game tab**

Опубликовать через Packages tab три пакета в одну комнату: `cura_registry`, `cura_player`, `crate_prop_example`. Проверить: Q открывает/закрывает панель; указатель возвращается в capture; выбор crate экипирует вьюмодель spawner; ЛКМ создаёт ящик на полу; ящик виден второму клиенту и сохраняется после hot-reload `crate_prop_example`. При провале — зафиксировать лог и вернуться к владельцу задачи.

- [ ] **Step 6: Commit**

```powershell
git add packages/server/godot_project/examples/cura_registry packages/server/godot_project/_wired/tests/cura_registry_api_smoke.gd packages/server/godot_project/_wired/tests/fixtures/cura_registry
git commit -m "feat(cura-registry): wire the library package and document usage"
```
