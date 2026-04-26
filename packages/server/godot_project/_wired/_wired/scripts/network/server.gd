extends Node
class_name WiredServerNode

func _ready() -> void:
	pass

func _enter_tree() -> void:
	get_tree().set_multiplayer(MultiplayerAPI.create_default_interface(), get_path())

func start_server(port:int):
	var server = WebSocketMultiplayerPeer.new()
	var check = server.create_server(port)
	if check == Error.OK:
		multiplayer.multiplayer_peer = server
		print("server started")
	
	multiplayer.peer_connected.connect(
		func(peer_id):
			print("client connected " + str(peer_id))
	)
	multiplayer.peer_disconnected.connect(
		func(peer_id):
			print("client connected " + str(peer_id))
	)
