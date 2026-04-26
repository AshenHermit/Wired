extends Node
class_name SceneContainer

func _enter_tree() -> void:
	Global.register_scene_container(self)
