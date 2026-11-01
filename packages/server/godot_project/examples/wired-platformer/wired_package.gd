extends WiredPackageRegistration

## Example platformer package entry.
##
## Registration order is part of the package contract: the body moves first,
## the camera follows the anchor the body publishes, and the spawner only reads
## the final anchor. Dynamic entities are qualified by the registry as
## `<package_id>/crate`.
##
## Paths are relative to this file, so the package keeps working after it is
## copied from `godot_project/examples/wired-platformer` into a room's
## `res://packages/<id>` directory.

func register(_registry: WiredPackageRegistry) -> void:
	add_static_scene("static/platform.tscn", {"order": 10})
	add_player_component("player/body.tscn", {"order": 10, "authority": "server"})
	add_player_component(
		"player/camera.tscn", {"order": 20, "authority": "local", "local_only": true}
	)
	add_player_component("player/spawner.tscn", {"order": 30, "authority": "server"})
	# Dynamic registration is deliberately limited to the core contract
	# (`authority`, `persist`). Per-player cooldown and limit are package policy
	# and live in `player/spawner.gd`; the core does not pretend to enforce them.
	add_dynamic_entity(
		"crate", "dynamic/crate.tscn", {"authority": "server", "persist": true}
	)
