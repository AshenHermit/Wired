# Hot-Reload Package Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the first package Emit from breaking player synchronization by making server-side hot reload wait for successful application by every active client before sending the authoritative post-Emit snapshot.

**Architecture:** Keep the existing one-time `packages_ready` gate for initial player spawning. Add a separate per-package/per-revision hot-reload barrier in `WiredNetwork`; the server records active peers when announcing a revision, clients acknowledge only after `sync_package()` has emitted `package_applied` and rebuilt live components, and a signal releases the barrier when all required peers succeed. `MainScene` sends a fresh world snapshot after release, while failed/stale reports remain pending and disconnected peers are removed.

**Tech Stack:** Godot 4 GDScript, `SceneTree` smoke tests, reliable RPCs, existing `WiredNetwork`/`MainScene` package-sync flow.

**Spec:** `docs/superpowers/specs/2026-11-08-hot-reload-package-barrier-design.md`

## Global Constraints

- Keep initial `packages_ready` as a one-time initial-spawn gate; do not reuse it for hot reload.
- Do not recreate player roots or change `MultiplayerSpawner` ownership.
- Do not add arbitrary sleeps or frame delays as synchronization.
- Failed or stale client reports must not release a newer revision barrier.
- Disconnected peers must not block a pending barrier.
- Preserve the stable game-root-name fix in `main_scene.gd`.
- Follow existing GDScript style and run tests with the locally available Godot executable; note the local 4.6.2 versus project target 4.8-beta2 distinction.

## Review Focus

- A revision announced with one active client must remain pending until that exact client reports success; test in `network_readiness_smoke.gd`.
- A failed report must not release the barrier and a later successful retry must release it; test in `network_readiness_smoke.gd`.
- A stale report for an older revision must not release the current revision; test in `network_readiness_smoke.gd`.
- A client disconnect during a pending barrier must release the remaining barrier state; test in `network_readiness_smoke.gd`.
- A revision announced with no active clients must complete without waiting; test the server-side release path in `network_readiness_smoke.gd` or a focused main-scene smoke test.

---

### Task 1: Add the hot-reload barrier state and protocol tests

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/network/network.gd`
- Test: `packages/server/godot_project/_wired/tests/network_readiness_smoke.gd`

**Interfaces:**
- Produces a separate hot-reload API on `WiredNetwork`: a signal for released revisions, server-side announcement tracking, and report validation keyed by `(package_id, revision)`.
- Does not change the existing `peer_packages_ready` signal or `is_peer_packages_ready()` contract.

- [ ] **Step 1: Write failing tests**

Add focused tests to `network_readiness_smoke.gd` for:

- announcing a revision with an authenticated peer leaves the revision pending;
- a matching successful report releases the revision exactly once;
- a failed report leaves it pending, then a matching successful retry releases it;
- a stale report does not release the current revision;
- disconnecting a pending peer removes it from the barrier and releases the revision if no peers remain;
- announcing a revision with no authenticated peers releases immediately.

Assert observable behavior through the new signal and public/query methods rather than private dictionary layout. Use the existing test setup patterns for manually populated `_players`, direct RPC-handler calls, and signal capture.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
& 'C:\Users\hermit\gamedev\Godot_v4.6.2-stable_win64.exe\godot.exe' --headless --path packages/server/godot_project/_wired --script res://tests/network_readiness_smoke.gd --quit-after 2
```

Expected: failure because the hot-reload barrier interface does not exist yet.

- [ ] **Step 3: Implement the minimal barrier state in `network.gd`**

Add a signal with an exact revision payload, for example `hot_reload_ready(package_id: int, revision: int)`, and private pending state keyed by package id. Implement exact server-side methods used by `MainScene`, including:

- `begin_hot_reload(package_id: int, revision: int)`: records the current revision and the authenticated peers that must acknowledge it; immediately emits readiness when the required set is empty;
- report handling in `cli_package_ready()`: retain initial readiness behavior, but also match successful/failed reports against the pending hot-reload revision and release only when every required peer has reported success;
- disconnect cleanup in `_on_peer_disconnected()`: remove the peer from pending barriers and release barriers whose remaining required set is empty;
- a small query/helper API if needed by tests and `MainScene` to determine whether a revision is pending.

Do not let an old report release a newer pending revision. Keep failure state pending so the existing client retry can report success later.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run the same Godot command. Expected: all network readiness checks pass, including the new barrier cases.

- [ ] **Step 5: Commit the isolated protocol change**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/network/network.gd packages/server/godot_project/_wired/tests/network_readiness_smoke.gd
git commit -m "feat: add hot-reload package barrier"
```

### Task 2: Connect server package announcements to the barrier

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Modify: `packages/server/godot_project/_wired/_wired/scripts/network/network.gd` if the task-1 interface needs a narrowly scoped server announcement adjustment
- Test: `packages/server/godot_project/_wired/tests/network_readiness_smoke.gd` or a focused main-scene smoke test

**Interfaces:**
- Consumes `WiredNetwork.begin_hot_reload(package_id, revision)` and `WiredNetwork.hot_reload_ready(package_id, revision)` from Task 1.
- Produces the server ordering: local package apply → revision announcement/barrier registration → client reports → barrier release → fresh snapshots.

- [ ] **Step 1: Write the failing ordering test**

Add a test that exercises the server-side announcement path with an already authenticated peer and records whether a world snapshot is sent before or after the hot-reload-ready signal. Assert that the revision is registered before the client can release it and that the post-Emit snapshot is not sent while the barrier is pending.

If the existing smoke harness cannot intercept the network RPC cleanly, add the smallest test seam already consistent with the codebase (a test subclass/stub for `send_world_snapshot`) rather than introducing production-only behavior.

- [ ] **Step 2: Run the test to verify RED**

Run the focused smoke test with the Godot command used in Task 1. Expected: the test observes the current premature snapshot/release behavior or fails because no barrier is connected.

- [ ] **Step 3: Implement the server integration**

In `MainScene`:

- connect `net.hot_reload_ready` during `_ready()`;
- in `_apply_package_revision()`, after local `sync_package()` succeeds, register the hot-reload barrier before or atomically with broadcasting the revision, then announce the revision;
- handle `hot_reload_ready(package_id, revision)` by sending a fresh snapshot to every authenticated/ready peer after the complete revision is applied;
- ensure the no-client case does not leave the server waiting;
- avoid calling the initial-spawn `_on_peer_packages_ready()` path for hot reload.

The exact ordering must ensure a client cannot report success before the server has created the corresponding pending entry. Preserve existing package revision broadcasts and dynamic-world restoration behavior, but do not send a hot-reload snapshot from the pre-barrier path.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run the focused smoke test and verify that the snapshot ordering assertions pass.

- [ ] **Step 5: Commit the server integration**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/tests/network_readiness_smoke.gd
git commit -m "feat: gate post-emit snapshots on client readiness"
```

### Task 3: Make the client acknowledgement occur after the complete local apply

**Files:**
- Modify: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Test: `packages/server/godot_project/_wired/tests/main_scene_swap_smoke.gd` or a new focused package-flow smoke test under `packages/server/godot_project/_wired/tests/`

**Interfaces:**
- Consumes the existing `PackagesManager.package_applied` callback and client operation queue.
- Produces a client report only after registry reload, game/static rebuild, and `players_manager.rebuild_live_components()` have completed for the announced revision.

- [ ] **Step 1: Write the failing client-order test**

Add a focused test for `_apply_client_package()`/the package operation flow that records callback order and asserts:

```text
package_applied
→ registered package application and live-player component rebuild
→ client package report
→ pending world snapshot retry
```

The test must also assert that a failed package apply reports failure and does not pretend that local component rebuild completed.

- [ ] **Step 2: Run the test to verify RED**

Run the focused Godot smoke test. Expected: the current direct `package_applied`/report flow exposes the missing explicit completion point or fails the ordering assertion.

- [ ] **Step 3: Implement the minimal completion signal/awaitable flow**

Ensure `_apply_client_package()` does not report success until `_apply_registered_package()` has synchronously completed the live component rebuild for that revision. If a signal/callback is needed, make it package/revision-specific and keep it inside the existing queued operation; do not add a timer. Keep `_retry_pending_world_snapshot()` after the report and preserve failed-download retry behavior.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run the same focused test and verify the recorded order.

- [ ] **Step 5: Commit the client ordering change**

```bash
git add packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/tests/
git commit -m "fix: acknowledge package hot reload after rebuild"
```

### Task 4: Run the complete relevant verification suite

**Files:**
- No intended production changes.

- [ ] **Step 1: Run all affected Godot smoke tests**

Run:

```bash
& 'C:\Users\hermit\gamedev\Godot_v4.6.2-stable_win64.exe\godot.exe' --headless --path packages/server/godot_project/_wired --script res://tests/network_readiness_smoke.gd --quit-after 2
& 'C:\Users\hermit\gamedev\Godot_v4.6.2-stable_win64.exe\godot.exe' --headless --path packages/server/godot_project/_wired --script res://tests/main_scene_swap_smoke.gd --quit-after 2
& 'C:\Users\hermit\gamedev\Godot_v4.6.2-stable_win64.exe\godot.exe' --headless --path packages/server/godot_project/_wired --script res://tests/players_manager_smoke.gd --quit-after 2
& 'C:\Users\hermit\gamedev\Godot_v4.6.2-stable_win64.exe' --headless --path packages/server/godot_project/_wired --script res://tests/late_join_smoke.gd --quit-after 2
```

Expected: each smoke test exits successfully. Existing intentional warning/error fixtures may print their known diagnostics; report any new failures separately.

- [ ] **Step 2: Run repository checks relevant to changed files**

Run:

```bash
git diff --check
pnpm --filter server check-types
```

If GDScript changes are not covered by the TypeScript check, state that explicitly and rely on the Godot smoke-test results for them.

- [ ] **Step 3: Inspect the final diff and runtime logs**

Confirm that:

- the first Emit now has `WIRED_PACKAGE_REVISION_ANNOUNCED`, client apply/report, barrier release, then snapshot;
- a failed report does not release the barrier;
- no `Node not found .../PlayerBody/Sync` appears in a real two-process/browser reproduction;
- the existing stable root-name change and unrelated user modifications remain intact.

- [ ] **Step 4: Commit verification-only adjustments if needed**

Only commit additional changes if a verification failure identifies a real defect; do not alter tests to hide failures.
