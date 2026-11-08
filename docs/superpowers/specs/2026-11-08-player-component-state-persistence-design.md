# Player Component State Persistence Design

## Intent

Persist package component state for players when a player disconnects, when a room runtime shuts down, and periodically while it is running. Restore the state when the same Wired account joins the room again.

The Godot runtime already owns the component state format and writes the room's `state.json`; this change extends that existing path instead of introducing a backend state API or database storage.

## Goals

- Associate a runtime player connection with the authenticated Wired account.
- Preserve component state on player disconnect.
- Persist all active player states on a periodic interval.
- Preserve the existing graceful runtime-shutdown save.
- Restore state by stable account identity across runtime restarts.
- Allow multiple simultaneous connections for one account.
- Define conflicts between simultaneous connections as last-write-wins.
- Keep the temporary network `player_id` separate from the persistent account identity.

## Non-goals

- Merging component state from multiple simultaneous connections.
- Preventing an account from opening multiple tabs/connections.
- Moving state into Postgres or adding a new persistence service.
- Persisting arbitrary client-only state that is not exposed through component save hooks.
- Changing the meaning of `player_id` in MultiplayerSpawner or network replication.

## Constraints

- `player_id` is allocated by the current Godot runtime and is not stable across runtime restarts.
- The backend authenticates the website user before minting the game ticket.
- The Godot runtime verifies the ticket using `WIRED_GAME_TICKET_SECRET`; the browser must not be trusted to provide an account ID.
- Ticket nonces are single-use and tickets are short-lived.
- The current state format is owned by `main_scene.gd`, `PlayersManager`, and `WiredPlayer`.
- Existing state files and runtime protocol behavior should remain loadable where practical.

## Chosen approach

Extend the existing signed game ticket with the authenticated account ID. The backend passes `user.id` to `GameTicketService.mint`; the ticket signature covers the room, account ID, expiry, and nonce. The Godot runtime verifies the signature and stores the resulting account ID in its authenticated peer record.

A player save record gains a persistent `account_id` field. The temporary `player_id` and `peer_id` remain in the record for runtime diagnostics and compatibility, but are not used as the restore key.

`PlayersManager` keeps account-based saved snapshots separately from active player nodes:

- On disconnect, capture the player's current `WiredPlayer.save_state()` under its account ID before despawning it.
- On periodic save and shutdown, capture every active player's state under its account ID.
- On a new connection, assign a fresh `player_id` as today, then restore the saved snapshot only if that account does not already have an active connection in this runtime.
- If the account already has an active connection, create the second player normally without cloning the existing snapshot.
- Every save of an account replaces its prior snapshot. Therefore the most recently captured snapshot wins.
- If connection A disconnects while connection B for the same account remains active, A is despawned and its state becomes the account snapshot; B continues independently. The next periodic or shutdown save of B replaces that snapshot.

The existing `state.json` file remains the durable room-level storage. The save operation should write all active players plus retained disconnected-account snapshots in the player records, with a clear account identity and no duplicate record for the same account in the persisted list. If multiple active connections for one account exist at save time, the deterministic last-captured record is persisted according to the chosen last-write-wins policy.

## Periodic saving

Add `GODOT_ROOM_STATE_SAVE_INTERVAL_MS` to the Godot runtime configuration with a default of 30 seconds. A server-only timer in `main_scene.gd` triggers `_save_state("periodic")`; the timer must be stopped or ignored during shutdown to prevent a save racing with the final shutdown save. Failed saves remain visible through the existing `WIRED_STATE_SAVE_FAILED` diagnostics.

The periodic save must not mutate gameplay state or despawn players. It only captures the current component snapshots and writes the existing state file.

## Ticket contract

Update all three sides consistently using ticket format v2; old ticket formats do not need to remain verifiable because tickets are short-lived:

1. Backend `GameTicketService` accepts an account ID and includes it in the signed ticket payload/string.
2. The Godot ticket verifier validates and returns the account ID.
3. Godot authentication stores the verified account ID in the peer/player record and passes it through `PlayersManager` into `WiredPlayer`.

Malformed, missing, zero, or negative account IDs must reject authentication. The account ID must come only from the verified ticket, never from an unsigned hello field.

Existing `state.json` files without `account_id` remain safely loadable as legacy records, but those records are ignored for account restoration and are replaced by the next authenticated save.

## State model

Conceptually each player record contains:

```json
{
  "account_id": 42,
  "player_id": 7,
  "peer_id": 3,
  "display_name": "Player",
  "anchor_position_2d": [0, 0],
  "anchor_position_3d": [0, 0, 0],
  "components": {}
}
```

`account_id` is the durable identity. `player_id` and `peer_id` are runtime-local metadata. Component state remains keyed by the existing stable component key `<package_id>:<relative_path>`.

## Testing

Add or update tests for:

- ticket minting and verification include the account ID in the authenticated, signed data;
- invalid or missing account IDs are rejected;
- a disconnected player's component state is captured before despawn;
- a reconnecting account receives its saved state with a new `player_id`;
- a second simultaneous connection for the same account does not clone the first connection's state;
- later saves implement last-write-wins;
- periodic saves write state and do not run after shutdown begins;
- shutdown still writes the final snapshot;
- legacy state records without an account ID do not crash loading;
- existing component and dynamic-world persistence behavior remains intact.

## Alternatives considered

### Backend snapshot API
The backend could ask each runtime for a state snapshot over a new control protocol. This adds another IPC contract and failure mode while the runtime already owns the authoritative state and file format, so it is rejected.

### Database persistence
Storing component state in Postgres would complicate serialization, package compatibility, migrations, and multi-runtime ownership. It is outside the current room-runtime design and is rejected for this scope.

### Unsigned account ID from the browser
This would allow a client to claim another account's saved state and is rejected. The account ID must be covered by the existing ticket signature.

## Implementation decisions

- The configuration name is `GODOT_ROOM_STATE_SAVE_INTERVAL_MS`, defaulting to 30 seconds.
- The ticket change is ticket format v2; old ticket formats do not need to verify after deployment.
- `account_id` is stored on authenticated peer records and on `WiredPlayer`, while `player_id` remains the runtime-local network identity.
- Account snapshots are indexed by `account_id`; an active account may have multiple player connections, but only the first connection may consume an existing saved snapshot. A later simultaneous connection starts without cloning it.
- If one of several same-account connections disconnects, its state becomes the account snapshot; subsequent captures use last-write-wins.
- Legacy player records without `account_id` are ignored for restoration but do not make state loading fail.
- Preserve deterministic record ordering when writing state to keep tests and diagnostics stable.
