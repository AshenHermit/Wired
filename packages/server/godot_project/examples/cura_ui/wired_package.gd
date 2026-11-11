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
	add_main_scene("custom_main.tscn")
