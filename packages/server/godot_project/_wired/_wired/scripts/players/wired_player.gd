extends Node
class_name WiredPlayer

## Server-owned player root.
##
## The root never stores a transform: the package body component drives the
## replicated anchor through `set_anchor_position_2d/3d`, so the same contract
## works for 2D and 3D packages. Components are added in registry order and
## receive their authority from the registry descriptor.
##
## Input:
## - the local client samples `wired_move_*`/`wired_jump` at most 30 Hz and
##   sends `{move, jump, seq}` over the unreliable player-input channel;
## - the server accepts it only from the owning peer, clamps `move` to length 1
##   and stores it in `input` for the component that simulates the body.
##
## Actions:
## components register package-qualified handlers on the server; clients send
## intents with already-qualified names. Qualification happens only in
## `WiredPlayerComponent`, never here.

const INPUT_SEND_INTERVAL_MSEC := 33
const MAX_INPUT_MOVE_LENGTH := 1.0
const MAX_ACTIONS_PER_SECOND := 20
const DEFAULT_PEER_ID := 1

const MOVE_LEFT := "wired_move_left"
const MOVE_RIGHT := "wired_move_right"
const MOVE_UP := "wired_move_up"
const MOVE_DOWN := "wired_move_down"
const JUMP := "wired_jump"

var player_id: int = 0
var peer_id: int = 0
var display_name: String = ""
## Last accepted input snapshot: `{move: Vector2, jump: bool, seq: int}`.
var input: Dictionary = {}
var spawn_position_2d := Vector2.ZERO
var spawn_position_3d := Vector3.ZERO
var network: WiredNetwork = null
var components: Array[WiredPlayerComponent] = []

var _anchor_position_2d := Vector2.ZERO
var _anchor_position_3d := Vector3.ZERO
var _action_handlers: Dictionary = {}
var _last_input_seq := 0
var _input_seq := 0
var _last_input_sent_msec := -1
var _action_window_start_msec := 0
var _action_window_count := 0


## Wires identity and transport. Called before the player enters the tree, so
## the input signal is connected for every peer and filtered by `peer_id`;
## only the server ever emits it.
func setup(
	new_player_id: int,
	new_peer_id: int,
	new_display_name: String,
	new_network: WiredNetwork
) -> void:
	player_id = new_player_id
	peer_id = new_peer_id
	display_name = new_display_name
	network = new_network
	if network != null:
		if not network.player_input_received.is_connected(_on_player_input_received):
			network.player_input_received.connect(_on_player_input_received)


func is_local_player() -> bool:
	var api := multiplayer
	if api == null:
		# Outside the tree (tests, construction) the offline peer is 1.
		return peer_id == DEFAULT_PEER_ID
	return peer_id == api.get_unique_id()


func is_server_authority() -> bool:
	var api := multiplayer
	if api == null:
		return true
	return api.is_server()


func get_anchor_position_2d() -> Vector2:
	return _anchor_position_2d


func set_anchor_position_2d(value: Vector2) -> void:
	_anchor_position_2d = value


func get_anchor_position_3d() -> Vector3:
	return _anchor_position_3d


func set_anchor_position_3d(value: Vector3) -> void:
	_anchor_position_3d = value


## Attaches one package component. `authority` is the registry string:
## `"server"` maps to peer 1, anything else to the owning peer.
func add_component(
	component: WiredPlayerComponent, authority: String, local_only: bool
) -> void:
	if component == null:
		push_warning("WIRED_PLAYER_INVALID_COMPONENT player=%d" % player_id)
		return
	component.player = self
	component.authority_mode = (
		authority if not authority.is_empty() else WiredPlayerComponent.AUTHORITY_SERVER
	)
	component.local_only = local_only
	component.set_multiplayer_authority(_authority_peer(component.authority_mode))
	# Append before entering the tree: `_wired_ready` may already inspect the
	# player's component list.
	components.append(component)
	add_child(component)


## Server only. The action name is already qualified by the component.
func register_action(qualified_action: String, handler: Callable) -> void:
	if not is_server_authority():
		return
	if qualified_action.is_empty():
		push_warning("WIRED_PLAYER_EMPTY_ACTION player=%d" % player_id)
		return
	_action_handlers[qualified_action] = handler


## Server only. Dispatches a qualified action to its component handler, with a
## small per-player rate limit so a broken client cannot flood the server.
func handle_action(
	qualified_action: String, payload: Dictionary, sender_peer: int
) -> void:
	if not _consume_action_budget():
		push_warning(
			"WIRED_PLAYER_ACTION_RATE_LIMITED player=%d action=%s"
			% [player_id, qualified_action]
		)
		return
	if not _action_handlers.has(qualified_action):
		push_warning(
			"WIRED_PLAYER_ACTION_UNHANDLED player=%d action=%s sender=%d"
			% [player_id, qualified_action, sender_peer]
		)
		return
	var handler: Callable = _action_handlers[qualified_action]
	if not handler.is_valid():
		push_warning(
			"WIRED_PLAYER_ACTION_INVALID_HANDLER player=%d action=%s"
			% [player_id, qualified_action]
		)
		return
	handler.call(sender_peer, payload)


## Local player only. The action name is already qualified by the component;
## it is never qualified a second time here.
func request_action(qualified_action: String, payload: Dictionary = {}) -> void:
	if not is_local_player():
		return
	if qualified_action.is_empty():
		push_warning("WIRED_PLAYER_EMPTY_ACTION player=%d" % player_id)
		return
	if network == null:
		push_warning(
			"WIRED_PLAYER_NO_NETWORK player=%d action=%s"
			% [player_id, qualified_action]
		)
		return
	network.send_player_action(qualified_action, payload)


func save_state() -> Dictionary:
	var component_states: Array = []
	for component: WiredPlayerComponent in components:
		if not is_instance_valid(component):
			continue
		component_states.append(
			{
				"package_id": component.package_id,
				"state": component._wired_save_state(),
			}
		)
	return {
		"player_id": player_id,
		"peer_id": peer_id,
		"name": display_name,
		"anchor_position_2d": [_anchor_position_2d.x, _anchor_position_2d.y],
		"anchor_position_3d": [
			_anchor_position_3d.x, _anchor_position_3d.y, _anchor_position_3d.z
		],
		"components": component_states,
	}


## Restores anchors and per-component state. Identity (player id, peer id and
## name) comes from the spawn record, never from the save file.
func load_state(state: Dictionary) -> void:
	if state.has("anchor_position_2d"):
		_anchor_position_2d = _as_vector2(state["anchor_position_2d"])
	if state.has("anchor_position_3d"):
		_anchor_position_3d = _as_vector3(state["anchor_position_3d"])
	var records: Variant = state.get("components", [])
	if not (records is Array):
		return
	var record_list: Array = records
	var count := mini(record_list.size(), components.size())
	for index in count:
		var record: Variant = record_list[index]
		if typeof(record) != TYPE_DICTIONARY:
			continue
		var component := components[index]
		if not is_instance_valid(component):
			continue
		if str(record.get("package_id", "")) != component.package_id:
			continue
		var component_state: Variant = record.get("state", {})
		if typeof(component_state) == TYPE_DICTIONARY:
			component._wired_load_state(component_state)


func _physics_process(_delta: float) -> void:
	if not _is_local_client():
		return
	input = _collect_input()
	var now := Time.get_ticks_msec()
	if (
		_last_input_sent_msec >= 0
		and now - _last_input_sent_msec < INPUT_SEND_INTERVAL_MSEC
	):
		return
	_last_input_sent_msec = now
	network.send_player_input(input)


## Server side: accepts only the owning peer's input, drops stale sequences and
## clamps the movement vector.
func _on_player_input_received(from_peer: int, received: Dictionary) -> void:
	if from_peer != peer_id or not is_server_authority():
		return
	var seq := int(received.get("seq", 0))
	if seq > 0 and seq <= _last_input_seq:
		return
	if seq > _last_input_seq:
		_last_input_seq = seq
	var accepted := received.duplicate(true)
	var move: Variant = accepted.get("move", Vector2.ZERO)
	if move is Vector2:
		var move_2d: Vector2 = move
		accepted["move"] = move_2d.limit_length(MAX_INPUT_MOVE_LENGTH)
	elif move is Vector3:
		var move_3d: Vector3 = move
		accepted["move"] = move_3d.limit_length(MAX_INPUT_MOVE_LENGTH)
	else:
		accepted["move"] = Vector2.ZERO
	input = accepted


func _collect_input() -> Dictionary:
	_input_seq += 1
	return {
		"move": Vector2(
			_action_axis(MOVE_LEFT, MOVE_RIGHT), _action_axis(MOVE_UP, MOVE_DOWN)
		).limit_length(MAX_INPUT_MOVE_LENGTH),
		"jump": _action_pressed(JUMP),
		"seq": _input_seq,
	}


## The input map itself arrives with the example package (Task 7); guard the
## lookups so a room without those actions does not spam engine errors.
func _action_axis(negative: String, positive: String) -> float:
	var value := 0.0
	if _action_pressed(negative):
		value -= 1.0
	if _action_pressed(positive):
		value += 1.0
	return value


func _action_pressed(action: String) -> bool:
	if not InputMap.has_action(action):
		return false
	return Input.is_action_pressed(action)


func _is_local_client() -> bool:
	return network != null and network.mode == "client" and is_local_player()


func _authority_peer(authority: String) -> int:
	if authority == WiredPlayerComponent.AUTHORITY_SERVER:
		return 1
	return peer_id


func _consume_action_budget() -> bool:
	var now := Time.get_ticks_msec()
	if now - _action_window_start_msec >= 1000:
		_action_window_start_msec = now
		_action_window_count = 0
	if _action_window_count >= MAX_ACTIONS_PER_SECOND:
		return false
	_action_window_count += 1
	return true


func _as_vector2(value: Variant) -> Vector2:
	if value is Vector2:
		var vector: Vector2 = value
		return vector
	if value is Array and value.size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	return Vector2.ZERO


func _as_vector3(value: Variant) -> Vector3:
	if value is Vector3:
		var vector: Vector3 = value
		return vector
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO
