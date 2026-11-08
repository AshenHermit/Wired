# Player Component State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and restore player component state by authenticated Wired account across disconnects, periodic saves, and Godot runtime shutdowns while allowing multiple simultaneous connections per account.

**Architecture:** Extend the signed game ticket to carry `account_id` and thread that identity from `GameRoomService` through `RoomRuntimeService` into the Godot handshake. Keep `player_id`/`peer_id` runtime-local, add account-based snapshot indexing in `PlayersManager`, and retain the existing room `state.json` writer as the durable store. Add a 30-second server-only periodic save guarded by the existing shutdown flag.

**Tech Stack:** NestJS 11/TypeScript/Jest, Godot 4.8-beta2/GDScript headless runtime smoke tests, existing HMAC ticket protocol, existing room `state.json` persistence.

**Spec:** `docs/superpowers/specs/2026-11-08-player-component-state-persistence-design.md`

## Global Constraints

- `account_id` must come only from the verified signed ticket; never trust an unsigned browser hello field.
- Ticket format v2 is required; old ticket formats do not need to verify after deployment.
- `player_id` remains a temporary network identity and must not be the restore key.
- Multiple simultaneous connections for one account are allowed; only the first may consume an existing snapshot, and later connections must not clone it.
- Same-account snapshot conflicts use last-write-wins.
- `GODOT_ROOM_STATE_SAVE_INTERVAL_MS` defaults to 30 seconds.
- Legacy `state.json` player records without `account_id` must not crash loading and must not be restored by account.
- Do not add a database table, migration, or new backend snapshot API.

## Review Focus

- A forged unsigned account ID must never restore another account's state — ticket verification test in Task 1.
- A second simultaneous connection must not duplicate the first player's inventory/position — PlayersManager test in Task 3.
- A disconnect must capture state before freeing the player node — disconnect test in Task 3.
- A periodic save must not race with final shutdown save — timer/shutdown tests in Task 4.
- Old state files and malformed account IDs must fail safely rather than crash runtime startup — compatibility tests in Tasks 2 and 3.

---

### Task 1: Versioned account-bound game tickets

**Files:**
- Modify: `packages/server/src/godot-game/game-room/game-ticket.service.ts`
- Modify: `packages/server/src/godot-game/game-room/game-room.service.ts`
- Modify: `packages/server/src/godot-game/runtime/room-runtime.service.ts`
- Modify: `packages/server/src/godot-game/runtime/room-runtime.types.ts` if the connection method needs the explicit account type
- Modify: `packages/server/godot_project/_wired/_wired/scripts/network/ticket.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/network/network.gd`
- Modify: `packages/server/src/godot-game/game-room/game-ticket.service.spec.ts`
- Modify/Create: Godot ticket/network smoke test covering v2 verification

**Interfaces:**
- Produce `GameTicketService.mint(roomId: string, accountId: number, ttlSec?: number): MintedGameTicket`.
- Produce `RoomRuntimeService.connectRoom(roomId: string, accountId: number): Promise<RoomConnection>`.
- Ticket v2 must sign and verify room, account ID, expiry, and nonce; verification returns `{ ok, accountId, nonce, exp }`.

- [ ] **Step 1: Add failing backend ticket tests** for account ID inclusion, signature sensitivity to account changes, and rejection of non-positive account IDs.
- [ ] **Step 2: Run `pnpm --filter server exec jest game-ticket.service.spec --runInBand` and verify the new tests fail.**
- [ ] **Step 3: Implement ticket v2** in the backend and `ticket.gd`, using a fixed unambiguous signed message and a v2 marker; reject malformed/non-positive account IDs on both sides.
- [ ] **Step 4: Thread `user.id` through `GameRoomService.connect` → `RoomRuntimeService.connectRoom` → `GameTicketService.mint`; keep the existing start/readiness ordering so no ticket is discarded.**
- [ ] **Step 5: Store verified `account_id` in Godot's authenticated peer record, include it in auth/spawn data, and never read it from the unsigned hello payload.**
- [ ] **Step 6: Run backend ticket and runtime service tests plus the Godot ticket smoke test; expected result is all PASS.**
- [ ] **Step 7: Commit with `feat: bind game tickets to player accounts`.**

### Task 2: Account identity in player/state contracts

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/wired_protocol.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/players/wired_player.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/players_manager.gd`
- Modify: `packages/server/godot_project/_wired/tests/players_manager_smoke.gd`
- Modify: `packages/server/godot_project/_wired/tests/state_persistence_smoke.gd`

**Interfaces:**
- Add `WiredProtocol.KEY_ACCOUNT_ID := "account_id"`.
- Extend `WiredPlayer.setup(..., account_id: int, ...)` and add `var account_id: int`.
- `WiredPlayer.save_state()` must include `account_id`; `load_state()` must not overwrite runtime identity.
- `PlayersManager` authentication/spawn records must carry account ID, while `_spawned` remains keyed by peer ID.

- [ ] **Step 1: Add failing Godot smoke assertions** that a player save contains account ID, loading preserves runtime identity, and records without account ID are ignored safely.
- [ ] **Step 2: Run the existing Godot smoke-test command used by the repository and verify the new assertions fail.**
- [ ] **Step 3: Add the protocol constant and thread account ID through authenticated records, `_spawn_data`, `build_player`, and `WiredPlayer.setup`.**
- [ ] **Step 4: Update `WiredPlayer.save_state` and compatibility loading; reject/skip invalid account IDs without throwing.**
- [ ] **Step 5: Run player/state smoke tests and verify PASS.**
- [ ] **Step 6: Commit with `feat: carry account identity through player state`.**

### Task 3: Disconnect snapshots and account-based restore

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/global/players_manager.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/players/wired_player.gd` as needed for identity/state helpers
- Modify: `packages/server/godot_project/_wired/tests/players_manager_smoke.gd`
- Modify: `packages/server/godot_project/_wired/tests/state_persistence_smoke.gd`

**Interfaces:**
- Maintain an account snapshot map keyed by positive account ID, separate from `_spawned: peer_id -> WiredPlayer`.
- Maintain an active-account count/set so a saved account snapshot is consumed only when no same-account connection is active.
- Disconnect handling must call a capture method before `queue_free()`/removing `_spawned`.
- Save/load methods must emit at most one persisted record per account and apply deterministic ordering.

- [ ] **Step 1: Add failing tests for disconnect-before-despawn capture, reconnect with a new `player_id`, duplicate same-account connection without cloning, and last-write-wins.**
- [ ] **Step 2: Run the targeted Godot smoke tests and verify failure.**
- [ ] **Step 3: Implement account snapshot storage and active-account bookkeeping; change `_on_peer_left`/`despawn_player` to capture state before removing the player.**
- [ ] **Step 4: Restore a snapshot on first account connection only; leave later simultaneous connections at defaults; ensure a later save replaces the account snapshot.**
- [ ] **Step 5: Make `save_state` combine active snapshots and disconnected snapshots by account without duplicate records; preserve dynamic-world persistence unchanged.**
- [ ] **Step 6: Run all relevant Godot smoke tests, including legacy state loading, and verify PASS.**
- [ ] **Step 7: Commit with `feat: persist player snapshots by account`.**

### Task 4: Configurable periodic save and shutdown coordination

**Files:**
- Modify: `packages/server/src/config/config.ts`
- Modify: `packages/server/src/config/config.interface.ts` (if needed through inferred `AppConfig` shape)
- Modify: `packages/server/src/godot-game/runtime/room-runtime.configuration.ts`
- Modify: `packages/server/src/godot-game/runtime/room-runtime.configuration.spec.ts`
- Modify: `packages/server/src/godot-game/runtime/room-runtime.configuration.ts` spawn arguments
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Modify: `packages/server/godot_project/_wired/tests/state_persistence_smoke.gd`

**Interfaces:**
- Add `godotRuntime.stateSaveIntervalMs`, sourced from `GODOT_ROOM_STATE_SAVE_INTERVAL_MS`, default `30_000`.
- Pass the interval to the Godot process through a dedicated `--state-save-interval-ms` argument.
- `main_scene.gd` starts a server-only timer after `_run_server`, calls `_save_state("periodic")`, and stops/ignores it once `_shutdown_in_progress` is true.

- [ ] **Step 1: Add failing config tests for the 30-second default, environment override, invalid interval rejection, and spawn argument forwarding.**
- [ ] **Step 2: Run `pnpm --filter server exec jest room-runtime.configuration.spec --runInBand` and verify failure.**
- [ ] **Step 3: Implement the config field, validation, and spawn argument.**
- [ ] **Step 4: Add a server-only Godot timer with one save per interval; guard both timer callback and `_save_state` against shutdown re-entry.**
- [ ] **Step 5: Add smoke assertions that periodic save writes `reason=periodic` and shutdown writes one final save without a timer race.**
- [ ] **Step 6: Run configuration tests and Godot persistence smoke tests; verify PASS.**
- [ ] **Step 7: Commit with `feat: periodically save room player state`.**

### Task 5: Full regression verification

**Files:**
- Modify: any existing tests whose mocks require the new `connectRoom(roomId, accountId)` signature.

- [ ] **Step 1: Run `pnpm --filter server check-types`.**
- [ ] **Step 2: Run `pnpm --filter server test`.**
- [ ] **Step 3: Run the repository's Godot headless smoke-test suite, including `players_manager_smoke.gd`, `state_persistence_smoke.gd`, and existing dynamic-world/player tests.**
- [ ] **Step 4: Inspect the diff for accidental ticket secret/account leakage to logs or browser-visible unsigned payloads.**
- [ ] **Step 5: Commit any required test-only compatibility fixes with a focused message.**
