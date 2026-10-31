extends SceneTree

## Headless smoke test for the package readiness rule used by WiredNetwork.
##
## Readiness is an initial-spawn gate only: a peer is ready once every announced
## package has a matching, successfully applied report. A room without packages
## is ready immediately. Later revisions do not reset or re-emit readiness.
##
## Run from the repository root:
##   godot --headless --path packages/server/godot_project/_wired \
##     --script res://tests/network_readiness_smoke.gd --quit-after 2

var _failures: PackedStringArray = []
var _checks := 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_readiness_matrix()
	_test_network_api_surface()
	_test_packages_ready_emits_once()
	_finish()


func _test_readiness_matrix() -> void:
	_check(PackageReadiness.is_ready({}, {}), "a room without packages must be ready")
	_check(
		not PackageReadiness.is_ready({"pkg": 3}, {}),
		"an announced package without a report must block readiness",
	)
	_check(
		PackageReadiness.is_ready({"pkg": 3}, {"pkg": {"revision": 3, "state": "ready"}}),
		"a matching ready report must satisfy readiness",
	)
	_check(
		not PackageReadiness.is_ready(
			{"pkg": 3}, {"pkg": {"revision": 2, "state": "ready"}}
		),
		"a ready report for an older revision must not satisfy readiness",
	)
	_check(
		not PackageReadiness.is_ready(
			{"pkg": 3}, {"pkg": {"revision": 3, "state": "failed"}}
		),
		"a failed report for the current revision must not satisfy readiness",
	)
	_check(
		PackageReadiness.is_ready(
			{"pkg": 3, "other": 5},
			{
				"pkg": {"revision": 3, "state": "ready"},
				"other": {"revision": 5, "state": "ready"},
			}
		),
		"readiness must require every announced package, not only one",
	)
	_check(
		not PackageReadiness.is_ready(
			{"pkg": 3, "other": 5},
			{"pkg": {"revision": 3, "state": "ready"}}
		),
		"one missing report must block readiness",
	)
	_check(
		PackageReadiness.is_ready(
			{"pkg": 3},
			{
				"pkg": {"revision": 3, "state": "ready"},
				"extra": {"revision": 9, "state": "failed"},
			}
		),
		"reports for packages that are not announced must be ignored",
	)


func _test_network_api_surface() -> void:
	var net := WiredNetwork.new()
	_check(net.has_signal("peer_authenticated"), "peer_authenticated must exist")
	_check(net.has_signal("peer_packages_ready"), "peer_packages_ready must exist")
	_check(net.has_signal("player_input_received"), "player_input_received must exist")
	_check(net.has_signal("player_action_received"), "player_action_received must exist")
	_check(
		net.has_method("is_peer_packages_ready"),
		"is_peer_packages_ready must exist",
	)
	_check(net.has_method("send_player_input"), "send_player_input must exist")
	_check(net.has_method("send_player_action"), "send_player_action must exist")
	_check(
		not net.is_peer_packages_ready(1),
		"an unknown peer must never be packages-ready",
	)
	net.free()


func _test_packages_ready_emits_once() -> void:
	var net := WiredNetwork.new()
	var events: Array = []
	net.peer_packages_ready.connect(
		func(peer_id: int) -> void: events.append(peer_id)
	)
	net._players[7] = {
		"player_id": 3,
		"ready": true,
		"packages_ready": false,
		"name": "bob",
	}
	net._mark_packages_ready(7)
	net._mark_packages_ready(7)
	net._mark_packages_ready(99)
	_check(
		events == [7],
		"peer_packages_ready must be emitted once for a known peer, got %s" % events,
	)
	_check(net.is_peer_packages_ready(7), "the gate must stay open after emission")
	_check(
		not net.is_peer_packages_ready(99),
		"a peer that never authenticated must not become ready",
	)
	net.free()


# --- assertions -----------------------------------------------------------


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures.append(message)


func _finish() -> void:
	if _failures.is_empty():
		print("NETWORK_READINESS_SMOKE_OK checks=%d" % _checks)
		print("ALL TESTS PASSED")
		quit(0)
		return
	for message: String in _failures:
		printerr("NETWORK_READINESS_SMOKE_FAILED %s" % message)
	quit(1)
