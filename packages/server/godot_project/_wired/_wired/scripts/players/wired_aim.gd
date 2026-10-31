extends RefCounted
class_name WiredAim

## Aim helper shared by package input components.
##
## The client only ever sends a direction: the server derives the spawn point
## from its own authoritative anchor, so the aim vector must be unit length and
## independent of the distance between the player and the cursor. A cursor
## exactly on the anchor has no direction; `Vector2.RIGHT` keeps the contract
## total instead of sending a `(0, 0)` that the server would reject.


## Unit vector from the anchor towards the mouse position in world space.
static func direction(anchor: Vector2, mouse_world: Vector2) -> Vector2:
	var delta := mouse_world - anchor
	if delta.is_zero_approx():
		return Vector2.RIGHT
	return delta.normalized()
