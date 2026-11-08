# Hot-Reload Package Barrier Design

## Intent

Prevent the first package Emit from breaking player synchronization. A package revision must not be considered hot-reloaded on the server until every active client has applied the same revision and rebuilt its live player components, including `MultiplayerSynchronizer` nodes.

## Goals

- Add a server-side barrier for revisions announced after clients are already connected.
- Ensure each client applies the revision before the server sends the post-Emit world snapshot.
- Preserve the existing initial package-readiness gate and late-join behavior.
- Make the first Emit and subsequent Emits follow the same ordering.
- Add focused regression coverage for the barrier protocol.

## Non-goals

- Do not recreate player roots or change MultiplayerSpawner ownership.
- Do not alter package artifact/download behavior.
- Do not use arbitrary sleeps or frame delays as synchronization.
- Do not remove the stable game-root-name fix already in `main_scene.gd`.

## Constraints

- Godot RPCs are reliable but asynchronous; readiness must be tracked per peer and per revision.
- Existing `packages_ready` is a one-time initial-spawn gate and must remain one-time.
- Multiple package revisions may be announced while another revision is pending.
- A client may fail to apply a revision; that client must not release the barrier.
- Disconnected peers must be removed from the pending barrier.

## Approach

Use a separate hot-reload readiness state in `WiredNetwork`, distinct from initial `packages_ready`:

1. When the server applies and announces a revision, create/update a pending barrier entry containing the package revision and the authenticated peers that must acknowledge it.
2. Clients receive `package_revision`, download/apply the package, rebuild live components through the existing `package_applied` callback, and report success or failure.
3. The server records the report for that package/revision. A successful report only releases that peer's portion of the barrier.
4. Once all peers have reported success, emit a hot-reload-ready signal to `MainScene`.
5. `MainScene` sends a fresh world snapshot to all ready peers after the barrier releases. The snapshot is package-checked before player/dynamic state is applied.
6. Failed reports remain pending and are retried by the existing client retry flow; stale reports cannot release a newer revision.
7. Disconnect handling removes the peer from all pending barriers so a departed client cannot block the room.

The server should not depend on the existing initial `peer_packages_ready` signal for this behavior. Initial spawn remains gated by `packages_ready`; hot reload uses a separate per-revision acknowledgement path.

## Files likely affected

- `packages/server/godot_project/_wired/_wired/scripts/network/network.gd`: pending revision state, report validation, barrier release, disconnect cleanup, and a hot-reload-ready signal.
- `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`: connect to the barrier signal, defer post-Emit snapshot/restore work until release, and handle the no-client case.
- `packages/server/godot_project/_wired/tests/network_readiness_smoke.gd`: protocol tests for pending, success, failure, stale revision, and disconnect behavior.
- A focused main-scene/package-flow smoke test if the existing test harness can exercise the server/client ordering without a real network.

## Acceptance criteria

- After the first Emit with an already connected client, the server does not send the post-Emit snapshot until that client reports successful application of the announced revision.
- A client failure or stale report does not release the barrier.
- A disconnected client no longer blocks release.
- The same behavior works for a second Emit and for multiple active clients.
- Existing initial readiness, late-join, package sync, and scene swap tests remain green.
