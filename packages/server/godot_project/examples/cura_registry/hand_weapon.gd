extends WiredPlayerComponent

## Базовый скрипт инструмента в руках игрока.
##
## Пакеты наследуют этот файл через `extends "res://packages/cura_registry/hand_weapon.gd"`
## и переопределяют только публичные хуки. Никаких `class_name` и прямых RPC:
## серверную логику пакет объявляет через `register_action`, локальные намерения
## отправляет `request_action` менеджера инструментов.
##
## Идентификаторы локальны для пакета. В сцене `tool_id == "spawner"`, а менеджер
## хранит полный `<package_id>/<tool_id>`; базовый скрипт квалифицирует имя перед
## сравнением, поэтому наследник никогда не работает с полными id вручную.

@export var tool_id: String = ""
## Сцена вьюмоделя, которую инструмент монтирует в камеру от первого лица.
@export var viewmodel_path: String = ""
## Требует выбранного пропа (например, спавнер не стреляет без цели).
@export var requires_prop: bool = false

## Владелец активного инструмента из Task 4. Поле типизировано `Node`, чтобы
## пакет не зависел от конкретной реализации менеджера: достаточно свойства
## `active_tool_id`, которое читается динамически.
var manager: Node = null

## Предыдущее визуальное состояние, чтобы equip/unequip срабатывали только на
## смену активного инструмента, а не на каждый кадр.
var _visually_equipped := false


# --- серверные хуки -------------------------------------------------------


## Экипировка на сервере. `ctx` несёт менеджер и выбранный проп.
func wired_equip(ctx: Dictionary) -> void:
	pass


func wired_unequip() -> void:
	pass


## Основное действие сервера; `ctx` приходит от `use_tool` менеджера.
func wired_primary(ctx: Dictionary) -> void:
	pass


func wired_secondary(ctx: Dictionary) -> void:
	pass


func wired_update(delta: float) -> void:
	pass


# --- хуки на каждом пире --------------------------------------------------


## Визуальная экипировка вьюмоделя. Вызывается базовым `_wired_visual_process`
## только при смене активного инструмента.
func wired_visual_equip(active: bool) -> void:
	pass


## Анимация и эффекты вьюмоделя; `is_local` истинен для локального игрока.
func wired_visual_update(delta: float, is_local: bool) -> void:
	pass


# --- состояние ------------------------------------------------------------


func wired_save_state() -> Dictionary:
	return {}


func wired_load_state(state: Dictionary) -> void:
	pass


func _wired_save_state() -> Dictionary:
	return wired_save_state()


func _wired_load_state(state: Dictionary) -> void:
	wired_load_state(state)


# --- визуальный процесс ---------------------------------------------------


## Активность инструмента определяется менеджером. Если менеджера нет или его
## `active_tool_id` пуст, инструмент считается неактивным и визуальные хуки не
## вызываются повторно.
func _wired_visual_process(delta: float) -> void:
	var active := false
	if manager != null:
		active = str(manager.get("active_tool_id")) == _qualified_tool_id()
	if active != _visually_equipped:
		_visually_equipped = active
		wired_visual_equip(active)
	if active:
		wired_visual_update(delta, is_local_player())


## Квалификация локального `tool_id` правилами ядра. Используем реестр из
## `Global`, когда он готов; вне дерева создаём временный реестр только ради
## чистого `"<package_id>/<tool_id>"` преобразования.
func _qualified_tool_id() -> String:
	var global_node := get_node_or_null("/root/Global")
	if global_node != null:
		var registry := global_node.get("package_registry") as WiredPackageRegistry
		if registry != null:
			return registry.resolve_action(package_id, tool_id)
	var temporary := WiredPackageRegistry.new()
	var qualified := temporary.resolve_action(package_id, tool_id)
	temporary.free()
	return qualified
