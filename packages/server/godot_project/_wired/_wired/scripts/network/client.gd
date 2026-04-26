extends Node
class_name WiredClientNode

func _enter_tree() -> void:
	get_tree().set_multiplayer(MultiplayerAPI.create_default_interface(), get_path())

func start_client(url:String):
	var client = WebSocketMultiplayerPeer.new()
	var check = client.create_client(url)
	if check == Error.OK:
		multiplayer.multiplayer_peer = client
		print("client started")
	
	multiplayer.connected_to_server.connect(
		func():
			print("connected to server")
	)
