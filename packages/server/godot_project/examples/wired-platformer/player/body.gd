extends WiredPlayerComponent

## Example 2D platformer body (package `wired-platformer`).
##
## Server authority: the server reads the replicated input snapshot, simulates
## `Body` with `move_and_slide` and publishes `Body:position`/`Body:velocity`.
## Every peer keeps the component for visuals and writes the replicated body
## position into the player anchor, which the camera follows.
##
## The root and the actual `CharacterBody2D` both carry `_wired_player_body`:
## `move_and_slide` reports the collider child, while package lookups usually
## start from the component root.

const PLAYER_BODY_META := "_wired_player_body"

@export var speed := 240.0
@export var jump_velocity := -420.0
@export var gravity := 980.0
@export var push_strength := 1.0
## Horizontal decay applied when the player gives no meaningful input, so a
## push from another player survives the next frame and then settles.
@export var friction := 1200.0

var body: CharacterBody2D = null


func _wired_ready() -> void:
	body = get_node_or_null("Body") as CharacterBody2D
	if body == null:
		push_warning(
			"WIRED_EXAMPLE_BODY_MISSING_NODE package=%s node=Body" % package_id
		)
		return
	# The scene carries both markers; set them again so a programmatically built
	# body follows the same contract as the shipped scene.
	set_meta(PLAYER_BODY_META, true)
	body.set_meta(PLAYER_BODY_META, true)
	if player != null:
		player.set_anchor_position_2d(body.position)


## Server only (the component base gates this hook). Moves the body, publishes
## the anchor and pushes other player bodies it ran into.
func _wired_physics_process(delta: float) -> void:
	if body == null or player == null:
		return
	var input_x := _move_x(player.input.get("move", Vector2.ZERO))
	if absf(input_x) > 0.01:
		# Meaningful input owns the horizontal axis.
		body.velocity.x = input_x * speed
	else:
		# Idle: never erase an external push in the same frame. Decay it with
		# friction instead, so another player's push survives long enough to
		# move this body.
		body.velocity.x = move_toward(body.velocity.x, 0.0, friction * delta)
	if body.is_on_floor():
		if bool(player.input.get("jump", false)):
			body.velocity.y = jump_velocity
	else:
		body.velocity.y += gravity * delta
	# `move_and_slide` removes the velocity component that hit the other body,
	# so keep the intended velocity for the push loop.
	var motion_velocity := body.velocity
	body.move_and_slide()
	player.set_anchor_position_2d(body.position)
	PlayerPush.push_collisions(body, motion_velocity, push_strength)


## Every peer: derive the local anchor from the replicated body position. The
## camera component reads the same anchor, so clients follow the server.
func _wired_visual_process(_delta: float) -> void:
	if body == null or player == null:
		return
	player.set_anchor_position_2d(body.position)


func _wired_replicated_properties() -> PackedStringArray:
	return PackedStringArray(["Body:position", "Body:velocity"])


func _move_x(move: Variant) -> float:
	var value := 0.0
	if move is Vector2:
		value = (move as Vector2).x
	elif move is Vector3:
		value = (move as Vector3).x
	return clampf(value, -1.0, 1.0)
