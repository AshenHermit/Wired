# Регистрация сущностей и контента

Пакет не создаёт узлы напрямую. Вместо этого он **регистрирует дескрипторы**
в `WiredPackageRegistry` через хелперы `WiredPackageRegistration`. Ядро само
строит мир из этих дескрипторов.

## Виды контента

| Вид | Хелпер | Что делает |
|---|---|---|
| main-сцена | `add_main_scene(path)` | Заменяет штатный `Main/Game` своей сценой |
| статика | `add_static_scene(path, options)` | Сцены, общие для всех клиентов (платформы, декорации) |
| компонент игрока | `add_player_component(path, options)` | Часть каждого игрока (тело, камера, спавнер) |
| динамическая сущность | `add_dynamic_entity(type, path, options)` | Серверно-заспавненные объекты (ящики, пули, NPC) |

## Статика

Статика строится из реестра и **не реплицируется**: каждый клиент сам
инстанцирует одни и те же сцены из одного и того же реестра. Маркеры спавна
игроков — это `Marker2D`/`Marker3D` в группе `wired_player_spawn` или с
метаданными `wired_player_spawn = true`.

```gdscript
add_static_scene("static/platform.tscn", {"order": 10})
```

Опции: `order` (int), `authority` (по умолчанию `"server"`).

## Компоненты игрока

Каждый зарегистрированный компонент становится дочерним узлом `WiredPlayer`
и строится из реестра в порядке `package_id → order → registration_index`.
Скрипт компонента должен наследовать `WiredPlayerComponent`.

```gdscript
add_player_component("player/body.tscn", {"order": 10, "authority": "server"})
add_player_component(
    "player/camera.tscn",
    {"order": 20, "authority": "local", "local_only": true}
)
```

Опции:

- `order` — порядок сборки;
- `authority` — `"server"` (только сервер симулирует) или `"local"` (только
  владелец);
- `local_only` — компонент существует только на пире владельца (камера).

## Динамические сущности

Динамическая сущность — это серверно-заспавненный объект, реплицируемый
через `MultiplayerSpawner`. Скрипт сущности должен наследовать
`WiredDynamicEntity`.

```gdscript
add_dynamic_entity(
    "crate", "dynamic/crate.tscn",
    {"authority": "server", "persist": true}
)
```

- `local_type` (первый аргумент) — локальное имя типа; ядро квалифицирует
  его как `<package_id>/<local_type>` (например `42/crate`).
- `authority` — только `"server"` допускается для спавна (клиентские
  динамические сущности не поддерживаются).
- `persist` — попадает ли сущность в `state.json` (по умолчанию `true`).
  С `persist: false` сущность видна в мире и в снимке для позднего клиента,
  но не сохраняется.

### Хуки `WiredDynamicEntity`

Пакет переопределяет:

- `_wired_apply_spawn(data)` — применить спавн-запись (движение, импульс).
  Вызывается один раз на каждом пире.
- `_wired_replicated_properties()` — пути свойств для синхронизатора
  (относительно корня сущности, например `RigidBody2D:position`).
- `_wired_save_state()` / `_wired_load_state(state)` — сериализация состояния
  для `state.json` и восстановления.
- `_wired_freeze_on_client` вызывается автоматически: клиентские копии
  фризятся, чтобы реплицированный трансформ был единственным источником истины.

`spawn_data` — одноразовый ввод (импульс курсора) и никогда не сохраняется.
Восстановление идёт через `_wired_load_state`, а не через свежий спавн.

### Спавн из компонента

Компонент игрока может заспавнить динамическую сущность на сервере:

```gdscript
# внутри WiredPlayerComponent
var crate := spawn_dynamic("crate", {
    "position": global_position,
    "direction": aim_direction,
})
```

`spawn_dynamic` сам квалифицирует локальное имя типа.

## Main-сцена

Пакет может заменить штатный `Main/Game` своей сценой. Корень сцены должен
использовать скрипт `WiredGameScene` и указать `world_viewport` —
`SubViewport`, в который ядро переносит `StaticWorld`, `DynamicWorld` и
`Players`.

```
CustomMain (Node) [script: WiredGameScene]
  ├─ Game (SubViewportContainer)
  │  └─ SubViewport [world_viewport]   # пустой: сервисы добавит ядро
  └─ UI (CanvasLayer)
     └─ ...
```

`world_viewport` намеренно пустой. Ядро само переносит в него живые
`StaticWorld`, `DynamicWorld` и `Players`. Не копируйте эти узлы из
`main.tscn`: при совпадении имён Godot переименует живые сервисы в
`@Node@N`, и сетевые пути игроков перестанут совпадать между сервером и
клиентом.

Побеждает первая main-сцена в порядке реестра. Если сцена битая или
`world_viewport` не задан, комната остаётся на штатном `Game`, а в лог
пишется `WIRED_MAIN_SCENE_INVALID ... reason=...`.

## Сервисы ядра

Пакеты обращаются к миру через автозагрузку `Global`:

- `Global.get_static_world()` — `StaticWorldContainer`
- `Global.get_dynamic_world()` — `DynamicWorldContainer`
- `Global.get_players()` — `PlayersManager`
- `Global.get_network()` — `WiredNetwork`
- `Global.get_package_registry()` — `WiredPackageRegistry`

## Маркеры спавна

Статическая сцена содержит `Marker2D`/`Marker3D` в группе
`wired_player_spawn` (или с метаданными `wired_player_spawn = true`).
`StaticWorldContainer` собирает их рекурсивно в порядке дерева; индекс `i`
одинаков для 2D и 3D (Marker3D проецируется в `Vector2(x, y)`, Marker2D
поднимается в `Vector3(x, y, 0)`).

## См. также

- [Начало работы](getting-started.md)
- [Справочник API](api-reference.md)
- [Сетевое руководство](multiplayer-guide.md)
