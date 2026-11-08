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
	_test_hot_reload_barrier()
	_test_gameplay_rpcs_require_authentication()
	_test_network_buffer_configuration()
	_test_focus_in_requests_snapshot()
	_test_visibility_requests_snapshot()
	_test_remove_package_revision_forgets_the_entry()
	_finish()


## A background tab throttles the engine while WebSocket packets keep arriving.
## The default 64 KiB inbound buffer overflows and Godot drops packets, so both
## peers must be created with a much larger buffer.
func _test_network_buffer_configuration() -> void:
	var net := WiredNetwork.new()
	var peer := net._make_peer()
	_check(
		peer.inbound_buffer_size == WiredNetwork.NETWORK_BUFFER_SIZE,
		"inbound buffer must be raised from the 64 KiB default, got %d"
		% peer.inbound_buffer_size,
	)
	_check(
		peer.outbound_buffer_size == WiredNetwork.NETWORK_BUFFER_SIZE,
		"outbound buffer must be raised from the 64 KiB default, got %d"
		% peer.outbound_buffer_size,
	)
	_check(
		WiredNetwork.NETWORK_BUFFER_SIZE >= 4 * 1024 * 1024,
		"the network buffer must hold at least 4 MiB",
	)
	peer.close()
	net.free()


## Focus returning to a client tab is the recovery point: buffered packets may
## have been dropped while the tab was hidden, so the client asks for a fresh
## authoritative world snapshot. The Web export reports this through the window
## focus notification, not the desktop application focus notification.
func _test_focus_in_requests_snapshot() -> void:
	var net := FocusProbe.new()
	net.mode = "client"
	net._notification(Node.NOTIFICATION_WM_WINDOW_FOCUS_IN)
	_check(
		net.snapshot_requests == 1,
		"window focus-in must request one world snapshot, got %d"
		% net.snapshot_requests,
	)
	net._notification(Node.NOTIFICATION_WM_WINDOW_FOCUS_OUT)
	net._notification(0)
	_check(
		net.snapshot_requests == 1,
		"focus-out and unrelated notifications must not request a snapshot",
	)
	net.mode = "server"
	net._notification(Node.NOTIFICATION_WM_WINDOW_FOCUS_IN)
	_check(
		net.snapshot_requests == 1,
		"a server must never request a client snapshot",
	)
	net.free()


## A browser tab switch does not focus the canvas, so the window-focus
## notification is not enough. `visibilitychange` is the reliable Web signal:
## the client resyncs only when the document becomes visible again.
func _test_visibility_requests_snapshot() -> void:
	var net := FocusProbe.new()
	_check(
		net.has_method("_handle_visibility"),
		"the browser visibility handler must exist",
	)
	if not net.has_method("_handle_visibility"):
		net.free()
		return
	net.mode = "client"
	net._handle_visibility(true)
	_check(
		net.snapshot_requests == 1,
		"becoming visible must request one world snapshot, got %d"
		% net.snapshot_requests,
	)
	net._handle_visibility(false)
	_check(
		net.snapshot_requests == 1,
		"becoming hidden must not request a snapshot",
	)
	net.mode = "server"
	net._handle_visibility(true)
	_check(
		net.snapshot_requests == 1,
		"a server must never request a snapshot on visibility change",
	)
	net.free()


class FocusProbe extends WiredNetwork:
	var snapshot_requests := 0

	func request_world_snapshot() -> void:
		snapshot_requests += 1


class BarrierProbe extends WiredNetwork:
	var sender_id := 0

	func _remote_sender_id() -> int:
		return sender_id


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
	_check(
		net.has_signal("world_snapshot_requested")
		and net.has_signal("world_snapshot_received"),
		"world snapshot signals must exist",
	)
	_check(
		net.has_method("send_world_snapshot")
		and net.has_method("request_world_snapshot"),
		"world snapshot transport methods must exist",
	)
	_check(
		net.has_method("get_package_revisions")
		and net.has_method("is_peer_authenticated"),
		"the snapshot server helpers must exist",
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


func _test_hot_reload_barrier() -> void:
	var net := BarrierProbe.new()
	net.mode = "server"
	var released: Array = []
	_check(net.has_signal("hot_reload_ready"), "hot_reload_ready signal must exist")
	_check(net.has_method("begin_hot_reload"), "begin_hot_reload method must exist")
	if not net.has_signal("hot_reload_ready") or not net.has_method("begin_hot_reload"):
		net.free()
		return
	net.hot_reload_ready.connect(
		func(package_id: int, revision: int) -> void:
			released.append({"package_id": package_id, "revision": revision})
	)
	net._players[7] = {"player_id": 3, "ready": true, "packages_ready": true, "name": "bob"}
	net._players[8] = {"player_id": 4, "ready": true, "packages_ready": true, "name": "eve"}
	net._package_reports[7] = {}
	net._package_reports[8] = {}

	net.begin_hot_reload(42, 9)
	_check(released.is_empty(), "a revision with authenticated peers must remain pending")
	net.sender_id = 7
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 9, "ok": true}))
	_check(released.is_empty(), "one successful client report must not release the barrier")
	net.sender_id = 8
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 9, "ok": true}))
	_check(released == [{"package_id": 42, "revision": 9}], "all successful reports must release exactly once")
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 9, "ok": true}))
	_check(released.size() == 1, "a released revision must not emit twice")

	net.begin_hot_reload(42, 10)
	net.sender_id = 7
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 10, "ok": false}))
	_check(released.size() == 1, "a failed report must leave the barrier pending")
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 9, "ok": true}))
	_check(released.size() == 1, "a stale report must not release the current revision")
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 10, "ok": true}))
	net.sender_id = 8
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 10, "ok": true}))
	_check(released == [{"package_id": 42, "revision": 9}, {"package_id": 42, "revision": 10}], "a successful retry must release the current revision")

	net.begin_hot_reload(42, 11)
	net._on_peer_disconnected(7)
	_check(released.size() == 2, "one remaining peer must keep the barrier pending")
	net._on_peer_disconnected(8)
	_check(released == [{"package_id": 42, "revision": 9}, {"package_id": 42, "revision": 10}, {"package_id": 42, "revision": 11}], "disconnecting all pending peers must release the revision")

	net.begin_hot_reload(42, 12)
	_check(released.back() == {"package_id": 42, "revision": 12}, "no authenticated peers must release immediately")
	net.free()


## The gameplay RPC handlers re-check authentication themselves, not only the
## ticket handshake. Offline `get_remote_sender_id()` is 0, so adding peer 0 to
## `_players` simulates an authenticated sender without a socket.
func _test_gameplay_rpcs_require_authentication() -> void:
	var net := WiredNetwork.new()
	net.mode = "server"
	var inputs: Array = []
	var actions: Array = []
	var snapshot_requests: Array = []
	net.player_input_received.connect(
		func(peer_id: int, input: Dictionary) -> void:
			inputs.append({"peer": peer_id, "input": input})
	)
	net.player_action_received.connect(
		func(peer_id: int, action: String, payload: Dictionary) -> void:
			actions.append({"peer": peer_id, "action": action, "payload": payload})
	)
	net.world_snapshot_requested.connect(
		func(peer_id: int) -> void: snapshot_requests.append(peer_id)
	)

	net.cli_player_input({"move": Vector2.RIGHT, "seq": 1})
	net.cli_player_action("pkg.test/ping", {"n": 1})
	net.cli_world_snapshot()
	_check(inputs.is_empty(), "input from an unauthenticated peer must be rejected")
	_check(actions.is_empty(), "actions from an unauthenticated peer must be rejected")
	_check(
		snapshot_requests.is_empty(),
		"snapshot requests from an unauthenticated peer must be rejected",
	)

	net._players[0] = {
		"player_id": 9,
		"ready": true,
		"packages_ready": true,
		"name": "eve",
	}
	net._package_reports[0] = {}
	net.cli_player_input({"move": Vector2.RIGHT, "seq": 1})
	_check(
		inputs.size() == 1 and inputs[0]["peer"] == 0,
		"input from an authenticated peer must be forwarded",
	)
	net.cli_player_action("", {})
	_check(actions.is_empty(), "an empty action must still be rejected")
	net.cli_player_action("pkg.test/ping", {"n": 2})
	_check(
		actions.size() == 1 and actions[0]["action"] == "pkg.test/ping",
		"a valid action from an authenticated peer must be forwarded",
	)
	net.cli_world_snapshot()
	_check(
		snapshot_requests == [0],
		"a package-ready authenticated peer may request a snapshot, got %s"
		% [snapshot_requests],
	)
	# Malformed package reports must be dropped without touching readiness.
	net.cli_package_ready("{not json")
	net.cli_package_ready(JSON.stringify({"package_id": 42, "revision": 1, "ok": true}))
	_check(
		net._package_reports[0].is_empty(),
		"malformed and unknown package reports must not be recorded",
	)
	net.free()


# --- assertions -----------------------------------------------------------


func _test_remove_package_revision_forgets_the_entry() -> void:
	var net := WiredNetwork.new()
	net.mode = "server"
	net._package_revisions[42] = 3
	net.remove_package_revision(42)
	_check(
		not net.get_package_revisions().has(42),
		"removed package must leave the revision map",
	)
	net.free()


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
