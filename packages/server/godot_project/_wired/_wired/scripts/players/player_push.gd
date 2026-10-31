extends RefCounted
class_name PlayerPush

## Server-side helper that lets one player body push another.
##
## `move_and_slide` only resolves the collider against the pusher's motion; it
## never changes the other body's velocity. After every slide the body component
## asks this helper to add a velocity component along the pusher's direction.
##
## Rules:
## - only nodes marked with `_wired_player_body` (the collider or one of its
##   ancestors) are pushed, so walls and crates are never moved directly;
## - `position` is never written, the other body keeps its own `move_and_slide`;
## - the addend converges on the pusher's speed instead of accumulating every
##   frame: a body already moving away at or above the target is left alone.

## Marker meta on the player body root and on the actual `CharacterBody2D`
## collider. `move_and_slide` reports the collider, which may be a child of the
## package component root.
const PLAYER_BODY_META := "_wired_player_body"
## Hard cap for one push, independent of the pusher's speed.
const MAX_PUSH_SPEED := 480.0


## Adds a bounded velocity component along `velocity` to `body`.
## `strength` scales the target speed; it is not a per-frame multiplier.
static func push_other(
	body: CharacterBody2D, velocity: Vector2, strength: float = 1.0
) -> void:
	if body == null or strength <= 0.0:
		return
	var push_velocity := velocity * strength
	if push_velocity.is_zero_approx():
		return
	var direction := push_velocity.normalized()
	var target_speed := minf(push_velocity.length(), MAX_PUSH_SPEED)
	var along := body.velocity.dot(direction)
	if along >= target_speed:
		return
	body.velocity += direction * (target_speed - along)


## Whether `node` belongs to a player body. Both the component root and the
## `CharacterBody2D` that `move_and_slide` reports carry the meta, and a nested
## collider inherits it from its ancestor.
static func is_player_body(node: Node) -> bool:
	var current := node
	while current != null:
		if current.has_meta(PLAYER_BODY_META) and bool(
			current.get_meta(PLAYER_BODY_META)
		):
			return true
		current = current.get_parent()
	return false


## Pushes one slide collider if it is another player body. `velocity` is the
## velocity that caused the slide: `move_and_slide` zeroes `source.velocity`
## along the contact normal, so the caller must capture it before moving.
## Returns whether a push happened; the source body is always skipped.
static func push_collider(
	source: CharacterBody2D,
	collider: Node,
	velocity: Vector2,
	strength: float = 1.0
) -> bool:
	if source == null or collider == null or collider == source:
		return false
	if not (collider is CharacterBody2D):
		return false
	if not is_player_body(collider):
		return false
	if velocity.is_zero_approx():
		return false
	var target := collider as CharacterBody2D
	var before := target.velocity
	push_other(target, velocity, strength)
	# A body already moving away at the target speed is untouched; report that
	# so callers can distinguish "pushed" from "collided".
	return not target.velocity.is_equal_approx(before)


## Server-only loop: call right after `move_and_slide` with the pre-slide
## velocity. Returns how many player bodies were pushed this frame.
static func push_collisions(
	source: CharacterBody2D, velocity: Vector2, strength: float = 1.0
) -> int:
	if source == null:
		return 0
	var pushed := 0
	for index in source.get_slide_collision_count():
		var collision := source.get_slide_collision(index)
		if collision == null:
			continue
		if push_collider(source, collision.get_collider(), velocity, strength):
			pushed += 1
	return pushed
