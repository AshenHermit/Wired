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
## A sequence outside this range is treated as malformed, not as a clock:
## clients start at 1 and cannot legitimately jump to absurd values.
const MAX_INPUT_SEQ := 1_000_000_000

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
## Component state of packages that are no longer registered, keyed by
## `<package_id>:<relative_path>`. It is written by the manager before a rebuild
## and merged back into `save_state()`, so disabling a package parks its state
## instead of losing it.
var _parked_component_states: Dictionary = {}
var _action_handlers: Dictionary = {}
var _last_input_seq := 0
var _input_seq := 0
var _last_input_sent_msec := -1
var _action_window_start_msec := 0
var _action_window_count := 0
## Missing input actions are a package configuration error, not a per-frame
## event: warn once per action and then treat the input as zero.
var _warned_missing_actions: Dictionary = {}
## Web input fallback: track pressed keys by keycode for Web export compatibility.
var _pressed_keys: Dictionary = {}


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
	# Defense in depth: the transport already rejects unauthenticated peers and
	# the manager routes by sender, but a client copy must never dispatch.
	if not is_server_authority():
		return
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


## Captures the state of the live components before a rebuild detaches them.
## The manager calls this only when the registry changed, so a component whose
## package was removed keeps its last state until the package returns.
func park_component_states() -> void:
	for component: WiredPlayerComponent in components:
		if not is_instance_valid(component):
			continue
		_parked_component_states[component.state_key()] = component._wired_save_state()


## Drops parked state that belonged to a permanently deleted package.
func purge_package(package_id: String) -> void:
	for key: String in _parked_component_states.keys():
		if key.begins_with(package_id + ":"):
			_parked_component_states.erase(key)


## Drops parked state of every package that is not in the room any more.
func keep_only_packages(package_ids: PackedStringArray) -> void:
	for key: String in _parked_component_states.keys():
		if not package_ids.has(key.get_slice(":", 0)):
			_parked_component_states.erase(key)


func save_state() -> Dictionary:
	var component_states: Dictionary = _parked_component_states.duplicate(true)
	for component: WiredPlayerComponent in components:
		if not is_instance_valid(component):
			continue
		# The key is the package id plus the scene path, never the array index.
		# Inserting or reordering components therefore cannot move state.
		component_states[component.state_key()] = component._wired_save_state()
	return {
		WiredProtocol.KEY_PLAYER_ID: player_id,
		WiredProtocol.KEY_PEER_ID: peer_id,
		WiredProtocol.KEY_DISPLAY_NAME: display_name,
		WiredProtocol.KEY_ANCHOR_POSITION_2D: [_anchor_position_2d.x, _anchor_position_2d.y],
		WiredProtocol.KEY_ANCHOR_POSITION_3D: [
			_anchor_position_3d.x, _anchor_position_3d.y, _anchor_position_3d.z
		],
		"components": component_states,
	}


## Applies only the saved anchors. `PlayersManager` calls this before the
## spawned subtree is ready, so a body component whose saved record has no
## component state still starts at the persisted anchor.
func apply_saved_anchor(state: Dictionary) -> void:
	if state.has(WiredProtocol.KEY_ANCHOR_POSITION_2D):
		_anchor_position_2d = WiredProtocol.as_vector2(
			state[WiredProtocol.KEY_ANCHOR_POSITION_2D]
		)
	if state.has(WiredProtocol.KEY_ANCHOR_POSITION_3D):
		_anchor_position_3d = WiredProtocol.as_vector3(
			state[WiredProtocol.KEY_ANCHOR_POSITION_3D]
		)


## Restores anchors and per-component state. Identity (player id, peer id and
## name) comes from the spawn record, never from the save file. New saves use a
## dictionary keyed by `<package_id>:<relative_path>`; the legacy array form is
## still accepted so old `state.json` files keep loading.
func load_state(state: Dictionary) -> void:
	apply_saved_anchor(state)
	var records: Variant = state.get("components", {})
	if typeof(records) == TYPE_DICTIONARY:
		var keyed: Dictionary = records
		var live_keys: Dictionary = {}
		for component: WiredPlayerComponent in components:
			if not is_instance_valid(component):
				continue
			var state_key := component.state_key()
			live_keys[state_key] = true
			var component_state: Variant = keyed.get(state_key, null)
			if typeof(component_state) == TYPE_DICTIONARY:
				component._wired_load_state(component_state)
		# Keys without a live component belong to a package that is currently
		# not registered; keep them parked so re-enabling restores the state.
		_parked_component_states.clear()
		for key: Variant in keyed.keys():
			var parked_key := str(key)
			if live_keys.has(parked_key):
				continue
			var parked_state: Variant = keyed[key]
			if typeof(parked_state) == TYPE_DICTIONARY:
				_parked_component_states[parked_key] = parked_state
		return
	if not (records is Array):
		return
	# Legacy format: `[{package_id, state}, ...]` applied by index. Accepted for
	# migration only; the keyed format never relies on positions.
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


func _process(_delta: float) -> void:
	# Web export: poll input directly on every frame
	if not _is_local_client():
		return
	_poll_web_input()


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


## Server side: accepts only the owning peer's input, drops stale or malformed
## sequences and clamps finite movement vectors. `limit_length()` turns INF into
## NaN, so finiteness is checked before it, not after.
func _on_player_input_received(from_peer: int, received: Dictionary) -> void:
	if from_peer != peer_id or not is_server_authority():
		return
	var seq := _valid_input_seq(received.get("seq", 0))
	if seq <= 0:
		push_warning(
			"WIRED_PLAYER_INPUT_REJECTED player=%d reason=invalid_seq" % player_id
		)
		return
	if seq <= _last_input_seq:
		return
	_last_input_seq = seq
	var accepted := received.duplicate(true)
	accepted["seq"] = seq
	var move: Variant = accepted.get("move", Vector2.ZERO)
	if move is Vector2:
		var move_2d: Vector2 = move
		accepted["move"] = (
			move_2d.limit_length(MAX_INPUT_MOVE_LENGTH)
			if move_2d.is_finite()
			else Vector2.ZERO
		)
	elif move is Vector3:
		var move_3d: Vector3 = move
		accepted["move"] = (
			move_3d.limit_length(MAX_INPUT_MOVE_LENGTH)
			if move_3d.is_finite()
			else Vector3.ZERO
		)
	else:
		accepted["move"] = Vector2.ZERO
	accepted["jump"] = bool(accepted.get("jump", false))
	input = accepted


## Accepts an integer or an integral finite float in `1..MAX_INPUT_SEQ`.
## Everything else (NaN, INF, negatives, booleans, strings) is rejected with 0.
func _valid_input_seq(value: Variant) -> int:
	var seq := 0
	if typeof(value) == TYPE_INT:
		seq = int(value)
	elif typeof(value) == TYPE_FLOAT:
		var number := float(value)
		if not is_finite(number) or number != floorf(number):
			return 0
		seq = int(number)
	else:
		return 0
	if seq <= 0 or seq > MAX_INPUT_SEQ:
		return 0
	return seq


func _poll_web_input() -> void:
	# Web export: update _pressed_keys by directly querying key state
	# This bypasses the broken _input() callback on 4.8-beta2 Web export
	var keycodes_to_check := [
		65,  # A (wired_move_left)
		68,  # D (wired_move_right)
		87,  # W (wired_move_up)
		83,  # S (wired_move_down)
		32,  # Space (wired_jump)
	]
	for keycode in keycodes_to_check:
		if Input.is_key_pressed(keycode):
			_pressed_keys[keycode] = true
		else:
			_pressed_keys.erase(keycode)


func _collect_input() -> Dictionary:
	_input_seq += 1
	var left := _action_pressed(MOVE_LEFT)
	var right := _action_pressed(MOVE_RIGHT)
	var up := _action_pressed(MOVE_UP)
	var down := _action_pressed(MOVE_DOWN)
	var jump := _action_pressed(JUMP)
	return {
		"move": Vector2(
			(float(right) - float(left)), (float(down) - float(up))
		).limit_length(MAX_INPUT_MOVE_LENGTH),
		"jump": jump,
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
		if not _warned_missing_actions.has(action):
			_warned_missing_actions[action] = true
			push_warning(
				"WIRED_PLAYER_INPUT_ACTION_MISSING action=%s treating_as_zero"
				% action
			)
		return false
	
	# Try InputMap first (works on native)
	if Input.is_action_pressed(action):
		return true
	
	# Web export fallback: check pressed_keys against action events
	if not _is_local_client():
		return false
	
	var events := InputMap.action_get_events(action)
	for event in events:
		if event is InputEventKey:
			var key_event := event as InputEventKey
			var key_code := key_event.physical_keycode if key_event.physical_keycode != 0 else key_event.keycode
			if key_code != 0 and _pressed_keys.has(key_code):
				return true
	return false


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
