extends Node

class_name PlayerCharacterModel

@export var skeleton: Skeleton3D
@export var meshes_to_leave: Array[MeshInstance3D] = []
@export var animation_tree:AnimationTree
@export var spine_rotation_target:Node3D

const head_bone_name = "m_head"
var head_bone_id

# Called when the node enters the scene tree for the first time.
func _ready() -> void:
	head_bone_id = skeleton.find_bone(head_bone_name)

func make_first_person_vision():
	for child in skeleton.get_children():
		if child is MeshInstance3D:
			child.visible = false
	for child in meshes_to_leave:
		child.visible = true

func get_head_global_pose():
	var pose = skeleton.global_transform * skeleton.get_bone_global_pose(head_bone_id)
	return pose
	
func set_movement_running():
	animation_tree.set("parameters/movement_trans/transition_request", "run")

func set_movement_idle():
	animation_tree.set("parameters/movement_trans/transition_request", "idle")

func set_spine_rotation(rotation:Vector3):
	spine_rotation_target.rotation = rotation

# Called every frame. 'delta' is the elapsed time since the previous frame.
func _process(delta: float) -> void:
	pass
