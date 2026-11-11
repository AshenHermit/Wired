# Game Package Progress (Editor-Bridge Event Forwarding) Implementation Plan

> **For agentic workers:** REQUIRED SUB‑SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task‑by‑task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per‑package loading progress and errors in the Game tab via toast notifications, using the existing editor‑bridge channel to forward events.

**Architecture:**
- Extend the server‑side package‑stream response to include incremental byte counts and error flags.
- Augment the frontend editor‑bridge with an event emitter that forwards `packageProgress` and `packageError` events.
- Export a lightweight shared emitter module that the Game tab can import without pulling in editor‑only code.
- Add a React `GameProgressToast` component that listens to those events and renders a list of shadcn/ui `Toast` items, each with a `Progress` bar and optional error badge.

**Tech Stack:**
- NestJS (TypeScript) – server side.
- Next.js 16 (React 19, TypeScript) – client side.
- shadcn/ui components (`Toast`, `Progress`).
- `mitt` (tiny event emitter) for bridge‑to‑Game communication.
- Jest + React Testing Library for unit tests; Playwright for end‑to‑end UI test.

**Spec:** `docs/superpowers/specs/2026-11-11-game-package-progress-design.md`

## Global Constraints
- Must not introduce a new network protocol; use the existing editor‑bridge channel only.
- UI must be toast‑style, appear above the game iframe, auto‑dismiss after 5 s for successful packages, stay until manual dismissal for errors.
- No increase in bundle size for the Game tab beyond the shared emitter module (keep under 5 KB gzipped).

## Review Focus
1. **Late‑joiner UI** – If the Game tab opens after loading started, progress should reflect current state (cached in emitter).
2. **Error propagation** – Errors from script compilation must surface as red toasts; ensure no silent failures.
3. **Performance** – Emitting many small progress events should not cause UI jank; throttle updates if needed.
4. **Type safety** – Event payload types must be consistent between server, bridge, and UI.
5. **Internationalisation** – Toast messages should use the existing `next-intl` system (English/Russian).

---

### Task 1: Extend backend package‑stream payload

**Files:**
- Modify: `packages/server/src/godot-game/package-stream.service.ts` (add `loadedBytes`, `totalBytes`, `status` fields).
- Modify: DTOs in `packages/shared/src/api/types.ts` to include the new fields.

**Interfaces:**
- Consumes: Existing package metadata (`packageId`, `name`).
- Produces: `PackageProgressPayload { packageId: string; name: string; loadedBytes: number; totalBytes: number; status: 'loading' | 'complete' | 'error'; errorMessage?: string }`

- [ ] **Step 1:** Write a failing test that calls the stream service and expects the new fields to be present in the first emitted chunk.
- [ ] **Step 2:** Run the test to verify it fails (missing fields).
- [ ] **Step 3:** Implement the extended DTO and modify the streaming logic to calculate and attach `loadedBytes`/`totalBytes` and set `status`.
- [ ] **Step 4:** Run the test to verify it passes.
- [ ] **Step 5:** Commit the changes.

### Task 2: Add a lightweight event emitter to the editor‑bridge

**Files:**
- Create: `frontend/src/lib/editorBridgeEvents.ts` (exports a `mitt` emitter with typed events).
- Modify: `frontend/src/app/room/[room_code]/(godot)/editor-bridge.ts` to import the emitter and emit `packageProgress` / `packageError` after each chunk is written.

**Interfaces:**
- Consumes: Backend payload from Task 1.
- Produces: Emits `packageProgress` (`{packageId, name, percent: number, status, errorMessage?}`) and `packageError` (same shape with `status: 'error'`).

- [ ] **Step 1:** Write a failing test that imports the bridge, simulates a chunk, and asserts that the emitter does **not** yet have a listener (so no event).
- [ ] **Step 2:** Run the test to confirm failure.
- [ ] **Step 3:** Implement the emitter, add `emitPackageProgress` helper, hook it into the bridge’s file‑write callback.
- [ ] **Step 4:** Run the test to verify the event is emitted with correct payload.
- [ ] **Step 5:** Commit.

### Task 3: Export the emitter for consumption by the Game tab

**Files:**
- No new files; just ensure `editorBridgeEvents.ts` has a default export `bridgeEvents`.

**Interfaces:**
- Consumes: None (module is self‑contained).
- Produces: Public `bridgeEvents` object that other modules can `import { bridgeEvents } from '@/lib/editorBridgeEvents'`.

- [ ] **Step 1:** Write a test that imports `bridgeEvents` in an isolated module and verifies it has the expected `on`/`off` methods.
- [ ] **Step 2:** Run the test (should fail because the module does not export).
- [ ] **Step 3:** Export the emitter correctly.
- [ ] **Step 4:** Run the test to pass.
- [ ] **Step 5:** Commit.

### Task 4: Implement the `GameProgressToast` UI component

**Files:**
- Create: `frontend/src/app/room/[room_code]/(godot)/GameProgressToast.tsx`
- Modify: `frontend/src/app/room/[room_code]/(godot)/page.tsx` (or the Game tab component) to render `<GameProgressToast />` above the iframe.

**Interfaces:**
- Consumes: `bridgeEvents` from Task 3 (`bridgeEvents.on('packageProgress', handler)`).
- Produces: UI side‑effects only (no exported symbols needed).

- [ ] **Step 1:** Write a failing test using React Testing Library that renders the component, fires a mock `packageProgress` event, and expects a toast with a progress bar to appear.
- [ ] **Step 2:** Run the test (fails because component missing).
- [ ] **Step 3:** Implement the component: subscribe to `bridgeEvents` on mount, maintain local state map of package IDs → progress, render a list of `Toast` items (shadcn/ui) each containing `Progress` bar and, if `status === 'error'`, a red badge with `errorMessage`. Auto‑dismiss successful toasts after 5 s.
- [ ] **Step 4:** Run the test to verify toast appears and updates correctly.
- [ ] **Step 5:** Commit.

### Task 5: Add unit and end‑to‑end tests for the full flow

**Files:**
- Create: `frontend/src/app/room/[room_code]/(godot)/__tests__/GameProgressToast.integration.test.tsx` (React Testing Library) – simulates bridge events for multiple packages, checks list updates, error handling, auto‑dismiss.
- Create: `e2e/tests/game-progress-toast.spec.ts` (Playwright) – starts the dev server, opens a room, triggers a mock package‑stream via the backend (using a test‑only endpoint or by mocking the bridge), verifies toasts appear in the browser.

**Interfaces:**
- Consumes: All previous tasks’ public APIs.

- [ ] **Step 1:** Write a failing integration test that renders the Game tab with the real bridge emitter but does not emit any events; expect no toasts.
- [ ] **Step 2:** Run the test (fails because component not yet integrated).
- [ ] **Step 3:** Implement the test harness to emit a series of `packageProgress` events (including one with `status: 'error'`).
- [ ] **Step 4:** Run the test to verify correct UI behavior (progress bars, error toast, auto‑dismiss).
- [ ] **Step 5:** Write the Playwright e2e test skeleton and run it (fails because endpoint missing).
- [ ] **Step 6:** Add a temporary test‑only backend route (`GET /test/emit-package-progress`) that triggers the bridge events for the e2e run.
- [ ] **Step 7:** Run the Playwright test to ensure the browser shows the toasts.
- [ ] **Step 8:** Clean up the test‑only route (guard it behind `NODE_ENV === 'test'`).
- [ ] **Step 9:** Commit all test files.

---

## Self‑Review

1. **Spec coverage:** Every requirement from the design doc is addressed: per‑package progress, error display, toast UI, no extra network layer, caching for late joiners.
2. **Step scan:** Each step is a single, actionable change (write test, run, implement, run, commit). No step contains ambiguous “handle edge cases” without a test.
3. **Type consistency:** All payload types are defined once (`PackageProgressPayload`) and reused across server, bridge, and UI.
4. **Review focus:** The five focus items are each exercised by at least one test (late‑joiner state cached in emitter, error toast test, throttling can be added later if needed, type safety ensured by TypeScript, i18n strings are pulled via `useTranslations`).
5. **Proportion:** The plan is concise (5 tasks, ~25 steps) relative to the spec; no code bodies are written, only signatures and test outlines.

---

**Plan complete and saved to `docs/superpowers/plans/2026-11-11-game-package-progress-plan.md`.**

Please review the plan. Which execution approach would you prefer?

- **Subagent‑driven** – a fresh subagent will implement each task, a reviewer will check after every task, and we’ll get a clean, incremental history. This is safest because the tasks depend on one another’s interfaces.
- **Native** – I would implement everything in this session myself and then run a final review. Faster but less granular safety.

I recommend the **subagent‑driven** approach because the plan contains several inter‑dependent interface contracts (backend payload → bridge emitter → UI component) and a step‑by‑step review will catch mismatches early.
