# Godot userdata volume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Godot `user://` (room package cache) across backend container recreate by pointing `XDG_DATA_HOME` at the existing `wired_storage` volume.

**Architecture:** Compose already mounts `wired_storage` at `/app/storage` and persists `state.json` under `GODOT_ROOM_STATE_DIR=/app/storage/godot_rooms`. Override the image default `XDG_DATA_HOME=/opt/godot-data` with `/app/storage/godot-data` on the `backend` service so Godot userdata lands on the same volume. `RoomRuntimeConfiguration.buildRuntimeEnv` already allowlists `XDG_DATA_HOME` into the child process; pin that with one unit test so a future allowlist trim cannot silently drop persistence.

**Tech Stack:** Docker Compose, NestJS/Jest for the env allowlist assertion, Godot 4.8-beta2 runtime (no GDScript changes).

**Spec:** `docs/superpowers/specs/2026-11-07-godot-userdata-volume-design.md`

## Global Constraints

- One volume only: reuse `wired_storage`; do not add a new named volume.
- Target path exactly: `XDG_DATA_HOME=/app/storage/godot-data`.
- Do not change Nest path defaults, Dockerfile bake of `/opt/godot-data` templates, or Godot save/load of `state.json`.
- No migration of existing `/opt/godot-data` contents.
- Conventional Commits; match file language (compose comments can be Russian like neighboring lines; AGENTS.md stays Russian where surrounding text is).

## Review Focus

- Compose env missing or overridden by empty `.env` → Godot falls back to image `/opt/godot-data` and userdata is lost again; expect literal `/app/storage/godot-data` on the running backend process.
- Allowlist regression removing `XDG_DATA_HOME` → parent has the var but Godot child does not; expect spawn `env.XDG_DATA_HOME` to equal `process.env.XDG_DATA_HOME`.
- Accidental mount of a new volume over `/opt/godot-data` while leaving compose `XDG_*` unset → split-brain; this plan must not introduce that mount.
- Assuming `state.json` was the only wipe → leave `GODOT_ROOM_STATE_DIR` untouched and still under `/app/storage`.
- Pre-creating `/app/storage/godot-data` as root-only → prefer letting Godot/`DirAccess` create the tree on a writable volume rather than a one-off mkdir in the image.

---

### Task 1: Persist `XDG_DATA_HOME` on `wired_storage`

**Files:**
- Modify: `docker-compose.yml` (`backend.environment`, near `STORAGE_DIR` / `GODOT_ROOM_STATE_DIR`)
- Modify: `AGENTS.md` (Deploy/Env note that Godot userdata lives under `/app/storage/godot-data` on `wired_storage`)
- Modify: `packages/server/src/godot-game/runtime/room-runtime.configuration.spec.ts`
- Spec already committed: `docs/superpowers/specs/2026-11-07-godot-userdata-volume-design.md`

**Interfaces:**
- Consumes: `RoomRuntimeConfiguration.createSpawnOptions(config, roomId, port)` → `RuntimeSpawnOptions.env`
- Produces: compose `XDG_DATA_HOME=/app/storage/godot-data`; unit test proving spawn env forwards that variable when set on the parent

- [ ] **Step 1: Write the failing test**

In `room-runtime.configuration.spec.ts`, add a test that temporarily sets `process.env.XDG_DATA_HOME` to a sentinel path (e.g. `/app/storage/godot-data`), calls `createSpawnOptions(config, 'room-1', 19101)`, asserts `options.env?.XDG_DATA_HOME` equals that sentinel, and restores the previous env in `finally`.

- [ ] **Step 2: Run test to verify it fails (or already passes)**

Run: `pnpm --filter server exec jest room-runtime.configuration.spec --runInBand`

Expected: if allowlist still contains `XDG_DATA_HOME`, the new test PASS already — keep it as a regression pin and proceed. If FAIL because the key is missing from spawn env, fix allowlist in `room-runtime.configuration.ts` before compose work (should already be present at line ~34).

- [ ] **Step 3: Set compose env and document**

In `docker-compose.yml` under `backend.environment`, after `GODOT_ROOM_STATE_DIR`, add a short comment that Godot `user://` must live on the storage volume, then:

`- XDG_DATA_HOME=/app/storage/godot-data`

In `AGENTS.md`, in the Deploy or Env bullet that mentions `wired_wired_storage` / `STORAGE_DIR`, add that compose also sets `XDG_DATA_HOME=/app/storage/godot-data` so room package userdata survives recreate (templates stay baked at image `/opt/godot-data` for build only).

Do not edit `backend.Dockerfile` `ENV XDG_DATA_HOME` (build-stage templates stay put).

- [ ] **Step 4: Re-run the unit test**

Run: `pnpm --filter server exec jest room-runtime.configuration.spec --runInBand`

Expected: PASS

- [ ] **Step 5: Static check of compose**

Run: `docker compose config`

Expected: rendered `backend` environment includes `XDG_DATA_HOME: /app/storage/godot-data` (or equivalent string form) and still has `GODOT_ROOM_STATE_DIR: /app/storage/godot_rooms`; volumes still only `wired_db` and `wired_storage`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml AGENTS.md packages/server/src/godot-game/runtime/room-runtime.configuration.spec.ts docs/superpowers/specs/2026-11-07-godot-userdata-volume-design.md docs/superpowers/plans/2026-11-07-godot-userdata-volume.md
git commit -m "$(cat <<'EOF'
fix(deploy): persist Godot userdata on wired_storage

EOF
)"
```

On Windows PowerShell, if heredoc is awkward, use an equivalent multi-line `git commit -m` that keeps the same subject.
