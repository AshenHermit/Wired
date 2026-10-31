extends SceneTree

## Headless smoke test for the example crate spawner.
##
## The spawner is an example package script, so it lives outside `res://` and is
## loaded by absolute path. The suite drives the server handler directly and
## checks the authoritative rules: spawn point from the player anchor, sender,
## cooldown, live limit and direction validation. The client path is covered by
## driving `_wired_unhandled_input`, including the SubViewport mouse conversion
## and the local-player gate.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/spawner_smoke.gd --quit-after 2

const FIXTURE_ROOT := "res://tests/fixtures/dynamic_root"
const FIXTURE_SCENE := "crate.tscn"
const PACKAGE_ID := "pkg.example"
const CRATE_TYPE := "pkg.example/crate"
const ACTION := "pkg.example/spawn_crate"
const EXAMPLE_ROOT := "../examples/wired-platformer"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []
var _registries: Array[Node] = []


## Records action intents instead of touching a socket.
class RecordingNetwork extends WiredNetwork:

	var actions: Array = []

	func send_player_action(action: String, payload: Dictionary) -> void:
		actions.append({"action": action, "payload": payload})


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_server_spawns_from_the_authoritative_anchor()
	_test_sender_must_own_the_player()
	_test_cooldown_rejects_rapid_spawns()
	_test_per_player_limit_counts_live_crates()
	_test_direction_validation_and_normalization()
	_test_client_input_only_for_the_local_player()
	_test_example_crate_scene_matches_the_dynamic_contract()
	_free_owned()
	_finish()


func _test_server_spawns_from_the_authoritative_anchor() -> void:
	var setup := _make_setup()
	var spawner: Variant = setup["spawner"]
	spawner.spawn_offset = 48.0
	spawner.impulse_force = 400.0
	_trigger(setup, Vector2.RIGHT)

	var entities := _live_entities(setup["world"])
	_check(entities.size() == 1, "a valid action must spawn one crate")
	if entities.size() != 1:
		return
	var entity := entities[0] as WiredDynamicEntity
	_check(
		entity.type_id == CRATE_TYPE,
		"the crate must use the qualified dynamic type, got %s" % entity.type_id,
	)
	_check(
		entity.owner_player_id == 7,
		"the crate must be owned by the requesting player, got %d"
		% entity.owner_player_id,
	)
	var body := entity.get_node_or_null("RigidBody2D") as RigidBody2D
	_check(body != null, "the crate must contain a RigidBody2D")
	if body != null:
		_check(
			body.position == Vector2(148, 100),
			"the server must spawn at anchor + direction * offset, got %s"
			% body.position,
		)
	_check(
		entity.get("impulse_count") == 1,
		"the crate must receive the cursor impulse once, got %s"
		% entity.get("impulse_count"),
	)
	_check(
		entity.get("last_impulse") == Vector2(400, 0),
		"the crate must receive direction * impulse_force, got %s"
		% entity.get("last_impulse"),
	)


func _test_sender_must_own_the_player() -> void:
	var setup := _make_setup()
	setup["player"].handle_action(
		ACTION, {"direction": Vector2.RIGHT}, 99
	)

	_check(
		_live_entities(setup["world"]).is_empty(),
		"an action routed from another peer must not spawn",
	)


func _test_cooldown_rejects_rapid_spawns() -> void:
	var setup := _make_setup()
	var spawner: Variant = setup["spawner"]
	spawner.cooldown_ms = 250
	_trigger(setup, Vector2.RIGHT)
	var first := _live_entities(setup["world"]).size()
	_trigger(setup, Vector2.RIGHT)

	_check(first == 1, "the first action inside the cooldown must spawn")
	_check(
		_live_entities(setup["world"]).size() == 1,
		"a second action inside the cooldown must be rejected, got %d crates"
		% _live_entities(setup["world"]).size(),
	)


func _test_per_player_limit_counts_live_crates() -> void:
	var setup := _make_setup()
	var spawner: Variant = setup["spawner"]
	spawner.cooldown_ms = 0
	spawner.max_per_player = 2
	for _index in 3:
		_trigger(setup, Vector2.RIGHT)

	_check(
		_live_entities(setup["world"]).size() == 2,
		"the live limit must cap fresh crates at max_per_player, got %d"
		% _live_entities(setup["world"]).size(),
	)
	var world: DynamicWorldContainer = setup["world"]
	var first_id: int = _live_entities(world)[0].entity_id
	world.despawn_entity(first_id)
	_trigger(setup, Vector2.RIGHT)
	_check(
		_live_entities(world).size() == 2,
		"a despawned crate must free one slot in the limit, got %d"
		% _live_entities(world).size(),
	)


func _test_direction_validation_and_normalization() -> void:
	var setup := _make_setup()
	var spawner: Variant = setup["spawner"]
	spawner.cooldown_ms = 0
	for invalid: Variant in [
		Vector2(2, 0),
		Vector2(0.01, 0),
		Vector2(NAN, 0),
		"nope",
	]:
		_trigger(setup, invalid)
	_check(
		_live_entities(setup["world"]).is_empty(),
		"non-finite or out-of-range directions must be rejected, got %d crates"
		% _live_entities(setup["world"]).size(),
	)

	# A short-but-valid vector is normalized, so the spawn offset and impulse
	# stay at their full values.
	_trigger(setup, Vector2(0.5, 0))
	var entities := _live_entities(setup["world"])
	_check(entities.size() == 1, "a valid short direction must spawn")
	if entities.size() != 1:
		return
	var body := entities[0].get_node_or_null("RigidBody2D") as RigidBody2D
	_check(
		body != null and body.position == Vector2(148, 100),
		"the server must normalize the accepted direction, got %s"
		% (body.position if body != null else Vector2.ZERO),
	)


func _test_client_input_only_for_the_local_player() -> void:
	var net := RecordingNetwork.new()
	var setup := _make_setup(net)
	var spawner: Variant = setup["spawner"]
	var player: WiredPlayer = setup["player"]
	var viewport: Viewport = spawner.get_viewport()
	var mouse_world: Vector2 = (
		viewport.get_canvas_transform().affine_inverse()
		* viewport.get_mouse_position()
	)
	# Cursor exactly on the anchor: the aim falls back to a unit vector.
	player.set_anchor_position_2d(mouse_world)

	var press := InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT
	press.pressed = true
	spawner._wired_unhandled_input(press)

	_check(
		net.actions.size() == 1,
		"the local player must send one spawn intent, got %d" % net.actions.size(),
	)
	if net.actions.size() == 1:
		_check(
			net.actions[0]["action"] == ACTION,
			"the intent must use the qualified action, got %s"
			% net.actions[0]["action"],
		)
		var payload: Dictionary = net.actions[0]["payload"]
		_check(
			payload.get("direction") == Vector2.RIGHT,
			"a zero-length aim must send Vector2.RIGHT, got %s"
			% payload.get("direction"),
		)

	var release := InputEventMouseButton.new()
	release.button_index = MOUSE_BUTTON_LEFT
	release.pressed = false
	spawner._wired_unhandled_input(release)
	_check(
		net.actions.size() == 1,
		"releasing the button must not send another intent",
	)

	player.peer_id = 99
	spawner._wired_unhandled_input(press)
	_check(
		net.actions.size() == 1,
		"a remote player copy must not send intents, got %d"
		% net.actions.size(),
	)


## The example crate lives outside `res://`; load it by absolute path and check
## the scene/script contract the dynamic container relies on.
func _test_example_crate_scene_matches_the_dynamic_contract() -> void:
	var packed := load(_example_path("dynamic/crate.tscn")) as PackedScene
	_check(packed != null, "the example crate.tscn must load")
	if packed == null:
		return
	var entity := packed.instantiate() as WiredDynamicEntity
	_check(entity != null, "the example crate must extend WiredDynamicEntity")
	if entity == null:
		return
	_owned.append(entity)
	_check(
		entity.get_node_or_null("RigidBody2D") is RigidBody2D,
		"the example crate must contain a RigidBody2D",
	)
	_check(
		entity._wired_replicated_properties()
		== PackedStringArray(
			[
				"RigidBody2D:position",
				"RigidBody2D:rotation",
				"RigidBody2D:linear_velocity",
			]
		),
		"the example crate must replicate position, rotation and velocity, got %s"
		% [entity._wired_replicated_properties()],
	)
	_check(
		entity.has_method("_wired_save_state")
		and entity.has_method("_wired_load_state"),
		"the example crate must implement the persistence hooks",
	)


# --- helpers --------------------------------------------------------------


func _trigger(setup: Dictionary, direction: Variant) -> void:
	var player: WiredPlayer = setup["player"]
	player.handle_action(ACTION, {"direction": direction}, player.peer_id)


func _make_setup(network: WiredNetwork = null) -> Dictionary:
	var registry := WiredPackageRegistry.new()
	_registries.append(registry)
	var context := WiredPackageContext.new()
	context.package_id = PACKAGE_ID
	context.root_path = FIXTURE_ROOT
	registry.register_context(PACKAGE_ID, context)
	var registration := WiredPackageRegistration.new()
	registration.package_id = PACKAGE_ID
	registration.add_dynamic_entity("crate", FIXTURE_SCENE)
	registry.add_registration(registration)

	var world := DynamicWorldContainer.new()
	root.add_child(world)
	_owned.append(world)
	world.setup(registry, null)
	_set_global_dynamic_world(world)

	var packed := load(_example_path("player/spawner.tscn")) as PackedScene
	_check(packed != null, "the example spawner.tscn must load")
	var spawner: WiredPlayerComponent = null
	if packed != null:
		spawner = packed.instantiate() as WiredPlayerComponent
		_check(spawner != null, "the example spawner must be a WiredPlayerComponent")
	if spawner == null:
		return {}
	_owned.append(spawner)

	var net := network if network != null else RecordingNetwork.new()
	_owned.append(net)
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(7, 1, "local", net)
	spawner.package_id = PACKAGE_ID
	player.add_component(spawner, "server", false)
	root.add_child(player)
	player.set_anchor_position_2d(Vector2(100, 100))
	return {"world": world, "spawner": spawner, "player": player, "network": net}


## Examples are not part of `res://`; resolve them next to the base project.
func _example_path(relative_path: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return (
		project_dir
		.path_join(EXAMPLE_ROOT)
		.path_join(relative_path)
		.simplify_path()
	)


## The spawner reaches the dynamic world through the `Global` autoload. The
## smoke script looks it up by path because autoload identifiers are not
## available when Godot runs a `--script` SceneTree.
func _set_global_dynamic_world(world: DynamicWorldContainer) -> void:
	var global := root.get_node_or_null("Global")
	if global != null:
		global.set("dynamic_world", world)


func _live_entities(world: DynamicWorldContainer) -> Array[Node]:
	var entities: Array[Node] = []
	for child: Node in world.get_children():
		if child is WiredDynamicEntity and not child.is_queued_for_deletion():
			entities.append(child)
	return entities


func _free_owned() -> void:
	_set_global_dynamic_world(null)
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
		print("SPAWNER_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("SPAWNER_SMOKE_FAILED %s" % message)
	quit(1)
