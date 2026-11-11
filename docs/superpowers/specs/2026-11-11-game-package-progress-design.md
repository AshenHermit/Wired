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

## Non-goals

- Byte-accurate progress for the native runtime's package download. The browser
  does not perform that download; the runtime does. The Game tab shows the
  runtime's application state (pending / applied / failed).
- Replacing the existing full-screen connection/error overlay.
- Adding a WebSocket or polling protocol dedicated to package progress.

## Constraints

- No new network protocol. Reuse the existing editor-bridge event channel and the
  existing `GET /rooms/:id/game/packages` status poll.
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

The Game tab itself also feeds the same channel from its existing package-status
poll: each active package becomes a loading / complete / error event. This makes
the feature work for the runtime-applied packages the Game tab actually waits
for, not only for packages applied in the editor.

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
- Game-tab package states map to percent as follows: applied at the published
  revision → 100 / complete; failed → 0 / error with `runtime.error`; everything
  else → 0 / loading.
- The existing `GameTab` poll emits status events, so a late joiner sees the
  current state on the first poll.

## What is left to the builder

- Exact toast copy is in the message files; adjust wording there.
- If the runtime later exposes byte-level delivery progress, `percent` can carry
  it without changing the event shape or the UI.
