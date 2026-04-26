extends Node

var _scene_container:SceneContainer
func register_scene_container(instance:SceneContainer):
	_scene_container = instance
func get_scene_container()->SceneContainer:
	return _scene_container
