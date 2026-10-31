extends WiredPackageRegistration

## Fixture entry mirroring `examples/wired-platformer/wired_package.gd`.
##
## The example itself is outside the base `_wired` project, so the contract test
## loads this copy with the same five registrations and empty `Node` scenes.

func register(_registry: WiredPackageRegistry) -> void:
	add_static_scene("static/platform.tscn", {"order": 10})
	add_player_component("player/body.tscn", {"order": 10, "authority": "server"})
	add_player_component(
		"player/camera.tscn", {"order": 20, "authority": "local", "local_only": true}
	)
	add_player_component("player/spawner.tscn", {"order": 30, "authority": "server"})
	add_dynamic_entity(
		"crate",
		"dynamic/crate.tscn",
		{"authority": "server", "persist": true, "limit_per_player": 8}
	)
