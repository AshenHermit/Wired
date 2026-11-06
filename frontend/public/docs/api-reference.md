# Справочник API Wired

## `WiredPackageRegistration`

Базовый класс точки входа пакета. Пакет наследует его и переопределяет
`register(registry)`.

### Поля

- `package_id: String` — строковый id пакета, проставляется загрузчиком
  перед вызовом `register`.
- `context: WiredPackageContext` — разрешённое расположение применённой
  ревизии.

### Хелперы регистрации

```gdscript
func add_static_scene(relative_path: String, options: Dictionary = {}) -> void
func add_player_component(relative_path: String, options: Dictionary = {}) -> void
func add_main_scene(relative_path: String, options: Dictionary = {}) -> void
func add_dynamic_entity(local_type: String, relative_path: String, options: Dictionary = {}) -> void
```

Опции (общие):

- `order: int` — порядок внутри пакета (по умолчанию 0);
- `authority: String` — `"server"` (по умолчанию) или `"local"`;
- `local_only: bool` — только на пире владельца (по умолчанию `false`).

Опции динамической сущности:

- `persist: bool` — сохраняется в `state.json` (по умолчанию `true`).

### `WiredPackageContext`

- `scene_path(relative_path) -> String` — абсолютный путь к файлу пакета
  (`res://`/`user://`).
- `instantiate(relative_path) -> Node` — загрузить и инстанцировать сцену
  пакета (возвращает `null` при ошибке).
- `package_id`, `revision`, `artifact_key`.

## `WiredPackageRegistry`

Реестр контента комнаты (чистые данные).

- `get_static_scenes() -> Array[Dictionary]`
- `get_player_components() -> Array[Dictionary]`
- `get_dynamic_entities() -> Array[Dictionary]`
- `get_main_scenes() -> Array[Dictionary]`
- `get_main_scene() -> Dictionary`
- `find_dynamic_entity(qualified_type) -> Dictionary`
- `get_context(package_id) -> WiredPackageContext`
- `resolve_action(package_id, local_name) -> String` — квалификация имени.
- `clear_package(package_id)` — убрать контент пакета.

Дескриптор содержит ключи: `package_id`, `path`, `order`, `authority`,
`local_only`, `options`, `registration_index`. Динамический дополнительно:
`local_type`, `qualified_type`.

## `WiredDynamicEntity`

Базовый класс динамической сущности (наследует `Node`).

Поля (проставляются ядром до `_ready`):

- `entity_id: int` — монотонный id, стабильный при save/load;
- `type_id: String` — квалифицированный тип `<package_id>/<local_type>`;
- `owner_player_id: int` — игрок-инициатор (0 для мировых);
- `persistent: bool` — опция `persist`;
- `spawn_data: Dictionary` — полная спавн-запись.

Хуки для переопределения:

- `_wired_apply_spawn(data)` — применить спавн один раз на каждом пире;
- `_wired_replicated_properties() -> PackedStringArray` — пути свойств
  синхронизатора (относительно корня сущности);
- `_wired_save_state() -> Dictionary` — состояние для `state.json`;
- `_wired_load_state(state)` — восстановить состояние.

Вспомогательные методы:

- `_as_vector2(value, fallback) -> Vector2`
- `_as_vector3(value, fallback) -> Vector3`

## `WiredPlayerComponent`

Базовый класс компонента игрока (наследует `Node`).

Поля:

- `player: WiredPlayer` — владелец (проставляется до входа в дерево);
- `package_id: String`, `relative_path: String`;
- `authority_mode: String` — `"server"` или `"local"`;
- `local_only: bool`.

Хуки:

- `_wired_ready()` — вызывается в `_ready` после создания синхронизатора;
- `_wired_process(delta)` — симуляция (только владелец);
- `_wired_physics_process(delta)` — физика (только владелец);
- `_wired_visual_process(delta)` — визуал (на всех пирах);
- `_wired_unhandled_input(event)` — ввод (только локальный игрок);
- `_wired_replicated_properties() -> PackedStringArray`;
- `_wired_save_state() -> Dictionary`;
- `_wired_load_state(state)`.

Методы:

- `register_action(local_name, handler)` — зарегистрировать обработчик
  действия (только сервер). Имя автоматически квалифицируется.
- `request_action(local_name, payload)` — отправить намерение на сервер
  (только локальный игрок).
- `spawn_dynamic(local_type, data) -> Node` — заспавнить динамическую
  сущность (только сервер). Имя типа квалифицируется автоматически.
- `state_key() -> String` — `<package_id>:<relative_path>`.
- `is_local_player()`, `is_server()`.

## `WiredPlayer`

Корень игрока (наследует `Node`).

- `player_id`, `peer_id`, `display_name`;
- `input: Dictionary` — последний принятый ввод `{move, jump, seq}`;
- `spawn_position_2d`, `spawn_position_3d`;
- `components: Array[WiredPlayerComponent]`;
- `get_anchor_position_2d/3d()`, `set_anchor_position_2d/3d()`;
- `register_action(qualified_action, handler)` (сервер);
- `handle_action(qualified_action, payload, sender_peer)` (сервер);
- `request_action(qualified_action, payload)` (локальный игрок);
- `add_component(component, authority, local_only)`;
- `save_state() -> Dictionary`, `load_state(state)`,
  `apply_saved_anchor(state)`;
- `park_component_states()`, `purge_package(package_id)`,
  `keep_only_packages(package_ids)`.

## `WiredProtocol`

Константы ключей спавн-записей и метаданных узлов:

- `KEY_ENTITY_ID`, `KEY_TYPE_ID`, `KEY_OWNER_PLAYER_ID`, `KEY_STATE`,
  `KEY_RESTORE`, `KEY_SPAWN_DATA`;
- `KEY_PACKAGE_ID`, `KEY_PATH`, `KEY_ORDER`, `KEY_AUTHORITY`,
  `KEY_LOCAL_ONLY`, `KEY_QUALIFIED_TYPE`, `KEY_OPTIONS`;
- `META_PACKAGE_ID`, `META_PACKAGE_SCENE`, `META_PACKAGE_REVISION`,
  `META_PACKAGE_ARTIFACT_KEY`, `META_REGISTERED`, `META_ENTITY_ID`;
- `KEY_PACKAGES`, `KEY_PLAYERS`, `KEY_DYNAMIC_WORLD`;
- `as_vector2(value, fallback)`, `as_vector3(value, fallback)`.

## `Global` (автозагрузка)

- `get_package_registry() -> WiredPackageRegistry`
- `get_static_world() -> StaticWorldContainer`
- `get_dynamic_world() -> DynamicWorldContainer`
- `get_players() -> PlayersManager`
- `get_network() -> WiredNetwork`

## `StaticWorldContainer`

- `rebuild()` — пересобрать статику из реестра;
- `clear()` — убрать только зарегистрированные корни;
- `get_spawn_position_2d(index) -> Vector2`,
  `get_spawn_position_3d(index) -> Vector3`.

## `DynamicWorldContainer`

- `spawn_entity(qualified_type, data) -> Node` — заспавнить (только сервер);
- `despawn_entity(entity_id)` — деспавнить;
- `save_state() -> Array[Dictionary]` — сохранить (только persistent);
- `snapshot_state() -> Array[Dictionary]` — снимок (включая non-persistent);
- `seed_pending(records)`, `restore_pending()`, `load_state(records)`;
- `park_package(package_id)`, `drop_package(package_id)`,
  `purge_package(package_id)`, `purge_missing_packages(package_ids)`;
- `apply_snapshot(records, packages)` — клиентский ремонт мира.

## `PlayersManager`

- `build_player(data, registry) -> WiredPlayer`;
- `spawn_player(peer_id)`, `despawn_player(peer_id)`;
- `get_player_by_peer(peer_id)`, `get_player_by_id(player_id)`;
- `snapshot_players() -> Array[Dictionary]`;
- `apply_snapshot(records)`;
- `rebuild_live_components() -> int`;
- `save_state() -> Dictionary`, `load_state(state)`;
- `purge_package(package_id)`, `purge_missing_packages(package_ids)`.

## Действия (actions)

Действия — это именованные намерения игрока, маршрутизируемые через сервер.

На сервере (в компоненте):

```gdscript
func _wired_ready() -> void:
    register_action("jump", _on_jump)

func _on_jump(sender_peer: int, payload: Dictionary) -> void:
    # серверная логика
    pass
```

На клиенте:

```gdscript
func _wired_unhandled_input(event) -> void:
    if event.is_action_pressed("ui_accept"):
        request_action("jump", {"height": 1.0})
```

Имя автоматически квалифицируется как `<package_id>/<local_name>`. Лимит:
20 действий в секунду на игрока.

## Ввод

Локальный клиент семплирует `wired_move_*`/`wired_jump` с частотой не выше
30 Гц и отправляет `{move, jump, seq}` по ненадёжному каналу. Сервер
принимает ввод только от владельца, клампит `move` до длины 1 и сохраняет
в `player.input`.

## См. также

- [Начало работы](/docs?doc=getting-started)
- [Регистрация сущностей](/docs?doc=entity-registration)
- [Сетевое руководство](/docs?doc=multiplayer-guide)
