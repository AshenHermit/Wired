# Entity Registration

Entities are game objects that Wired synchronizes across clients. Learn how to register them.

## What is an Entity?

An entity represents any game object that multiple clients need to know about:
- Players
- NPCs
- Bullets
- Interactive objects

## Registering an Entity

Use the Wired API to register entities:

```gdscript
extends Node
class_name Player

func _ready():
    # Register this node as an entity
    Wired.register_entity(self, "player")
```

## Entity Properties

Once registered, an entity's transform and basic properties are automatically synchronized across all connected clients.

## See Also

- [Multiplayer Guide](multiplayer-guide.md) for network synchronization patterns
- [API Reference](api-reference.md) for complete API documentation
