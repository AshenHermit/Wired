# Game Tab Package Progress Design

**Date:** 2026-11-11
**Status:** Approved

## Intent

When a player opens the room's **Game** tab, they should see what is happening
with the room's packages: which packages are being loaded, how far each one has
got, which ones finished, and which ones failed. Today the tab only shows a
single overlay line such as "Applying the room packages (1/3)…", so a failure
or a slow package is hard to attribute.

The information must be visible in the frontend, above the Godot Web iframe,
without adding a new network protocol.

## Goals

- Show one toast per active package with its name and an individual progress bar.
- Update a package's toast in place as its state changes.
- Auto-dismiss successful packages after 5 seconds.
- Keep failed packages visible until the user dismisses them.
- Include the package failure text, including Godot script/compile errors reported
  by the runtime, in the error toast.
- Work for late joiners: the first poll already reports the current package state.
- Show the **Web client's own** download and apply progress in the Game tab. The
  server runtime applying a revision does not mean the browser has it yet.

## Non-goals

- Byte-accurate progress for the native runtime's package download. The Game tab
  reports the browser client's transfer, not the server runtime's.
- Replacing the existing full-screen connection/error overlay.
- Adding a WebSocket or polling protocol dedicated to package progress.

## Constraints

- No new network protocol. Reuse the existing editor-bridge event channel, the
  Web game bridge (`wired:game-event`), and the existing
  `GET /rooms/:id/game/packages` status poll.
- Toasts are rendered by the frontend, not inside the Godot iframe.
- UI strings live in `frontend/messages/{en,ru}.json` and are read through
  `next-intl`; no hardcoded user-facing text.
- The emitter module stays tiny (well under 5 KB gzipped).
- Use the existing Sonner `<Toaster />` mounted in the root layout rather than
  adding a second toast system.

## Approach

**Editor-bridge event forwarding.** The editor bridge already knows when package
revisions are written. A small typed `mitt` emitter in
`frontend/src/lib/editorBridgeEvents.ts` carries `packageProgress` and
`packageError` events. The Game tab subscribes to those events through
`GameProgressToast`, which renders Sonner toasts.

The Game tab itself also feeds the same channel from two sources:

1. Its existing package-status poll announces each active package once as
   `loading` (or `error` when the runtime failed), so the tab is never silent
   while the runtime starts.
2. The exported Godot Web client forwards byte-level `package_progress` events
   from `PackagesManager` over `wired:game-event` while it downloads and applies
   the room's packages. A `package_sync` event supplies the terminal state for
   hot reloads. The server runtime's `applied` state is deliberately **not**
   mapped to 100%: only the browser's own completion is.

### Alternatives considered

1. **Dedicated WebSocket channel** — rejected: a new protocol and connection for
   data the tab already polls.
2. **Frontend polling only** — rejected: would duplicate the existing poll and
   couple the UI directly to the API shape.
3. **Editor-bridge event forwarding** — chosen: one cheap shared channel, no new
   network surface, and the UI stays independent of the producer.

## Implementation decisions

- `PackageProgressPayload` is defined once in `packages/shared/src/api/types.ts`
  and reused by the frontend event type.
- `PackageProgressEvent` replaces raw byte counts with a whole `percent`.
- `GameProgressToast` uses stable Sonner ids (`package-progress-<id>`), so an
  update replaces that package's toast instead of stacking a new one.
- Success uses `toast.success` with `duration: 5000`. Loading and error toasts use
  `duration: Infinity`; errors show the runtime's error text in destructive
  styling.
- The progress bar is an accessible inline bar (`role="progressbar"`,
  `aria-valuenow`), not a new shadcn component.
- The `PackagesManager` emits `package_progress(package_id, name, revision,
  loaded_bytes, total_bytes, status, error)` from `_download_files` (throttled to
  ten updates per second per HTTP request) and from the apply boundary.
  `main_scene` forwards it over the Web bridge; `GameTab` turns it into the same
  `PackageProgressEvent` the editor bridge uses.
- `package_progress` `loading` carries the real downloaded percentage;
  `complete` is 100 and comes only after the client's registry/world rebuild.
  A package already on disk emits `complete` immediately.
- The `GameTab` poll announces loading only once per package and reports
  `runtime.error` for failures. It never promotes the server's `applied` state
  to 100%.

## What is left to the builder

- Exact toast copy is in the message files; adjust wording there.
- The Web client reports file-transfer bytes; a future transport that exposes
  per-chunk progress can feed the same `loaded_bytes` / `total_bytes` fields
  without changing the event shape or the UI.
