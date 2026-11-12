extends SceneTree

## Reports what a baked scene contains, for the integration test.
##
##   godot --headless --path packages/server/godot_bake \
##     --script res://tests/inspect_bake.gd -- res://tests/tmp/model.scn
##
## Prints `WIRED_INSPECT_OK <json>` with `{"loop_modes": [...], "materials": [...]}`.

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		print("WIRED_INSPECT_ERROR no scene path")
		quit(1)
		return
	var packed := ResourceLoader.load(str(args[0])) as PackedScene
	if packed == null:
		print("WIRED_INSPECT_ERROR load failed: %s" % str(args[0]))
		quit(1)
		return
	var scene := packed.instantiate()
	var loop_modes: Array = []
	var materials: Array = []
	_collect(scene, loop_modes, materials)
	print(
		"WIRED_INSPECT_OK "
		+ JSON.stringify({"loop_modes": loop_modes, "materials": materials})
	)
	scene.free()
	quit(0)


func _collect(node: Node, loop_modes: Array, materials: Array) -> void:
	var player := node as AnimationPlayer
	if player != null:
		for name: String in player.get_animation_list():
			var animation := player.get_animation(name)
			if animation != null:
				loop_modes.append(int(animation.loop_mode))
	var mesh_instance := node as MeshInstance3D
	if mesh_instance != null and mesh_instance.mesh != null:
		for surface in mesh_instance.mesh.get_surface_count():
			var material := mesh_instance.get_active_material(surface)
			if material != null and not str(material.resource_name).is_empty():
				materials.append(str(material.resource_name))
	for child: Node in node.get_children():
		_collect(child, loop_modes, materials)
