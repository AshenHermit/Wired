# Wired API Reference

Core API methods for Godot development.

## Wired Class

### Methods

#### `register_entity(node: Node, entity_type: String) -> void`

Registers a node as a network entity that will be synchronized across all clients.

**Parameters:**
- `node`: The Node to register
- `entity_type`: Type identifier (e.g., "player", "npc", "projectile")

**Example:**
```gdscript
Wired.register_entity(self, "player")
```

#### `send_message(channel: String, data: Dictionary) -> void`

Sends a message to other clients on a specific channel.

**Parameters:**
- `channel`: Message channel name (custom string identifier)
- `data`: Dictionary payload to send

**Example:**
```gdscript
Wired.send_message("chat", {"text": "Hello!", "sender": player_name})
```

#### `on_message(channel: String, callback: Callable) -> void`

Listens for messages on a channel.

**Parameters:**
- `channel`: Message channel name to listen on
- `callback`: Callable that receives the message data

**Example:**
```gdscript
Wired.on_message("chat", func(data):
    print("Message from %s: %s" % [data.sender, data.text])
)
```

### Signals

#### `player_joined(player_id: String)`

Emitted when a new player joins the room.

#### `player_left(player_id: String)`

Emitted when a player leaves the room.

#### `entity_spawned(entity_id: String, entity_type: String)`

Emitted when a new entity is registered in the room.

#### `entity_removed(entity_id: String)`

Emitted when an entity is unregistered or removed.

## Examples

### Basic Setup

```gdscript
extends Node3D
class_name GameManager

func _ready():
    Wired.player_joined.connect(_on_player_joined)
    Wired.player_left.connect(_on_player_left)

func _on_player_joined(player_id: String):
    print("Player joined: %s" % player_id)

func _on_player_left(player_id: String):
    print("Player left: %s" % player_id)
```
