# Preview upload UX polish

**Date:** 2026-11-07  
**Status:** draft  
**Size:** small change  
**Branch:** `preview_pics`

## Intent

Make room/package settings usable on short viewports and turn the preview control into a single clickable frame that opens an action menu — the shape this reusable upload component should keep for later uses (e.g. avatar).

## Goals

- Settings (and other) modals that exceed the viewport scroll inside the dialog instead of overflowing the screen.
- The string "Preview image" / "Превью" appears once per field.
- `ImageUploadField` shows a bordered square frame: bound image, or an empty-state icon when unbound.
- Clicking the frame opens a menu with Paste (from clipboard), Upload, and Remove — no inline Upload/Remove buttons.
- Upload-on-pick / upload-on-paste / URL bind-on-save behavior from the preview-images design stays unchanged.

## Non-goals

- Avatar UI.
- Changing media API, size/type limits, or orphan cleanup.
- Redesigning room/package cards or `PreviewThumbnail`.
- Reworking dialog animation primitives beyond height/overflow on `DialogContent`.

## Anti-goals

- Leaving both the parent field label and the component's internal label visible.
- Keeping always-visible Upload/Remove chrome next to the frame.
- Fixing overflow only in one settings dialog while the shared shell still clips other tall dialogs.

## Constraints

- Frontend only: `ImageUploadField`, shared animate-ui `DialogContent`, room/package settings call sites, i18n, existing Vitest for the field.
- Reuse existing animate-ui `DropdownMenu`.
- Parent forms already own the field label (`Rooms.preview`, `Packages.editDialog.preview`); the component must stop rendering `Media.label`.
- `Media.paste` already exists in en/ru — wire it for the menu item.
- Clipboard read via a menu action may be denied by the browser; show the existing toast path / a clear failure, and keep Ctrl/Cmd+V on the focused frame as a backup (builder call).
- Empty frame uses a lucide-style icon already common in the UI (builder picks which).

## Approaches considered

1. **In-place `ImageUploadField` redesign + shared `DialogContent` scroll (chosen).** One component becomes the clickable frame + dropdown; parents keep their labels; `DialogContent` gains max-height + overflow so all dialogs benefit. Least surface area; matches "this is how the upload component looks."
2. **Split into frame + menu primitives composed by `ImageUploadField`.** Better for future size variants, more files for a polish pass.
3. **Frame + Popover with button row.** Same click target, heavier and less "menu" than requested.

**Picked:** (1), with a **square** frame (~current `size-20`) and **global** dialog overflow.

## Behavior

### Dialog overflow

Shared `DialogContent` (`frontend/src/components/animate-ui/components/radix/dialog.tsx`) adds something equivalent to `max-h-[min(100vh-2rem,100dvh-2rem)] overflow-y-auto` (exact classes left to the builder) so header/body/footer scroll together inside the viewport. No per-dialog special case for room/package settings.

### Single label

- Keep parent `<FieldLabel>` / `<Label>` at call sites.
- Remove the internal `{t("label")}` from `ImageUploadField`.
- Do not add a second label elsewhere.

### `ImageUploadField` chrome

- Square bordered button/trigger: shows `<img>` when `value` is set, otherwise an empty-state icon centered in the frame.
- Uploading state: spinner on/over the frame; trigger disabled while uploading / when `disabled`.
- Hidden `<input type="file">` unchanged for accept/type limits.
- Dropdown items:
  - **Paste** — read image from clipboard (Clipboard API); same validation + `uploadMedia` path as file pick.
  - **Upload** — opens the file picker.
  - **Remove** — `onChange(null)`; omit or disable when `value` is null (builder call: prefer omit).
- Props stay `{ value, onChange, disabled? }`.

### Call sites

`RoomEditingPanel` and `PackageEditDialog` keep the outer label + `<ImageUploadField />`; no Upload/Remove markup outside the component.

### Tests / i18n

Update `ImageUploadField.test.tsx` for menu-driven upload/remove/empty frame. Use `Media.paste` / existing upload/remove keys; no new product strings beyond any empty-state `aria-label` if needed (builder call).

## Left to the builder

- Exact Tailwind for dialog max-height/overflow and frame border/empty icon.
- Whether Remove is hidden vs disabled with no image.
- Whether focused-frame Ctrl/Cmd+V stays alongside menu Paste (recommended: yes).
- Toast copy if clipboard read fails (reuse `uploadFailed` or a small Media string if needed).
