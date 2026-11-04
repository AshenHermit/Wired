# Кастомная main-сцена пакета Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пакет может заменить `Main/Game` своей сценой с собственным UI, а ядро переносит в её `SubViewport` живые `StaticWorld`, `DynamicWorld` и `Players`, не пересоздавая сеть, реестр и состояние игроков.

**Architecture:** Пакет регистрирует main-сцену через `add_main_scene()`; реестр отдаёт первый дескриптор в детерминированном порядке. `main_scene.gd` больше не использует `$`-пути: все сервисы и UI приходят через `@export`, а штатный `Game` остаётся отсоединённым fallback-корнем. При смене ключа `<package_id>:<path>:<revision>:<artifact_key>` ядро снимает сервисы со старого viewport, заменяет `Game` на новый корень и переносит сервисы в его `world_viewport`.

**Tech Stack:** Godot 4.8-beta2, GDScript, headless smoke-тесты `SceneTree`; без изменений frontend/server/shared/БД.

**Spec:** `docs/superpowers/specs/2026-11-04-custom-main-game-scene-design.md`

## Global Constraints

- Godot строго 4.8-beta2. Команды ниже используют `$GODOT`:
  ```powershell
  $GODOT = ".\packages\server\godot_runtime\4.8-beta2-win32-x64\Godot_v4.8-beta2_win64_console.exe"
  ```
- Headless smoke-тест запускается так:
  ```powershell
  & $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/<name>.gd --quit-after 2
  ```
  Успех — строка `ALL TESTS PASSED` и exit code 0.
- После Task 3 в `main_scene.gd` не должно остаться `$Game`, `$UI`, `$Net` и других путей к узлам сцены. `get_node_or_null("/root/Global")` в пакетных скриптах — autoload, его не трогаем.
- Обязательные экспорты `main_scene.gd`: `default_game_root`, `net`, `ui`, `status_label`, `log_label`, `static_world`, `dynamic_world`, `dynamic_spawner`, `players_manager`, `players_spawner`. Имя `players_manager`, а не `players`: в `main_scene.gd` уже есть локальные `players`, которые затенят экспорт.
- Диагностики: `WIRED_MAIN_SCENE_MISSING_EXPORT name=<field>`, `WIRED_MAIN_SCENE_INVALID package=<id> path=<path> reason=not_wired_game_scene|missing_world_viewport`, `WIRED_MAIN_SCENE_INSTANTIATE_FAILED package=<id> path=<path>`, `WIRED_MAIN_SCENE_MULTIPLE package=<id> ignored=<n>`.
- Штатный `Main/Game` при замене снимается с дерева, но **не освобождается**; при удалении main-сцены возвращается на прежний индекс.
- Кастомная сцена сохраняет свои `mouse_filter`; принудительный `MOUSE_FILTER_IGNORE` применяется только к `Main/UI`.
- Порядок реестра детерминирован: package id (числом, если числовой), затем `order`, затем `registration_index`.
- UI/docs — по-русски, UTF-8. Код, идентификаторы и пути — по-английски. Каждая задача заканчивается коммитом Conventional Commits.

## Review Focus

1. **Живая сессия при замене сцены.** Игроки и динамические сущности не теряются: экземпляры `static_world`, `dynamic_world`, `players_manager` и их спавнеров остаются теми же, а спавн продолжается уже в новом `world_viewport`.
2. **Битая main-сцена.** Корень без `WiredGameScene`, пустой `world_viewport` или несуществующий файл не роняют runtime: комната остаётся на текущей сцене, а после исправления пакета замена повторяется.
3. **Удаление пакета и публикация ревизии.** При удалении main-сцены возвращается штатный `Game` на прежнее место; при новой ревизии сцена пересобирается, старый кастомный корень не остаётся в дереве и не перехватывает ввод.
4. **Несколько регистраций и несколько SubViewport.** Побеждает первый дескриптор в порядке реестра; сервисы попадают именно в `world_viewport`, а не в первый `SubViewport` сцены.
5. **Ввод в кастомном UI.** Кнопки/панели пакетной сцены сохраняют `MOUSE_FILTER_STOP` и кликаются, тогда как `Main/UI` по-прежнему игнорирует мышь, чтобы клики доходили до игрового viewport.

---

### Task 0: Привести раскладку к зелёному baseline

Сейчас `scene_layout_smoke.gd` красный: сцена в `main.tscn` намеренно изменилась в `ee0916f`, а тест остался от `8da30ef`. Это не часть фичи, но без зелёного baseline нельзя проверять следующие задачи.

**Files:**
- Modify: `packages/server/godot_project/_wired/tests/scene_layout_smoke.gd`

**Interfaces:**
- Consumes: ничего.
- Produces: зелёный `scene_layout_smoke.gd`, который проверяет авторскую сцену, а не старые значения.

- [ ] **Step 1: Исправить устаревшие проверки**

Замени проверку `handle_input_locally` (строки 64–67) на авторское значение:

```gdscript
		_check(
			not viewport.handle_input_locally,
			"the SubViewport must forward input to the parent viewport",
		)
```

Удали блок с точным сравнением альфы с `0.35` (строки 111–115). Проверка `background.color.a < 1.0` выше остаётся единственной.

- [ ] **Step 2: Запустить тест**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
```
Expected: `SCENE_LAYOUT_SMOKE_OK checks=...` и `ALL TESTS PASSED`, exit 0.

- [ ] **Step 3: Commit**

```powershell
git add packages/server/godot_project/_wired/tests/scene_layout_smoke.gd
git commit -m "test(wired): align layout smoke with authored main scene"
```

---

### Task 1: Контракт `WiredGameScene` и штатный `Game`

**Files:**
- Create: `packages/server/godot_project/_wired/_wired/scripts/world/wired_game_scene.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scenes/main.tscn`
- Test: `packages/server/godot_project/_wired/tests/scene_layout_smoke.gd`

**Interfaces:**
- Consumes: ничего.
- Produces: глобальный класс `WiredGameScene` с `@export var world_viewport: SubViewport`; штатный `Main/Game` использует этот скрипт и указывает на `Game/SubViewport`.

- [ ] **Step 1: Написать падающую проверку**

В `scene_layout_smoke.gd` добавь preload рядом с константами:

```gdscript
const GAME_SCENE_SCRIPT := preload("res://_wired/scripts/world/wired_game_scene.gd")
```

Внутри `if game is SubViewportContainer:` после проверки `stretch` добавь:

```gdscript
		_check(
			game.get_script() == GAME_SCENE_SCRIPT,
			"Main/Game must use the WiredGameScene script, got %s" % game.get_script(),
		)
		var game_viewport: Variant = game.get("world_viewport")
		_check(
			game_viewport is SubViewport,
			"Main/Game.world_viewport must be a SubViewport, got %s" % game_viewport,
		)
```

Внутри `if viewport is SubViewport:` добавь сравнение:

```gdscript
		_check(
			game_viewport == viewport,
			"Main/Game.world_viewport must point at Game/SubViewport",
		)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
```
Expected: FAIL — `wired_game_scene.gd` не существует / `world_viewport` не задан.

- [ ] **Step 3: Создать `wired_game_scene.gd`**

```gdscript
extends Node
class_name WiredGameScene

## Корень `Main/Game`: сцена пакета или штатный `Game`.
##
## `world_viewport` — единственный контракт с ядром: в него переносятся
## StaticWorld, DynamicWorld и Players. Остальные SubViewport сцены свободны
## (миникарта, превью, UI-эффекты).
@export var world_viewport: SubViewport
```

- [ ] **Step 4: Подключить скрипт к штатному `Game`**

В `main.tscn` добавь ext_resource (uid Godot подставит при сохранении):

```
[ext_resource type="Script" path="res://_wired/scripts/world/wired_game_scene.gd" id="6_game"]
```

В узле `Game` после `stretch = true` добавь:

```
script = ExtResource("6_game")
world_viewport = NodePath("SubViewport")
```

- [ ] **Step 5: Запустить тест**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
```
Expected: `ALL TESTS PASSED`, exit 0.

- [ ] **Step 6: Commit**

```powershell
git add packages/server/godot_project/_wired/_wired/scripts/world/wired_game_scene.gd packages/server/godot_project/_wired/_wired/scenes/main.tscn packages/server/godot_project/_wired/tests/scene_layout_smoke.gd
git commit -m "feat(wired): add WiredGameScene contract for custom game roots"
```

---

### Task 2: Регистрация и реестр main-сцен

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/packages/wired_package_registration.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/package_registry.gd`
- Test: `packages/server/godot_project/_wired/tests/package_registry_smoke.gd`

**Interfaces:**
- Consumes: существующие `_entry()`, `_sorted_descriptors()`, `clear_package()`.
- Produces:
  - `WiredPackageRegistration.KIND_MAIN: String = "main"`
  - `WiredPackageRegistration.add_main_scene(relative_path: String, options: Dictionary = {}) -> void`
  - `WiredPackageRegistry.KIND_MAIN: String = "main"`
  - `WiredPackageRegistry.get_main_scenes() -> Array[Dictionary]`
  - `WiredPackageRegistry.get_main_scene() -> Dictionary` (первый или `{}`)

- [ ] **Step 1: Написать падающий тест**

В `package_registry_smoke.gd` добавь `_test_main_scenes()` в `_initialize()` (например, после `_test_static_scenes()`):

```gdscript
	_test_main_scenes()
```

Реализация:

```gdscript
func _test_main_scenes() -> void:
	var registry := WiredPackageRegistry.new()
	_check(
		registry.get_main_scene().is_empty(),
		"a registry without main scenes must return an empty descriptor",
	)
	_check(
		registry.get_main_scenes().is_empty(),
		"a registry without main scenes must return an empty list",
	)

	var b := WiredPackageRegistration.new()
	b.package_id = "pkg.b"
	b.add_main_scene("game/b.tscn", {"order": 20})
	registry.add_registration(b)

	var a := WiredPackageRegistration.new()
	a.package_id = "pkg.a"
	a.add_main_scene("game/first.tscn", {"order": 10})
	a.add_main_scene("game/second.tscn", {"order": 10})
	registry.add_registration(a)

	var scenes := registry.get_main_scenes()
	_check(scenes.size() == 3, "three main scenes must be registered, got %d" % scenes.size())
	if scenes.size() == 3:
		_check(
			scenes[0]["package_id"] == "pkg.a"
			and scenes[0]["path"] == "game/first.tscn",
			"the first main scene must be pkg.a/first.tscn, got %s/%s"
			% [scenes[0]["package_id"], scenes[0]["path"]],
		)
		_check(
			scenes[1]["path"] == "game/second.tscn",
			"equal order must keep the registration index order, got %s" % scenes[1]["path"],
		)
		_check(
			scenes[2]["package_id"] == "pkg.b",
			"the last main scene must be pkg.b, got %s" % scenes[2]["package_id"],
		)
		_check(
			not scenes[0].has("kind"),
			"main descriptors must not expose the internal kind discriminator",
		)
	_check(
		registry.get_main_scene()["path"] == "game/first.tscn",
		"get_main_scene must return the first ordered descriptor",
	)
	_check(
		registry.get_player_components().is_empty()
		and registry.get_static_scenes().is_empty()
		and registry.get_dynamic_entities().is_empty(),
		"a main scene must not leak into other descriptor lists",
	)
	registry.clear_package("pkg.a")
	var remaining := registry.get_main_scenes()
	_check(
		remaining.size() == 1 and remaining[0]["package_id"] == "pkg.b",
		"clear_package must drop only that package's main scenes",
	)
	registry.free()
```

- [ ] **Step 2: Убедиться, что тест падает**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
```
Expected: FAIL — `add_main_scene` / `get_main_scenes` не существуют.

- [ ] **Step 3: Реализовать регистрацию**

В `wired_package_registration.gd`:

```gdscript
const KIND_MAIN := "main"
```

и метод рядом с другими `add_*`:

```gdscript
func add_main_scene(relative_path: String, options: Dictionary = {}) -> void:
	_entries.append(_entry(KIND_MAIN, relative_path, options))
```

- [ ] **Step 4: Реализовать реестр**

В `package_registry.gd`:

```gdscript
const KIND_MAIN := "main"

func get_main_scenes() -> Array[Dictionary]:
	return _sorted_descriptors(KIND_MAIN)


func get_main_scene() -> Dictionary:
	var scenes := get_main_scenes()
	return scenes[0] if not scenes.is_empty() else {}
```

- [ ] **Step 5: Запустить тест**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
```
Expected: `PACKAGE_REGISTRY_SMOKE_OK checks=...` и `ALL TESTS PASSED`, exit 0.

- [ ] **Step 6: Commit**

```powershell
git add packages/server/godot_project/_wired/_wired/scripts/packages/wired_package_registration.gd packages/server/godot_project/_wired/_wired/scripts/global/package_registry.gd packages/server/godot_project/_wired/tests/package_registry_smoke.gd
git commit -m "feat(wired): register package main scenes in the registry"
```

---

### Task 3: Явные экспорты вместо `$`-путей

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scenes/main.tscn`
- Test: `packages/server/godot_project/_wired/tests/scene_layout_smoke.gd`

**Interfaces:**
- Consumes: `WiredGameScene` из Task 1.
- Produces: `main_scene.gd` без `$`-путей; `main.tscn` заполняет все экспорты; `_validate_exports() -> bool`, `_is_wired_game_scene(root: Node) -> bool`, `_world_viewport_of(root: Node) -> SubViewport`.

- [ ] **Step 1: Написать падающую проверку экспортов**

В `scene_layout_smoke.gd` после `if main == null: return` добавь:

```gdscript
	var required_exports := [
		"default_game_root",
		"net",
		"ui",
		"status_label",
		"log_label",
		"static_world",
		"dynamic_world",
		"dynamic_spawner",
		"players_manager",
		"players_spawner",
	]
	for export_name: String in required_exports:
		_check(
			main.get(export_name) != null,
			"Main.%s must be wired in main.tscn" % export_name,
		)
	_check(
		main.has_method("_validate_exports") and bool(main.call("_validate_exports")),
		"Main must validate its exported references",
	)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
```
Expected: FAIL — экспортов и `_validate_exports` ещё нет.

- [ ] **Step 3: Заменить поля и `@onready` на экспорты**

В `main_scene.gd` удали поля `_static_world`, `_dynamic_world`, `_players` (строки 34–36) и `@onready var _net/_status/_log` (строки 54–56). Вместо них добавь `preload` и экспорты рядом с `SnapshotRules`:

```gdscript
const WiredGameSceneScript := preload("res://_wired/scripts/world/wired_game_scene.gd")

@export var default_game_root: Node
@export var net: WiredNetwork
@export var ui: CanvasLayer
@export var status_label: Label
@export var log_label: RichTextLabel
@export var static_world: StaticWorldContainer
@export var dynamic_world: DynamicWorldContainer
@export var dynamic_spawner: MultiplayerSpawner
@export var players_manager: PlayersManager
@export var players_spawner: MultiplayerSpawner
```

`default_game_root` намеренно `Node`, а не `WiredGameScene`: новый `class_name` не попадает в global class cache до импорта editor'ом, а headless-тесты должны работать без него. Принадлежность проверяется через `WiredGameSceneScript`.

- [ ] **Step 4: Добавить валидацию и хелперы**

```gdscript
func _is_wired_game_scene(root: Node) -> bool:
	return root != null and root is WiredGameSceneScript


func _world_viewport_of(root: Node) -> SubViewport:
	if not _is_wired_game_scene(root):
		return null
	var viewport: Variant = root.get("world_viewport")
	return viewport as SubViewport


func _validate_exports() -> bool:
	var missing: PackedStringArray = []
	if default_game_root == null:
		missing.append("default_game_root")
	if net == null:
		missing.append("net")
	if ui == null:
		missing.append("ui")
	if status_label == null:
		missing.append("status_label")
	if log_label == null:
		missing.append("log_label")
	if static_world == null:
		missing.append("static_world")
	if dynamic_world == null:
		missing.append("dynamic_world")
	if dynamic_spawner == null:
		missing.append("dynamic_spawner")
	if players_manager == null:
		missing.append("players_manager")
	if players_spawner == null:
		missing.append("players_spawner")
	for name: String in missing:
		push_error("WIRED_MAIN_SCENE_MISSING_EXPORT name=%s" % name)
	if not missing.is_empty():
		return false
	if not _is_wired_game_scene(default_game_root):
		push_error(
			"WIRED_MAIN_SCENE_INVALID package=<default> path=%s reason=not_wired_game_scene"
			% default_game_root.scene_file_path
		)
		return false
	if _world_viewport_of(default_game_root) == null:
		push_error(
			"WIRED_MAIN_SCENE_INVALID package=<default> path=%s reason=missing_world_viewport"
			% default_game_root.scene_file_path
		)
		return false
	return true
```

В начале `_ready()`:

```gdscript
	if not _validate_exports():
		return
```

- [ ] **Step 5: Переписать `_setup_services` и UI pass-through**

`_setup_services()`:

```gdscript
func _setup_services() -> void:
	_registry = WiredPackageRegistry.new()
	_registry.name = "PackageRegistry"
	add_child(_registry)
	Global.package_registry = _registry
	if dynamic_world != null:
		dynamic_world.setup(_registry, dynamic_spawner)
	Global.register_scene_services(static_world, dynamic_world, players_manager, net)
	if static_world != null:
		static_world.setup(_registry)
	if players_manager != null:
		players_manager.setup(_registry, net, players_spawner)
```

`_setup_ui_input_passthrough()`:

```gdscript
func _setup_ui_input_passthrough() -> void:
	for child: Node in ui.find_children("*", "Control", true, false):
		(child as Control).mouse_filter = Control.MOUSE_FILTER_IGNORE
```

Больше не нужен локальный `dynamic_world_node` и `get_node_or_null("Spawner")` — спавнеры приходят экспортами.

- [ ] **Step 6: Переименовать все использования**

По всему `main_scene.gd` (включая комментарии, чтобы не осталось stale-имён):

| Было | Стало |
|---|---|
| `_net` | `net` |
| `_status` | `status_label` |
| `_log` | `log_label` |
| `_static_world` | `static_world` |
| `_dynamic_world` | `dynamic_world` |
| `_players` | `players_manager` |

Локальные `var players` в `_apply_world_snapshot_owned` и `_save_state` не переименовывай. Проверь, что после замены нет `$`:

```powershell
Select-String -Path packages/server/godot_project/_wired/_wired/scripts/main_scene.gd -Pattern '\$(Game|UI|Net)'
```
Expected: пустой вывод.

- [ ] **Step 7: Заполнить экспорты в `main.tscn`**

У узла `Main` после `script = ExtResource("1_main")`:

```
default_game_root = NodePath("Game")
net = NodePath("Net")
ui = NodePath("UI")
status_label = NodePath("UI/Margin/VBox/Status")
log_label = NodePath("UI/Margin/VBox/Log")
static_world = NodePath("Game/SubViewport/StaticWorld")
dynamic_world = NodePath("Game/SubViewport/DynamicWorld")
dynamic_spawner = NodePath("Game/SubViewport/DynamicWorld/Spawner")
players_manager = NodePath("Game/SubViewport/Players")
players_spawner = NodePath("Game/SubViewport/Players/Spawner")
```

- [ ] **Step 8: Запустить тесты**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/state_persistence_smoke.gd --quit-after 2
```
Expected: все три — `ALL TESTS PASSED`, exit 0.

- [ ] **Step 9: Commit**

```powershell
git add packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/_wired/scenes/main.tscn packages/server/godot_project/_wired/tests/scene_layout_smoke.gd
git commit -m "refactor(wired): reference main scene services through exports"
```

---

### Task 4: Замена `Main/Game`, возврат штатного корня и безопасный fallback

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Create: `packages/server/godot_project/_wired/tests/main_scene_swap_smoke.gd`

**Interfaces:**
- Consumes: `WiredPackageRegistry.get_main_scene()`, `WiredPackageContext.instantiate()`, `WiredGameScene.world_viewport`.
- Produces в `main_scene.gd`:
  - поля `_game_root: Node`, `_default_game_root: Node`, `_game_scene_key: String`
  - `_desired_game_scene() -> Dictionary` с ключами `package_id`, `path`, `context`, `key`
  - `_unbind_game_services() -> void`
  - `_bind_game_services(viewport: SubViewport) -> void`
  - `_swap_game_scene(new_root: Node) -> bool`
  - `_rebuild_game_scene_if_needed() -> void`

- [ ] **Step 1: Написать падающий smoke-тест**

Создай `tests/main_scene_swap_smoke.gd`:

```gdscript
extends SceneTree

const MAIN_SCENE := "res://_wired/scenes/main.tscn"
const WiredGameSceneScript := preload("res://_wired/scripts/world/wired_game_scene.gd")

var _failures: PackedStringArray = []
var _checks := 0
var _stubs: Array = []


class StubPackages extends PackagesManager:
	var scenes: Dictionary = {}

	func instantiate_scene(
		_package_id: int, scene_path: String, _revision: int = 0
	) -> Node:
		var scene: PackedScene = scenes.get(scene_path, null)
		return scene.instantiate() if scene != null else null

	func runtime_path(
		_package_id: int, _revision: int, filepath: String, _artifact_key: String = ""
	) -> String:
		return "res://tests/packages/%s" % filepath


func _initialize() -> void:
	_test_swap_and_restore()
	_test_invalid_root_keeps_current()
	_test_missing_file_keeps_current()
	_test_missing_viewport_keeps_current()
	_test_multiple_subviewports()
	_test_multiple_registrations()
	_test_custom_ui_keeps_mouse_filter()
	_test_revision_rebuild()
	_test_retry_after_invalid()
	_finish()


func _make_main():
	var main = (load(MAIN_SCENE) as PackedScene).instantiate()
	main.call("_setup_services")
	return main


func _make_package_scene(root_name: String, viewport_index: int = 0) -> PackedScene:
	var root := SubViewportContainer.new()
	root.name = root_name
	root.set_script(WiredGameSceneScript)
	var preview := SubViewport.new()
	preview.name = "Preview"
	root.add_child(preview)
	preview.owner = root
	var world := SubViewport.new()
	world.name = "World"
	root.add_child(world)
	world.owner = root
	root.set("world_viewport", preview if viewport_index == 0 else world)
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	return packed


func _register_main(
	main, package_id: String, path: String, scene: PackedScene = null, order: int = 0
) -> void:
	var stub := StubPackages.new()
	if scene != null:
		stub.scenes[path] = scene
	_stubs.append(stub)
	var context := WiredPackageContext.new()
	context.package_id = package_id
	context.revision = 1
	context.artifact_key = "artifact"
	context.packages = stub
	var registry := main._registry as WiredPackageRegistry
	registry.register_context(package_id, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = package_id
	registration.add_main_scene(path, {"order": order})
	registry.add_registration(registration)


func _test_swap_and_restore() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	var default_viewport: SubViewport = default_root.get_node("SubViewport")
	var sw: Node = main.static_world
	var dw: Node = main.dynamic_world
	var pm: Node = main.players_manager
	_register_main(main, "1", "game/custom.tscn", _make_package_scene("CustomGame"))

	main.call("_rebuild_game_scene_if_needed")
	var custom: Node = main._game_root
	_check(custom != default_root, "the package scene must replace the default Game root")
	_check(custom.get_parent() == main, "the package scene must be installed under Main")
	_check(default_root.get_parent() == null, "the default Game root must be detached, not freed")
	_check(main._game_root == custom, "Main must track the installed root")

	var custom_viewport: SubViewport = custom.get("world_viewport")
	_check(sw.get_parent() == custom_viewport, "StaticWorld must move into world_viewport")
	_check(dw.get_parent() == custom_viewport, "DynamicWorld must move into world_viewport")
	_check(pm.get_parent() == custom_viewport, "Players must move into world_viewport")
	_check(main.static_world == sw, "StaticWorld must keep its instance across a swap")
	_check(main.dynamic_world == dw, "DynamicWorld must keep its instance across a swap")
	_check(main.players_manager == pm, "PlayersManager must keep its instance across a swap")

	var installed: Node = main._game_root
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == installed, "an unchanged main-scene key must not rebuild the scene")

	main._registry.clear_package("1")
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "removing the package must restore the default Game")
	_check(default_root.get_parent() == main, "the default Game must return under Main")
	_check(custom.get_parent() == null, "the replaced custom root must leave Main")
	_check(main._game_scene_key == "", "restoring the default Game must clear the scene key")
	_check(sw.get_parent() == default_viewport, "StaticWorld must return to the default viewport")
	_check(dw.get_parent() == default_viewport, "DynamicWorld must return to the default viewport")
	_check(pm.get_parent() == default_viewport, "Players must return to the default viewport")

	main.free()


func _make_scene_without_script() -> PackedScene:
	var root := Node.new()
	var child := SubViewport.new()
	root.add_child(child)
	child.owner = root
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	return packed


func _make_scripted_scene_without_viewport() -> PackedScene:
	var root := Node.new()
	root.set_script(WiredGameSceneScript)
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	return packed


func _test_invalid_root_keeps_current() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(main, "1", "game/plain.tscn", _make_scene_without_script())
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "a root without WiredGameScene must not replace Game")
	main.free()


func _test_missing_file_keeps_current() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(main, "1", "game/missing.tscn")
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "a missing main scene file must not replace Game")
	main.free()


func _test_missing_viewport_keeps_current() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(
		main, "1", "game/no_viewport.tscn", _make_scripted_scene_without_viewport()
	)
	main.call("_rebuild_game_scene_if_needed")
	_check(
		main._game_root == default_root,
		"a WiredGameScene without world_viewport must not replace Game",
	)
	main.free()


func _test_multiple_subviewports() -> void:
	var main = _make_main()
	var sw: Node = main.static_world
	_register_main(
		main, "1", "game/two_views.tscn", _make_package_scene("TwoViews", 1)
	)
	main.call("_rebuild_game_scene_if_needed")
	var custom: Node = main._game_root
	var preview: SubViewport = custom.get_node("Preview")
	var world: SubViewport = custom.get_node("World")
	_check(sw.get_parent() == world, "services must go to the designated world_viewport")
	_check(not preview.is_ancestor_of(sw), "the first SubViewport must stay free for the package")
	main.free()


func _test_multiple_registrations() -> void:
	var main = _make_main()
	_register_main(main, "2", "game/late.tscn", _make_package_scene("Late"), 20)
	_register_main(main, "1", "game/early.tscn", _make_package_scene("Early"), 10)
	main.call("_rebuild_game_scene_if_needed")
	_check(
		main._game_root.name == "Early",
		"the deterministic first main scene must win, got %s" % main._game_root.name,
	)
	_check(
		main._registry.get_main_scenes().size() == 2,
		"both main scenes must stay registered for the warning path",
	)
	main.free()


func _test_custom_ui_keeps_mouse_filter() -> void:
	var main = _make_main()
	var scene := _make_package_scene("WithUi")
	var root := scene.instantiate()
	var button := Button.new()
	button.name = "HudButton"
	root.add_child(button)
	button.owner = root
	var packed := PackedScene.new()
	packed.pack(root)
	root.free()
	_register_main(main, "1", "game/with_ui.tscn", packed)
	main.call("_rebuild_game_scene_if_needed")
	main.call("_setup_ui_input_passthrough")
	var custom: Node = main._game_root
	var hud := custom.get_node("HudButton") as Button
	_check(
		hud.mouse_filter == Control.MOUSE_FILTER_STOP,
		"custom scene UI must keep its own mouse_filter",
	)
	var log_control := main.ui.get_node("Margin/VBox/Log") as Control
	_check(
		log_control.mouse_filter == Control.MOUSE_FILTER_IGNORE,
		"Main/UI must still ignore the mouse after the swap",
	)
	main.free()


func _test_revision_rebuild() -> void:
	var main = _make_main()
	_register_main(main, "1", "game/rev.tscn", _make_package_scene("Rev1"))
	main.call("_rebuild_game_scene_if_needed")
	var first: Node = main._game_root
	var stub := StubPackages.new()
	stub.scenes["game/rev.tscn"] = _make_package_scene("Rev2")
	_stubs.append(stub)
	var context := WiredPackageContext.new()
	context.package_id = "1"
	context.revision = 2
	context.artifact_key = "artifact"
	context.packages = stub
	main._registry.register_context("1", context)
	main.call("_rebuild_game_scene_if_needed")
	var second: Node = main._game_root
	_check(
		second != first and second.name == "Rev2",
		"a new revision must rebuild the main scene",
	)
	_check(first.get_parent() == null, "the previous revision root must leave Main")
	main.free()


func _test_retry_after_invalid() -> void:
	var main = _make_main()
	var default_root: Node = main.default_game_root
	_register_main(main, "1", "game/retry.tscn", _make_scene_without_script())
	main.call("_rebuild_game_scene_if_needed")
	_check(main._game_root == default_root, "the invalid scene must be rejected")
	main._registry.clear_package("1")
	_register_main(main, "1", "game/retry.tscn", _make_package_scene("Retried"))
	main.call("_rebuild_game_scene_if_needed")
	_check(
		main._game_root.name == "Retried",
		"a fixed scene must replace the default Game after a failed attempt",
	)
	main.free()


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	for stub: Node in _stubs:
		if is_instance_valid(stub):
			stub.free()
	_stubs.clear()
	if _failures.is_empty():
		print("MAIN_SCENE_SWAP_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("MAIN_SCENE_SWAP_SMOKE_FAILED %s" % message)
	quit(1)
```

`main` в тесте намеренно без статического типа: тест обращается к рантайм-полям `_registry`, `_game_root`, `_game_root.name`. `_make_main()` тоже без return-типа по той же причине.

- [ ] **Step 2: Убедиться, что тест падает**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/main_scene_swap_smoke.gd --quit-after 2
```
Expected: FAIL — `_rebuild_game_scene_if_needed` ещё нет, `_game_root` не задан.

- [ ] **Step 3: Добавить поля и инициализацию**

Рядом с `_registry`:

```gdscript
## Корень, который сейчас стоит под `Main`: штатный Game или сцена пакета.
var _game_root: Node
## Штатный `Main/Game`, снятый с дерева, но сохранённый для fallback.
var _default_game_root: Node
## Идентичность установленной main-сцены; пусто для штатного Game.
var _game_scene_key := ""
```

В конце `_setup_services()`:

```gdscript
	_default_game_root = default_game_root
	_game_root = default_game_root
```

- [ ] **Step 4: Реализовать перенос сервисов**

```gdscript
func _unbind_game_services() -> void:
	for service: Node in [static_world, dynamic_world, players_manager]:
		if service != null and service.get_parent() != null:
			service.get_parent().remove_child(service)


func _bind_game_services(viewport: SubViewport) -> void:
	for service: Node in [static_world, dynamic_world, players_manager]:
		if service == null or service.get_parent() == viewport:
			continue
		if viewport.get_node_or_null(NodePath(service.name)) != null:
			push_warning("WIRED_MAIN_SCENE_SERVICE_COLLISION name=%s" % service.name)
		if service.get_parent() != null:
			service.get_parent().remove_child(service)
		viewport.add_child(service)
```

- [ ] **Step 5: Реализовать выбор сцены и замену корня**

```gdscript
func _desired_game_scene() -> Dictionary:
	if _registry == null:
		return {}
	var descriptor := _registry.get_main_scene()
	if descriptor.is_empty():
		return {}
	var registrations := _registry.get_main_scenes()
	if registrations.size() > 1:
		push_warning(
			"WIRED_MAIN_SCENE_MULTIPLE package=%s ignored=%d"
			% [descriptor.get("package_id", ""), registrations.size() - 1]
		)
	var package_id := str(descriptor.get("package_id", ""))
	var path := str(descriptor.get(WiredProtocol.KEY_PATH, ""))
	var context := _registry.get_context(package_id)
	if context == null or path.is_empty():
		return {}
	return {
		"package_id": package_id,
		"path": path,
		"context": context,
		"key": "%s:%s:%d:%s"
		% [package_id, path, context.revision, context.artifact_key],
	}


func _swap_game_scene(new_root: Node) -> bool:
	var viewport := _world_viewport_of(new_root)
	if viewport == null:
		return false
	if new_root == _game_root:
		return true
	_unbind_game_services()
	var parent := _game_root.get_parent()
	var index := _game_root.get_index()
	if parent != null:
		parent.remove_child(_game_root)
		parent.add_child(new_root)
		parent.move_child(new_root, index)
	else:
		add_child(new_root)
	if _game_root != _default_game_root:
		_game_root.queue_free()
	_game_root = new_root
	_bind_game_services(viewport)
	Global.register_scene_services(static_world, dynamic_world, players_manager, net)
	return true


func _rebuild_game_scene_if_needed() -> void:
	var desired := _desired_game_scene()
	var key := str(desired.get("key", ""))
	if key == _game_scene_key:
		return
	if key.is_empty():
		if _game_root != _default_game_root and _swap_game_scene(_default_game_root):
			_game_scene_key = ""
		return
	var context := desired.get("context") as WiredPackageContext
	var path := str(desired.get("path", ""))
	var instance := context.instantiate(path) if context != null else null
	if instance == null:
		push_warning(
			"WIRED_MAIN_SCENE_INSTANTIATE_FAILED package=%s path=%s"
			% [desired.get("package_id", ""), path]
		)
		return
	if not _is_wired_game_scene(instance):
		push_warning(
			"WIRED_MAIN_SCENE_INVALID package=%s path=%s reason=not_wired_game_scene"
			% [desired.get("package_id", ""), path]
		)
		instance.free()
		return
	if _world_viewport_of(instance) == null:
		push_warning(
			"WIRED_MAIN_SCENE_INVALID package=%s path=%s reason=missing_world_viewport"
			% [desired.get("package_id", ""), path]
		)
		instance.free()
		return
	if not _swap_game_scene(instance):
		instance.free()
		return
	_game_scene_key = key
```

`_swap_game_scene` сначала снимает сервисы, потом заменяет корень и освобождает только предыдущий **кастомный** корень. Штатный `_default_game_root` не освобождается никогда. При ошибке `_game_scene_key` не меняется, поэтому следующее применение пакета снова попробует ту же сцену.

- [ ] **Step 6: Подключить вызовы**

В `_apply_registered_package()` после `PackageEntryLoader.load_entry(...)` и перед `static_world.rebuild()`:

```gdscript
	_rebuild_game_scene_if_needed()
```

В `_apply_package_removal()` после `_packages.forget_package(package_id, purge)` и перед `static_world.rebuild()`:

```gdscript
	_rebuild_game_scene_if_needed()
```

- [ ] **Step 7: Запустить smoke-тест**

Run:
```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/main_scene_swap_smoke.gd --quit-after 2
```
Expected: `MAIN_SCENE_SWAP_SMOKE_OK checks=...` и `ALL TESTS PASSED`, exit 0.

- [ ] **Step 8: Прогнать все smoke-тесты**

```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/state_persistence_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/main_scene_swap_smoke.gd --quit-after 2
```
Expected: все четыре — `ALL TESTS PASSED`, exit 0.

- [ ] **Step 9: Commit**

```powershell
git add packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/tests/main_scene_swap_smoke.gd
git commit -m "feat(wired): swap Main/Game with a package main scene"
```

---

### Task 5: Документация контракта и финальная проверка

**Files:**
- Modify: `packages/server/godot_project/examples/wired-platformer/README.md`

**Interfaces:**
- Consumes: `add_main_scene()`, `WiredGameScene`, `world_viewport`.
- Produces: раздел README с примером, ограничениями и ручным чек-листом.

- [ ] **Step 1: Добавить раздел в README**

После таблицы регистраций (перед «Как опубликовать пакет в комнате») добавь раздел
«Своя main-сцена (необязательно)»:

````markdown
## Своя main-сцена (необязательно)

Пакет может заменить штатный `Main/Game` своей сценой. Регистрация:

```gdscript
func register(_registry: WiredPackageRegistry) -> void:
	add_main_scene("game/game.tscn")
```

Корень сцены должен использовать скрипт `WiredGameScene` (напрямую или через
`extends "res://_wired/scripts/world/wired_game_scene.gd"`) и указать
`world_viewport` — `SubViewport`, в который ядро переносит `StaticWorld`,
`DynamicWorld` и `Players`:

```gdscript
extends WiredGameScene
```

Остальные `SubViewport` (миникарта, превью) свободны: ядро использует только
`world_viewport`. Узлы `StaticWorld`, `DynamicWorld` и `Players` резервируются
ядром — не создавайте свои с такими именами.

Кастомный UI сохраняет свой `mouse_filter`: кнопки и панели кликаются. Штатный
`Main/UI` по-прежнему игнорирует мышь, чтобы клики доходили до игрового
viewport.

Побеждает первая main-сцена в порядке реестра (package id, `order`, порядок
регистраций). Если сцена битая или `world_viewport` не задан, комната остаётся
на штатном `Game`. При новой ревизии пакета main-сцена пересобирается, поэтому
её UI-состояние сбрасывается; живые игроки и динамические сущности сохраняются.
````

- [ ] **Step 2: Финальный прогон всех smoke-тестов**

```powershell
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/scene_layout_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/package_registry_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/state_persistence_smoke.gd --quit-after 2
& $GODOT --headless --path packages/server/godot_project/_wired --script res://tests/main_scene_swap_smoke.gd --quit-after 2
```
Expected: все четыре — `ALL TESTS PASSED`, exit 0.

- [ ] **Step 3: Ручной чек-лист (опционально, если есть собранный Web export)**

1. `pnpm export:game`.
2. Создать пакет с `add_main_scene("game/game.tscn")` и сценой, у которой есть свой `SubViewport` и кнопка в UI.
3. Открыть Game в двух окнах: кнопка кликается, игроки видны в кастомном viewport.
4. Нажать Emit с изменённой main-сценой: сцена пересобирается, игроки и ящики не исчезают.
5. Удалить пакет из комнаты: возвращается штатный `Game`.

- [ ] **Step 4: Commit**

```powershell
git add packages/server/godot_project/examples/wired-platformer/README.md
git commit -m "docs(wired): document package main scenes"
```
