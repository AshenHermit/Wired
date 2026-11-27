extends Node3D

## Заглушка модели персонажа для smoke-тестов. Настоящая модель импортирует
## `.glb`, недоступный в базовом проекте `res://`; здесь достаточно контракта,
## который использует `character.gd`.

func make_first_person_vision() -> void:
	pass


func set_spine_rotation(_rotation: Vector3) -> void:
	pass


func get_head_global_pose() -> Transform3D:
	return Transform3D(Basis.IDENTITY, Vector3(0.0, 1.6, 0.0))


func set_movement_running() -> void:
	pass


func set_movement_idle() -> void:
	pass


func set_movement_direction(_direction: Vector2) -> void:
	pass
