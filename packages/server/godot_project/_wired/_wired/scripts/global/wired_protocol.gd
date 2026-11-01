extends RefCounted
class_name WiredProtocol

## Shared vocabulary of the runtime multiplayer protocol.
##
## Spawn records, late-join snapshots and package state travel as plain
## `Dictionary` values through `MultiplayerSpawner` and reliable RPCs, so a typo
## in one stringly-typed key silently produced a default instead of an error.
## Every producer and consumer of those dictionaries uses the constants below.
##
## Node metadata is collected here too: the `_wired_package_*` keys are written
## by `PackagesManager`, and `_wired_registered` marks every root a container
## created, so no generic code may replace it.
##
## Load it with `preload` (`const Protocol := preload(...)`): a new `class_name`
## is not in the global class cache until the editor imported it, and headless
## `--script` runs must not depend on that step.

# --- spawn record and late-join snapshot keys ------------------------------

const KEY_PLAYER_ID := "player_id"
const KEY_PEER_ID := "peer_id"
const KEY_NAME := "name"
const KEY_DISPLAY_NAME := "display_name"
const KEY_SPAWN_POSITION_2D := "spawn_position_2d"
const KEY_SPAWN_POSITION_3D := "spawn_position_3d"
## Persisted anchor of a player, saved by `WiredPlayer.save_state`.
const KEY_ANCHOR_POSITION_2D := "anchor_position_2d"
const KEY_ANCHOR_POSITION_3D := "anchor_position_3d"
const KEY_ENTITY_ID := "entity_id"
const KEY_TYPE_ID := "type_id"
const KEY_OWNER_PLAYER_ID := "owner_player_id"
const KEY_STATE := "state"
const KEY_RESTORE := "restore"
const KEY_SPAWN_DATA := "spawn_data"

# --- registry descriptor keys ----------------------------------------------

const KEY_PACKAGE_ID := "package_id"
const KEY_PATH := "path"
const KEY_ORDER := "order"
const KEY_AUTHORITY := "authority"
const KEY_LOCAL_ONLY := "local_only"
const KEY_QUALIFIED_TYPE := "qualified_type"
const KEY_OPTIONS := "options"

# --- world snapshot envelope ----------------------------------------------

const KEY_PACKAGES := "packages"
const KEY_PLAYERS := "players"
const KEY_DYNAMIC_WORLD := "dynamic_world"

# --- server event envelope -------------------------------------------------

const KEY_TYPE := "type"
const EVENT_WORLD_STATE := "world_state"
const EVENT_PLAYER_JOINED := "player_joined"
const EVENT_PLAYER_READY := "player_ready"
const EVENT_PLAYER_LEFT := "player_left"
const EVENT_PACKAGE_REVISION := "package_revision"
## A package left the room. Clients drop its content and request a fresh
## world snapshot instead of waiting for a revision that will never come.
const EVENT_PACKAGE_REMOVED := "package_removed"
const EVENT_WORLD_SNAPSHOT := "world_snapshot"
const EVENT_ERROR := "error"

# --- applied revision map --------------------------------------------------

const KEY_REVISION := "revision"
const KEY_ARTIFACT_KEY := "artifact_key"

# --- node metadata ---------------------------------------------------------

## Owning package of a scene instantiated by `PackagesManager`.
const META_PACKAGE_ID := "_wired_package_id"
## Relative scene path of that scene inside the package artifact.
const META_PACKAGE_SCENE := "_wired_package_scene"
## Revision the live scene was instantiated from.
const META_PACKAGE_REVISION := "_wired_package_revision"
## Artifact key of the runtime directory a live scene was instantiated from.
## The revision alone is not enough to tell two builds of it apart: a republished
## dependency keeps its revision and gets a new key.
const META_PACKAGE_ARTIFACT_KEY := "_wired_package_artifact_key"
## Set on every root a container owns. Such a root must never be replaced by a
## generic reloader: its lifetime belongs to its container.
const META_REGISTERED := "_wired_registered"
## Saved id of a restored dynamic entity whose live id had to be reassigned.
const META_SOURCE_ENTITY_ID := "_wired_source_entity_id"
## Live id of a dynamic entity, mirrored on the node for diagnostics.
const META_ENTITY_ID := "_wired_entity_id"


## Parses a serialized 2D vector. JSON state stores vectors as `[x, y]`.
static func as_vector2(value: Variant, fallback := Vector2.ZERO) -> Vector2:
	if value is Vector2:
		var vector: Vector2 = value
		return vector
	if value is Array and value.size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	return fallback


## Parses a serialized 3D vector. JSON state stores vectors as `[x, y, z]`.
static func as_vector3(value: Variant, fallback := Vector3.ZERO) -> Vector3:
	if value is Vector3:
		var vector: Vector3 = value
		return vector
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return fallback
