# AGENTS.md

Wired is a browser-based Godot game platform: Next.js frontend + NestJS API/asset server + shared TypeScript contracts. The Godot editor runs entirely client-side as WASM; each room's game runs in a native Godot runtime spawned by the backend.

## Repo map

- `frontend/` — Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui (`components.json`, new-york style, animate-ui registry). `(browser)` group holds login/home; `room/[room_code]/(godot)/` holds the editor, Packages tab, Game tab, and the bridge/sync modules.
- `packages/server/` — NestJS 11 + TypeORM/Postgres, Swagger at `/api/docs`. Entrypoints: `src/main.ts`, `src/app.module.ts`. Modules: `auth`, `users`, `rooms`, `scripting-packages`, `godot-editor-provider`, `godot-game` (room runtime, tickets, package sync, WebSocket proxy, game export). `godot-game` is not a stub.
- `packages/shared/` — API types/payloads (`src/api/types.ts`) plus runtime constants (`GAME_ROOMS_TYPES`, …). `build` emits CommonJS `dist` because the server imports values at runtime; server/frontend tests and dev resolve it through tsconfig paths, so no build is needed to run tests or `start:dev`.
- `packages/server/godot_editor/`, `godot_runtime/`, `game_export/`, `storage/` are gitignored artifacts: `pnpm fetch:editor` / `fetch:runtime` / `fetch:templates` install the pinned official Godot **4.8-beta2** (versions, sizes and sha512 pinned in `packages/server/scripts/fetch-*.mjs`; runtime writes `godot_runtime/runtime.json`). `packages/server/godot_project/_wired/` is a committed asset: the shared base project for every room.
- `docs/superpowers/{specs,plans}/` — checked-in design docs. `.worktrees/` holds git worktrees (ignored).
- Deploy lives in `.github/workflows/deploy.yml` + `scripts/deploy-remote.sh`. No migrations (schema is `DB_SYNC`-driven), no root README.

## Architecture facts that bite

- **Godot-only.** `GAME_ROOMS_TYPES` must keep legacy `"ts-game"` because `DB_SYNC=1` and old rows exist; only `AVAILABLE_GAME_ROOMS_TYPES` (`["godot"]`) can be created. Don't narrow the entity enum or delete legacy `ts-game` handling without a DB plan.
- Room/package/user URLs use Hashids, not raw IDs (`frontend/src/utils/hash-utils.ts`; per-type salt = `HASH_ID_SECRET + type`). The salt is `NEXT_PUBLIC_HASHIDS_SALT`, falling back to `NEXT_PUBLIC_WEBSOCKET_URL`, then `wired-io-ids`. Changing it invalidates every existing `/room/<code>` link. Decode before calling the API.
- API calls are browser-only: `frontend/src/api/services/*` → `api-client/client-api.ts` axios with `NEXT_PUBLIC_BACKEND_URL` and `Authorization: Bearer` read from the `access_token` cookie (`AUTH_COOKIE_NAME`, deliberately not httpOnly). There is no server-side API client; don't add server fetches expecting the cookie to propagate.
- Server paths are resolved from **cwd** at config load (`src/config/config.ts`): editor assets, `godot_project`, `storage`, `game_export`. Run the server through pnpm from `packages/server`; launching `node packages/server/dist/...` from the repo root 404s assets and writes storage to the wrong place.
- COOP/COEP headers (`frontend/next.config.ts` and the editor/export controllers) are required by the WASM editor (SharedArrayBuffer). They are set on `/:path*`, not just `/room/*`, because client-side navigation does not reload the document. The `/api/*` rewrite proxies to `NEXT_PUBLIC_BACKEND_URL`; Godot asset URLs depend on it (`withApiPrefix`).
- Package file operations go through the editor bridge, **not** `rtenv.FS`: `godot-packages-fs.ts` → `editor-bridge.ts` (`window.__wiredEditorBridge.request`) → `addons/wired_bridge/plugin.gd` → `package_fs.gd`. The official 4.8-beta2 build does not export Emscripten `FS` and has no `rtenv`, so never reintroduce direct engine-FS access. Bridge timeouts/absence set `fsReady = false` and the panel keeps probing; writes use `Engine.copyToFS`, reads return base64 from `collect`.
- `GODOT_RUNTIME_PATH` must be a **4.8-beta2** editor executable matching `config/features` in `_wired/project.godot` (`"4.8"`). If unset, server and `export:game` use the runtime installed by `pnpm fetch:runtime`. Web export also needs the matching templates: `pnpm fetch:templates` installs `web_debug.zip`/`web_release.zip` into Godot's per-user template dir.
- UI auth is Google OAuth only; the backend also has email/password endpoints. The Google callback sets the cookie on `COMMON_DOMAIN`, then redirects to `SITE_HOST`.
- The room "Game" tab runs the client-side Godot Web export in a same-origin iframe. `POST /rooms/:id/game/connection` starts/reuses that room's native runtime and mints a single-use ticket (request a fresh one per attempt); `GET /rooms/:id/game/status` reads state without starting anything; `GET /rooms/:id/game/packages` reports how far runtime/clients have applied published revisions. All are browser-only and called through `/api/*`.
- Runtime package delivery signs short-lived read URLs with `WIRED_PACKAGE_READ_SECRET` (fallback `WIRED_GAME_TICKET_SECRET`) and `WIRED_PACKAGE_READ_TTL_SEC` (default 900s). Artifacts are built under `<PACKAGES_FILES_DIR>/<packageId>/runtime/v2/<roomId>/<revision>/<artifactKey>/`; only the newest three per `<package>/<room>/<revision>` are retained. Every dependency publish creates a new artifact key for each dependent, so storage grows with publishes, bounded by that retention window; stale directories are pruned after a successful build. Only `runtime/v2` is scanned: legacy `runtime/v1` trees are ignored and left orphaned, never migrated.
- Game WebSocket upgrades go through the backend at `/rooms/<id>/game/ws` and are proxied to the room's loopback runtime port; the browser never receives `19100-19199`. `GODOT_ROOM_PUBLIC_WS_BASE` must be `wss://api.<domain>/rooms/{room}/game/ws` in production (compose derives it from `COMMON_DOMAIN`), and `WIRED_GAME_TICKET_SECRET` must be set in the root `.env` for compose.
- The Web export is a **build artifact** (`packages/server/game_export/web` by default, `GODOT_GAME_EXPORT_DIR` overrides it, gitignored). Keep it **outside** `godot_project/_wired`: that directory is the shared base project and `GET /godot-project-info/wired` copies its files into the editor FS (skipping `build/`, `storage/`, `.godot/`). Run `pnpm export:game` before opening the Game tab locally; the backend serves it at `/game-export/*` with COOP/COEP. The Docker image bakes its own export, so a deployed image never needs a local one.

## Commands

```bash
pnpm install
pnpm fetch:editor                        # pinned 4.8-beta2 web editor (gitignored)
pnpm fetch:runtime                       # pinned 4.8-beta2 native runtime for this OS (gitignored)
pnpm fetch:templates                     # pinned 4.8-beta2 Web export templates (Godot user dir)
pnpm dev:server                          # Nest watch; needs the Postgres in packages/server/.env
pnpm --filter frontend dev -- -p 3001    # backend owns :3000; SITE_HOST expects :3001
pnpm check-types:frontend                # tsc --noEmit
pnpm --filter server check-types         # tsc --noEmit (tests also typecheck via ts-jest)
pnpm --filter server build               # nest build; prebuild builds @wired-io/shared
pnpm --filter frontend build             # next build --webpack
pnpm --filter frontend lint              # eslint, no auto-fix
pnpm --filter server lint                # eslint --fix
pnpm export:game                         # rebuild the Godot Web export
pnpm build                               # recursive: shared + server + frontend
```

- Server tests: `pnpm --filter server test` (Jest, `rootDir` `packages/server/src`, `*.spec.ts`). Currently 43 suites / 540 tests green; `room-runtime.integration` is skipped unless opted in.
- Single server spec: `pnpm --filter server exec jest create-room.dto.spec`.
- Opt-in real-Godot integration: `WIRED_GODOT_INTEGRATION=1 GODOT_RUNTIME_PATH=<godot-console.exe> pnpm --filter server exec jest room-runtime.integration --runInBand`.
- Fetch/export helper unit tests: `pnpm --filter server test:scripts` (node `--test`, `scripts/lib/*.test.mjs`; not run by CI).
- Frontend tests: `pnpm --filter frontend test` (Vitest + jsdom, co-located `src/**/*.test.{ts,tsx}`; 10 files / 160 tests). Single file: `pnpm --filter frontend exec vitest run GameTab`.
- `pnpm export:game` reads `packages/server/.env` for `GODOT_RUNTIME_PATH`/`GODOT_RUNTIME_PROJECT_PATH`; without an explicit path it uses the `fetch:runtime` install. It fails fast if the executable, templates or `project.godot` are missing.
- Root `pnpm dev` is not a full-stack command (`server` has `start:dev`, not `dev`). Use the two dev commands above.
- Next uses Webpack intentionally (`--webpack`); don't switch to Turbopack casually.

## Deploy

- `push` to `main` (or Actions → Deploy with an explicit ref) runs `verify` (install, `pnpm build:shared`, both test suites, frontend types) then `deploy`.
- `deploy` SSHs to the host and pipes `scripts/deploy-remote.sh` over stdin, so the server always executes the script from the deployed commit. The script is idempotent: installs Docker if missing, creates `shared-net`, clones/fetches into `DEPLOY_PATH` (default `/home/Wired`), strips CRLF from `.env`, validates required keys, then `compose build --pull`, `up -d --force-recreate --wait`, and `docker image prune -f` only — it never touches other containers or volumes.
- Secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `PROD_ENV`, optional `SSH_PORT`; variable `DEPLOY_PATH`. `PROD_ENV` is the full text of `.env.prod` (template `.env.prod.example`) and is written to `<DEPLOY_PATH>/.env` on every run, overwriting server-side edits.
- Backend image (Node 22) downloads editor + runtime + templates and runs `export:game` at build time, then copies `dist`, `godot_editor`, `godot_runtime`, `godot_project`, `game_export`; final `WORKDIR /app/packages/server`. `.dockerignore` excludes those artifacts, so builds always fetch inside the image (needs outbound GitHub access; cold build ≈1.4 GB).
- Compose: project name `wired` (fixed so volumes `wired_wired_db`/`wired_wired_storage` stay stable), its own `db` service, healthchecks, external `shared-net`, and `nginx/conf/default.conf.template` rendered with `COMMON_DOMAIN` via envsubst. Compose sets `XDG_DATA_HOME=/app/storage/godot-data` on `backend` so Godot `user://` (room package userdata) survives recreate on `wired_wired_storage`; export templates stay baked under image `/opt/godot-data` at build time only.

## Env

- Four gitignored env files, not one: root `.env` (local compose only), `.env.prod` (prod source of truth, pasted into the `PROD_ENV` secret), `packages/server/.env` (Nest dev and `export:game`, loaded from the package cwd), `frontend/.env.local` (Next). Changing a URL or port often means editing more than one. Never commit or echo their contents.
- Local root `.env` points `DB_HOST` at a **remote shared Postgres** with `DB_SYNC=1`; prod compose uses its own `db`. Either way, starting the server auto-mutates the schema — treat entity/DB changes as production-affecting.
- Runtime knobs (defaults in `src/config/config.ts`): `GODOT_RUNTIME_PATH`, `GODOT_RUNTIME_PROJECT_PATH`, `GODOT_EDITOR_PATH`, `GODOT_PROJECT_PATH`, `GODOT_GAME_EXPORT_DIR`, `GODOT_BAKE_PROJECT_PATH`, `GODOT_BAKE_TIMEOUT_MS`, `GODOT_BAKE_MAX_CONCURRENCY`, `GODOT_BAKE_CACHE_MAX_BYTES`, `STORAGE_DIR`, `PACKAGES_FILES_DIR`, `GODOT_ROOM_STATE_DIR`, `GODOT_ROOM_BIND`, `GODOT_ROOM_PORT_START/END`, `GODOT_ROOM_IDLE_TIMEOUT_MS`, `GODOT_ROOM_SHUTDOWN_GRACE_MS`, `GODOT_ROOM_START_TIMEOUT_MS`, `GODOT_ROOM_LOG_BUFFER_LINES`, `GODOT_ROOM_API_URL`, `GODOT_ROOM_PUBLIC_WS_BASE`, `GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM`, `GODOT_ROOM_WS_MAX_TOTAL`, `GODOT_GAME_TICKET_TTL_SEC`, `GODOT_GAME_TICKET_RATE_LIMIT`/`_RATE_WINDOW_MS`, `WIRED_GAME_TICKET_SECRET` (mandatory; never send it to the browser).
- `NEXT_PUBLIC_*` values are baked into the frontend bundle at image build time (compose build args) — changing them requires rebuilding the image; every deploy does.
- Node >= 22 is required (root `engines`, `glob` from `node:fs/promises`, `import.meta.dirname` in scripts); both images use `node:22-bookworm-slim`. pnpm is pinned by `packageManager` (`pnpm@10.12.1`) and enabled via corepack.
- Server build emits `packages/server/dist/server/src/main.js`; `start:prod` and the image `CMD` depend on that path.

## Conventions

- Conventional Commits (`feat:`, `refactor(server):`, `chore:`) are the norm.
- Server Prettier: single quotes, trailing commas. ESLint is type-aware; server `lint` auto-fixes, frontend `lint` does not.
- UI copy and docs are largely Russian; match the language and UTF-8 encoding of the file you edit.
- API contract changes belong in `packages/shared/src/api/types.ts` plus matching server DTOs/entities. There is no codegen.
- Frontend UI strings live in `frontend/messages/{en,ru}.json` and are read through next-intl (`useTranslations` / `getTranslations`). The locale is the `NEXT_LOCALE` cookie, default `en`; never hardcode user-facing text in components.
- Use the `typescript-lsp` MCP tools for TS/JS code navigation (`textDocument_documentSymbol`, `_hover`, `_definition`, `_references`, `workspace_symbol`) instead of guessing or grep-only searching; V2 has no built-in LSP, so this MCP server is the only source. Pass URIs as `file://C:/...` (two slashes) — three slashes resolve to `C:\C:\...` and fail. URIs returned by `definition`/`references` are malformed (backslashes plus a trailing slash); read their `line`/`character` and rebuild the URI before reusing it. The server exposes requests only, no diagnostics, so type errors still come from `pnpm check-types:frontend`, `pnpm --filter server check-types`, and lint.
