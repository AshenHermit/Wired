# Cura Registry — Sandbox Entity Registry Design

Date: 2026-11-27

## Intent

Build a library package `packages/server/godot_project/examples/cura_registry` that
any other room package can call from its `wired_package.gd` to register
sandbox entities (props, tools, future NPC/effect kinds). Players open a Q
panel listing registered entities grouped by category; selecting a prop equips
a toolgun whose left click spawns that prop on a surface. The result must be a
flexible foundation for a Garry's Mod-like sandbox, not a one-off crate
spawner.

`_wired` is shared core for every room, most of which are not sandboxes. The
only permitted core change is a **neutral generic registry slot**; all sandbox
semantics live in the library package and its consumers.

## Goals

- A third-party package can register a prop with one call from `wired_package.gd`.
- The Q panel is data-driven: categories/entries come from registered packages,
  with no hardcoded list in `cura_player` or core.
- Selecting a prop equips a hand weapon; left click spawns the chosen
  registered type on a surface via the server-authoritative dynamic world.
- A toolgun is one kind of hand weapon: any package can register its own
  in-hand item/weapon with server behavior and client viewmodel through the
  same base script and player-component lifecycle.
- Registrations survive package hot reload deterministically on every peer.
- The API can grow to tools, NPCs, effects and other sandbox kinds without
  further core changes.

## Non-goals

- Physgun, toolgun-ing, entity editing, constraints, undo, or a spawn menu
  editor beyond selecting registered entries.
- Client-authoritative spawning or trusting client-provided hit positions.
- Changing the core input map, adding autoloads, or putting sandbox names in
  `_wired` code (generic keys such as `"kind"`/`"id"` are fine).
- Frontend changes; the panel is an in-game Godot UI inside a package.
- `class_name` declarations or direct RPC in package scripts.

## Constraints

- Dependencies are declared by authoring quoted `res://packages/<slug>/...`
  references in `.gd`/`.tscn`/`.tres`; the backend rewrites them to
  `user://wired/rooms/<room>/packages/<slug>/<revision>-<artifactKey>/...` at
  publish. Dependencies are staged/applied before dependents, so calling the
  library from `register()` is safe. No manifest file exists.
- `WiredPackageRegistry` is rebuilt on each package apply: `clear_package(id)`
  wipes that package's entries and context, then `add_registration()` re-adds
  them. No long-lived custom state may live in the registry itself.
- `WiredPlayerComponent.spawn_dynamic(local_type)` qualifies with the calling
  component's package id. Cross-package spawning must use
  `Global.dynamic_world.spawn_entity(qualified_type, data)` on the server.
- Dynamic entity roots extend `WiredDynamicEntity`; server authority is
  required. The server owns simulation; clients render interpolated state.
- `WiredPlayer.request_action` is a reliable RPC limited to 20 actions/sec per
  player. Tools must debounce.
- Package scripts cannot use `class_name` (hot-swap limitation) and must not
  declare their own RPC; all networking goes through
  `register_action`/`request_action`.
- `cura_player` already has an `arm_camera_container` SubViewport (layer 6)
  for a first-person viewmodel and a replicated yaw/pitch for aiming.

## Approaches

1. **Metadata only in existing `options`.** Props via `add_dynamic_entity`
   options; tools squeezed into player/static descriptors; UI scans four
   descriptor lists. No core edit, but no honest place for tools/NPCs and a
   stringly-typed schema. Rejected.
2. **Neutral generic core slot + library package (chosen).** Add one generic
   custom-entry kind to `WiredPackageRegistry` (`kind`/`id`/`options`, stamped
   with `package_id`, deterministic sorting, cleared with the package). The
   library wraps it in typed helpers and owns UI/toolgun scenes. Extensible to
   any sandbox entity kind; core gains no sandbox knowledge.
3. **Sandbox service in `_wired` autoload.** Simplest plumbing, but puts mode
   logic into the shared core. Rejected by the user's constraint.

## Design

### 1. Core addition (engine-neutral, no sandbox semantics)

`packages/server/godot_project/_wired/_wired/scripts/global/wired_protocol.gd`

- Add `const KEY_ID := "id"` and `const KEY_QUALIFIED_ID := "qualified_id"`.

`.../scripts/packages/wired_package_registration.gd`

- Add:
  `func add_custom(kind: String, local_id: String, options: Dictionary = {}) -> void`
  which appends `_entry(kind, "", options)` plus
  `{KEY_ID: local_id}` to `_entries`. `_entry()` already copies arbitrary
  options, sets `order`/`authority`/`local_only` defaults and assigns
  `registration_index`. No new `KIND_*` constant: `kind` is any string.

`.../scripts/global/package_registry.gd`

- In `add_registration()`, for any descriptor that has `KEY_ID`, set
  `descriptor[KEY_QUALIFIED_ID] = resolve_action(package_id, local_id)` (same
  namespace rule as dynamic types/actions). Existing four kinds do not carry
  `id` and are untouched.
- Add generic `get_entries(kind: String) -> Array[Dictionary]` using the
  existing `_sorted_descriptors()` and comparator. `get_static_scenes()` etc.
  become thin wrappers. Add `find_entry(kind, qualified_id) -> Dictionary`.
- `clear_package()` needs no change: it already drops all entries of a
  package, including custom ones.

Core smoke tests gain cases for custom-entry sorting, qualification and
per-package clearing (`_wired/tests/package_registry_smoke.gd` or the existing
registry smoke file).

### 2. Library package API

`examples/cura_registry/api.gd` — script with `static` functions, no
`class_name`. Consumers write:

```gdscript
extends WiredPackageRegistration
const Cura = preload("res://packages/cura_registry/api.gd")

func register(registry: WiredPackageRegistry) -> void:
    Cura.register_category(self, "props", {"label": "Props", "order": 10})
    Cura.register_prop(self, "crate", "dynamic/crate.tscn", {
        "category": "props", "label": "Wooden crate", "icon": "res://...",
        "authority": "server", "persist": true,
    })
```

- `register_category(registration, local_id, options)` →
  `registration.add_custom("cura.category", local_id, options)`.
- `register_prop(registration, local_type, scene_path, options)` →
  `registration.add_dynamic_entity(local_type, scene_path, core_options)` with
  `authority` (default `"server"`) and `persist` passed through, plus
  `registration.add_custom("cura.prop", local_type, display_options)` where
  `display_options` carries `category`, `label`, `icon`, `order`, `tags` and
  `dynamic_type = local_type`. One call gives both a spawnable type and a
  UI-visible entry.
- `register_tool(registration, local_id, options)` →
  `registration.add_custom("cura.tool", local_id, options)`; options include
  `label`, `icon`, `category` and `order`. The tool's behavior is **not** a
  path in this descriptor: the tool package registers its own player component
  scene (see §4), which is both the server behavior and the client viewmodel
  driver. Spawner is just the first such tool, registered by `cura_registry`.
- `resolve_path(package_id, relative_path) -> String` uses
  `Global.get_package_registry().get_context(package_id)` and
  `context.scene_path(relative_path)`. All packages that register entries have
  an entry script, hence a context.

The library's own `wired_package.gd` registers its default category, the
built-in spawner tool **and its hand-weapon component**, the Q panel component
and the tool manager component. A README in the package documents both the
prop and the custom-weapon registration patterns.

### 3. Q panel (local-only player component)

`examples/cura_registry/ui/registry_panel.tscn`, registered with
`{"order": 40, "authority": "local", "local_only": true}`.

- Root is a `CanvasLayer`; script extends `WiredPlayerComponent`. No
  `class_name`.
- In `_wired_ready`, register an InputMap action via
  `register_input_action("cura_panel", [InputEventKey with physical_keycode KEY_Q])`.
  No `project.godot` change; Q is package-local and qualified by package id.
- Build the list from `Global.get_package_registry().get_entries(...)` for
  `"cura.category"`, `"cura.prop"` and `"cura.tool"`; group by category id,
  sort by `order` then label; uncategorized entries go to a fallback group.
- Signals: `prop_selected(qualified_type: String)` and
  `tool_selected(qualified_tool: String)`.
- Opening the panel releases the pointer (`MOUSE_MODE_VISIBLE`); closing on
  Q/Escape/selection restores capture only if it was captured before. On web,
  track capture with a local flag as `cura_player` already does, because the
  browser can drop pointer lock without a reliable `Input.mouse_mode` value.
- Rebuild deferred on `Global.packages.package_applied`. Selection is stored
  as a qualified id; if its entry vanished after reload, clear it.

### 4. Hand weapons, `tool_manager` and equip flow

A tool is a **hand weapon**, not a special case. The abstraction is a player
component, so it already has a `player` link, authority, replication, state
hooks and both execution paths on every peer.

`examples/cura_registry/hand_weapon.gd` — base script, no `class_name`, extends
`WiredPlayerComponent`; a tool package declares
`extends "res://packages/cura_registry/hand_weapon.gd"` (rewritten at publish).
Subclass API:

- server: `wired_equip(ctx)`, `wired_unequip()`, `wired_primary(ctx)`,
  `wired_secondary(ctx)`, `wired_update(delta)`;
- every peer: `wired_visual_update(delta, is_local)` for the viewmodel,
  animation and effects; the base overrides `_wired_visual_process` and calls
  it, so subclasses never fight the hook;
- state: base delegates `_wired_save_state`/`_wired_load_state` to optional
  `wired_save_state()`/`wired_load_state()` overrides.

`tool_manager.tscn` is registered by `cura_registry` with
`{"order": 50, "authority": "server"}`. It owns:

- `active_tool: WiredPlayerComponent`, found among `player.components` by
  group `cura_hand_weapon` and matching `tool_id` (qualified id);
- `selected_prop: String`, the qualified prop type chosen in the panel;
- `register_action("use_tool", _on_use_tool)` on the server and
  `request_action("use_tool", ...)` from the same component's local instance.
  `_wired_unhandled_input` runs for the local player on **any** component
  (`wired_player_component.gd:75-80`), including a server-authority one, so no
  separate local input component is needed.

A third-party weapon package registers its scene itself:

```gdscript
Cura.register_tool(self, "gravity_gun", {"label": "Gravity Gun", "category": "tools"})
add_player_component("tools/gravity_gun.tscn", {"authority": "server", "order": 60})
```

The scene root extends `hand_weapon.gd`, declares `@export var tool_id: String`
and joins group `cura_hand_weapon`. Its `wired_equip()` instantiates its
viewmodel into the mount; its `wired_primary(ctx)` implements its own server
behavior using core services. Spawner is registered the same way by
`cura_registry` — the manager has no `if tool == spawner` branch.

Viewmodel mount: `cura_player`'s `arm_camera_container` SubViewport. The
manager finds the character via `player.components` group
`cura_player_character`; `character.gd` gains an exported `tool_mount: Node3D`,
`equip_viewmodel(scene)` / `clear_viewmodel()` and
`get_first_person_camera()`. `cura_player` thus needs no dependency on the
library's scripts, and any hand weapon can reuse the mount.

### 5. Left click and authoritative spawn

- Local side (`tool_manager._wired_unhandled_input`): the `cura_player`
  character never calls `set_input_as_handled()` on a click, so the manager sees
  the same event. Fire only when a tool is equipped, the panel is closed and
  `character.look_is_active(...)` is true. Debounce to **4 shots/sec**:
  `cura_player` already sends look snapshots at ~15/s plus occasional dash, so
  6 shots/s would exceed `WiredPlayer`'s 20 actions/sec budget and actions
  would be silently dropped. `character.gd` gains a public
  `is_look_captured()` wrapper over its private flag/web-mode check.
- Local camera raycast is used **only for preview**. Send
  `request_action("use_tool", {"tool": <qualified_tool_id>, "prop": <qualified_prop>, "hit": <position>})`.
- Server handler `use_tool` (registered by the manager with `register_action`,
  server only): verify `sender_peer == player.peer_id`; verify the tool via
  `find_entry("cura.tool", payload.tool)` and find its behavior among
  `player.components` (group `cura_hand_weapon`, matching `tool_id`); verify
  the prop via `find_entry("cura.prop", payload.prop)` plus
  `find_dynamic_entity(payload.prop)` with `authority == "server"` when the
  tool is a spawner. Reject otherwise. Ignore the client `hit` for authority.
- Server raycast origin: `player.get_anchor_position_3d() + Vector3(0, 1.6, 0)`
  (the `cura_player` body origin is at the feet). Direction comes from the
  `cura_player` character component's replicated yaw/pitch, read through the
  `cura_player_character` group on `player.components`; pitch is clamped and
  yaw wrapped by the existing look handler. Max distance 64 m. Collision mask
  is world + dynamic props (static geometry and spawned `WiredDynamicEntity`
  bodies, not player bodies on layer 0), so props can be placed on other props.
  Without `cura_player`, aiming is unavailable and the spawner is disabled —
  the panel itself still works. On a hit, build the trusted `ctx` and call
  `active_tool.wired_primary(ctx)`. The built-in spawner's implementation is
  `Global.dynamic_world.spawn_entity(payload.prop, {"position": hit.position + hit.normal * 0.05, "owner_player_id": player.peer_id})`.
  No hit → no use. The per-player action budget already caps floods; keep the
  local debounce for feel. Custom weapons supply their own `wired_primary`
  with the same validated `ctx` and no manager changes.

### 6. Hot reload and lifecycle

- Custom entries live in the core registry, so `clear_package`/`add_registration`
  rebuild them automatically when a package is applied or updated.
- Panel and tool manager rebuild/validate on `package_applied` via
  `call_deferred`: refresh category lists, drop a selection whose entry is
  gone, re-find the active hand weapon by qualified `tool_id` after
  `players_manager.rebuild_live_components()`, re-equip its viewmodel and
  re-resolve paths through fresh package contexts.
- Selection state (`selected_prop`, `selected_tool`) belongs to the
  server-authority tool manager and is written in
  `_wired_save_state`/`_wired_load_state`, so it survives component rebuilds
  and reconnect via the player's state round-trip. Each hand weapon's own
  state goes through its own component hooks. The local-only panel is
  ephemeral and rebuilds from that selection; it needs no state hooks.
- Dependencies are applied before dependents; if `cura_registry` itself is
  updated, dependent packages' entries remain until their own apply, but
  weapon components are registered by their own packages and carry their own
  base-script reference, so the new revision is picked up on their apply.
- Live spawned entities are owned by the dynamic world and survive package
  reload via its existing park/restore logic.

### 7. Example prop package

Add a minimal `examples/crate_prop_example` used to verify the full chain:
`wired_package.gd` with the `preload("res://packages/cura_registry/api.gd")`
call from the snippet above, and a RigidBody3D scene extending
`WiredDynamicEntity` with a box mesh/collision. It is a demo/fixture for
manual verification, not installed room content.

## Files

New:

- `packages/server/godot_project/examples/cura_registry/` (entry, `api.gd`,
  README, panel scene/script, `tool_manager.tscn`, `hand_weapon.gd`, spawner
  weapon scene + viewmodel)
- `packages/server/godot_project/examples/crate_prop_example/` (entry, crate
  scene, README)
- `docs/superpowers/specs/2026-11-27-cura-registry-design.md`

Modified:

- `_wired/_wired/scripts/global/wired_protocol.gd`
- `_wired/_wired/scripts/packages/wired_package_registration.gd`
- `_wired/_wired/scripts/global/package_registry.gd`
- `_wired/tests/` registry smoke test
- `examples/cura_player/player/character.gd` and
  `examples/cura_player/player/player_character.tscn` (viewmodel mount,
  camera/capture accessors)

## Calls made by the planner

- Generic `kind`/`id`/`options` slot instead of sandbox-named core kinds: the
  only core change, reusable for any future mode, keeps lifecycle semantics
  identical to existing descriptors.
- One library helper call registers both the dynamic type and its UI
  metadata: prevents the two lists from drifting apart.
- Category/tool/prop ids qualified as `<package_id>/<id>`: same namespace rule
  as actions and dynamic types, avoids collisions between packages.
- Server re-raycast instead of trusting the client hit: players cannot spawn
  through walls or at arbitrary positions; client raycast stays visual-only.
- Package-local Q action instead of editing `project.godot`: no shared engine
  config or export rebuild required.
- Hand weapon = player component extending a library base script, registered by
  its own package, with `tool_manager` holding only `active_tool`. This gives
  every tool a player link, replication, state and both server/client paths;
  toolgun is one instance of a general in-hand item abstraction. No script
  loading by path and no manager-side special cases.
- `_wired_unhandled_input` runs for the local player on a server-authority
  component, so one `tool_manager` handles both local input and server actions.
- `cura_player` gains only a viewmodel mount and capture/camera accessors, not
  a library dependency; group lookup over `player.components` keeps the
  examples loosely coupled.

## Open items for the builder

- Verify all new/edited GDScript parses in pinned Godot 4.8-beta2, and that
  core smoke tests still pass.
- Manual Game-tab check with `cura_registry`, `cura_player` and
  `crate_prop_example` published into one room: Q opens/closes the panel,
  pointer capture returns, selecting the crate equips the spawner viewmodel,
  LMB spawns a persistent crate on the floor, both in web and native runtime.
- Decide during planning whether to add an icon/texture import path for panel
  entries or keep text-only labels for the first version (default: text-only).
