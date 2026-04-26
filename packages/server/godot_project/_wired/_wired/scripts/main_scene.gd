extends Node

@export var server_scene: PackedScene
@export var client_scene: PackedScene
@export var scene_container: Node

func _ready() -> void:
	var args = OS.get_cmdline_args()
	print(args)
	if args.has("--server"):
		var server_node:WiredServerNode = server_scene.instantiate()
		scene_container.add_child(server_node)
		if args.has("--port"):
			var idx = args.find("--port")
			var port = args.get(idx + 1).to_int()
			server_node.start_server(port)
	else:
		var client_node:WiredClientNode = client_scene.instantiate()
		scene_container.add_child(client_node)
		if args.has("--url"):
			var idx = args.find("--url")
			var url = args.get(idx + 1)
			client_node.start_client(url)
