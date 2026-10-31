extends SceneTree

## Headless smoke test for `WiredAim`.
##
## `WiredAim.direction` turns an authoritative anchor plus a mouse position in
## world space into the aim vector a package sends to the server. It always
## returns a unit vector, and a zero-length aim falls back to `Vector2.RIGHT`
## instead of producing `(0, 0)`.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/wired_aim_smoke.gd --quit-after 2

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_direction_normalizes_and_handles_zero()
	_test_direction_is_unit_length_in_every_quadrant()
	_finish()


func _test_direction_normalizes_and_handles_zero() -> void:
	_check(
		WiredAim.direction(Vector2(10, 10), Vector2(10, 10)) == Vector2.RIGHT,
		"a zero-length aim must fall back to Vector2.RIGHT, got %s"
		% WiredAim.direction(Vector2(10, 10), Vector2(10, 10)),
	)
	_check(
		WiredAim.direction(Vector2.ZERO, Vector2(3, 4)) == Vector2(0.6, 0.8),
		"direction must normalize the anchor-to-mouse delta, got %s"
		% WiredAim.direction(Vector2.ZERO, Vector2(3, 4)),
	)


func _test_direction_is_unit_length_in_every_quadrant() -> void:
	var anchor := Vector2(120, -40)
	for mouse: Vector2 in [
		Vector2(500, 300),
		Vector2(-500, 300),
		Vector2(-500, -300),
		Vector2(500, -300),
	]:
		var direction := WiredAim.direction(anchor, mouse)
		_check(
			is_equal_approx(direction.length(), 1.0),
			"aim %s must be unit length, got %s" % [mouse, direction],
		)
		_check(
			direction.is_normalized(),
			"aim %s must stay normalized, got %s" % [mouse, direction],
		)
		_check(
			direction.dot((mouse - anchor).normalized()) > 0.999,
			"aim %s must point at the mouse, got %s" % [mouse, direction],
		)


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("WIRED_AIM_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("WIRED_AIM_SMOKE_FAILED %s" % message)
	quit(1)
