import { describe, expect, it, vi } from "vitest";
import {
  GODOT_EDITOR_FS_ROOT,
  clearGodotEditorStorage,
  godotEditorSessionRoot,
  isGodotEditorDatabase,
} from "./godot-editor-storage";

type FakeRequest = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
};

function createFactory(
  names: (string | undefined)[],
  options: { databases?: boolean; blocked?: string[] } = {},
) {
  const deleted: string[] = [];
  const factory = {
    databases:
      options.databases === false
        ? undefined
        : vi.fn(async () =>
            names.map((name) => ({ name, version: 1 })),
          ),
    deleteDatabase: vi.fn((name: string) => {
      deleted.push(name);
      const request: FakeRequest = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (options.blocked?.includes(name)) {
          request.onblocked?.();
        } else {
          request.onsuccess?.();
        }
      });
      return request;
    }),
  };
  return { factory: factory as unknown as IDBFactory, deleted };
}

describe("Godot editor storage cleanup", () => {
  it("recognises the editor file system databases", () => {
    expect(isGodotEditorDatabase(GODOT_EDITOR_FS_ROOT)).toBe(true);
    expect(isGodotEditorDatabase(`${GODOT_EDITOR_FS_ROOT}/room-7/session`)).toBe(
      true,
    );
    expect(isGodotEditorDatabase(`${GODOT_EDITOR_FS_ROOT}2`)).toBe(false);
    expect(isGodotEditorDatabase("other")).toBe(false);
  });

  it("scopes the persistent root per room and keeps one session per document", () => {
    const first = godotEditorSessionRoot(7);
    expect(first).toMatch(
      new RegExp(`^${GODOT_EDITOR_FS_ROOT}/room-7/[^/]+$`),
    );
    expect(godotEditorSessionRoot(7)).toBe(first);
    expect(godotEditorSessionRoot(8)).not.toBe(first);
  });

  it("deletes only the editor databases", async () => {
    const old = `${GODOT_EDITOR_FS_ROOT}/room-7/previous`;
    const { factory, deleted } = createFactory([
      GODOT_EDITOR_FS_ROOT,
      old,
      "unrelated-database",
      undefined,
    ]);

    await clearGodotEditorStorage(factory);

    expect(deleted.sort()).toEqual([GODOT_EDITOR_FS_ROOT, old].sort());
  });

  it("falls back to the editor root when databases() is unavailable", async () => {
    const { factory, deleted } = createFactory(
      [`${GODOT_EDITOR_FS_ROOT}/room-7/previous`],
      { databases: false },
    );

    await clearGodotEditorStorage(factory);

    expect(deleted).toEqual([GODOT_EDITOR_FS_ROOT]);
  });

  it("does not hang when a database is held open", async () => {
    const live = `${GODOT_EDITOR_FS_ROOT}/room-7/live`;
    const { factory } = createFactory([live], { blocked: [live] });

    await expect(clearGodotEditorStorage(factory)).resolves.toBeUndefined();
  });

  it("does nothing when IndexedDB is unavailable", async () => {
    await expect(clearGodotEditorStorage(undefined)).resolves.toBeUndefined();
  });

  it("clears storage once per document", async () => {
    vi.resetModules();
    const storage = await import("./godot-editor-storage");
    const { factory, deleted } = createFactory([
      `${GODOT_EDITOR_FS_ROOT}/room-7/previous`,
    ]);

    await storage.prepareGodotEditorStorage(factory);
    await storage.prepareGodotEditorStorage(factory);

    expect(deleted).toHaveLength(1);
  });
});
