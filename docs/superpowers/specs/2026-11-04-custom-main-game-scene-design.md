# Кастомная main-сцена пакета

Дата: 2026-11-04
Статус: согласован

## Зачем

Сейчас сцена комнаты фиксирована: `_wired/scenes/main.tscn` содержит `Main`,
`Net`, `Game` (`SubViewportContainer` → `SubViewport` → `StaticWorld` /
`DynamicWorld` / `Players`) и `UI`. Пакет может добавлять только контент внутрь
контейнеров (`add_static_scene`, `add_player_component`,
`add_dynamic_entity`).

Нужно, чтобы пакет мог заменить узел `Game` своей сценой и верстать в ней
собственный интерфейс, не пересобирая сеть, менеджеры игроков и пакетов.

## Цели

- `wired_package.gd` регистрирует сцену, которая заменяет `Main/Game`.
- В этой сцене можно располагать любые `Control`/`CanvasLayer`; ядро не
  навязывает им `mouse_filter`.
- Ядро по-прежнему владеет `StaticWorld`, `DynamicWorld` и `Players` (вместе со
  спавнерами), сетью и реестром пакетов.
- Замена переживает hot-reload пакета: живые игроки и динамические сущности не
  теряются, если сервисные узлы не пересоздаются.
- Если пакет не регистрирует main-сцену или она битая, комната работает как
  раньше на штатном `Game`.

## Не цели

- Песочница/безопасность: пакеты остаются доверенным контентом комнаты.
- Замена `Main`, `Net` или `UI` целиком.
- Несколько одновременно активных main-сцен.
- Гарантия, что UI-состояние кастомной сцены переживёт публикацию новой
  ревизии пакета.

## Ограничения и факты

- `main_scene.gd` сейчас жёстко читает `$Game/SubViewport/...` и один раз
  вызывает `_setup_services()`; `Global` получает ссылки на сервисные узлы.
- `DynamicWorld.setup()` и `Players.setup()` переиспользуют авторские
  `MultiplayerSpawner`; повторный `setup()` не создаёт второй спавнер.
- `PackagesManager.instantiate_scene()` загружает сцену из применённой ревизии с
  `CACHE_MODE_IGNORE`, ставит meta пакета и возвращает `Node`.
- `WiredPackageRegistry` сортирует дескрипторы детерминированно: package id,
  `order`, индекс регистрации. Один и тот же порядок обязателен на всех пирах.
- Headless smoke-тесты GDScript запускаются вручную/в проверках через
  `godot --headless --path packages/server/godot_project/_wired --script ...`.
- `Main/UI` — отдельный `CanvasLayer`; его контролы обязаны игнорировать мышь,
  чтобы клики доходили до игрового viewport. Кастомная сцена — исключение: её
  UI должен уметь принимать ввод.

## Рассмотренные подходы

### Вариант A — сцена пакета заменяет `Game`, ядро переносит сервисы (выбран)

Пакет регистрирует сцену. Ядро снимает свои `StaticWorld`, `DynamicWorld`,
`Players` со спавнерами с текущего `SubViewport`, заменяет корень `Game` и
переносит сервисы в `SubViewport` новой сцены.

Плюсы:

- пакет отвечает только за компоновку и UI;
- сервисы и их состояние (игроки, сущности, спавнеры) не пересоздаются;
- fallback на штатный `Game` тривиален;
- контракт маленький: одна регистрация и одна явная ссылка на viewport.

Минусы:

- корень сцены обязан использовать скрипт `WiredGameScene`;
- имена сервисных узлов зарезервированы;
- перенос узлов во время активной сессии теоретически чувствителен к сетевым
  путям, поэтому проверяется отдельным smoke-тестом и ручным прогоном.

### Вариант B — пакет сам верстает `SubViewport` и контейнеры со спавнерами

Плюсы: максимум свободы, можно менять иерархию контейнеров.

Минусы: дублирует обвязку ядра, расходится с ним при обновлениях, при
hot-reload теряет живых игроков и сущности, легко сломать `spawn_path`.

### Вариант C — сцена пакета внутри `SubViewport`, UI отдельным `CanvasLayer`

Плюсы: минимальный риск.

Минусы: не заменяет `Game`; UI не живёт в той же сцене, чего и требует задача.

**Решение: вариант A.**

## Контракт пакета

В `wired_package.gd`:

```gdscript
func register(_registry: WiredPackageRegistry) -> void:
	add_main_scene("game/game.tscn")
```

Правила:

- `add_main_scene(relative_path, options = {})` добавляет запись вида `main` в
  регистрацию; путь относителен корня пакета, `order` участвует в сортировке.
- Активна только одна main-сцена: побеждает первый дескриптор в
  детерминированном порядке реестра. Остальные игнорируются с однократным
  предупреждением.
- Корень сцены — обычный `Node`, на практике full-rect `Control`
  (`SubViewportContainer`) или `SubViewportContainer` с UI-соседями.
- Корень использует скрипт `WiredGameScene` (напрямую или через
  `extends "res://_wired/scripts/world/wired_game_scene.gd"`) и задаёт
  `@export var world_viewport: SubViewport` — тот viewport, в который ядро
  переносит `StaticWorld`, `DynamicWorld` и `Players`.
- Других `SubViewport` в сцене может быть сколько угодно: миникарта, превью,
  UI-эффекты. Ограничения «ровно один» нет; ядро использует только
  `world_viewport`.
- Узлы `StaticWorld`, `DynamicWorld`, `Players` резервируются ядром. Если пакет
  создал одноимённые узлы, сцена считается невалидной: ядро пишет
  `WIRED_MAIN_SCENE_INVALID ... reason=reserved_node name=<имя>` и оставляет
  штатный `Game`. Так живые сервисы сохраняют свои имена: иначе Godot
  переименовал бы их в недетерминированные `@Node@N`, и сетевые пути сервера и
  клиента разошлись бы.
- Остальные узлы, включая UI, ядро не трогает: `mouse_filter`, anchors и
  видимость остаются авторскими.

## Архитектура ядра

### Явные ссылки вместо путей

`main_scene.gd` перестаёт использовать `$Game/SubViewport/...`, `$UI/...` и
`$Net`. Все узлы приходят из `@export`, а `main.tscn` их заполняет:

```gdscript
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

`players_manager`, а не `players`: в `main_scene.gd` уже есть локальные
переменные `players`, которые затенят экспорт.

`default_game_root` типизирован как `Node`, а не `WiredGameScene`: новый
`class_name` не попадает в global class cache до импорта editor'ом, а headless
smoke-тесты должны запускаться без него. Принадлежность скрипту проверяется
через `preload("res://_wired/scripts/world/wired_game_scene.gd")`.

Правила:

- `_ready()` проверяет обязательные ссылки; при `null` пишет
  `WIRED_MAIN_SCENE_MISSING_EXPORT name=<field>` и не продолжает запуск.
- `default_game_root` — штатный `Game` из `main.tscn`; он же становится
  `_default_game_root` для fallback. Текущий корень хранится в рантайм-поле
  `_game_root`.
- `static_world`, `dynamic_world`, `players_manager`, `net`, `ui`,
  `status_label`, `log_label` — стабильные экземпляры; swap main-сцены их не
  заменяет.
- Спавнеры передаются в `DynamicWorld.setup()` и `Players.setup()` напрямую, без
  `get_node_or_null("Spawner")`.
- `_setup_ui_input_passthrough()` обходит `ui`, а не `$UI`.
- `get_node_or_null("/root/Global")` в компонентах остаётся: это путь к
  autoload, а не к узлу сцены.

### Новый скрипт `WiredGameScene`

`_wired/scripts/world/wired_game_scene.gd`:

```gdscript
extends Node
class_name WiredGameScene

## Корень `Main/Game`: сцена пакета или штатный `Game`.
## `world_viewport` — единственный контракт с ядром: в него переносятся
## StaticWorld, DynamicWorld и Players. Остальные SubViewport сцены свободны.
@export var world_viewport: SubViewport
```

Штатный `Game` в `main.tscn` получает этот скрипт и
`world_viewport = NodePath("SubViewport")`.

### Регистрация и реестр

- `WiredPackageRegistration`: `KIND_MAIN`, метод `add_main_scene()`,
  переиспользуется `_entry()`.
- `WiredPackageRegistry`: `KIND_MAIN`, `get_main_scenes() ->
  Array[Dictionary]` и `get_main_scene() -> Dictionary` (первый дескриптор или
  пустой словарь). Сортировка и очистка — существующие.

### `main_scene.gd`

- Хранит `_game_root` (текущий корень `Game`), `_default_game_root` (штатный
  узел из `main.tscn`, снятый с дерева, но не освобождённый) и
  `_game_scene_key` (пустая строка для штатного `Game`).
- `_world_viewport_of(root) -> SubViewport` — проверяет, что `root is
  WiredGameScene`, и возвращает `world_viewport`; `null`, если скрипт не тот
  или ссылка не задана.
- `_bind_game_services(viewport)` — переносит `static_world`, `dynamic_world`,
  `players_manager` в указанный `SubViewport`. Первый вызов использует уже
  авторские узлы; повторные — только `remove_child`/`add_child`.
- `_desired_game_scene()` — берёт `get_main_scene()`, контекст пакета и путь;
  возвращает `{path, context, key}` или пустой словарь.
- `_rebuild_game_scene_if_needed()`:
  1. Если активна штатная сцена и пакет ничего не зарегистрировал — ничего не
     делает.
  2. Если ключ не изменился — ничего не делает.
  3. Инстанцирует сцену через `context.instantiate(path)`; при ошибке пишет
     `WIRED_MAIN_SCENE_*` и оставляет текущую.
  4. Берёт `world_viewport` с корня; если скрипт не `WiredGameScene` или ссылка
     пустая — освобождает экземпляр и оставляет текущую.
  5. Снимает сервисы со старого viewport, заменяет `Game` в `Main` на новый
     корень (тот же индекс), освобождает предыдущий кастомный корень, переносит
     сервисы в новый viewport и обновляет `Global` (ссылки на те же объекты).
- `_game_scene_key` = `<package_id>:<path>:<revision>:<artifact_key>`; для
  штатной сцены — `""`. Публикация новой ревизии пересоздаёт main-сцену, как и
  остальной контент.
- Вызов: в `_apply_registered_package()` после загрузки entry и в
  `_apply_package_removal()` после `clear_package`, до `static_world.rebuild()`.
- Штатный `_default_game_root` не освобождается при замене; при удалении
  main-сцены он возвращается в `Main` на прежнее место.

### UI

- `_setup_ui_input_passthrough()` по-прежнему обходит только `ui`.
- Контролы кастомной сцены сохраняют свой `mouse_filter`; интерактивные
  элементы (кнопки, панели) работают штатно.

### Ошибки и диагностика

- `WIRED_MAIN_SCENE_INSTANTIATE_FAILED package=%s path=%s`
- `WIRED_MAIN_SCENE_INVALID package=%s path=%s reason=not_wired_game_scene|missing_world_viewport`
- `WIRED_MAIN_SCENE_MULTIPLE package=%s ignored=%d` — один раз на применение.
- Ошибка не роняет runtime: комната остаётся на текущей сцене.

## Проверка

- `package_registry_smoke.gd`: регистрация `add_main_scene`, сортировка,
  `get_main_scene`, `clear_package`.
- Новый `main_scene_swap_smoke.gd`: подменить корень `Game` на тестовую сцену с
  `WiredGameScene.world_viewport`, проверить перенос сервисов, сохранение
  экземпляров и возврат штатного корня; проверить отказ, если скрипт не
  `WiredGameScene` или `world_viewport` не задан; проверить сцену с несколькими
  `SubViewport`, где выбран не первый.
- `scene_layout_smoke.gd`: дополнительно проверяет, что штатный `Game` — это
  `WiredGameScene` с непустым `world_viewport`; остальная раскладка не меняется.
- Ручной прогон: пакет с `add_main_scene`, два клиента, Emit новой ревизии —
  игроки и сущности остаются, UI новой сцены кликается.

## Что остаётся на усмотрение реализатора

- Точная валидация корня (обязательны `WiredGameScene` и непустой
  `world_viewport`; тип корня не ограничивается `SubViewportContainer`).
- Формат предупреждения о дубликатах сервисных узлов.
- Выносить ли перенос сервисов в отдельный helper ради тестируемости; если
  выносится, поведение и имена диагностик не меняются.
- Обновление `examples/wired-platformer/README.md` разделом про main-сцену.

## Влияние на существующие данные

Нет изменений БД, манифеста, API и сетевого протокола. Новый вид регистрации
живёт только в реестре пакетов и в `wired_package.gd`.
