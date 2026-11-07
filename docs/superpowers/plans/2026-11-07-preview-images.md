# Preview Images + Reusable Media Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional preview images for rooms and packages, editable in settings via a reusable upload component (file pick or clipboard paste), shown as a left thumbnail on cards when present.

**Architecture:** Authenticated `POST /media` stores images under `STORAGE_DIR/uploads` with hash filenames and returns `/media/<file>`; entities store that URL (or `null`) on save. Public `GET /media/:filename` serves bytes through `serveStaticAsset`. Frontend `ImageUploadField` uploads immediately and parents bind the URL on create/update.

**Tech Stack:** NestJS 11, TypeORM/`DB_SYNC`, Next.js 16, React 19, next-intl, Vitest, Jest, existing `apiClient.postFile`.

**Spec:** `docs/superpowers/specs/2026-11-07-preview-images-design.md`

## Global Constraints

- `DB_SYNC=1`: nullable columns only; no migration files.
- Upload ≠ bind: `POST /media` never writes Room/Package fields.
- Files live in `STORAGE_DIR/uploads` with `randomBytes(32).toString('hex')` + extension names; no GC of orphans.
- Accept `image/png`, `image/jpeg`, `image/webp` only; max **2 MiB**; verify magic bytes, not just `Content-Type`.
- Bind URLs must match `/media/<64-hex>.(png|jpg|webp)` only (no external URLs).
- Clear preview by sending JSON `previewImage: null` (omit leaves unchanged).
- UI strings in `frontend/messages/{en,ru}.json` via next-intl.
- Card `<img src>` uses `withApiPrefix(url)` so COEP pages load same-origin via `/api/*`.
- No avatar UI in this plan; API + component must stay entity-agnostic.
- Conventional Commits.

## Review Focus

1. Anonymous `POST /media` — 401; anonymous `GET /media/:file` — 200 when file exists.
2. Upload of non-image bytes with spoofed `Content-Type: image/png` — 400; nothing written under `uploads/`.
3. Bind of `https://evil.example/x.png` or `/media/../secrets` into room/package — 400.
4. Card with `previewImage: null` / missing — no empty image slot (text-only layout as today).
5. Workshop publish/fork/copy-to-room — `previewImage` string copied; file not duplicated on disk.

---

### Task 1: Shared preview + media types

**Files:**
- Modify: `packages/shared/src/api/types.ts`
- Create: `packages/shared/src/api/media.ts`
- Modify: `packages/shared/src/index.ts` — add `export * from "./api/media"`

**Interfaces:**
- Produces:
  - `previewImage: string | null` on `Room`, `ScriptingPackage`
  - `previewImage?: string | null` on `WorkshopPackageSummary`
  - `previewImage?: string | null` on `CreateRoomPayload`, `UpdateRoomPayload`, `UpdateScriptingPackagePayload`, `CreateScriptingPackagePayload`
  - `MediaUploadResponse = { url: string }`
  - `WIRED_MEDIA_URL_PATTERN = /^\/media\/[0-9a-f]{64}\.(png|jpg|webp)$/`
  - `isWiredMediaUrl(value: string): boolean`

- [ ] **Step 1: Add types and validator**

Add the fields above. `isWiredMediaUrl` returns true only for the pattern. Do not add avatar changes.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter server check-types`
Expected: PASS (shared resolves via tsconfig paths).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api/types.ts packages/shared/src/api/media.ts packages/shared/src/index.ts
git commit -m "feat(shared): add previewImage and media upload types"
```

---

### Task 2: Media storage + Nest `/media` API

**Files:**
- Create: `packages/server/src/media/media.constants.ts`
- Create: `packages/server/src/media/media-image.ts` (magic-byte detect → mime/ext)
- Create: `packages/server/src/media/media-storage.service.ts`
- Create: `packages/server/src/media/media.controller.ts`
- Create: `packages/server/src/media/media.module.ts`
- Create: `packages/server/src/media/media-image.spec.ts`
- Create: `packages/server/src/media/media.controller.spec.ts`
- Modify: `packages/server/src/app.module.ts` — import `MediaModule`

**Interfaces:**
- Consumes: `AppConfigService.storage.dir`, `serveStaticAsset`, `contentTypeFor`, `MediaUploadResponse`, `@Public()`
- Produces:
  - `MAX_MEDIA_FILE_SIZE = 2 * 1024 * 1024`
  - `detectImageKind(buffer: Buffer): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; ext: 'png' | 'jpg' | 'webp' } | null`
  - `MediaStorageService.saveImage(buffer: Buffer): Promise<{ url: string; filename: string }>` — writes `<storage.dir>/uploads/<64hex>.<ext>`, returns `url: `/media/${filename}``
  - `MediaStorageService.uploadsRoot: string`
  - `POST /media` (auth, multipart field `file`) → `MediaUploadResponse`
  - `GET /media/:filename` (`@Public()`) → stream via `serveStaticAsset(uploadsRoot, filename, req, res, { crossOriginIsolation: true })`

- [ ] **Step 1: Write failing unit tests for magic-byte detection**

In `media-image.spec.ts`:
- PNG / JPEG / WEBP fixtures (minimal valid headers) → correct `{ mime, ext }`
- empty buffer / random bytes / HTML masquerading as png → `null`

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm --filter server exec jest media-image --runInBand`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `detectImageKind` and constants**

Manual signature checks only (no new npm dependency). Map jpeg → `.jpg`.

- [ ] **Step 4: Write failing controller/storage tests**

`media.controller.spec.ts` (supertest style matching `scripting-packages.controller.spec.ts` / room DTO specs):
- authenticated POST with tiny PNG → 201/200 + body `{ url: matching WIRED_MEDIA_URL_PATTERN }` and file exists under temp uploads dir
- unauthenticated POST → 401
- oversized buffer (> 2 MiB) → 400
- wrong magic bytes → 400
- GET existing file → 200 + image content-type
- GET `../` / absolute-looking filename → 400 or 404 (must not escape uploads root)

- [ ] **Step 5: Run controller tests — expect FAIL**

Run: `pnpm --filter server exec jest media.controller --runInBand`
Expected: FAIL.

- [ ] **Step 6: Implement storage service, controller, module**

`FileInterceptor('file', { limits: { fileSize: MAX_MEDIA_FILE_SIZE } })` (same pattern as package revision upload; rely on multer memory `file.buffer`). Reject missing file / failed detect / unexpected mime. `mkdir` uploads dir on save. Register `MediaModule` in `AppModule`.

- [ ] **Step 7: Run media tests — expect PASS**

Run: `pnpm --filter server exec jest media --runInBand`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/media packages/server/src/app.module.ts
git commit -m "feat(server): add reusable /media image upload API"
```

---

### Task 3: Room and package `previewImage` bind

**Files:**
- Modify: `packages/server/src/database/entities/room.entity.ts`
- Modify: `packages/server/src/database/entities/scripting-package.entity.ts`
- Modify: `packages/server/src/rooms/dto/create-room.dto.ts`
- Modify: `packages/server/src/rooms/dto/update-room.dto.ts`
- Modify: `packages/server/src/rooms/rooms.service.ts`
- Modify: `packages/server/src/scripting-packages/dto/create-scripting-package.dto.ts`
- Modify: `packages/server/src/scripting-packages/dto/update-scripting-package.dto.ts`
- Create: `packages/server/src/media/is-wired-media-url.decorator.ts` (class-validator wrapper around `isWiredMediaUrl`)
- Modify: `packages/server/src/rooms/dto/create-room.dto.spec.ts` (and/or add update DTO spec)
- Modify: `packages/server/src/scripting-packages/dto/update-scripting-package.dto.spec.ts`
- Modify: `packages/server/src/rooms/rooms.service.spec.ts` as needed
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts` (`preparePackageUpdate` + `create` data path)

**Interfaces:**
- Consumes: `isWiredMediaUrl`
- Produces: nullable `previewImage` column (`varchar`, `nullable: true`, `default: null`) on both entities; DTO field `previewImage?: string | null` with `@IsOptional()` + custom `@IsWiredMediaUrl()` that allows `null` and validates strings

- [ ] **Step 1: Write failing DTO validation tests**

Assert via `createValidationPipe()`:
- `{ previewImage: '/media/' + 'a'.repeat(64) + '.png' }` accepted
- `{ previewImage: null }` accepted on update DTOs
- `{ previewImage: 'https://evil.example/x.png' }` rejected
- `{ previewImage: '/media/../x.png' }` rejected

- [ ] **Step 2: Run DTO specs — expect FAIL**

Run: `pnpm --filter server exec jest create-room.dto update-scripting-package.dto --runInBand`
Expected: FAIL on new cases.

- [ ] **Step 3: Add columns, decorator, DTO fields, service assigns**

Room `create`/`update` and package `preparePackageUpdate`: `if (dto.previewImage !== undefined) entity.previewImage = dto.previewImage`. Create-package DTO gets optional `previewImage` so workshop copy paths can pass it; frontend package-create UI stays without the field.

- [ ] **Step 4: Run DTO + relevant service tests — expect PASS**

Run: `pnpm --filter server exec jest create-room.dto update-scripting-package.dto rooms.service --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/database/entities packages/server/src/rooms packages/server/src/scripting-packages/dto packages/server/src/scripting-packages/scripting-packages.service.ts packages/server/src/media/is-wired-media-url.decorator.ts
git commit -m "feat(server): bind previewImage on rooms and packages"
```

---

### Task 4: Workshop summary + copy `previewImage`

**Files:**
- Modify: `packages/server/src/scripting-packages/workshop/package-workshop.service.ts`
- Modify: `packages/server/src/scripting-packages/workshop/package-workshop.service.spec.ts`
- Modify: `packages/server/src/scripting-packages/scripting-packages.service.ts` — `createGlobalRecord` input accepts optional `previewImage`

**Interfaces:**
- Consumes: entity `previewImage`, `WorkshopPackageSummary.previewImage`
- Produces: `WORKSHOP_SELECT` includes `p."previewImage"`; `toSummary` sets `previewImage: row.previewImage ?? null`; `publishToWorkshop` values / `createGlobalRecord` / `forkToWorkshop` create / `copyToRoom` create pass `previewImage: pkg.previewImage` / `source.previewImage`

- [ ] **Step 1: Write failing workshop tests**

- Listing/summary includes `previewImage` when column set
- `publishToWorkshop` creates global record with source `previewImage`
- `copyToRoom` / `forkToWorkshop` copy the string onto the new package

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter server exec jest package-workshop.service --runInBand`
Expected: FAIL on new assertions.

- [ ] **Step 3: Implement SQL + copy wiring**

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter server exec jest package-workshop.service --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scripting-packages/workshop packages/server/src/scripting-packages/scripting-packages.service.ts
git commit -m "feat(server): include previewImage in workshop listing and copies"
```

---

### Task 5: Frontend media client + `ImageUploadField`

**Files:**
- Create: `frontend/src/api/services/media.ts`
- Create: `frontend/src/api/services/media.test.ts`
- Create: `frontend/src/components/media/ImageUploadField.tsx`
- Create: `frontend/src/components/media/ImageUploadField.test.tsx`
- Create: `frontend/src/components/media/media-url.ts` — `mediaSrc(url: string) => withApiPrefix(url)`
- Modify: `frontend/messages/en.json`, `frontend/messages/ru.json` — add `Media` namespace (label, upload, paste, remove, uploading, errors.invalidType, errors.tooLarge, errors.uploadFailed)

**Interfaces:**
- Consumes: `apiClient.postFile`, `MediaUploadResponse`, `withApiPrefix`
- Produces:
  - `uploadMedia(file: File): Promise<MediaUploadResponse>` → `apiClient.postFile('media', file)`
  - `ImageUploadField({ value: string | null; onChange: (next: string | null) => void; disabled?: boolean })`

- [ ] **Step 1: Write failing tests**

`media.test.ts`: `uploadMedia` calls `postFile('media', file)` and returns `{ url }`.

`ImageUploadField.test.tsx`:
- with `value` set → renders `<img>` whose `src` is `withApiPrefix(value)`
- choosing a file triggers upload mock then `onChange(url)`
- paste of image file/blob triggers upload then `onChange`
- remove button calls `onChange(null)`
- without `value` → no `<img>` preview of a bound entity image (empty state OK for the editor itself)

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter frontend exec vitest run media ImageUploadField`
Expected: FAIL.

- [ ] **Step 3: Implement service, i18n, component**

UX: show current image when `value` set; file input; paste listener while focused/hovered; remove clears locally via `onChange(null)`; upload errors via toast or inline using `Media.errors.*`. Client-side pre-check MIME + size before POST (still rely on server).

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter frontend exec vitest run media ImageUploadField`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/services/media.ts frontend/src/api/services/media.test.ts frontend/src/components/media frontend/messages/en.json frontend/messages/ru.json
git commit -m "feat(frontend): add reusable media upload field"
```

---

### Task 6: Settings — room and package preview editors

**Files:**
- Modify: `frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/dialogs/PackageEditDialog.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/room-packages/model.ts` — `RoomPackageEntry.previewImage: string | null`; map from `pkg.previewImage`
- Modify: `frontend/src/app/room/[room_code]/_godot/room-packages/reducer.ts` — keep `previewImage` on metadata updates
- Modify: `frontend/messages/en.json`, `frontend/messages/ru.json` — `Rooms.preview`, `Packages.preview` labels
- Modify tests that construct rooms/packages/entries if types break (`PackagesTab.test.tsx`, `use-room-packages.test.tsx`, etc.)

**Interfaces:**
- Consumes: `ImageUploadField`, existing `createRoom` / `updateRoom` / `updatePackageMetadata`
- Produces: form state includes `previewImage: string | null`; save payloads include it (including explicit `null` when cleared)

- [ ] **Step 1: Wire RoomEditingPanel**

Extend zod/form (or parallel React state for nullable URL) with `previewImage`. Reset from `room.previewImage ?? null` on edit; `null` on create. Render `ImageUploadField`. Pass through create/update payloads.

- [ ] **Step 2: Wire PackageEditDialog + RoomPackageEntry**

Load `previewImage` from fetched package; include in `updatePackageMetadata` call. Do not add to package-create dialog.

- [ ] **Step 3: Fix broken frontend unit tests / typecheck**

Run: `pnpm check-types:frontend`
Expected: PASS.

Run: `pnpm --filter frontend exec vitest run PackagesTab use-room-packages RoomAccessSettingsDialog`
Expected: PASS (update fixtures with `previewImage: null` where needed).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx frontend/src/app/room/[room_code]/_godot/dialogs/PackageEditDialog.tsx frontend/src/app/room/[room_code]/_godot/room-packages frontend/messages/en.json frontend/messages/ru.json frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx frontend/src/app/room/[room_code]/_godot/use-room-packages.test.tsx
git commit -m "feat(frontend): edit room and package preview images in settings"
```

---

### Task 7: Left thumbnail on cards

**Files:**
- Create: `frontend/src/components/media/PreviewThumbnail.tsx` — `{ src: string; className?: string }` renders `img` with `src={mediaSrc(src)}`, fixed ~80×80 (`size-20`), `object-cover object-center`, `rounded-md`, `shrink-0`, `alt=""`
- Modify: `frontend/src/app/(browser)/_components/rooms/RoomCard.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx` (`PackageCard`)
- Modify: `frontend/src/components/packages/WorkshopBrowser.tsx` (`WorkshopPackageCard`)
- Create or modify: `frontend/src/app/(browser)/_components/rooms/RoomCard.test.tsx` (create if none)
- Modify: `frontend/src/components/packages/WorkshopBrowser.test.tsx`
- Modify: `frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx` as needed

**Interfaces:**
- Consumes: `previewImage` from `Room` / `RoomPackageEntry` / `WorkshopPackageSummary`, `PreviewThumbnail`
- Produces: when `previewImage` truthy, horizontal row with thumbnail left of existing text; when falsy, previous markup with no image slot

- [ ] **Step 1: Write failing card tests**

- With preview URL → thumbnail `img` present with `withApiPrefix` src
- Without preview → query for that img finds nothing; title/actions still render

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter frontend exec vitest run RoomCard WorkshopBrowser PackagesTab`
Expected: FAIL on new cases.

- [ ] **Step 3: Implement thumbnail + card layouts**

- [ ] **Step 4: Run frontend tests + typecheck — expect PASS**

Run: `pnpm --filter frontend exec vitest run RoomCard WorkshopBrowser PackagesTab ImageUploadField media`
Expected: PASS.

Run: `pnpm check-types:frontend && pnpm --filter server check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/media/PreviewThumbnail.tsx frontend/src/app/(browser)/_components/rooms/RoomCard.tsx frontend/src/app/room/[room_code]/_godot/PackagesTab.tsx frontend/src/components/packages/WorkshopBrowser.tsx frontend/src/app/(browser)/_components/rooms/RoomCard.test.tsx frontend/src/components/packages/WorkshopBrowser.test.tsx frontend/src/app/room/[room_code]/_godot/PackagesTab.test.tsx
git commit -m "feat(frontend): show preview thumbnails on room and package cards"
```

---
