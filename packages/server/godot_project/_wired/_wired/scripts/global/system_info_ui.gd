extends CanvasLayer

func _process(delta: float) -> void:
	if Input.is_action_pressed("show_system_info"):
		visible = true
	else:
		visible = false
