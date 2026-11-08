# Hot-Reload Game Root Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent package hot-reload from creating `Main/Game/Game`, preserving Godot multiplayer paths for player synchronizers.

**Architecture:** Normalize wrapper package scenes before `_swap_game_scene`. A direct `Game` child containing the configured world viewport becomes the runtime root; wrapper siblings such as package UI move under it. Existing non-wrapper scenes use the current swap path.

**Tech Stack:** Godot 4.8-beta2, GDScript smoke tests.

**Spec:** `docs/superpowers/specs/2026-11-08-hot-reload-game-root-design.md`

## Global Constraints

- Preserve `Main/Game/SubViewport/...` as the stable multiplayer path.
- Do not change player synchronization or spawn protocol.
- Reject name collisions instead of silently renaming nodes.
- Keep default Game fallback and service rebinding behavior.

## Review Focus

- Wrapper with `CustomMain/Game/SubViewport`: normalized without nested Game.
- Wrapper sibling UI: preserved after extraction.
- Existing direct `WiredGameScene`: behavior remains unchanged.
- Wrapper child-name collision: rejected safely.
- Invalid package scene: current root remains active.

### Task 1: Regression and normalization

**Files:**
- Modify: `packages/server/godot_project/_wired/tests/main_scene_swap_smoke.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`

- [x] Add a failing test for a wrapper scene and assert stable paths plus preserved UI.
- [x] Run the smoke test and observe failure caused by `Main/Game/Game`.
- [x] Implement `_normalize_game_scene_root(root: Node) -> Node` and call it before `_swap_game_scene`.
- [x] Run the smoke test and related smoke tests.

### Task 2: Documentation and final verification

**Files:**
- Create: `docs/superpowers/specs/2026-11-08-hot-reload-game-root-design.md`
- Create: this plan

- [x] Record the selected approach and constraints.
- [ ] Run `git diff --check` and inspect the final diff.
- [ ] Reproduce the two-client Emit flow when the running server has loaded the updated Godot project; verify no nested Game/missing Sync errors.
