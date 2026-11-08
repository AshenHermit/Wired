# Room State Cleanup Design

## Intent
Add a section in the room settings dialog (RoomAccessSettingsDialog) with buttons to delete the current user's data from the room's server-side `state.json`. If the current user is the room owner, also show buttons to clear all users' data and to clear dynamic objects data. Each button opens a confirmation modal before performing the action.

## Goals
- Let a user remove their own player state from a room's `state.json`.
- Let the room owner remove all players' state and all dynamic-entity state.
- Reflect changes in the running runtime without restart when possible; otherwise persist to disk for next run.

## Non-goals
- Changing `state.json` schema.
- Deleting room packages or room metadata.

## Approach
Backend: add a runtime command path and HTTP endpoint `POST /rooms/:id/state/cleanup` with body `{ scope: 'self' | 'all-players' | 'dynamic' }`, authorized by room access (self for any member; all/dynamic owner-only). The endpoint forwards to the running room runtime via the existing runtime control channel; if runtime is stopped, edits `state.json` on disk directly (removing the relevant records) so the next start is clean.

Frontend: new section in RoomAccessSettingsDialog. Buttons:
- "Очистить мои данные" (always, for members)
- "Очистить данные всех пользователей" (owner only)
- "Очистить данные динамических объектов" (owner only)
Each opens a confirmation AlertDialog. On confirm, call the API and show toast result.

## Constraints
- Must not corrupt `state.json`; write atomically.
- Must respect account_id-based player records and legacy records.
- Owner detection via existing room owner field.

## Open questions
- Exact runtime command protocol (to be defined in plan).
