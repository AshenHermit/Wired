extends WiredPlayerComponent

## Менеджер активного инструмента библиотеки `cura_registry`.
##
## У одного `WiredPlayer` живут две копии компонента: серверная регистрирует
## `use_tool` и передаёт его активному `hand_weapon`, локальная читает ЛКМ и
## отправляет намерение через `request_action`. Прямых RPC нет: вся серверная
## логика инструмента остаётся в пакете.
##
## Клиентский `hit` из payload никогда не используется для спавна: сервер
## пересчитывает попадание из реплицированных углов персонажа. Часы генерации
## выстрелов берутся только из `now_msec()`, чтобы темп можно было подменить
## в тесте и уложиться в бюджет 20 action/s ядра.

const ACTION_USE := "use_tool"
## 4 выстрела/с: 250 мс между нажатиями укладываются в бюджет 20 action/s.
const FIRE_INTERVAL_MSEC := 250
## Начало луча на высоте глаз: якорь игрока стоит в стопах.
const EYE_HEIGHT := 1.6
const RAY_DISTANCE := 64.0
## Бит 0 — статическая геометрия мира, бит 1 — динамические пропы. Игроки
## живут на слое 0 и в маску не попадают.
const RAY_COLLISION_MASK := (1 << 0) | (1 << 1)
const CHARACTER_GROUP := "cura_player_character"
const PANEL_GROUP := "cura_registry_panel"
const WEAPON_GROUP := "cura_hand_weapon"
const PLAYER_BODY_META := "_wired_player_body"

var selected_tool: String = ""
var selected_prop: String = ""
var active_tool_id: String = ""
var panel_open: bool = false

## Активный инструмент хранится только на сервере и не реплицируется:
## клиенты определяют активность по `active_tool_id` в визуальных хуках.
var active_tool: WiredPlayerComponent = null
var _panel: WiredPlayerComponent = null
var _last_shot_msec: int = -1


func _wired_ready() -> void:
	if is_server():
		register_action(ACTION_USE, _on_use_tool)
	if not is_local_player() or player == null:
		return
	for component: WiredPlayerComponent in player.components:
		if not _is_live(component) or not component.is_in_group(PANEL_GROUP):
			continue
		_panel = component
		if (
			component.has_signal("prop_selected")
			and not component.is_connected("prop_selected", Callable(self, "_on_prop_selected"))
		):
			component.connect("prop_selected", Callable(self, "_on_prop_selected"))
		if (
			component.has_signal("tool_selected")
			and not component.is_connected("tool_selected", Callable(self, "_on_tool_selected"))
		):
			component.connect("tool_selected", Callable(self, "_on_tool_selected"))


func _on_prop_selected(qualified_type: String) -> void:
	set_active(selected_tool, qualified_type)


func _on_tool_selected(qualified_tool: String) -> void:
	set_active(qualified_tool, selected_prop)


## Локальный ЛКМ становится намерением, а не серверным действием: повторная
## проверка прав и raycast выполняются на сервере в `_on_use_tool`.
func _wired_unhandled_input(event: InputEvent) -> void:
	if not is_local_player() or player == null:
		return
	if not (event is InputEventMouseButton):
		return
	var mouse := event as InputEventMouseButton
	if mouse.button_index != MOUSE_BUTTON_LEFT or not mouse.pressed:
		return
	if panel_open:
		return
	var panel := _find_panel()
	if panel != null and panel.has_method("is_open") and bool(panel.call("is_open")):
		return
	# Без экипированного инструмента клик не становится действием.
	if active_tool_id.is_empty():
		return
	var character := _find_character()
	if character == null or not character.has_method("is_look_captured"):
		return
	if not bool(character.call("is_look_captured")):
		return
	var now := now_msec()
	if _last_shot_msec >= 0 and now - _last_shot_msec < FIRE_INTERVAL_MSEC:
		return
	_last_shot_msec = now
	request_action(ACTION_USE, {
		"tool": selected_tool,
		"prop": selected_prop,
		"hit": _local_raycast(),
	})


## Выбор инструмента и пропа приходит из панели. Смена инструмента на сервере
## снимает старый инструмент и экипирует новый; клиенты синхронизируются через
## `active_tool_id`.
func set_active(tool_id: String, prop_id: String) -> void:
	selected_tool = tool_id
	selected_prop = prop_id
	var next_tool := _find_weapon(tool_id)
	var previous_tool := active_tool
	if previous_tool != null and not is_instance_valid(previous_tool):
		previous_tool = null
	if (
		is_server()
		and previous_tool != null
		and previous_tool != next_tool
		and previous_tool.has_method("wired_unequip")
	):
		previous_tool.call("wired_unequip")
	active_tool = next_tool
	active_tool_id = tool_id if next_tool != null else ""
	if is_server() and next_tool != null and next_tool.has_method("wired_equip"):
		next_tool.call("wired_equip", {
			"player": player,
			"manager": self,
			"prop": prop_id,
		})


## Серверный обработчик `use_tool`. Клиентская позиция попадания игнорируется:
## серверный hit всегда строится из состояния сервера.
func _on_use_tool(sender_peer: int, payload: Dictionary) -> void:
	if not is_server() or player == null:
		return
	if sender_peer != player.peer_id:
		return
	var tool_id := str(payload.get("tool", ""))
	var weapon := _find_weapon(tool_id)
	if weapon == null or weapon != active_tool:
		return
	if not weapon.has_method("wired_primary"):
		return
	var global_node := get_node_or_null("/root/Global")
	if global_node == null:
		return
	var registry := global_node.get("package_registry") as WiredPackageRegistry
	if registry == null:
		return
	if registry.find_entry("cura.tool", tool_id).is_empty():
		return
	var prop_id := str(payload.get("prop", ""))
	if bool(weapon.get("requires_prop")):
		if registry.find_entry("cura.prop", prop_id).is_empty():
			return
		if registry.find_dynamic_entity(prop_id).is_empty():
			return
	var hit := server_raycast()
	# Попадания нет — применения инструмента нет (spec: No hit → no use).
	if hit.is_empty():
		return
	weapon.call("wired_primary", {
		"player": player,
		"manager": self,
		"hit": hit,
		"selected_prop": prop_id,
		"payload": payload,
	})


## Серверный raycast из реплицированных углов персонажа. Маска исключает
## player bodies, поэтому нельзя попасть в самих игроков или в своё тело.
func server_raycast() -> Dictionary:
	if player == null:
		return {}
	var character := _find_character()
	if character == null:
		return {}
	var yaw_value: Variant = character.get("replicated_yaw")
	var pitch_value: Variant = character.get("replicated_pitch")
	if not (yaw_value is float or yaw_value is int):
		return {}
	if not (pitch_value is float or pitch_value is int):
		return {}
	var yaw := float(yaw_value)
	var pitch := float(pitch_value)
	var direction := Vector3(
		-sin(yaw) * cos(pitch),
		sin(pitch),
		-cos(yaw) * cos(pitch)
	)
	if direction.length_squared() < 0.000001:
		return {}
	var origin := player.get_anchor_position_3d() + Vector3(0, EYE_HEIGHT, 0)
	return _raycast(origin, direction.normalized())


## Превью на клиенте: локальный hit нужен только для отклика интерфейса и
## никогда не доверяется серверу.
func _local_raycast() -> Dictionary:
	var character := _find_character()
	if character == null or not character.has_method("get_first_person_camera"):
		return {}
	var camera: Variant = character.call("get_first_person_camera")
	if not (camera is Camera3D):
		return {}
	var view := camera as Camera3D
	return _raycast(
		view.global_position, -view.global_transform.basis.z.normalized()
	)


func _raycast(from: Vector3, direction: Vector3) -> Dictionary:
	var viewport := get_viewport()
	if viewport == null:
		return {}
	var world := viewport.world_3d
	if world == null:
		return {}
	var space := world.direct_space_state
	if space == null:
		return {}
	var query := PhysicsRayQueryParameters3D.create(
		from,
		from + direction * RAY_DISTANCE,
		RAY_COLLISION_MASK,
		_excluded_player_bodies(),
	)
	query.collide_with_areas = false
	query.collide_with_bodies = true
	return space.intersect_ray(query)


func _excluded_player_bodies() -> Array[RID]:
	var excluded: Array[RID] = []
	if player == null:
		return excluded
	for component: WiredPlayerComponent in player.components:
		if not _is_live(component):
			continue
		var node: Node = component
		if node is CollisionObject3D and node.has_meta(PLAYER_BODY_META):
			excluded.append((node as CollisionObject3D).get_rid())
		var body: Variant = component.get("body")
		if body is CollisionObject3D:
			excluded.append((body as CollisionObject3D).get_rid())
	return excluded


## Спавн пропа на сервере через ядро; тип уже квалифицирован реестром.
func spawn_prop(qualified_type: String, position: Vector3) -> Node:
	if player == null:
		return null
	var global_node := get_node_or_null("/root/Global")
	if global_node == null:
		return null
	var world: Node = global_node.get("dynamic_world") as Node
	if world == null or not world.has_method("spawn_entity"):
		return null
	return world.call("spawn_entity", qualified_type, {
		"position": position,
		"owner_player_id": player.peer_id,
	}) as Node


## Единственный источник времени для debounce: подменяется в smoke-тесте.
func now_msec() -> int:
	return Time.get_ticks_msec()


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray(["selected_tool", "selected_prop", "active_tool_id"])


func _wired_save_state() -> Dictionary:
	return {
		"selected_tool": selected_tool,
		"selected_prop": selected_prop,
		"active_tool_id": active_tool_id,
	}


func _wired_load_state(state: Dictionary) -> void:
	selected_tool = str(state.get("selected_tool", ""))
	selected_prop = str(state.get("selected_prop", ""))
	active_tool_id = str(state.get("active_tool_id", ""))


## Инструмент ищется только среди компонентов игрока в группе и по полному id.
func _find_weapon(qualified_id: String) -> WiredPlayerComponent:
	if player == null or qualified_id.is_empty():
		return null
	for component: WiredPlayerComponent in player.components:
		if (
			not _is_live(component)
			or not component.is_in_group(WEAPON_GROUP)
			or component.get("package_id") == null
			or component.get("tool_id") == null
		):
			continue
		if _qualified_id(
			str(component.get("package_id")), str(component.get("tool_id"))
		) == qualified_id:
			return component
	return null


func _find_panel() -> WiredPlayerComponent:
	if (
		_panel != null
		and is_instance_valid(_panel)
		and _panel.is_in_group(PANEL_GROUP)
	):
		return _panel
	if player == null:
		return null
	for component: WiredPlayerComponent in player.components:
		if _is_live(component) and component.is_in_group(PANEL_GROUP):
			_panel = component
			return component
	return null


## Персонаж сначала ищется среди компонентов игрока, затем в дереве: пакет
## `cura_player` может быть смонтирован как компонент, smoke-тест — как узел.
func _find_character() -> Node:
	if player != null:
		for component: WiredPlayerComponent in player.components:
			if _is_live(component) and component.is_in_group(CHARACTER_GROUP):
				return component
	var tree := get_tree()
	if tree == null:
		return null
	return tree.get_first_node_in_group(CHARACTER_GROUP)


func _qualified_id(package_id: String, local_name: String) -> String:
	var global_node := get_node_or_null("/root/Global")
	if global_node != null:
		var registry := global_node.get("package_registry") as WiredPackageRegistry
		if registry != null:
			return registry.resolve_action(package_id, local_name)
	var temporary := WiredPackageRegistry.new()
	var qualified := temporary.resolve_action(package_id, local_name)
	temporary.free()
	return qualified


func _is_live(node: Node) -> bool:
	return node != null and is_instance_valid(node)
