extends SceneTree

## Headless smoke test for players and their registered components.
##
## `PlayersManager.build_player` turns one spawn record plus the package
## registry into a `WiredPlayer` root with deterministic components, authority
## and anchors, without touching the scene tree. The suite also covers action
## qualification and routing, input replication on the server, the component
## synchronizer, spawn gating and save/load.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/players_manager_smoke.gd --quit-after 2

const FIXTURE_ROOT := "res://tests/fixtures/player_root"
const COMPONENT_SCENE := "player_component.tscn"
const EXTRA_COMPONENT_SCENE := "player_component_b.tscn"
const PACKAGE_ID := "pkg.test"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _registries: Array[Node] = []


## Records what would go over the wire; `WiredNetwork` itself refuses to send
## outside an authenticated client session.
class RecordingNetwork extends WiredNetwork:

	var actions: Array = []
	var inputs: Array = []

	func send_player_action(action: String, payload: Dictionary) -> void:
		actions.append({"action": action, "payload": payload})

	func send_player_input(input: Dictionary) -> void:
		inputs.append(input)


## Pretends to be a client copy so hook gating can be tested without a socket.
class ClientPlayer extends WiredPlayer:

	func is_server_authority() -> bool:
		return false

	func is_local_player() -> bool:
		return false


func _initialize() -> void:
	# Deferred so the tree (and its MultiplayerAPI) exists before players are built.
	_run.call_deferred()


func _run() -> void:
	_test_build_player_adds_components_in_order_and_sets_anchor()
	_test_component_authority_and_local_only()
	_test_component_synchronizer_and_hooks()
	_test_server_components_do_not_simulate_on_clients()
	_test_request_action_only_from_local_player()
	_test_local_client_sends_throttled_input()
	_test_component_qualifies_action_names()
	_test_handle_action_calls_registered_handler()
	_test_save_and_load_state()
	_test_component_state_key_survives_reorder()
	_test_non_finite_input_is_rejected()
	_test_build_player_tags_components_as_registered()
	_test_hot_reload_rebuilds_live_components()
	_test_spawn_waits_for_both_gates_and_routes_actions()
	_test_disconnect_despawns_the_player()
	_test_spawner_parents_the_spawned_player()
	_free_owned()
	_finish()


func _test_build_player_adds_components_in_order_and_sets_anchor() -> void:
	var registry := _make_registry()
	var player := _build_player(registry, 7, 1, Vector2(48, 96))
	_check(player.player_id == 7, "build_player must keep the player id")
	_check(player.peer_id == 1, "build_player must keep the peer id")
	_check(player.display_name == "bob", "build_player must keep the name")
	_check(
		player.spawn_position_2d == Vector2(48, 96),
		"the spawn position must be stored on the player",
	)
	_check(
		player.get_anchor_position_2d() == Vector2(48, 96),
		"the spawn position must become the initial 2D anchor, got %s"
		% player.get_anchor_position_2d(),
	)
	_check(
		player.get_anchor_position_3d() == Vector3.ZERO,
		"the 3D anchor must come from the spawn record",
	)
	_check(
		player.components.size() == 1,
		"build_player must add the registered component, got %d"
		% player.components.size(),
	)
	if player.components.size() == 1:
		_check(
			player.components[0].authority_mode == "server",
			"the component must keep its registered authority mode",
		)
		_check(
			player.components[0].package_id == PACKAGE_ID,
			"the component must know its owning package",
		)


func _test_component_authority_and_local_only() -> void:
	var registry := _make_registry(true)
	var remote := _build_player(registry, 8, 99, Vector2.ZERO)
	_check(
		remote.components.size() == 2,
		"a remote player must get server + non-local-only components, got %d"
		% remote.components.size(),
	)
	var remote_local := _find_local_authority_component(remote)
	_check(
		remote_local != null,
		"a local (non-local-only) component must exist for a remote player",
	)
	if remote_local != null:
		_check(
			remote_local.get_multiplayer_authority() == 99,
			"a local component must use the owning peer as authority, got %d"
			% remote_local.get_multiplayer_authority(),
		)
	var local := _build_player(registry, 9, 1, Vector2.ZERO)
	_check(
		local.components.size() == 3,
		"the owning peer must receive server, local-only and local components, got %d"
		% local.components.size(),
	)
	if local.components.size() == 3:
		_check(
			local.components[0].authority_mode == "server",
			"the lower order component must come first",
		)
		_check(
			local.components[1].authority_mode == "local"
			and local.components[1].local_only,
			"the second component must keep its local authority and local-only flag",
		)
		_check(
			local.components[2].authority_mode == "local"
			and not local.components[2].local_only,
			"the third component must be local authority without local_only",
		)
		_check(
			local.components[1].get_multiplayer_authority() == 1,
			"a local-only component must use the owning peer as authority",
		)
		_check(
			local.components[2].get_multiplayer_authority() == 1,
			"a local component must use the owning peer as authority",
		)
	# The server builds a client's player too; that copy has the same local
	# authority as the owner, not the server peer id.
	var client_owned := _build_player(registry, 10, 5, Vector2.ZERO)
	var client_local := _find_local_authority_component(client_owned)
	_check(
		client_local != null,
		"the server-side copy must keep local (non-local-only) components",
	)
	if client_local != null:
		_check(
			client_local.get_multiplayer_authority() == 5,
			"a local component built for peer 5 must use authority 5, got %d"
			% client_local.get_multiplayer_authority(),
		)
		_check(
			not client_local.local_only,
			"the third descriptor must not be local_only",
		)


func _test_component_synchronizer_and_hooks() -> void:
	var registry := _make_registry()
	var player := _build_player(registry, 7, 1, Vector2.ZERO)
	root.add_child(player)
	_check(player.is_node_ready(), "the player must be ready as soon as it is parented")
	if player.components.is_empty():
		_check(false, "the player must have a component to test")
		return
	var component: Variant = player.components[0]
	_check(component.ready_count == 1, "`_wired_ready` must run exactly once")
	var sync := component.get_node_or_null("Sync") as MultiplayerSynchronizer
	_check(sync != null, "the component must create a MultiplayerSynchronizer")
	if sync != null:
		_check(
			sync.root_path == NodePath(".."),
			"the synchronizer root must be its component, got %s" % sync.root_path,
		)
		_check(
			sync.get_multiplayer_authority() == 1,
			"the synchronizer must share the component authority",
		)
		var properties := sync.replication_config.get_properties()
		_check(
			properties.has(NodePath("Body:position")),
			"declared properties must reach the replication config, got %s"
			% [properties],
		)
	# The suite must finish inside the brief's two frames, so the hooks are
	# driven directly instead of waiting for the main loop.
	component._process(0.016)
	component._physics_process(0.016)
	_check(
		component.process_count > 0,
		"`_wired_process` must run on the server for a server component",
	)
	_check(
		component.physics_count > 0,
		"`_wired_physics_process` must run on the server for a server component",
	)
	_check(
		component.visual_count > 0,
		"`_wired_visual_process` must run on every peer",
	)
	# Input runs only for the local owner, independently of component authority.
	var event := InputEventKey.new()
	component._unhandled_input(event)
	_check(
		component.last_input_event == event,
		"`_wired_unhandled_input` must run for the local owner",
	)
	player.peer_id = 99
	component.last_input_event = null
	component._unhandled_input(event)
	_check(
		component.last_input_event == null,
		"`_wired_unhandled_input` must not run for a remote player",
	)


## A server-authority component exists on clients for visuals only. If the
## simulation guard disappeared, `process_count`/`physics_count` would be 1.
func _test_server_components_do_not_simulate_on_clients() -> void:
	var player := ClientPlayer.new()
	_owned.append(player)
	player.setup(11, 5, "remote", null)
	var component := _instantiate_component()
	component.package_id = PACKAGE_ID
	player.add_component(component, "server", false)
	var hooks: Variant = component
	hooks._process(0.016)
	hooks._physics_process(0.016)
	_check(
		hooks.process_count == 0,
		"a server component must not run `_wired_process` on a client copy",
	)
	_check(
		hooks.physics_count == 0,
		"a server component must not run `_wired_physics_process` on a client copy",
	)
	_check(
		hooks.visual_count == 1,
		"`_wired_visual_process` must still run on a client copy",
	)


func _test_request_action_only_from_local_player() -> void:
	var net := RecordingNetwork.new()
	_owned.append(net)
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(7, 99, "bob", net)
	player.request_action("pkg.test/ping", {"n": 1})
	_check(
		net.actions.is_empty(),
		"a non-local player must not send an action",
	)
	player.peer_id = 1
	player.request_action("pkg.test/ping", {"n": 1})
	_check(
		net.actions.size() == 1,
		"the local player must send the qualified action, got %s" % [net.actions],
	)
	if net.actions.size() == 1:
		_check(
			net.actions[0]["action"] == "pkg.test/ping",
			"`WiredPlayer` must not qualify an already-qualified action",
		)
		_check(
			net.actions[0]["payload"] == {"n": 1},
			"the action payload must be forwarded unchanged",
		)


func _test_local_client_sends_throttled_input() -> void:
	var net := RecordingNetwork.new()
	net.mode = "client"
	_owned.append(net)
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(7, 1, "bob", net)
	root.add_child(player)
	player._physics_process(0.016)
	_check(
		net.inputs.size() == 1,
		"the local client must send one input snapshot, got %d"
		% net.inputs.size(),
	)
	if net.inputs.size() == 1:
		var snapshot: Dictionary = net.inputs[0]
		_check(snapshot.has("move"), "the input snapshot must carry a move vector")
		_check(snapshot.has("jump"), "the input snapshot must carry the jump flag")
		_check(snapshot.get("seq") == 1, "the input snapshot must be sequenced")
	player._physics_process(0.016)
	_check(
		net.inputs.size() == 1,
		"input must not be sent more often than 30 Hz, got %d"
		% net.inputs.size(),
	)


func _test_component_qualifies_action_names() -> void:
	var net := RecordingNetwork.new()
	_owned.append(net)
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(7, 1, "bob", net)
	var component := _instantiate_component()
	component.player = player
	component.package_id = PACKAGE_ID
	component.request_action("ping", {"n": 2})
	_check(
		net.actions.size() == 1,
		"the component must forward the action to its player",
	)
	if net.actions.size() == 1:
		_check(
			net.actions[0]["action"] == "pkg.test/ping",
			"the component must qualify with its package id, got %s"
			% net.actions[0]["action"],
		)


func _test_handle_action_calls_registered_handler() -> void:
	var player := WiredPlayer.new()
	_owned.append(player)
	var calls: Array = []
	player.register_action(
		"pkg.test/ping",
		func(sender_peer: int, payload: Dictionary) -> void:
			calls.append({"sender": sender_peer, "payload": payload}),
	)
	player.handle_action("pkg.test/ping", {"n": 3}, 5)
	_check(
		calls.size() == 1,
		"handle_action must call the registered handler, got %s" % [calls],
	)
	if calls.size() == 1:
		_check(calls[0]["sender"] == 5, "the handler must receive the sender peer")
		_check(calls[0]["payload"] == {"n": 3}, "the handler must receive the payload")
	player.handle_action("pkg.test/missing", {}, 5)
	_check(
		calls.size() == 1,
		"an unknown action must not call any handler",
	)


func _test_save_and_load_state() -> void:
	var registry := _make_registry()
	var player := _build_player(registry, 7, 1, Vector2(10, 20))
	root.add_child(player)
	if player.components.is_empty():
		_check(false, "the player must have a component to save")
		return
	var component: Variant = player.components[0]
	component.body.position = Vector2(3, 4)
	player.set_anchor_position_3d(Vector3(1, 2, 3))
	var saved := player.save_state()
	_check(saved["player_id"] == 7, "save_state must keep the player id")
	_check(
		saved["anchor_position_2d"] == [10.0, 20.0],
		"save_state must serialize the 2D anchor, got %s"
		% [saved["anchor_position_2d"]],
	)
	var records: Dictionary = saved["components"]
	_check(records.size() == 1, "save_state must save every component")
	_check(
		records.has("pkg.test:player_component.tscn"),
		"component state must be keyed by package id and relative scene path, got %s"
		% [records.keys()],
	)
	_check(
		saved.get("display_name", "") == "bob",
		"save_state must use the spec's display_name key",
	)
	player.set_anchor_position_2d(Vector2.ZERO)
	player.set_anchor_position_3d(Vector3.ZERO)
	component.body.position = Vector2.ZERO
	player.load_state(saved)
	_check(
		player.get_anchor_position_2d() == Vector2(10, 20),
		"load_state must restore the 2D anchor",
	)
	_check(
		player.get_anchor_position_3d() == Vector3(1, 2, 3),
		"load_state must restore the 3D anchor",
	)
	_check(
		component.body.position == Vector2(3, 4),
		"load_state must restore component state, got %s" % component.body.position,
	)


## Inserting or reordering two components must not move saved state between
## them: the key is `<package_id>:<relative_path>`, not the array index.
func _test_component_state_key_survives_reorder() -> void:
	# Same package, two different scene paths: an insert at the front changes
	# the array index of the old component without changing its package id.
	var original := _make_component_registry(
		[
			{"path": COMPONENT_SCENE, "order": 10},
			{"path": EXTRA_COMPONENT_SCENE, "order": 20},
		]
	)
	var player := _build_player(original, 7, 1, Vector2.ZERO)
	root.add_child(player)
	if player.components.size() != 2:
		_check(false, "the reorder test needs two components")
		return
	var first: Variant = player.components[0]
	var second: Variant = player.components[1]
	first.body.position = Vector2(1, 1)
	second.body.position = Vector2(2, 2)
	var saved := player.save_state()

	# The extra component is inserted before the original one. The old
	# index-based loader would give the first saved record to the extra
	# component because both belong to the same package.
	var reordered := _make_component_registry(
		[
			{"path": EXTRA_COMPONENT_SCENE, "order": 5},
			{"path": COMPONENT_SCENE, "order": 10},
		]
	)
	var restored := _build_player(reordered, 7, 1, Vector2.ZERO)
	root.add_child(restored)
	if restored.components.size() != 2:
		_check(false, "the reordered player must keep two components")
		return
	restored.load_state(saved)
	var positions := {}
	for component: WiredPlayerComponent in restored.components:
		var instance: Variant = component
		positions[component.relative_path] = instance.body.position
	_check(
		positions.get(COMPONENT_SCENE, Vector2.ZERO) == Vector2(1, 1),
		"the original component state must follow its scene path, got %s"
		% positions.get(COMPONENT_SCENE, Vector2.ZERO),
	)
	_check(
		positions.get(EXTRA_COMPONENT_SCENE, Vector2.ZERO) == Vector2(2, 2),
		"the inserted component state must follow its scene path, got %s"
		% positions.get(EXTRA_COMPONENT_SCENE, Vector2.ZERO),
	)


## INF/NaN movement and absurd sequences are malformed, not values to clamp:
## `limit_length()` would turn INF into NaN and poison the body velocity.
func _test_non_finite_input_is_rejected() -> void:
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(7, 5, "bob", null)
	player._on_player_input_received(
		5, {"move": Vector2(INF, 0), "jump": true, "seq": 1}
	)
	_check(
		player.input.get("move") == Vector2.ZERO,
		"an INF 2D move must become zero, got %s" % player.input.get("move"),
	)
	_check(player.input.get("seq") == 1, "the finite sequence must be stored")
	player._on_player_input_received(
		5, {"move": Vector3(NAN, 1, 0), "jump": false, "seq": 2}
	)
	_check(
		player.input.get("move") == Vector3.ZERO,
		"a NaN 3D move must become zero, got %s" % player.input.get("move"),
	)
	player._on_player_input_received(
		5, {"move": Vector2.UP, "jump": false, "seq": WiredPlayer.MAX_INPUT_SEQ + 1}
	)
	_check(
		player.input.get("move") == Vector3.ZERO,
		"an absurd sequence must be dropped without changing input",
	)
	player._on_player_input_received(
		5, {"move": Vector2.UP, "jump": false, "seq": NAN}
	)
	_check(
		player.input.get("move") == Vector3.ZERO,
		"a NaN sequence must be dropped without changing input",
	)
	player._on_player_input_received(
		5, {"move": Vector2(3, 0), "jump": true, "seq": 4.0}
	)
	_check(
		player.input.get("move") == Vector2.RIGHT,
		"a finite integral float sequence must still be accepted, got %s"
		% player.input.get("move"),
	)


## Registry-created player components are owned by PlayersManager. Tagging them
## `_wired_registered` keeps a live component out of generic root replacement:
## only `rebuild_live_components` may replace it, after a package revision.
func _test_build_player_tags_components_as_registered() -> void:
	var player := _build_player(_make_registry(), 7, 1, Vector2.ZERO)
	root.add_child(player)
	_check(
		not player.components.is_empty(),
		"the metadata test needs a component",
	)
	for component: WiredPlayerComponent in player.components:
		_check(
			bool(component.get_meta("_wired_registered", false)),
			"every registry-created component must carry _wired_registered",
		)


## Hot reload: an applied package revision rebuilds the components of players
## that are already in the world. The root (and therefore the spawner's tracking)
## stays, the new components come from the current registry and the component
## state is carried over instead of snapping bodies back to their anchor.
func _test_hot_reload_rebuilds_live_components() -> void:
	var registry := _make_registry()
	var manager := PlayersManager.new()
	root.add_child(manager)
	_owned.append(manager)
	manager.setup(registry, null, null)
	manager._authenticated[1] = {
		WiredProtocol.KEY_PLAYER_ID: 7,
		WiredProtocol.KEY_NAME: "bob",
	}
	manager.spawn_player(1)
	var player := manager.get_player_by_peer(1)
	_check(player != null, "the hot-reload test needs a live player")
	if player == null or player.components.is_empty():
		_check(false, "the hot-reload test needs a live component")
		return
	var previous: Variant = player.components[0]
	previous.body.position = Vector2(11, 12)
	var player_id := player.get_instance_id()

	# A new revision adds a component. The registry instance is the same object
	# the player was built from, exactly like `PackageEntryLoader` applying an
	# entry into a live registry.
	var revision := WiredPackageRegistration.new()
	revision.package_id = PACKAGE_ID
	revision.add_player_component(EXTRA_COMPONENT_SCENE, {"order": 20})
	registry.add_registration(revision)

	var rebuilt := manager.rebuild_live_components()
	_check(rebuilt == 1, "one live player must be rebuilt, got %d" % rebuilt)
	_check(
		manager.get_player_by_peer(1) != null
		and manager.get_player_by_peer(1).get_instance_id() == player_id,
		"a rebuild must keep the player root (and its spawner tracking)",
	)
	_check(
		player.components.size() == 2,
		"the rebuilt player must follow the new registry, got %d components"
		% player.components.size(),
	)
	_check(
		previous.is_queued_for_deletion(),
		"the previous component must be released, not left running",
	)
	var positions := {}
	for component: WiredPlayerComponent in player.components:
		var instance: Variant = component
		_check(
			bool(component.get_meta("_wired_registered", false)),
			"a rebuilt component must carry _wired_registered",
		)
		positions[component.relative_path] = instance.body.position
	_check(
		positions.get(COMPONENT_SCENE, Vector2.ZERO) == Vector2(11, 12),
		"a rebuild must carry the component state over, got %s"
		% positions.get(COMPONENT_SCENE, Vector2.ZERO),
	)


func _test_spawn_waits_for_both_gates_and_routes_actions() -> void:
	var registry := _make_registry()
	var net := WiredNetwork.new()
	net._players[5] = {
		"player_id": 9,
		"ready": true,
		"packages_ready": false,
		"name": "eve",
	}
	var manager := PlayersManager.new()
	manager.name = "PlayersManagerSmoke"
	root.add_child(manager)
	_owned.append(manager)
	manager.setup(registry, net, null)
	net.peer_authenticated.emit(5, 9, "eve")
	_check(
		manager.get_player_by_peer(5) == null,
		"authentication alone must not spawn a player",
	)
	net.peer_packages_ready.emit(5)
	_check(
		manager.get_player_by_peer(5) == null,
		"a readiness signal while the gate is closed must not spawn a player",
	)
	net._mark_packages_ready(5)
	var player := manager.get_player_by_peer(5)
	_check(player != null, "both gates must spawn the player")
	if player == null:
		net.free()
		return
	_check(
		player.is_node_ready(),
		"the spawned player must be parented in Players and ready",
	)
	_check(player.display_name == "eve", "the spawn record must carry the name")
	net.peer_packages_ready.emit(5)
	_check(
		manager.get_player_by_peer(5) == player,
		"a repeated readiness signal must not spawn a second player",
	)
	net.player_action_received.emit(5, "pkg.test/ping", {"n": 4})
	if not player.components.is_empty():
		var component: Variant = player.components[0]
		_check(
			component.last_ping.get("sender", -1) == 5,
			"the manager must route actions to the peer's player",
		)
	net.player_input_received.emit(
		5, {"move": Vector2(3, 0), "jump": true, "seq": 1}
	)
	_check(
		player.input.get("move") == Vector2.RIGHT,
		"the server must clamp movement input to length 1, got %s"
		% player.input.get("move"),
	)
	_check(player.input.get("jump") == true, "jump input must be stored")
	net.player_input_received.emit(
		5, {"move": Vector2(0, 1), "jump": false, "seq": 1}
	)
	_check(
		player.input.get("move") == Vector2.RIGHT,
		"stale input sequences must be dropped",
	)
	player.set_anchor_position_2d(Vector2.RIGHT)
	player.set_anchor_position_3d(Vector3(0, 0, 1))
	var saved := manager.save_state()
	_check(
		saved.get("players", []).size() == 1,
		"the manager must save its players",
	)
	manager.despawn_player(5)
	_check(
		manager.get_player_by_peer(5) == null,
		"despawn_player must forget the player",
	)
	manager.load_state(saved)
	manager.spawn_player(5)
	var restored := manager.get_player_by_peer(5)
	_check(restored != null, "load_state must restore the saved player on respawn")
	if restored != null:
		_check(
			restored.get_anchor_position_2d() == Vector2.RIGHT,
			"the restored player must receive its saved anchor, got %s"
			% restored.get_anchor_position_2d(),
		)
	net.free()


## Disconnect path: `WiredNetwork` emits `peer_left` only for an authenticated
## server peer, and `PlayersManager` drops both the auth record and the node.
func _test_disconnect_despawns_the_player() -> void:
	var registry := _make_registry()
	var net := WiredNetwork.new()
	net.mode = "server"
	net._players[5] = {
		"player_id": 9,
		"ready": true,
		"packages_ready": false,
		"name": "eve",
	}
	var left_events: Array = []
	net.peer_left.connect(func(peer_id: int) -> void: left_events.append(peer_id))
	var manager := PlayersManager.new()
	root.add_child(manager)
	_owned.append(manager)
	manager.setup(registry, net, null)
	net.peer_authenticated.emit(5, 9, "eve")
	net._mark_packages_ready(5)
	var player := manager.get_player_by_peer(5)
	_check(player != null, "the disconnect test needs a spawned player")
	if player == null:
		net.free()
		return
	net._on_peer_disconnected(5)
	_check(
		manager.get_player_by_peer(5) == null,
		"a disconnect must remove the player from the manager",
	)
	_check(
		player.is_queued_for_deletion(),
		"a disconnected player node must be queued for removal",
	)
	_check(
		not manager._authenticated.has(5),
		"a disconnect must drop the peer's auth record",
	)
	_check(
		left_events == [5],
		"an authenticated disconnect must emit peer_left, got %s" % [left_events],
	)
	net._on_peer_disconnected(99)
	_check(
		left_events == [5],
		"an unauthenticated disconnect must not emit peer_left",
	)
	net._players[6] = {
		"player_id": 11,
		"ready": true,
		"packages_ready": true,
		"name": "gina",
	}
	net.mode = "client"
	net._on_peer_disconnected(6)
	_check(
		left_events == [5],
		"a client copy must never emit peer_left",
	)
	net.free()


## The real runtime path goes through `MultiplayerSpawner.spawn`: the spawner
## parents the returned node, so `_spawn_player` must not add it twice.
func _test_spawner_parents_the_spawned_player() -> void:
	var registry := _make_registry()
	var net := WiredNetwork.new()
	net._players[6] = {
		"player_id": 10,
		"ready": true,
		"packages_ready": false,
		"name": "frank",
	}
	var manager := PlayersManager.new()
	var spawner := MultiplayerSpawner.new()
	spawner.name = "Spawner"
	manager.add_child(spawner)
	root.add_child(manager)
	_owned.append(manager)
	manager.setup(registry, net, spawner)
	net.peer_authenticated.emit(6, 10, "frank")
	net._mark_packages_ready(6)
	var player := manager.get_player_by_peer(6)
	_check(player != null, "a configured spawner must spawn the player")
	if player != null:
		_check(
			player.get_parent() == manager,
			"MultiplayerSpawner must parent the player under Players",
		)
	_check(
		manager.get_child_count() == 2,
		"Players must contain exactly the spawner and the player, got %d"
		% manager.get_child_count(),
	)
	net.free()


# --- helpers --------------------------------------------------------------


func _make_registry(include_local := false) -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ROOT
	registry.register_context(PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	registration.add_player_component(
		COMPONENT_SCENE, {"order": 10, "authority": "server"}
	)
	if include_local:
		registration.add_player_component(
			COMPONENT_SCENE,
			{"order": 20, "authority": "local", "local_only": true},
		)
		# Local authority without local_only: the server builds this copy too,
		# owned by the peer it belongs to rather than by the server.
		registration.add_player_component(
			COMPONENT_SCENE, {"order": 30, "authority": "local"}
		)
	registry.add_registration(registration)
	return registry


func _make_component_registry(components: Array) -> WiredPackageRegistry:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ROOT
	registry.register_context(PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	for descriptor: Dictionary in components:
		registration.add_player_component(
			str(descriptor["path"]), {"order": int(descriptor["order"])}
		)
	registry.add_registration(registration)
	return registry


func _find_local_authority_component(player: WiredPlayer) -> WiredPlayerComponent:
	for component: WiredPlayerComponent in player.components:
		if component.authority_mode == "local" and not component.local_only:
			return component
	return null


func _build_player(
	registry: WiredPackageRegistry, player_id: int, peer_id: int, position: Vector2
) -> WiredPlayer:
	var manager := PlayersManager.new()
	_owned.append(manager)
	var data := {
		"player_id": player_id,
		"peer_id": peer_id,
		"name": "bob",
		"spawn_position_2d": position,
		"spawn_position_3d": Vector3.ZERO,
	}
	var player := manager.build_player(data, registry)
	_owned.append(player)
	return player


func _instantiate_component() -> WiredPlayerComponent:
	var packed := load(
		"res://tests/fixtures/player_root/player_component.tscn"
	) as PackedScene
	var component := packed.instantiate() as WiredPlayerComponent
	_owned.append(component)
	return component


func _free_owned() -> void:
	for node: Node in _owned:
		if is_instance_valid(node):
			node.free()
	_owned.clear()
	for registry: Node in _registries:
		if is_instance_valid(registry):
			registry.free()
	_registries.clear()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("PLAYERS_MANAGER_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("PLAYERS_MANAGER_SMOKE_FAILED %s" % message)
	quit(1)
