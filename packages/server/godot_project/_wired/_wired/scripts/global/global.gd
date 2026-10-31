extends Node

## Autoload that exposes the runtime services to package scripts.
##
## The main scene registers its services once in `_ready()`; packages then reach
## them through `Global.get_*()` instead of hard-coded node paths.

var package_registry: WiredPackageRegistry
var static_world: StaticWorldContainer
## Task 8 replaces this with `DynamicWorldContainer`.
var dynamic_world: Node
var players: PlayersManager
var packages: PackagesManager
var network: WiredNetwork

var _scene_container: SceneContainer


func register_scene_container(instance: SceneContainer) -> void:
	_scene_container = instance


func get_scene_container() -> SceneContainer:
	return _scene_container


## Wires the game scene services after `main.tscn` has been instantiated.
## `dynamic_world` stays a plain `Node` until Task 8 attaches its script.
func register_scene_services(
	static_world_container: StaticWorldContainer,
	dynamic_world_container: Node,
	players_manager: PlayersManager,
	network_service: WiredNetwork
) -> void:
	static_world = static_world_container
	dynamic_world = dynamic_world_container
	players = players_manager
	network = network_service


func get_package_registry() -> WiredPackageRegistry:
	return package_registry


func get_static_world() -> StaticWorldContainer:
	return static_world


func get_dynamic_world() -> Node:
	return dynamic_world


func get_players() -> PlayersManager:
	return players


func get_network() -> WiredNetwork:
	return network
