extends SceneTree

## Headless smoke test for `PlayerPush` and the example 2D player body.
##
## `PlayerPush` is the only core helper that may move another player: it adds
## velocity along the pusher's direction and never writes `position`. The suite
## also proves the `_wired_player_body` meta lookup (the collider itself or an
## ancestor) and that the example `body.tscn` carries the meta on both the root
## and the `CharacterBody2D` that `move_and_slide` reports.
##
## Example package scripts live outside `res://` (they are copied into the
## project at publish time), so the suite loads them by absolute path derived
## from the project directory. This is the documented workaround for the brief's
## in-project scripts only.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/player_push_smoke.gd --quit-after 2

const FIXTURE_SCENE := "res://tests/fixtures/push_root/push_body.tscn"
const PLAYER_BODY_META := "_wired_player_body"
const EXAMPLE_RELATIVE_DIR := "../examples/wired-platformer/player"

var _failures: PackedStringArray = []
var _checks := 0
var _owned: Array[Node] = []


func _initialize() -> void:
	# Deferred so the tree (and its MultiplayerAPI) exists before players are built.
	_run.call_deferred()


func _run() -> void:
	_test_push_adds_velocity_without_teleport()
	_test_push_converges_instead_of_accumulating()
	_test_player_body_meta_lookup()
	_test_push_collider_only_player_bodies()
	_test_example_body_scene_carries_the_meta()
	_test_pushed_body_keeps_velocity_through_idle_input_step()
	_free_owned()
	_finish()


## Brief case: a single push changes velocity and never teleports the body.
func _test_push_adds_velocity_without_teleport() -> void:
	var body := CharacterBody2D.new()
	_owned.append(body)
	body.velocity = Vector2.ZERO
	PlayerPush.push_other(body, Vector2(120, 0), 1.0)
	_check(body.velocity.x > 0, "a push must add velocity, got %s" % body.velocity)
	_check(
		body.velocity.x == 120.0,
		"a single push must add the pusher's velocity, got %s" % body.velocity,
	)
	_check(
		body.position == Vector2.ZERO,
		"a push must never move the body directly, got %s" % body.position,
	)
	# Strength scales the target speed, not a per-frame addend.
	var slow := CharacterBody2D.new()
	_owned.append(slow)
	PlayerPush.push_other(slow, Vector2(120, 0), 0.5)
	_check(
		slow.velocity.x == 60.0,
		"push strength must scale the target speed, got %s" % slow.velocity,
	)


## The push loop runs after every `move_and_slide`, so repeats must converge to
## the pusher's speed instead of growing without bound.
func _test_push_converges_instead_of_accumulating() -> void:
	var body := CharacterBody2D.new()
	_owned.append(body)
	for index in 120:
		PlayerPush.push_other(body, Vector2(240, 0), 1.0)
	_check(
		body.velocity.x == 240.0,
		"repeated pushes must converge on the pusher's speed, got %s"
		% body.velocity,
	)
	_check(
		body.velocity.length() <= PlayerPush.MAX_PUSH_SPEED + 0.001,
		"a push must stay bounded by MAX_PUSH_SPEED, got %s" % body.velocity,
	)


## `move_and_slide` reports the collider node; the example nests the actual
## `CharacterBody2D` under the package component root, so both placements count.
func _test_player_body_meta_lookup() -> void:
	var fixture := _instantiate_fixture()
	var child := Node.new()
	fixture.add_child(child)
	_owned.append(child)
	_check(
		fixture.has_meta(PLAYER_BODY_META),
		"the fixture root must carry the player-body meta",
	)
	_check(
		PlayerPush.is_player_body(fixture),
		"the fixture root must be recognized as a player body",
	)
	_check(
		PlayerPush.is_player_body(child),
		"a collider must inherit the player-body meta from its ancestor",
	)
	var plain := CharacterBody2D.new()
	_owned.append(plain)
	_check(
		not PlayerPush.is_player_body(plain),
		"a body without the meta must not be treated as a player body",
	)
	var disabled := CharacterBody2D.new()
	disabled.set_meta(PLAYER_BODY_META, false)
	_owned.append(disabled)
	_check(
		not PlayerPush.is_player_body(disabled),
		"an explicitly false meta must not count as a player body",
	)


## The meta check and the velocity change live together so `body.gd` cannot
## push walls or itself by accident.
func _test_push_collider_only_player_bodies() -> void:
	var source := CharacterBody2D.new()
	source.velocity = Vector2(200, 0)
	_owned.append(source)
	var fixture := _instantiate_fixture()
	var plain := CharacterBody2D.new()
	_owned.append(plain)
	var position_before := fixture.position
	_check(
		PlayerPush.push_collider(source, fixture, Vector2(200, 0), 1.0),
		"a player-body collider must be pushed",
	)
	_check(
		fixture.velocity.x > 0,
		"the pushed player body must gain velocity, got %s" % fixture.velocity,
	)
	_check(
		fixture.position == position_before,
		"the pushed player body must keep its position, got %s" % fixture.position,
	)
	_check(
		not PlayerPush.push_collider(source, plain, Vector2(200, 0), 1.0),
		"a plain collider must not be pushed",
	)
	_check(
		plain.velocity == Vector2.ZERO,
		"a plain collider must keep its velocity, got %s" % plain.velocity,
	)
	_check(
		not PlayerPush.push_collider(source, source, Vector2(200, 0), 1.0),
		"a body must never push itself",
	)
	_check(
		PlayerPush.push_collisions(source, Vector2(200, 0), 1.0) == 0,
		"without slide collisions the loop must push nobody",
	)
	# `move_and_slide` zeroes the source velocity along the contact normal, so
	# the explicit pre-slide velocity must still push in the same frame.
	var contact_fixture := _instantiate_fixture()
	source.velocity = Vector2.ZERO
	_check(
		PlayerPush.push_collider(source, contact_fixture, Vector2(90, 0), 1.0),
		"the pre-slide velocity must push even when the source came to a stop",
	)
	_check(
		contact_fixture.velocity.x == 90.0,
		"a contact push must add the pre-slide velocity, got %s"
		% contact_fixture.velocity,
	)
	# A body already moving away at the target speed is not changed, and the
	# helper reports "not pushed" instead of pretending it did something.
	var away_fixture := _instantiate_fixture()
	away_fixture.velocity = Vector2(500, 0)
	_check(
		not PlayerPush.push_collider(
			source, away_fixture, Vector2(100, 0), 1.0
		),
		"a body already moving away must not be reported as pushed",
	)
	_check(
		away_fixture.velocity.x == 500.0,
		"a body already moving away must keep its velocity, got %s"
		% away_fixture.velocity,
	)


## The example scene is outside `res://`, so it is loaded by absolute path. It
## must put the meta on the component root and on the actual collider child,
## and declare both replicated body properties.
func _test_example_body_scene_carries_the_meta() -> void:
	var setup := _instantiate_example_body()
	_check(not setup.is_empty(), "the example body scene must be usable")
	if setup.is_empty():
		return
	var component: Node = setup["component"]
	var player: WiredPlayer = setup["player"]
	var body: CharacterBody2D = setup["body"]
	_check(
		component.has_meta(PLAYER_BODY_META),
		"the example component root must carry the player-body meta",
	)
	_check(
		body.has_meta(PLAYER_BODY_META),
		"the CharacterBody2D collider must carry the player-body meta",
	)
	_check(
		component.has_method("_wired_physics_process"),
		"the example body must implement the physics hook",
	)
	_check(
		player.get_anchor_position_2d() == body.position,
		"`_wired_ready` must seed the anchor from the body, got %s"
		% player.get_anchor_position_2d(),
	)
	var properties: PackedStringArray = component._wired_replicated_properties()
	_check(
		properties == PackedStringArray(["Body:position", "Body:velocity"]),
		"the example body must replicate position and velocity, got %s"
		% [properties],
	)
	# Free this body so the integration test below starts in an empty physics
	# world instead of overlapping it at the origin.
	player.free()


## Regression: an unconditional `velocity.x = input.x * speed` erases a push in
## the very next frame when the pushed player is idle. The real hook is driven
## here, so the body must keep the push, move on the next slide and then settle
## through friction; meaningful input still owns the axis.
func _test_pushed_body_keeps_velocity_through_idle_input_step() -> void:
	var setup := _instantiate_example_body()
	_check(not setup.is_empty(), "the example body scene must be usable")
	if setup.is_empty():
		return
	var component: Node = setup["component"]
	var player: WiredPlayer = setup["player"]
	var body: CharacterBody2D = setup["body"]
	# The other player pushed this body: velocity is set, no local input.
	body.velocity = Vector2(90, 0)
	player.input = {"move": Vector2.ZERO, "jump": false}
	var position_before := body.position
	component._wired_physics_process(0.016)
	_check(
		body.velocity.x > 0.0,
		"an idle body must keep a push through the input step, got %s"
		% body.velocity,
	)
	_check(
		body.position.x > position_before.x,
		"the push must move the idle body, got %s" % body.position,
	)
	# Friction settles the push instead of holding it forever.
	for index in 10:
		player.input = {"move": Vector2.ZERO, "jump": false}
		component._wired_physics_process(0.016)
	_check(
		body.velocity.x == 0.0,
		"friction must settle a push back to rest, got %s" % body.velocity,
	)
	# Meaningful input still owns the horizontal axis.
	player.input = {"move": Vector2.RIGHT, "jump": false}
	body.velocity.x = -90.0
	component._wired_physics_process(0.016)
	_check(
		body.velocity.x == 240.0,
		"meaningful input must set the horizontal speed, got %s" % body.velocity,
	)


# --- helpers --------------------------------------------------------------


func _instantiate_fixture() -> CharacterBody2D:
	var packed := load(FIXTURE_SCENE) as PackedScene
	_check(packed != null, "the push fixture must load")
	if packed == null:
		return CharacterBody2D.new()
	var body := packed.instantiate() as CharacterBody2D
	_check(body != null, "the push fixture must be a CharacterBody2D")
	if body == null:
		return CharacterBody2D.new()
	_owned.append(body)
	return body


## Builds a ready example body owned by the local player, so its hooks can be
## driven against the real scene (outside `res://`, loaded by absolute path).
func _instantiate_example_body() -> Dictionary:
	var packed := _load_example_scene("body.tscn")
	_check(packed != null, "the example body.tscn must load")
	if packed == null:
		return {}
	var component: Node = packed.instantiate()
	if component == null:
		_check(false, "the example body.tscn must instantiate")
		return {}
	var player := WiredPlayer.new()
	_owned.append(player)
	player.setup(1, 1, "local", null)
	player.add_component(component, "server", false)
	root.add_child(player)
	var body := component.get_node_or_null("Body") as CharacterBody2D
	_check(body != null, "the example body must contain a CharacterBody2D `Body`")
	if body == null:
		return {}
	return {"component": component, "player": player, "body": body}


func _load_example_scene(file_name: String) -> PackedScene:
	var path := _example_path(file_name)
	if not FileAccess.file_exists(path):
		printerr("PLAYER_PUSH_SMOKE_MISSING_EXAMPLE %s" % path)
		return null
	return load(path) as PackedScene


## Examples are not part of `res://`; resolve them next to the base project.
func _example_path(file_name: String) -> String:
	var project_dir := ProjectSettings.globalize_path("res://")
	return project_dir.path_join(EXAMPLE_RELATIVE_DIR).path_join(file_name).simplify_path()


func _free_owned() -> void:
	for node: Node in _owned:
		if is_instance_valid(node) and not node.is_queued_for_deletion():
			node.free()
	_owned.clear()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("PLAYER_PUSH_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("PLAYER_PUSH_SMOKE_FAILED %s" % message)
	quit(1)
