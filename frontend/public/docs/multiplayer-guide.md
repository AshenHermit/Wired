# Multiplayer Guide

Build multiplayer games with Wired.

## Synchronizing State

Entities automatically sync their transform and properties to all connected clients:

```gdscript
extends Node3D
class_name MultiplayerCharacter

@export var speed = 5.0

func _process(delta):
    var input = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
    position += Vector3(input.x, 0, input.y) * speed * delta
    # Position is automatically synced to other players
```

## Handling Connections

React to player join/leave events:

```gdscript
extends Node
class_name ConnectionManager

func _ready():
    Wired.player_joined.connect(_on_player_joined)
    Wired.player_left.connect(_on_player_left)

func _on_player_joined(player_id: String):
    print("Player joined: ", player_id)

func _on_player_left(player_id: String):
    print("Player left: ", player_id)
```

## Communication Between Clients

Use channels to send custom messages:

```gdscript
extends Node
class_name Chat

func send_chat_message(text: String):
    Wired.send_message("chat", {
        "text": text,
        "sender": get_tree().multiplayer.get_unique_id(),
        "timestamp": Time.get_ticks_msec()
    })

func _ready():
    Wired.on_message("chat", _on_chat_message)

func _on_chat_message(data: Dictionary):
    print("[%s] %s" % [data.sender, data.text])
```

## Best Practices

### Only Sync What You Need

Register only entities that need network synchronization. Don't register UI-only nodes.

### Use Entity Types

Classify entities by type for easier filtering and debugging:

```gdscript
Wired.register_entity(player, "player")
Wired.register_entity(npc, "npc")
Wired.register_entity(bullet, "projectile")
```

### Handle Disconnections

Always clean up resources when players disconnect:

```gdscript
func _on_player_left(player_id: String):
    # Remove player character from scene
    if player_id in players:
        players[player_id].queue_free()
        players.erase(player_id)
```

### Performance Considerations

- Limit the number of simultaneous network messages
- Batch updates when possible
- Use channels efficiently (one channel per message type)
- Monitor sync latency and adjust update frequency accordingly
