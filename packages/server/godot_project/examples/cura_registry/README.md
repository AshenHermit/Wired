# `cura_registry`

Библиотека для пакетов контента Wired: реестр категорий, props и инструментов,
панель выбора по `Q`, серверный менеджер инструментов и базовый скрипт ручного
оружия. Библиотека не знает о конкретной игре: все записи попадают в
`WiredPackageRegistry`, а сетевые действия идут только через
`register_action`/`request_action`.

Скрипты пакета не объявляют `class_name` и не вызывают RPC напрямую.

## Что регистрирует сама библиотека

Её `wired_package.gd` объявляет:

- категории `cura.category`: `props` и `tools`;
- инструмент `cura.tool`: `spawner`;
- панель `ui/registry_panel.tscn` — `order 40`, `authority "local"`,
  `local_only true`;
- менеджер `tools/tool_manager.tscn` — `order 50`, `authority "server"`;
- оружие `tools/spawner.tscn` — `order 60`, `authority "server"`.

Все идентификаторы локальны для пакета; реестр ядра квалифицирует их как
`<package_id>/<id>`. В сигналах панели и в полезной нагрузке actions уже идут
полные строки (`42/spawner`, `42/crate`).

## Подключение зависимости

Опубликуйте `cura_registry` в комнате **до** пакетов, которые её используют.
В своём entry пакета подключите публичный API:

```gdscript
extends WiredPackageRegistration

const Cura = preload("res://packages/cura_registry/api.gd")
```

При публикации бэкенд переписывает этот путь на путь применённой ревизии
библиотеки, поэтому исходник пакета остаётся читаемым и не зависит от номера
ревизии. Внутри `register(registry)` используйте только `Cura.*` и
`add_player_component`.

## Регистрация пропа

Один вызов `register_prop` создаёт две записи: динамический тип для
`DynamicWorld` и дескриптор для панели. Они связываются общим
`dynamic_type == local_type`.

```gdscript
func register(_registry: WiredPackageRegistry) -> void:
	Cura.register_category(self, "props", {"label": "Props", "order": 10})
	Cura.register_prop(self, "crate", "dynamic/crate.tscn", {
		"category": "props",
		"label": "Wooden crate",
		"icon": "res://packages/crate_prop_example/icon.svg",
		"authority": "server",
		"persist": true,
	})
```

`authority` по умолчанию `"server"`; `persist` по умолчанию `false`. Проп с
`authority != "server"` менеджер не спавнит: точка спавна всегда вычисляется
сервером. Готовый пример — `examples/crate_prop_example`.

## Регистрация инструмента и своего hand weapon

Дескриптор инструмента описывает только отображение в панели. Поведение и
вьюмодель живут в отдельном компоненте игрока, который регистрирует сам пакет
инструмента:

```gdscript
func register(_registry: WiredPackageRegistry) -> void:
	Cura.register_tool(self, "gravity_gun", {
		"label": "Gravity Gun", "category": "tools", "order": 60,
	})
	add_player_component("tools/gravity_gun.tscn", {
		"authority": "server", "order": 60,
	})
```

Корень сцены расширяет базовый скрипт библиотеки, объявляет `tool_id` и вступает
в группу `cura_hand_weapon`:

```gdscript
extends "res://packages/cura_registry/hand_weapon.gd"

@export var tool_id: String = "gravity_gun"

func _ready() -> void:
	add_to_group("cura_hand_weapon")

## ctx приходит от серверного менеджера и содержит проверенные поля;
## координаты клиента в ctx.payload доверенными не считаются.
func wired_primary(ctx: Dictionary) -> void:
	var manager: Node = ctx.get("manager") as Node
	if manager != null and manager.has_method("spawn_prop"):
		var hit: Dictionary = ctx.get("hit", {})
		manager.call("spawn_prop", str(ctx.get("selected_prop", "")), hit.get("position", Vector3.ZERO))

## Вьюмодель монтируется через accessors персонажа; пакет не зависит от
## конкретной реализации `cura_player`.
func wired_visual_equip(active: bool) -> void:
	# Подключите свой viewmodel через character.equip_viewmodel(...)
	pass
```

Базовый скрипт даёт серверные хуки `wired_equip(ctx)`, `wired_unequip()`,
`wired_primary(ctx)`, `wired_secondary(ctx)`, `wired_update(delta)` и хуки для
каждого пира `wired_visual_equip(active)`, `wired_visual_update(delta, is_local)`.
Менеджер находит оружие по группе и полному `tool_id`, поэтому встроенный
`spawner` не является частным случаем.

## Authority и группы

- `"local"`, `local_only true` — только локальная панель (`Q`): она не
  реплицируется и не хранит состояние.
- `"server"` — менеджер и оружие: принятие решений и спавн происходят на
  сервере. Локальный экземпляр менеджера посылает `request_action`, серверный
  регистрирует `register_action` и проверяет `sender_peer`, инструмент, проп и
  результат серверного raycast.
- `cura_player_character` — персонаж `cura_player`; source захвата взгляда,
  углов наведения и монтажа вьюмодели.
- `cura_registry_panel` — панель библиотеки; менеджер ищет её среди компонентов
  игрока, чтобы связать выбор с экипировкой.
- `cura_hand_weapon` — оружие; менеджер ищет его среди компонентов игрока по
  полному `tool_id`.

Ограничение темпа: менеджер не чаще **4 action/с** (debounce 0.25 с). Бюджет
`WiredPlayer` — 20 actions/с, а `cura_player` уже тратит ~15 на snapshots
взгляда; более частая стрельба приводила бы к silently dropped actions.

## Ручная проверка в Game tab — ожидает человека

Автоматические smoke-тесты проверяют API, entry, компоненты и их контракты
в headless-режиме. Следующий сценарий требует живого frontend + backend и
пока **не выполнен**:

1. Опубликовать через Packages tab в одну комнату три пакета: `cura_registry`,
   `cura_player`, `crate_prop_example`.
2. `Q` открывает и закрывает панель; указатель возвращается в capture.
3. Выбор crate экипирует вьюмодель `spawner`.
4. ЛКМ создаёт ящик на полу.
5. Ящик виден второму клиенту и сохраняется после hot-reload
   `crate_prop_example`.

При провале зафиксировать лог и вернуться к владельцу задачи.
