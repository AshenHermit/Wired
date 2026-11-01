# Дизайн: контент-пакеты комнаты, игроки и игровой мир

Дата: 2026-11-01
Статус: approved (2026-11-01), readiness-гейт — вариант A
Область: базовый Godot-проект `packages/server/godot_project/_wired`, пример пакета комнаты, минимальные расширения сетевого слоя

## 1. Задача

Нужна удобная основа для создания контент-пакетов комнаты:

- базовый игровой проект и ядро в `_wired`;
- в `main.tscn` появляется `SubViewportContainer` → `SubViewport`;
- внутри `SubViewport`:
  - `StaticWorldContainer` — создаёт зарегистрированные статические сцены, не сохраняется;
  - `DynamicWorldContainer` — хранит изменяемую часть мира, умеет сохранять и загружать её;
  - `PlayersManager` — хранит игроков, умеет сохранять их состояние;
- пакет комнаты регистрирует свои статические сцены, компоненты игрока и динамические сущности;
- пример пакета: простая 2D-платформа, игрок с камерой и телом, толкание других игроков, спавн `RigidBody2D`-квадрата с импульсом в сторону курсора;
- всё это должно работать в мультиплеере: сервер авторитетен для игроков и динамического мира, клиенты видят согласованную картину.

Главный принцип: **автор пакета не пишет сетевую обвязку**. Спавн, RPC, authority, синхронизация, readiness и сохранение живут в ядре. Пакет описывает, что зарегистрировать и как обрабатывать игровые действия.

## 2. Цели

1. Дать пакету точку входа и понятный API регистрации.
2. Собрать игрока из компонентов, которые может добавлять любой пакет.
3. Сделать серверное тело игрока, локальную камеру и серверное толкание игроков.
4. Сделать серверный динамический мир со спавном и импульсом к курсору.
5. Сохранять динамический мир и состояние игроков в `state.json`.
6. Сохранить совместимость с текущей доставкой пакетов: без изменений БД, backend-схемы и формата манифеста.
7. Дать пример пакета, который можно опубликовать в комнате и проверить двумя клиентами.

## 3. Не-цели

- Клиентский prediction/rollback и сглаживание уровня production.
- Полноценная идентификация игрока между сессиями: текущий ticket не содержит user id.
- Изменение БД, сущностей NestJS, API пакетов или формата манифеста.
- UI импорта пакета в редакторе (кнопка «загрузить пример»).
- Изменение backend-поведения, кроме минимального readiness-гейта (вариант A, см. §11.2). Это не schema/API-изменение и не затрагивает формат манифеста.
- Поддержка 3D-примера. API и контейнеры проектируются двумерно- и трёхмерно-нейтральными, но пример — 2D.
- Разрешение пакетам произвольных `multiplayer.rpc()` как публичного API. Технически GDScript это не запрещает, но контракт ядра этого не требует.
- Гарантия сохранения состояния игрока после перезапуска сервера при текущем ticket. Это ограничение зафиксировано отдельно.

## 4. Ограничения и факты проекта

- Godot 4.7.2, GDScript, GL Compatibility. Базовый проект: `packages/server/godot_project/_wired`.
- `main.tscn` сейчас: `Main` (`main_scene.gd`), `Net` (`network.gd`), `UI` (`CanvasLayer` с фоном, статусом и логом). Игрового viewport нет.
- `SceneContainer` (`_wired/scenes/shared/scene_container.tscn`, `scene_container.gd`) — неиспользуемый legacy-узел. Его можно вывести из эксплуатации, заменив новой структурой.
- `Global` — autoload `_wired/scripts/global/global.gd`, сейчас хранит только `SceneContainer`.
- `PlayersManager` — заглушка с `server_instantiate_player(peer_id)`.
- `PackagesManager` уже умеет: конфигурироваться на комнату, скачивать ревизии, разрешать зависимости, отдавать `runtime_path`, `instantiate_scene`, `scene_dependencies`, сигналы `package_applied`/`package_failed`.
- `WiredNetwork` уже имеет ticket-аутентификацию, `world_state`, `package_revision`, `cli_package_ready`, `cli_game_action`, но:
  - `cli_game_action` только логирует;
  - `cli_package_ready` только пишет отчёт, не поднимает сигнал готовности;
  - нет спавна игроков и нет сигнала `peer_authenticated`.
- `main_scene.gd` создаёт `PackagesManager` и `PackageReloader` до сети; сервер пишет `state.json` в `--state-dir`.
- `PackageReloader` перезагружает корни сцен с meta `_wired_package_id`, но не autoload и не глобальные `class_name`.
- Пакеты — доверенный контент комнаты. Это не песочница безопасности.
- Документация и UI — русский UTF-8. Коммиты — Conventional Commits.

## 5. Рассмотренные подходы

### Вариант A — конвенция + реестр + базовые классы (выбран)

Пакет содержит корневой `wired_package.gd`, который extends `WiredPackageRegistration` и в `register(registry)` вызывает:

- `registry.add_static_scene(...)`;
- `registry.add_player_component(...)`;
- `registry.add_dynamic_entity(...)`.

Ядро даёт `WiredPlayer`, `WiredPlayerComponent`, `WiredDynamicEntity`, контекст игрока, authority, ввод, действия, спавн и сохранение.

Плюсы:

- нет изменений БД и манифеста;
- пакет не пишет RPC;
- один понятный контракт для статики, игроков и динамики;
- можно постепенно расширять API.

Минусы:

- контракт нужно документировать и версионировать;
- изменение компонента игрока требует респавна/перезапуска;
- `wired_package.gd` — конвенция, а не поле манифеста; ошибку легко не заметить, поэтому нужна диагностика.

### Вариант B — декларативный `wired_package.json` + тонкие скрипты

Плюсы: валидируемая схема, удобно для редактора и будущего UI.

Минусы: дублирование схемы, версионирование, всё равно нужны скрипты для поведения; на этом этапе лишняя сложность.

### Вариант C — чистый Godot без реестра

Плюсы: максимум свободы.

Минусы: каждый пакет повторяет сетевую обвязку, растёт риск рассинхрона; не выполняет требование «удобно для мультиплеера».

**Решение: вариант A.** Вариант B оставляем как возможное развитие, если появится редактор пакетов. Вариант C не используем для примеров и документации.

## 6. Архитектура ядра

### 6.1. Новые файлы

```
_wired/scripts/
  global/global.gd                         # расширить ссылками на сервисы
  global/players_manager.gd                # переписать
  global/package_registry.gd               # NEW: реестр пакетов
  packages/wired_package_registration.gd   # NEW: база точки входа
  packages/wired_package_context.gd        # NEW: контекст пакета
  world/static_world_container.gd          # NEW
  world/dynamic_world_container.gd         # NEW
  world/wired_dynamic_entity.gd            # NEW
  players/wired_player.gd                  # NEW
  players/wired_player_component.gd        # NEW
  network/network.gd                       # расширить
  main_scene.gd                            # расширить
```

`SceneContainer` и `scene_container.tscn` не используются новой архитектурой. Их можно удалить отдельным коммитом после проверки, что ссылок нет.

### 6.2. Структура `main.tscn`

```
Main (main_scene.gd)
├── Net (WiredNetwork)
├── Game (SubViewportContainer)
│   └── SubViewport
│       ├── StaticWorld (StaticWorldContainer)
│       ├── DynamicWorld (DynamicWorldContainer)
│       │   └── Spawner (MultiplayerSpawner, spawn_path = "..")
│       └── Players (PlayersManager)
│           └── Spawner (MultiplayerSpawner, spawn_path = "..")
└── UI (CanvasLayer)
    └── ... статус/лог, mouse_filter = IGNORE
```

Параметры `SubViewport`:

- `size = Vector2i(960, 540)`, растягивается контейнером;
- `render_target_update_mode = ALWAYS`;
- `handle_input_locally = true`;
- `own_world_3d = true` (для будущих 3D-пакетов);
- `gui_disable_input = false`.

`SubViewportContainer` — full rect, `stretch = true`, `mouse_filter = STOP` (он должен получать ввод). UI-слой рисуется сверху, но его элементы не должны перехватывать мышь: `Background`, `Margin`, `VBox`, `Status`, `Hint`, `Log` получают `mouse_filter = IGNORE`. Лог можно оставить видимым, но он не должен мешать прицеливанию.

### 6.3. `Global`

`Global` становится точкой доступа к сервисам:

```gdscript
var packages: PackagesManager
var package_registry: WiredPackageRegistry
var static_world: StaticWorldContainer
var dynamic_world: DynamicWorldContainer
var players: PlayersManager
var network: WiredNetwork

func register_* / get_* ...
```

Старые `register_scene_container`/`get_scene_container` можно оставить на один переходный период или удалить вместе с legacy-сценой. В новом коде они не используются.

### 6.4. Порядок инициализации

1. `main_scene._ready()` читает конфиг.
2. Создаёт `PackagesManager`, `PackageReloader`, `WiredPackageRegistry`; регистрирует их в `Global`.
3. Подключает сигналы сети.
4. Создаёт/настраивает `StaticWorldContainer`, `DynamicWorldContainer`, `PlayersManager` (они уже в сцене, получают зависимости через `Global`/`setup`).
5. `notifyReady` для bridge.
6. Сервер стартует сеть; клиент подключается.
7. Пакеты применяются; реестр перестраивается; статический мир пересоздаётся.
8. Клиент сообщает `package_ready`; сервер спавнит игрока после auth + readiness.
9. На shutdown сервер собирает `PlayersManager.save_state()` и `DynamicWorldContainer.save_state()` в `state.json`.

## 7. Контракт пакета

### 7.1. Точка входа

Пакет MAY содержать файл `wired_package.gd` в корне пакета. Если файла нет, пакет считается «только данные/сцены» и просто не регистрирует ничего; ошибкой это не является.

`wired_package.gd`:

```gdscript
extends WiredPackageRegistration

func register(registry: WiredPackageRegistry) -> void:
	registry.add_static_scene("static/platform.tscn", {"order": 0})
	registry.add_player_component("player/body.tscn", {
		"authority": "server",
		"order": 10,
	})
	registry.add_player_component("player/camera.tscn", {
		"authority": "local",
		"order": 20,
		"local_only": true,
	})
	registry.add_player_component("player/spawner.tscn", {
		"authority": "server",
		"order": 30,
	})
	registry.add_dynamic_entity("crate", "dynamic/crate.tscn", {
		"authority": "server",
		"persist": true,
	})
```

Правила:

- пути относительны корня пакета;
- пакетные скрипты не объявляют `class_name`;
- пакетные скрипты extends-ят классы ядра (`WiredPlayerComponent`, `WiredDynamicEntity`, `WiredPackageRegistration`);
- пакет не вызывает `multiplayer.rpc()` и не создаёт свои `MultiplayerSpawner`;
- если `wired_package.gd` не загрузился, ядро пишет ошибку в лог и продолжает работу без регистраций этого пакета.

### 7.2. `WiredPackageRegistration`

База для точки входа, `RefCounted`:

```gdscript
class_name WiredPackageRegistration extends RefCounted

# Реализованный контракт использует строки `"server"` и `"local"`; enum
# `Authority` из ранней редакции не вводился, чтобы пакетные скрипты не
# зависели от констант глобального класса.

var context: WiredPackageContext

func register(_registry: WiredPackageRegistry) -> void:
	pass

func scene_path(relative: String) -> String:
	return context.scene_path(relative)
```

`WiredPackageContext` хранит `package_id`, `revision`, `artifact_key`, `root_path` и умеет:

- `scene_path(relative) -> String` — путь для `load`/`instantiate`;
- `instantiate(relative) -> Node` — через `PackagesManager.instantiate_scene(...)`, с meta пакета.

### 7.3. `WiredPackageRegistry`

`class_name WiredPackageRegistry extends Node`.

Ответственность:

- знать все регистрации по пакетам;
- перезагружать регистрации при `package_applied`;
- отдавать отсортированные списки для статики, игроков и динамики;
- не давать пакетам столкнуться по именам;
- логировать ошибки и не ронять сервер.

Публичный API для пакета (вызывается внутри `register`):

```gdscript
add_static_scene(path: String, options: Dictionary = {}) -> void
add_player_component(path: String, options: Dictionary = {}) -> void
add_dynamic_entity(local_type: String, path: String, options: Dictionary = {}) -> void
```

Опции:

| Опция | Где | По умолчанию | Смысл |
|---|---|---|---|
| `order` | static/player | 0 | порядок создания |
| `authority` | player/dynamic | `"server"` | кто симулирует; у dynamic ядро принимает только `"server"` |
| `local_only` | player | false | создавать только у локального владельца |
| `persist` | dynamic | true | попадает ли сущность в `state.json` |

Ядро честно исполняет только эти опции. Политика на игрока — лимит живых
сущностей, кулдаун, время жизни — принадлежит компонентам пакета (например,
`player/spawner.gd` в примере) и не дублируется в регистрации. Опции
`limit_per_player`, `cooldown_ms`, `lifetime_ms` из ранней редакции удалены:
они не читались ядром и создавали ложное впечатление контракта. Динамическая
сущность с `authority != "server"` отклоняется при спавне с диагностикой
`WIRED_DYNAMIC_SPAWN_FAILED reason=authority_not_server`.

Внутренние ключи: `package_id`, `revision`, `qualified_name`.

Квалификация:

- действие: `"<package_id>/<local_action>"`;
- динамический тип: `"<package_id>/<local_type>"`.

Порядок:

1. `package_id` по возрастанию (стабильно между сервером и клиентами);
2. `order` по возрастанию;
3. индекс регистрации внутри пакета.

Перезагрузка:

- при `package_applied(package_id, revision, changed_files)` реестр сбрасывает регистрации этого пакета и загружает `wired_package.gd` заново;
- статический мир получает сигнал `registry_changed` и пересоздаётся;
- игроки получают новые компоненты только при следующем спавне; уже заспавненные игроки не пересобираются в v1 (в лог пишется предупреждение);
- динамические сущности: новые спавны используют новый тип; уже существующие живут до despawn;
- если изменился скрипт с `class_name` или autoload, нужен перезапуск runtime — это ограничение Godot, а не баг.

### 7.4. Совместимость с `PackageReloader`

`PackageReloader` продолжает отвечать за обычные корни сцен с meta `_wired_package_id`. Чтобы не было двойной перезагрузки:

- узлы, созданные реестром, получают meta `_wired_registered = true`;
- `PackageReloader` пропускает такие корни;
- реестр сам пересоздаёт зарегистрированную статику;
- для остальных сцен поведение не меняется.

## 8. Игрок

### 8.1. `WiredPlayer`

`class_name WiredPlayer extends Node`.

Поля:

```gdscript
var player_id: int
var peer_id: int
var display_name: String
var input: Dictionary          # последний принятый input
var spawn_position_2d: Vector2
var spawn_position_3d: Vector3
var components: Array[WiredPlayerComponent]
var _last_input_seq: int
var _action_handlers: Dictionary
```

Ключевые методы:

```gdscript
is_local_player() -> bool          # peer_id == multiplayer.get_unique_id()
is_server_authority() -> bool      # multiplayer.is_server()
get_anchor_position_2d() -> Vector2
get_anchor_position_3d() -> Vector3
set_anchor_position_2d(value: Vector2) -> void
set_anchor_position_3d(value: Vector3) -> void
request_action(qualified_action: StringName, payload: Variant) -> void
handle_action(qualified_action: StringName, payload: Variant) -> bool
register_action(qualified_action: StringName, handler: Callable) -> void
get_component(type_or_name) -> WiredPlayerComponent
save_state() -> Dictionary
load_state(data: Dictionary) -> void
```

Корень игрока — `Node`, authority сервера. Позиция игрока не хранится в корне: её задаёт компонент тела через `set_anchor_position_2d/3d`. Это позволяет одному контракту работать и с 2D, и с 3D.

Ввод:

- локальный игрок раз в тик (целевые 30 Гц) читает действия `wired_move_left/right/up/down`, `wired_jump`;
- формирует `{move: Vector2, jump: bool, seq: int}`;
- отправляет через `WiredNetwork.send_player_input(input)`;
- сервер принимает только от владельца, отбрасывает `seq <= last_seq`, клампит `move` к длине 1;
- сервер пишет input в `player.input`; компоненты читают его.

Действия:

- компонент вызывает `request_action("spawn_crate", payload)`;
- база квалифицирует имя и вызывает `player.request_action`;
- клиент отправляет reliable RPC через `WiredNetwork.send_player_action`;
- сервер проверяет, что `peer_id` отправителя совпадает с владельцем игрока;
- сервер вызывает `player.handle_action(qualified, payload)`;
- обработчик ищется в `_action_handlers`, зарегистрированном компонентом на сервере.

Частотный лимит действий — в `WiredPlayer`/`PlayersManager`: не больше N действий в секунду на игрока; превышение логируется и отбрасывается. Точное N — решение реализатора (разумно 10–20/с).

### 8.2. `WiredPlayerComponent`

`class_name WiredPlayerComponent extends Node`.

Поля:

```gdscript
var player: WiredPlayer
var package_id: String
var relative_path: String          # путь сцены относительно корня пакета
var authority_mode: String         # "server" | "local"
var local_only: bool

func state_key() -> String:
	return "<package_id>:<relative_path>"
```

Хуки:

```gdscript
_wired_ready() -> void
_wired_process(delta: float) -> void
_wired_physics_process(delta: float) -> void
_wired_visual_process(delta: float) -> void          # на всех peer-ах, только визуал/якорь
_wired_unhandled_input(event: InputEvent) -> void    # только локальный владелец
_wired_replicated_properties() -> PackedStringArray      # например ["Body:position", "Body:velocity"]
_wired_save_state() -> Dictionary
_wired_load_state(data: Dictionary) -> void
```

Помощники:

```gdscript
is_local_player() -> bool
is_server() -> bool
register_action(local_name: StringName, handler: Callable) -> void  # только сервер
request_action(local_name: StringName, payload: Variant) -> void    # только локальный
spawn_dynamic(local_type: StringName, data: Dictionary) -> Node     # только сервер
```

Правила вызова хуков:

- `AUTHORITY_SERVER`: `_wired_process`/`_wired_physics_process` выполняются только на сервере; на клиентах компонент существует для визуала и синхронизации, но не симулирует. `_wired_visual_process` при этом выполняется на всех peer-ах, включая клиентов, и используется только для визуальных/производных данных (например, обновить `player.anchor` из уже синхронизированного `Body`).
- `AUTHORITY_LOCAL`: `_wired_process`/`_wired_physics_process` выполняются только у локального владельца; обычно `local_only = true`.
- `AUTHORITY_CLIENT`: зарезервировано; в v1 не используется примером. Если понадобится, это owner-authoritative компонент с серверной валидацией.
- `_wired_unhandled_input` выполняется только на экземпляре компонента у локального владельца, независимо от authority. Это позволяет SERVER-компоненту на клиенте только отправить намерение через `request_action`, а на сервере — обработать его. `request_action` дополнительно проверяет `is_local_player()`.
- `register_action` вызывается только на сервере (обычно под `if is_server():` в `_wired_ready`).

Синхронизация:

- если `_wired_replicated_properties()` не пуст, `PlayersManager` создаёт `MultiplayerSynchronizer` внутри компонента;
- `root_path` синхронизатора — компонент, свойства — относительные пути (`"Body:position"`);
- authority синхронизатора — сервер для `AUTHORITY_SERVER`;
- синхронизация идёт с обычной частотой Godot; для v1 достаточно, интерполяцию можно добавить позже.

### 8.3. Спавн игрока

`PlayersManager` — серверный менеджер и одновременно контейнер игроков.

```gdscript
class_name PlayersManager extends Node

signal player_spawned(player: WiredPlayer)
signal player_despawned(player: WiredPlayer)

func setup(
	registry: WiredPackageRegistry,
	network: WiredNetwork,
	spawner: MultiplayerSpawner
) -> void
func get_player_by_peer(peer_id: int) -> WiredPlayer
func get_player_by_id(player_id: int) -> WiredPlayer
func build_player(data: Dictionary, registry: WiredPackageRegistry) -> WiredPlayer
func snapshot_players() -> Array[Dictionary]
func apply_snapshot(records: Array) -> void
func save_state() -> Dictionary          # {"players": [...]}
func load_state(state: Dictionary) -> void
```

Спавн:

1. Сервер получает `peer_authenticated(peer_id, player_id, name)`.
2. Сервер получает `peer_packages_ready(peer_id)`.
3. Когда оба события есть, сервер вызывает `Spawner.spawn({player_id, peer_id, name})`.
4. `MultiplayerSpawner` вызывает `_spawn_player(data)` на сервере и на клиентах.
5. `_spawn_player` создаёт `WiredPlayer`, добавляет компоненты из реестра в детерминированном порядке, настраивает authority и синхронизаторы, возвращает узел.
6. `MultiplayerSpawner` добавляет узел в `Players`; клиенты получают тот же набор компонентов.

Важно: сервер не спавнит игрока до `peer_packages_ready`. Это гарантирует, что клиент уже применил те же ревизии пакетов и соберёт те же компоненты. Сервер объявляет ревизию только после собственной синхронизации, поэтому порядок «сервер применил → объявил → клиент применил → отчитался → спавн» корректен. Отдельно см. §11.2 о том, как отличить «пакетов нет» от «пакеты ещё не пришли».

Точка спавна:

- `StaticWorldContainer` собирает узлы в группе `wired_player_spawn` (2D/3D `Marker2D`/`Marker3D`) и/или с meta `_wired_player_spawn`;
- API: `get_spawn_position_2d(index: int) -> Vector2`, `get_spawn_position_3d(index: int) -> Vector3`; если маркеров нет — `Vector2.ZERO`/`Vector3.ZERO`;
- `PlayersManager` добавляет в spawn data `spawn_position_2d`/`spawn_position_3d`; для нескольких игроков без отдельных маркеров используется небольшое детерминированное смещение по индексу;
- `WiredPlayer` хранит `spawn_position_2d/3d`; компонент тела при первом спавне ставит тело в эту точку, если нет восстановленного состояния;
- пример: в `static/platform.tscn` есть `Marker2D` в группе `wired_player_spawn`.

Это делает стартовую позицию частью мира, а не случайным значением сцены тела.

Компоненты:

- для каждой регистрации `add_player_component`: загрузить сцену, добавить как child игрока, вызвать `setup(player, registration)`;
- `local_only`: создавать только если `peer_id == multiplayer.get_unique_id()`; на сервере локальных игроков нет, поэтому камера серверу не создаётся;
- authority:
  - корень игрока — сервер (peer 1);
  - `AUTHORITY_SERVER` компонент — сервер;
  - `AUTHORITY_LOCAL` компонент — владелец;
- если компонент не загрузился, логировать и пропустить; игрок всё равно спавнится.

Отключение:

- при `disconnected`/потере peer сервер удаляет игрока; `MultiplayerSpawner` реплицирует удаление;
- если клиент переподключился, это новый `player_id` (см. ограничение идентичности).

### 8.4. Сохранение игрока

`WiredPlayer.save_state()` собирает:

```json
{
  "player_id": 1,
  "peer_id": 2,
  "display_name": "web-client",
  "components": {
    "<package_id>:<relative_scene_path>": { "...": "..." }
  }
}
```

Ключ компонента — `"<package_id>:<relative_scene_path>"` (например, `"42:player/body.tscn"`), а не индекс: добавление/перестановка компонентов не должна переносить состояние на другой компонент. Опция `id` в `add_player_component` может переопределить ключ для будущих переименований; по умолчанию используется относительный путь.

`PlayersManager.save_state()` возвращает массив таких записей.

`PlayersManager.load_state(records)`:

- сохраняет записи в `_restored_player_state` по `player_id`;
- при следующем спавне игрока с тем же `player_id` применяет состояние компонентов через `_wired_load_state`;
- если совпадения нет, запись остаётся неиспользованной.

Ограничение: `player_id` сейчас назначается сервером инкрементально и не является стабильной идентичностью аккаунта. Поэтому восстановление после перезапуска сервера — best-effort и может применить состояние не тому человеку. Для настоящего сохранения нужно расширить ticket/user identity (отдельная задача). В design doc это фиксируется явно, чтобы не создавать ложное ожидание.

## 9. Статический мир

`class_name StaticWorldContainer extends Node`.

Ответственность:

- по сигналу `registry_changed` пересоздать дочерние узлы;
- для каждой `add_static_scene` регистрации инстанцировать сцену через `PackagesManager.instantiate_scene`;
- добавить в контейнер;
- поставить meta `_wired_package_id`, `_wired_registered = true`;
- не сохранять и не синхронизировать: каждый peer строит статику локально из одинаковых файлов.

Порядок — детерминированный (package_id, order, index). Если сцена не загрузилась, логировать и продолжить.

Статика может содержать 2D и 3D узлы; контейнер — обычный `Node`, поэтому не навязывает тип. Для 3D `SubViewport.own_world_3d = true`.

Серверная физика игрока сталкивается со статикой сервера; клиентская визуальная картинка использует статику клиента. Readiness-гейт гарантирует, что наборы сцен совпадают.

## 10. Динамический мир

### 10.1. `DynamicWorldContainer`

`class_name DynamicWorldContainer extends Node`.

Дети:

- `Spawner` (`MultiplayerSpawner`, `spawn_path = ".."`);
- сервер создаёт сущности через `Spawner.spawn(data)`;
- клиенты получают их через тот же spawner.

API:

```gdscript
setup(registry: WiredPackageRegistry, spawner: MultiplayerSpawner) -> void
spawn_entity(qualified_type: String, data: Dictionary) -> Node
despawn_entity(entity_id: int) -> void
snapshot_state() -> Array[Dictionary]   # late-join snapshot, includes persist:false
apply_snapshot(records: Array) -> void  # client, idempotent by entity_id
save_state() -> Array[Dictionary]       # only persist:true live entities
load_state(records: Array) -> void
```

`spawn_entity`:

- только сервер;
- проверяет, что тип зарегистрирован и `authority == "server"`; другие
  authority отклоняются;
- пробрасывает `persist` в сущность: `false` оставляет её в живом мире и в
  late-join snapshot, но исключает из `state.json`;
- добавляет в data `type`, `owner_player_id`, `spawn_time`;
- вызывает `Spawner.spawn(data)`;
- возвращает узел или `null`; причина отказа пишется в лог и, при необходимости, в ответ игроку.
- лимиты и кулдауны на игрока ядро не проверяет: это политика компонента пакета.

`_spawn_entity(data)`:

- находит регистрацию по `type`;
- инстанцирует сцену через `PackagesManager.instantiate_scene`;
- выставляет `entity_type`, `owner_player_id`;
- вызывает `_wired_apply_spawn(data)`;
- возвращает узел (spawner сам добавляет его в контейнер).

### 10.2. `WiredDynamicEntity`

`class_name WiredDynamicEntity extends Node`.

Поля:

```gdscript
var entity_id: int
var type_id: String              # "<package_id>/<local_type>"
var owner_player_id: int
var persistent: bool             # registry option `persist`
var spawn_data: Dictionary
```

Хуки:

```gdscript
_wired_apply_spawn(data: Dictionary) -> void
_wired_replicated_properties() -> PackedStringArray
_wired_save_state() -> Dictionary
_wired_load_state(data: Dictionary) -> void
```

Поведение базы:

- на сервере `RigidBody2D.freeze = false`, `RigidBody3D.freeze = false`;
- на клиентах тело замораживается (`freeze = true`, kinematic-режим), позиция/поворот/скорость приходят через `MultiplayerSynchronizer`;
- `_wired_freeze_on_client()` обходит все `RigidBody2D`/`RigidBody3D` под корнем, включая сам корень, если пакет сделал тело корневой нодой;
- пакет сам хранит ссылку на тело (`@onready var body`) и применяет импульс в `_wired_apply_spawn`; base-класс не навязывает поля `body_2d`/`body_3d`;
- удаление выполняет `DynamicWorldContainer.despawn_entity(entity_id)`; освобождение узла реплицируется spawner-ом.

Пример crate:

```gdscript
extends WiredDynamicEntity

@onready var body: RigidBody2D = $RigidBody2D

func _wired_apply_spawn(data: Dictionary) -> void:
	body.global_position = data.position
	if data.has("impulse"):
		body.apply_central_impulse(data.impulse)

func _wired_replicated_properties() -> PackedStringArray:
	return ["RigidBody2D:position", "RigidBody2D:rotation", "RigidBody2D:linear_velocity"]

func _wired_save_state() -> Dictionary:
	return {
		"position": [body.global_position.x, body.global_position.y],
		"rotation": body.global_rotation,
		"velocity": [body.linear_velocity.x, body.linear_velocity.y],
	}
```

### 10.3. Сохранение мира

`DynamicWorldContainer.save_state()` возвращает массив:

```json
{
  "type": "<package_id>/crate",
  "owner_player_id": 1,
  "state": {
    "position": [x, y],
    "rotation": 0.0,
    "velocity": [x, y]
  }
}
```

Сохраняется только финальное состояние, без транзиентных параметров спавна (`impulse`, `direction`). Это важно: восстановление не должно повторно запускать все crate-ы с импульсом. Сущности, зарегистрированные с `persist: false`, в этот массив не попадают; при этом они входят в late-join snapshot, потому что опоздавший клиент должен увидеть текущий мир.

`main_scene._save_state(reason)` добавляет в `state.json`:

```json
{
  "room": "...",
  "port": 0,
  "reason": "shutdown",
  "active_players": 0,
  "server_seq": 0,
  "saved_at": "...",
  "dynamic_world": [],
  "players": []
}
```

Загрузка:

- `main_scene` читает `state.json` при старте сервера (если `--state-dir` задан);
- `DynamicWorldContainer.load_state(records)` сохраняет записи в `_pending`;
- когда registry впервые готов и типы зарегистрированы, контейнер восстанавливает сущности;
- восстановление идёт отдельным путём: `Spawner.spawn({type, owner_player_id, restore: true, state: {...}})`;
- `_spawn_entity` при `restore = true` создаёт узел, вызывает `_wired_load_state(state)` и **не** вызывает `_wired_apply_spawn`; транзиентный импульс не повторяется;
- на сервере после восстановления физика продолжается с сохранёнными position/rotation/velocity; на клиентах тело остаётся kinematic и получает состояние через синхронизатор;
- если тип отсутствует (пакет ещё не применён/удалён), запись остаётся в pending и логируется; можно повторить после следующего `registry_changed`;
- `PlayersManager.load_state` работает как best-effort (см. 8.4).

Периодичность: сохранение на shutdown и, опционально, раз в 30 секунд на сервере. Для v1 достаточно shutdown + периодическое, чтобы не потерять мир при падении.

## 11. Сетевой слой

### 11.1. Новые сигналы и методы `WiredNetwork`

Серверные сигналы:

```gdscript
signal peer_authenticated(peer_id: int, player_id: int, display_name: String)
signal peer_packages_ready(peer_id: int)
signal player_input_received(peer_id: int, input: Dictionary)
signal player_action_received(peer_id: int, action: String, payload: Dictionary)
signal world_snapshot_requested(peer_id: int)      # server
signal world_snapshot_received(snapshot: Dictionary)  # client
```

Методы:

```gdscript
func is_peer_packages_ready(peer_id: int) -> bool
func send_player_input(input: Dictionary) -> void          # client -> server, unreliable_ordered
func send_player_action(action_id: StringName, payload: Variant) -> void  # client -> server, reliable
func send_world_snapshot(peer_id: int, snapshot: Dictionary) -> void  # server, reliable
func request_world_snapshot() -> void                      # client -> server, reliable
```

Изменения в существующих RPC:

- `cli_hello` после успешной аутентификации эмитит `peer_authenticated(peer_id, player_id, name)`;
- `cli_game_action` вместо «только лог» эмитит `player_action_received` после проверки, что action пришёл от аутентифицированного peer;
- `cli_package_ready` после записи отчёта проверяет, что все объявленные ревизии применены; если да — эмитит `peer_packages_ready(peer_id)`;
- новый `cli_player_input(input)` принимает input только от аутентифицированного peer и эмитит `player_input_received`;
- если у комнаты нет пакетов, `peer_packages_ready` эмитится после `cli_ready` (нет чего ждать).

Сервер не доверяет клиентскому input: клампит вектор, проверяет seq, лимитирует действия.

### 11.2. Readiness

Текущая последовательность:

1. клиент аутентифицируется;
2. сервер отправляет `world_state` и текущие `package_revision`;
3. клиент синхронизирует пакеты и отправляет `cli_package_ready` на каждую ревизию;
4. сервер видит, что отчёты покрывают все объявленные ревизии;
5. сервер эмитит `peer_packages_ready`;
6. `PlayersManager` спавнит игрока.

Если клиент опоздал (late join), он получает актуальные ревизии в `_send_package_revisions`, применяет и отчитывается; спавн происходит после этого.

Если пакет меняется во время игры, сервер объявляет новую ревизию; клиенты применяют и снова отчитываются. Игроки при этом не пересоздаются автоматически в v1; новый контент применяется к статике и новым спавнам. Для компонентов игрока нужен respawn/reconnect.

#### 11.2.2. Late join snapshot

`MultiplayerSpawner` реплеит отслеженные спавны сразу при подключении
транспортного peer-а — до `cli_hello`, ревизий пакетов и `peer_packages_ready`.
Поэтому одного readiness-гейта для собственного игрока недостаточно: у
опоздавшего клиента реестр ещё пуст, и существующий игрок собирается без
компонентов, а динамическая сущность с неизвестным типом отбрасывается.

После `peer_packages_ready` сервер отправляет этому peer-у авторитетный
снимок мира (`srv_world_snapshot`, reliable, Dictionary):

```json
{
  "packages": {"7": {"revision": 3, "artifact_key": "..."}},
  "players": [{"player_id": 1, "peer_id": 2, "name": "...",
               "spawn_position_2d": [x, y], "spawn_position_3d": [x, y, z],
               "state": {"player_id": 1, "display_name": "...",
                         "components": {"7:player/body.tscn": {...}}}}],
  "dynamic_world": [{"entity_id": 12, "type_id": "7/crate",
                     "owner_player_id": 1, "state": {...}}]
}
```

Клиент применяет снимок только если его локальная карта применённых пакетов
совпадает с серверной по `revision` и `artifact_key` (одна ревизия может
давать разный набор компонентов после публикации зависимости). При
несовпадении снимок откладывается, клиент запрашивает новый
(`cli_world_snapshot`) и повторяет проверку после следующего
`package_applied`. Игроки чинятся на месте: недостающие компоненты
создаются, уже созданные не дублируются; динамические сущности создаются по
`entity_id`, уже отслеженные пропускаются. Повторное применение снимка
идемпотентно. Снимок не заменяет обычную репликацию: дальнейшие изменения
идут через `MultiplayerSpawner`/`MultiplayerSynchronizer`.

#### 11.2.3. Ограничение: аутентификация не гейтит транспортную репликацию

Ticket-аутентификация защищает все игровые RPC: `cli_player_input`,
`cli_player_action`, `cli_package_ready`, `cli_world_snapshot` и остальные
проверяют `_players.has(peer_id)` и отклоняют неизвестного отправителя.
Однако `MultiplayerSpawner` и `MultiplayerSynchronizer` работают на уровне
транспорта: Godot 4.7 реплеит spawn-пакеты и синхронизирует свойства peer-у,
который ещё не отправил `cli_hello`. Публичного per-peer фильтра у
`MultiplayerSpawner` в 4.7 нет; `MultiplayerSynchronizer` умеет visibility
filters, но это не отменяет сам spawn-пакет.

Это осознанно принятое ограничение v1, а не молчаливое игнорирование:

- окно ограничено `AUTH_TIMEOUT_SEC = 5`; сервер разрывает соединение, если
  `cli_hello` не пришёл вовремя;
- до аутентификации peer не может создать игрока, отправить ввод/действие,
  запросить снимок или получить `srv_world_snapshot`;
- реплицируемое состояние — игровое (позиции игроков и сущностей), не токены
  и не пользовательские данные; пакеты комнаты считаются доверенным
  контентом;
- настоящее per-peer гейтирование потребует заменить spawner/synchronizer на
  авторитетные RPC-спавн и снапшоты — отдельная задача, не входящая в v1.

Тест `network_readiness_smoke` фиксирует отказ игровых RPC неизвестному
отправителю; ограничение транспортной репликации остаётся документированным
residual-риском.

#### 11.2.1. Проблема начального bootstrap

Сейчас `WIRED_SERVER_READY` отдаётся backend-у сразу после старта сети, а `reconcileRoom` и команды `package <id> <rev>` приходят позже. Если клиент подключится в этот момент, `_package_revisions` пуст, `peer_packages_ready` эмитится сразу, и игрок спавнится без компонентов. Пустой `_package_revisions` неотличим от комнаты, в которой действительно нет пакетов.

Варианты:

- **A (рекомендуется): backend readiness-гейт.** `POST /rooms/:id/game/connection` (или выдача ticket) ждёт, пока `package-sync` завершит первичный reconcile и все опубликованные ревизии будут `applied`, затем отдаёт ticket. Для комнаты без пакетов — сразу. Не меняет БД, сущности и манифест; меняет только порядок запуска.
- **B: явная control-команда.** Backend после reconcile отправляет по stdin `packages_synced`/`world_ready`; runtime не спавнит игроков до неё. Больше работы в backend и протоколе, но контракт явный.
- **C: core-эвристика.** Ждать N мс или первый `package_revision`. Не рекомендуется: таймаут не гарантирует полноту, а пустая комната и медленная сеть ведут себя по-разному.

Решение: **A**. Пользователь разрешил минимальное backend-изменение 2026-11-01. C не используем.

## 12. Пример пакета

### 12.1. Расположение

Исходники примера — вне базового проекта, чтобы не попадать в каждый редактор:

```
packages/server/godot_project/examples/wired-platformer/
  README.md
  wired_package.gd
  static/platform.tscn
  player/body.tscn
  player/body.gd
  player/camera.tscn
  player/camera.gd
  player/spawner.tscn
  player/spawner.gd
  dynamic/crate.tscn
  dynamic/crate.gd
```

Почему вне `_wired`: `GET /godot-project-info/wired` копирует `godot_project/_wired` в editor FS. Пример не должен автоматически появляться у всех комнат. Пакет публикуется в конкретную комнату через существующий flow.

### 12.2. Состав

`wired_package.gd` регистрирует:

- static `static/platform.tscn`;
- player `player/body.tscn` (server authority);
- player `player/camera.tscn` (local authority, local_only);
- player `player/spawner.tscn` (server authority);
- dynamic `crate` → `dynamic/crate.tscn` (server, persist). Лимит 8 и кулдаун
  250 мс — экспортируемые параметры компонента `player/spawner.gd`, а не
  опции регистрации.

`static/platform.tscn`:

- `StaticBody2D`;
- `Polygon2D` — прямоугольная платформа (например, 640×40, цветной плейсхолдер);
- `CollisionShape2D` с `RectangleShape2D`;
- при желании — несколько платформ/стен, но для v1 достаточно одной.

`player/body.tscn`:

- корень `Node` со скриптом `body.gd extends WiredPlayerComponent`;
- child `CharacterBody2D` по имени `Body`;
- child `Polygon2D` — квадрат 32×32 (плейсхолдер);
- child `CollisionShape2D` с `RectangleShape2D` 32×32;
- параметры: гравитация, скорость, прыжок, `floor_snap_length`.

`body.gd`:

- `_wired_physics_process(delta)` только на сервере;
- при первом спавне ставит `body.global_position = player.spawn_position_2d`, если нет восстановленного состояния;
- читает `player.input.move` и `player.input.jump`;
- применяет гравитацию и `move_and_slide()`;
- обновляет `player.set_anchor_position_2d(body.global_position)`;
- `_wired_visual_process(delta)` на клиентах обновляет `player.set_anchor_position_2d(body.global_position)` из уже синхронизированного `Body`, чтобы локальная камера следовала за телом;
- после движения обрабатывает столкновения с другими игроками: если столкнулся с телом другого игрока, применяет серверный push (скорость/импульс второму телу);
- `_wired_replicated_properties()` → `["Body:position", "Body:velocity"]`;
- `_wired_save_state()` → позиция/скорость.

Толкание: `CharacterBody2D` не передаёт импульс другому `CharacterBody2D` автоматически. Поэтому на сервере после `move_and_slide()` перебираем `get_slide_collision_count()`; если коллайдер принадлежит телу другого игрока, вызываем у него `apply_push(direction * PUSH_FORCE)`. Второе тело добавляет внешнюю скорость и плавно её гасит. Это серверная логика, без RPC в пакете. Точную силу и затухание выбирает реализатор.

`player/camera.tscn`:

- корень `Node` со скриптом `camera.gd extends WiredPlayerComponent`;
- child `Camera2D` с `position_smoothing_enabled = true`;
- `_wired_process(delta)`: если `is_local_player()`, `camera.global_position = player.get_anchor_position_2d()`, `camera.enabled = true`;
- у не-локальных игроков камера отсутствует (`local_only = true`).

`player/spawner.tscn`:

- корень `Node` со скриптом `spawner.gd extends WiredPlayerComponent`;
- на сервере в `_wired_ready()` регистрирует действие `spawn_crate`;
- на локальном клиенте в `_wired_unhandled_input(event)` ловит ЛКМ (или действие `wired_spawn_crate`);
- считает позицию курсора в мировых координатах SubViewport:

```gdscript
var mouse_world := get_viewport().get_canvas_transform().affine_inverse() * get_viewport().get_mouse_position()
var origin := player.get_anchor_position_2d()
var direction := (mouse_world - origin).normalized()
request_action("spawn_crate", {"direction": [direction.x, direction.y]})
```

- на сервере `_on_spawn_crate(payload)`:
  - проверяет, что `direction` — конечный вектор, длина > 0, после нормализации не NaN, дальность в допустимых пределах;
  - проверяет собственный кулдаун и лимит живых сущностей (политика компонента);
  - считает `spawn_position = player.get_anchor_position_2d() + direction * SPAWN_OFFSET`;
  - вызывает `spawn_dynamic("crate", {position: spawn_position, impulse: direction * IMPULSE_FORCE, owner_player_id: player.player_id})`;
  - при отказе логирует причину.

Клиент никогда не присылает позицию спавна — только направление. Сервер сам
выбирает точку рядом с авторитетным телом и не доверяет клиентской позиции.
Проверки «точка не внутри стены» в v1 нет: при спавне вплотную к препятствию
ящик может пересечь коллайдер. Это ограничение примера, а не разрешение
клиенту выбирать позицию; raycast/`intersect_shape` — отдельное улучшение.

`dynamic/crate.tscn`:

- корень `Node` со скриптом `crate.gd extends WiredDynamicEntity`;
- child `RigidBody2D` по имени `RigidBody2D`;
- child `Polygon2D` — квадрат 24×24;
- child `CollisionShape2D` с `RectangleShape2D`;
- `_wired_apply_spawn`: ставит позицию, применяет импульс;
- `_wired_replicated_properties`: position/rotation/linear_velocity;
- `_wired_save_state`: position/rotation/velocity.

### 12.3. Input map

В базовый `project.godot` добавляются действия:

| Действие | Клавиши |
|---|---|
| `wired_move_left` | A, Left |
| `wired_move_right` | D, Right |
| `wired_move_up` | W, Up |
| `wired_move_down` | S, Down |
| `wired_jump` | Space |
| `wired_spawn_crate` | ЛКМ |

Это общие действия ядра; пакет может добавить свои через `InputMap` в runtime, но для примера достаточно базовых. Если действие отсутствует, ядро логирует предупреждение и считает ввод нулевым.

### 12.4. Доставка примера

Сейчас в UI нет импорта каталога пакета. Пакет создаётся в комнате через Packages tab (имя/версия/автор), файлы редактируются в editor FS, публикуются кнопкой Emit.

Для примера предлагается:

1. держать исходники в `godot_project/examples/wired-platformer`;
2. добавить `README.md` с инструкцией: создать пакет, скопировать файлы в `packages/<id>`, опубликовать;
3. опционально добавить dev-скрипт `packages/server/scripts/seed-example-package.mjs`, который через API создаёт пакет, draft-ревизию, загружает файлы и публикует. Скрипту нужны `WIRED_API_URL`, токен и id комнаты; он не входит в runtime и не меняет БД.

Seed-скрипт — инструмент разработки, а не обязательная часть архитектуры. Если он усложняет план, его можно вынести в отдельную задачу; пример всё равно должен быть проверяемым вручную.

## 13. Тестирование и проверка

### 13.1. GDScript smoke-тесты

Добавить в `packages/server/godot_project/_wired/tests/`:

- `package_registry_smoke.gd` — регистрация фейкового пакета, сортировка, квалификация имён, повторная загрузка, отсутствующий `wired_package.gd`;
- `players_manager_smoke.gd` — сборка игрока из фейковых компонентов, authority, local_only, input/action routing, save/load, ключ состояния при перестановке компонентов, non-finite input, `_wired_registered`;
- `dynamic_world_smoke.gd` — регистрация типа, spawn/despawn, freeze на клиенте (эмуляция), save/load, `persist: false`, authority validation, идемпотентный snapshot;
- `late_join_smoke.gd` — модель двух peer-ов без сокета: реплей спавнов при пустом реестре, применение пакетов, снапшот игрока и ящика, отсутствие дублей, package-map guard;
- `body_state_smoke.gd` — сохранение/загрузка позиции и скорости тела, fallback на сохранённый anchor;
- `network_readiness_smoke.gd` — readiness и отказ игровых RPC неизвестному отправителю;
- `spawner_smoke.gd` и `state_persistence_smoke.gd` — пример спавнера и сохранение `state.json`.

Запуск — как существующие smoke-тесты:

```bash
godot --headless --path packages/server/godot_project/_wired \
  --script res://tests/package_registry_smoke.gd --quit-after 2
```

### 13.2. Проверка типов/парсинга

Для каждого нового `.gd` — headless-запуск или `--check-only`, чтобы поймать синтаксис. Точная команда зависит от установленного Godot 4.7.2; в плане указать ту, которой пользуется репозиторий.

### 13.3. Ручной мультиплеерный сценарий

1. Собрать Web export: `pnpm export:game`.
2. Запустить backend/frontend, открыть комнату.
3. Создать/опубликовать пример пакета.
4. Открыть Game tab в двух окнах/вкладках (или server + client).
5. Проверить:
   - платформа видна обоим;
   - у каждого свой игрок, камера следует только за своим;
   - движение и прыжок реплицируются;
   - игроки толкают друг друга;
   - ЛКМ спавнит квадрат из игрока в сторону курсора, импульс виден обоим;
   - crate сталкивается с платформой и игроками;
   - лимит/кулдаун не дают спамить;
   - после рестарта сервера динамический мир восстанавливается из `state.json` (в пределах доступной идентичности).

### 13.4. Критерии приёмки

- В базовом проекте нет ошибок парсинга; существующие smoke-тесты проходят.
- Пакет без `wired_package.gd` не ломает игру.
- Статика создаётся детерминированно на сервере и клиентах.
- Игрок не спавнится до readiness; late join получает тот же набор компонентов.
- Пример работает в двух клиентах: движение, камера, толкание, crate с импульсом к курсору.
- В примерном пакете нет `multiplayer.rpc()` и собственных spawner/synchronizer.
- `state.json` содержит динамический мир и состояние игроков; загрузка не роняет сервер при отсутствующем типе.
- Документация API и ограничений (идентичность, hot reload) лежит рядом с кодом/в docs.

## 14. Риски и решения

| Риск | Решение |
|---|---|
| `MultiplayerSpawner` с custom spawn function по-разному ведёт себя на сервере/клиентах | Проверить smoke-тестом и двумя клиентами; при необходимости добавлять узел вручную и использовать `spawn_path` |
| `MultiplayerSynchronizer` не синхронизирует вложенные `RigidBody2D` | Указать `root_path` на компонент, свойства `Body:position` и т.п.; проверить в 4.7.2 |
| Синхронизация `position` и физика конфликтуют | На клиентах тело freeze/kinematic; сервер — единственный симулятор |
| UI перехватывает мышь | `mouse_filter = IGNORE` на всех элементах оверлея; проверить прицеливание |
| Пакетные скрипты из `user://` не видят `class_name` ядра | Проверить загрузку `wired_package.gd`; при проблеме использовать `extends "res://_wired/..."` в примере и документировать |
| Горячая перезагрузка ломает игроков | v1: статика пересобирается, игроки — при следующем спавне; для class_name/autoload — restart |
| Нет стабильной идентичности игрока | Явно ограничить restore; отдельная задача на ticket/user id |
| Пакет спавнит сущности за стеной | Сервер считает позицию от своего тела + direction; клиент не присылает позицию |
| Спам действиями | Rate limit действий в ядре; лимит/кулдаун сущностей — политика компонента пакета |
| Клиент подключается до первого reconcile пакетов и спавнится без компонентов | Readiness-гейт backend (§11.2.1, вариант A) плюс late-join snapshot после `peer_packages_ready` (§11.2.2) |
| Транспортная репликация доходит до неаутентифицированного peer-а | Документированное ограничение v1 (§11.2.3): RPC закрыты, окно ограничено auth timeout, per-peer spawn gating — отдельная задача |

## 15. Решения и открытые пункты

Уже принятые решения (не требуют выбора пользователя):

- `_wired_visual_process` обновляет якорь игрока на клиентах из синхронизированного `Body`; камера читает `player.anchor`.
- `_wired_unhandled_input` работает только у локального владельца; `register_action` — только на сервере.
- Восстановление динамического мира не повторяет импульс: отдельный `restore = true` и `_wired_load_state`.
- Точка спавна игрока — маркеры `wired_player_spawn` в статике; `PlayersManager` передаёт её в spawn data.
- Ключ состояния компонента — `"<package_id>:<relative_scene_path>"`, не индекс.
- Late join чинится серверным авторитетным снимком после
  `peer_packages_ready`; снимок применяется только при совпадении
  `revision` и `artifact_key` и идемпотентен (§11.2.2).
- Динамические регистрации честно поддерживают только `authority` и
  `persist`; лимиты/кулдауны остаются в компонентах пакета (§7.3).

Открытые пункты, которые не меняют архитектуру и решаются на этапе плана:

- точные имена классов/файлов (предложены выше);
- точные константы движения, прыжка, push, импульса, cooldown;
- размеры платформы и плейсхолдеров;
- нужен ли seed-скрипт в этой итерации или достаточно README + ручной публикации;
- сохранять ли `state.json` периодически или только на shutdown;
- добавлять ли интерполяцию клиентского тела в v1 (можно отложить).

Решено пользователем:

- readiness-гейт: вариант A, минимальное изменение backend. Control-команда `packages_synced` (вариант B) не используется.

## 16. Что дальше

1. Согласовать этот design doc.
2. После согласования — написать implementation plan в `docs/superpowers/plans/2026-11-01-wired-room-content-packages.md`.
3. Реализовывать по плану: сначала ядро и сцена, затем сеть/игроки, затем динамический мир, затем пример и проверка.
