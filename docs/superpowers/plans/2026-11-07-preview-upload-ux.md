# Preview Upload UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tall settings dialogs scroll inside the viewport, show a single Preview label, and turn `ImageUploadField` into a square clickable frame that opens a Paste/Upload/Remove menu.

**Architecture:** Shared animate-ui `DialogContent` gains max-height + overflow-y so every dialog scrolls. `ImageUploadField` drops its internal label, renders a square bordered `DropdownMenuTrigger` (image or empty icon), and moves Upload/Remove/Paste into the menu while keeping the same `uploadMedia` + `onChange(url|null)` contract. Parents keep their existing field labels.

**Tech Stack:** Next.js 16, React 19, next-intl, animate-ui DropdownMenu/Dialog, lucide-react, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-07-preview-upload-ux-design.md`

## Global Constraints

- Frontend-only; no media API, limit, or entity-bind changes.
- Props stay `ImageUploadFieldProps = { value: string | null; onChange: (next: string | null) => void; disabled?: boolean }`.
- Accept `image/png`, `image/jpeg`, `image/webp`; max **2 MiB** — same as today.
- Square frame (~`size-20`); empty state uses `ImageIcon` from `lucide-react`.
- One visible Preview label: parents keep `Rooms.preview` / `Packages.editDialog.preview`; component must not render `Media.label`.
- Menu items use `Media.paste` / `Media.upload` / `Media.remove`; Remove omitted when `value` is null.
- Keep focused-frame Ctrl/Cmd+V paste in addition to menu Paste.
- UI strings only via next-intl in `frontend/messages/{en,ru}.json`.
- Conventional Commits.

## Review Focus

1. Tall `PackageEditDialog` on a short viewport — dialog body scrolls; footer actions remain reachable via scroll (shared `DialogContent` scrolls as one unit).
2. Room + package settings — exactly one Preview label each (no `Media.label` + parent label).
3. Menu Paste when Clipboard API returns no image / permission denied — toast; `onChange` not called; prior `value` kept.
4. `disabled` or uploading — frame does not open the menu / file picker; spinner visible while uploading.
5. `value` null — no Remove item in the menu; empty icon visible inside the frame.

---

### Task 1: Shared DialogContent viewport overflow

**Files:**
- Modify: `frontend/src/components/animate-ui/components/radix/dialog.tsx` (`DialogContent` `className`)
- Create: `frontend/src/components/animate-ui/components/radix/dialog.test.tsx`

**Interfaces:**
- Consumes: existing `DialogContent` / `cn`
- Produces: `DialogContent` always includes max-height + `overflow-y-auto` so content taller than the viewport scrolls

- [ ] **Step 1: Write the failing test**

```tsx
import { renderWithIntl as render } from "@/test/render-with-intl";
import { Dialog, DialogContent } from "./dialog";

it("constrains DialogContent height and enables vertical overflow", () => {
  const { container } = render(
    <Dialog open>
      <DialogContent>body</DialogContent>
    </Dialog>,
  );
  const content = container.querySelector("[data-slot='dialog-content'], [role='dialog']")
    ?? container.querySelector(".overflow-y-auto");
  expect(content?.className ?? "").toMatch(/overflow-y-auto/);
  expect(content?.className ?? "").toMatch(/max-h-/);
});
```

If the primitive has no stable selector, assert against the element that receives the `cn(...)` classes in `DialogContent` (same node as today's `bg-background fixed ...` string).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend exec vitest run src/components/animate-ui/components/radix/dialog.test.tsx`
Expected: FAIL (no `overflow-y-auto` / `max-h-` yet)

- [ ] **Step 3: Add overflow classes to `DialogContent`**

In `dialog.tsx`, extend the existing `className={cn('bg-background fixed ...', className)}` with `max-h-[min(100vh-2rem,100dvh-2rem)] overflow-y-auto` (or equivalent that keeps the dialog inside the viewport). Do not change portal/overlay behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend exec vitest run src/components/animate-ui/components/radix/dialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/animate-ui/components/radix/dialog.tsx frontend/src/components/animate-ui/components/radix/dialog.test.tsx
git commit -m "fix(frontend): scroll tall dialogs inside the viewport"
```

---

### Task 2: Redesign `ImageUploadField` as frame + menu

**Files:**
- Modify: `frontend/src/components/media/ImageUploadField.tsx`
- Modify: `frontend/src/components/media/ImageUploadField.test.tsx`
- Modify: `frontend/messages/en.json` — under `Media.errors` add `clipboardFailed`
- Modify: `frontend/messages/ru.json` — same key

**Interfaces:**
- Consumes: `uploadMedia(file)`, `mediaSrc(value)`, animate-ui `DropdownMenu`/`DropdownMenuTrigger`/`DropdownMenuContent`/`DropdownMenuItem`, `Media.*` messages
- Produces: unchanged props; UI = square frame trigger + menu `{ paste, upload, remove? }`; still calls `onChange(url)` after upload and `onChange(null)` on remove

Exact new i18n values:
- en: `"clipboardFailed": "Could not read an image from the clipboard"`
- ru: `"clipboardFailed": "Не удалось прочитать изображение из буфера"`

- [ ] **Step 1: Rewrite failing tests for the new chrome**

Replace/extend `ImageUploadField.test.tsx` so it asserts:

1. `it("does not render the Media.label text")` — render with `value={null}`; `queryByText(/Preview image|Превью/i)` is null.
2. `it("renders an empty-state icon when value is null")` — no `img`; an svg (ImageIcon) is present inside the trigger.
3. `it("renders the current image through the API prefix")` — keep existing `src === withApiPrefix(URL)` assertion.
4. `it("uploads a chosen file via the Upload menu item")` — open menu (`getByRole('button')` on the frame), click Upload (`/upload|загрузить/i`), change the hidden file input, expect `uploadMedia` + `onChange(URL)`.
5. `it("uploads via the Paste menu item when the clipboard has an image")` — mock `navigator.clipboard.read` to resolve `[{ types: ['image/png'], getType: async () => new Blob([...], { type: 'image/png' }) }]`; click Paste; expect upload + `onChange`.
6. `it("toasts and keeps value when clipboard paste yields no image")` — mock clipboard read empty/throw; click Paste; `onChange` not called; toast path exercised (spy `toast.error` if the suite already patterns that, else assert `uploadMedia` not called).
7. `it("uploads a focused-frame Ctrl/Cmd+V paste")` — keep today's paste-on-root behavior.
8. `it("clears the value when Remove is chosen")` — with `value={URL}`, open menu, click Remove; `onChange(null)`. With `value={null}`, open menu; no Remove button.
9. No assertions that look for always-visible Upload/Remove buttons outside the menu.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter frontend exec vitest run src/components/media/ImageUploadField.test.tsx`
Expected: FAIL against the old button chrome / present label

- [ ] **Step 3: Implement frame + DropdownMenu**

In `ImageUploadField.tsx`:
- Remove the internal `{t("label")}` node.
- Render a square bordered trigger (`size-20`, `rounded-md`, `border`, `overflow-hidden`) as `DropdownMenuTrigger asChild` around a `<button type="button">`.
- Inside: `img` when `value`, else `<ImageIcon />`; overlay/replace with `Loader2Icon` while `uploading`.
- Menu: Paste → clipboard read → build `File` → existing `upload()`; Upload → `inputRef.current?.click()`; Remove only if `value` → `onChange(null)`.
- Keep hidden file input + `onPaste` on a focusable wrapper (the trigger button is fine).
- On clipboard failure / no image: `toast.error(t("errors.clipboardFailed"))`.
- Add the two i18n strings above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter frontend exec vitest run src/components/media/ImageUploadField.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/media/ImageUploadField.tsx frontend/src/components/media/ImageUploadField.test.tsx frontend/messages/en.json frontend/messages/ru.json
git commit -m "feat(frontend): make ImageUploadField a frame with action menu"
```

---

### Task 3: Confirm settings call sites stay single-label

**Files:**
- Modify only if needed: `frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx`
- Modify only if needed: `frontend/src/app/room/[room_code]/_godot/dialogs/PackageEditDialog.tsx`

**Interfaces:**
- Consumes: redesigned `ImageUploadField` from Task 2
- Produces: unchanged save payloads; each settings form still has exactly one Preview field label from the parent

- [ ] **Step 1: Verify call sites**

Confirm both still wrap `<ImageUploadField />` with a single parent label (`t("preview")` / `t("editDialog.preview")`) and have no extra Upload/Remove buttons. If anything duplicates chrome, delete the duplicate only — do not remove the parent label.

- [ ] **Step 2: Run focused + suite smoke**

Run: `pnpm --filter frontend exec vitest run src/components/media/ImageUploadField.test.tsx src/components/animate-ui/components/radix/dialog.test.tsx`
Expected: PASS

Run: `pnpm --filter frontend test`
Expected: PASS (full frontend suite)

- [ ] **Step 3: Commit only if call sites changed**

```bash
# skip commit when no file changes
git add frontend/src/app/(browser)/_components/rooms/RoomEditingPanel.tsx frontend/src/app/room/[room_code]/_godot/dialogs/PackageEditDialog.tsx
git commit -m "fix(frontend): keep a single preview label in settings dialogs"
```

---

## Self-review notes

- Spec goals (overflow, one label, frame+menu, paste/upload/remove, unchanged upload contract) map to Tasks 1–3.
- Builder calls pinned: `ImageIcon`, Remove omitted when empty, Ctrl/Cmd+V kept, `clipboardFailed` toast string.
- No server/shared work; proportion matches the short design.
