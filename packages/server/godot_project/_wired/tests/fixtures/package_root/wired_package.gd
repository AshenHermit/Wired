extends WiredPackageRegistration

func register(registry: WiredPackageRegistry) -> void:
	add_static_scene("static.tscn", {"order": 10})
