extends "res://tests/fixtures/cura_registry/hand_weapon.gd"

## Встроенный инструмент `spawner` библиотеки `cura_registry`.
##
## Серверная логика целиком в `wired_primary`: точка спавна берётся только из
## доверенного `ctx.hit`, который менеджер строит серверным raycast. Клиентский
## hit в `ctx.payload` инструмент не читает. Прямых RPC и обращения к `Global`
## нет: спавн идёт через `ctx.manager.spawn_prop`.
##
## Визуальная часть монтируется через accessors `cura_player`: персонаж ищется
## по группе `cura_player_character`, а вьюмодель — по `viewmodel_path` внутри
## этой же сцены. Пакет не зависит от конкретной реализации персонажа.

const CHARACTER_GROUP := "cura_player_character"


## Проп спавнится на поверхности с небольшим отступом по нормали, чтобы не
## зарываться в геометрию и не мерцать при повторном попадании.
func wired_primary(ctx: Dictionary) -> void:
	var manager: Node = ctx.get("manager") as Node
	if manager == null or not manager.has_method("spawn_prop"):
		return
	var hit: Dictionary = ctx.get("hit", {})
	var position: Variant = hit.get("position")
	var normal: Variant = hit.get("normal")
	if not (position is Vector3) or not (normal is Vector3):
		return
	manager.call(
		"spawn_prop",
		str(ctx.get("selected_prop", "")),
		(position as Vector3) + (normal as Vector3) * 0.05,
	)


## Визуальная экипировка на каждом пире: активный инструмент монтирует
## вьюмодель в `tool_mount` персонажа, неактивный — очищает монтаж.
func wired_visual_equip(active: bool) -> void:
	var character := _find_character()
	if character == null:
		return
	if not active:
		if character.has_method("clear_viewmodel"):
			character.call("clear_viewmodel")
		return
	if not character.has_method("equip_viewmodel") or viewmodel_path.is_empty():
		return
	var viewmodel := get_node_or_null(NodePath(viewmodel_path))
	if viewmodel == null:
		return
	# Дубликат не имеет владельца в родительской сцене, поэтому `pack` не
	# пытается сохранить связи с ней и не конфликтует с редакторскими флагами.
	var copy := viewmodel.duplicate() as Node
	copy.owner = null
	_set_owner(copy, copy)
	var packed := PackedScene.new()
	if packed.pack(copy) != OK:
		copy.free()
		return
	copy.free()
	character.call("equip_viewmodel", packed)


## `PackedScene.pack()` включает потомков только при явном владельце-корне.
func _set_owner(node: Node, owner: Node) -> void:
	for child: Node in node.get_children():
		child.owner = owner
		_set_owner(child, owner)


## Персонаж живёт среди компонентов игрока; резервный поиск по дереву нужен
## для smoke-тестов, где персонаж монтируется отдельным узлом.
func _find_character() -> Node:
	if player == null:
		return null
	for component: WiredPlayerComponent in player.components:
		if is_instance_valid(component) and component.is_in_group(CHARACTER_GROUP):
			return component
	var tree := get_tree()
	if tree == null:
		return null
	return tree.get_first_node_in_group(CHARACTER_GROUP)
