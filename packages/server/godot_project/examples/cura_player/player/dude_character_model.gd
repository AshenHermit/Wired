extends Node

class_name PlayerCharacterModel

@export var skeleton: Skeleton3D
@export var meshes_to_leave: Array[MeshInstance3D] = []
@export var animation_tree:AnimationTree
@export var spine_rotation_target:Node3D
@export var head_target:ModifierBoneTarget3D
@export var arms_mesh:MeshInstance3D

var anim_direction: Vector2 = Vector2.UP
var anim_direction_target: Vector2 = Vector2.UP

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
	animation_tree.set("parameters/fps_arms/add_amount", 1.0)
	arms_mesh.set_layer_mask_value(6, true)

func get_head_global_pose():
	var pose = head_target.global_transform
	return pose
	
func set_movement_running():
	animation_tree.set("parameters/movement_trans/transition_request", "run")

func set_movement_idle():
	animation_tree.set("parameters/movement_trans/transition_request", "idle")

func set_spine_rotation(rotation:Vector3):
	spine_rotation_target.rotation = rotation

func set_movement_direction(dir: Vector2):
	anim_direction_target = dir

# Called every frame. 'delta' is the elapsed time since the previous frame.
func _process(delta: float) -> void:
	anim_direction = anim_direction.lerp(anim_direction_target, delta * 5.0)
	animation_tree.set("parameters/run_direction_blend/blend_position", anim_direction)
