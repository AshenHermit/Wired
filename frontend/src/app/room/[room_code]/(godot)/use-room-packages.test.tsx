import {
  PackageManifest,
  PackageRevision,
  RoomPackagesStatus,
  ScriptingPackage,
  WorkshopPackageSummary,
} from "@wired-io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/utils/sha256";
import { EditorBridgeError, EditorBridgeOperationError } from "./editor-bridge";
import type { GodotEditorInstance } from "./GodotEditorInstance";

vi.mock("./godot-packages-fs", async () => {
  const actual =
    await vi.importActual<typeof import("./godot-packages-fs")>(
      "./godot-packages-fs",
    );
  return { ...actual, createPackageFileSystem: vi.fn() };
});

vi.mock("@/api/services/godot-game", () => ({
  getRoomPackages: vi.fn(),
}));

vi.mock("@/api/services/scripting-packages", () => ({
  createScriptingPackage: vi.fn(),
  checkPackageSlugAvailability: vi.fn(),
  createPackageRevision: vi.fn(),
  uploadRevisionFileAsUint8Array: vi.fn(),
  publishPackageRevision: vi.fn(),
  getPackageManifest: vi.fn(),
  getRevisionFile: vi.fn(),
  updateScriptingPackage: vi.fn(),
  deleteScriptingPackage: vi.fn(),
  copyWorkshopPackageToRoom: vi.fn(),
  publishPackageToWorkshop: vi.fn(),
  forkPackageToWorkshop: vi.fn(),
}));

import * as gameApi from "@/api/services/godot-game";
import * as packagesApi from "@/api/services/scripting-packages";
import {
  createPackageFileSystem,
  GodotFsError,
  type CollectedPackageFile,
  type PackageFileSystem,
} from "./godot-packages-fs";
import {
  LocalChangesError,
  NewerRevisionError,
  PackageDirectoryRenameError,
  SlugRenameDependentsError,
  WorkshopSlugTakenError,
  useRoomPackages,
} from "./use-room-packages";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PROJECT = "/root/Wired";
const HERO = "scripts/hero.gd";
const OTHER = "scripts/other.gd";

/**
 * In-memory stand-in for the bridge-backed package file system. The hook only
 * talks to this interface, so the panel tests never need a live editor: paths
 * stay package-relative and `snapshot`/`collectFiles` hash what `put` wrote.
 */
function createFakeFs() {
  const dirs = new Set<string>();
  const trees = new Map<string, Map<string, Uint8Array>>();
  const reads = { value: 0 };

  const tree = (slug: string): Map<string, Uint8Array> => {
    const existing = trees.get(slug);
    if (existing) return existing;
    const created = new Map<string, Uint8Array>();
    trees.set(slug, created);
    return created;
  };

  const exists = vi.fn(
    async (slug: string): Promise<boolean> => dirs.has(slug),
  );
  const createPackageDir = vi.fn(async (slug: string): Promise<void> => {
    dirs.add(slug);
    tree(slug);
  });
  const snapshot = vi.fn(
    async (slug: string): Promise<Record<string, string>> => {
      const hashes: Record<string, string> = {};
      for (const [filepath, contents] of tree(slug)) {
        reads.value += 1;
        hashes[filepath] = await sha256Hex(contents);
      }
      return hashes;
    },
  );
  const collectFiles = vi.fn(
    async (slug: string): Promise<CollectedPackageFile[]> => {
      const collected: CollectedPackageFile[] = [];
      for (const [filepath, contents] of tree(slug)) {
        collected.push({
          entry: {
            filepath,
            size: contents.byteLength,
            sha256: await sha256Hex(contents),
          },
          contents,
        });
      }
      return collected;
    },
  );
  const replaceContents = vi.fn(
    async (
      slug: string,
      contents: Map<string, Uint8Array>,
    ): Promise<{ written: string[]; deleted: string[] }> => {
      const previous = tree(slug);
      const deleted = [...previous.keys()].filter(
        (filepath) => !contents.has(filepath),
      );
      const written = [...contents.keys()];
      dirs.add(slug);
      trees.set(
        slug,
        new Map(
          [...contents].map(([filepath, data]) => [
            filepath,
            Uint8Array.from(data),
          ]),
        ),
      );
      return { written, deleted };
    },
  );
  const deletePackage = vi.fn(async (slug: string): Promise<void> => {
    dirs.delete(slug);
    trees.delete(slug);
  });
  const renamePackage = vi.fn(
    async (from: string, to: string): Promise<string[]> => {
      const contents = trees.get(from);
      if (!contents) return [];
      trees.set(to, new Map(contents));
      trees.delete(from);
      dirs.delete(from);
      dirs.add(to);
      return [];
    },
  );
  const sync = vi.fn(async (): Promise<void> => {});

  const files: PackageFileSystem = {
    exists,
    createPackageDir,
    snapshot,
    collectFiles,
    replaceContents,
    deletePackage,
    renamePackage,
    sync,
    packageDir: (slug: string) => `${PROJECT}/packages/${slug}`,
  };

  return {
    files,
    exists,
    createPackageDir,
    snapshot,
    collectFiles,
    replaceContents,
    deletePackage,
    renamePackage,
    sync,
    reads,
    put(slug: string, filepath: string, content: string) {
      dirs.add(slug);
      tree(slug).set(filepath, encoder.encode(content));
    },
    has(slug: string, filepath: string): boolean {
      return trees.get(slug)?.has(filepath) ?? false;
    },
    read(slug: string, filepath: string): string {
      const contents = trees.get(slug)?.get(filepath);
      if (!contents) throw new Error(`ENOENT: ${filepath}`);
      return decoder.decode(contents);
    },
  };
}

function makeEditor(): GodotEditorInstance {
  return {
    rootPath: "/root",
    projectInfo: { name: "Wired" },
    editor: { copyToFS: vi.fn() },
  } as unknown as GodotEditorInstance;
}

function bridgeWith(rescan?: () => void) {
  Object.assign(window, {
    __wiredEditorBridge: { request: vi.fn(), rescan },
  });
}

function roomPackage(
  id: number,
  name: string,
  slug = name.toLowerCase(),
): ScriptingPackage {
  return {
    id,
    slug,
    name,
    version: "0.1.0",
    description: "",
    tags: [],
    enabled: true,
    dependencies: [],
    scripts: [],
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
  };
}

const ONE_PACKAGE = [roomPackage(5, "Demo")];
const TWO_PACKAGES = [roomPackage(5, "Demo"), roomPackage(6, "Other")];

/** A record of the public workshop: a global package with a published revision. */
function workshopPackage(
  id: number,
  slug: string,
  authorId = 42,
): WorkshopPackageSummary {
  return {
    id,
    slug,
    name: "Workshop Demo",
    version: "1.0.0",
    description: "",
    tags: [],
    author: {
      id: authorId,
      email: "author@example.com",
      name: authorId === 42 ? "Автор" : "Чужой автор",
      service: "google",
      picture: "",
    },
    revision: 1,
    publishedAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
  };
}

async function manifestOf(
  content: string,
  revision = 2,
  packageId = 5,
  slug = packageId === 5 ? "demo" : "other",
): Promise<PackageManifest> {
  const data = encoder.encode(content);
  return {
    packageId,
    slug,
    name: packageId === 5 ? "Demo" : "Other",
    revision,
    files: [
      {
        filepath: HERO,
        size: data.byteLength,
        sha256: await sha256Hex(data),
      },
    ],
    totalSize: data.byteLength,
    publishedAt: "2026-10-30T10:00:00.000Z",
  };
}

function roomStatus(
  packages: {
    id: number;
    revision: number;
    enabled?: boolean;
    slug?: string;
  }[] = [{ id: 5, revision: 2 }],
): RoomPackagesStatus {
  return {
    roomId: 1,
    packages: packages.map(({ id, revision, enabled = true, slug }) => ({
      packageId: id,
      slug: slug ?? (id === 5 ? "demo" : id === 6 ? "other" : "new"),
      name: id === 5 ? "Demo" : "Other",
      enabled,
      revision,
      publishedAt: revision > 0 ? "2026-10-30T10:00:00.000Z" : null,
      state: "published",
      runtime: { state: "pending", revision, error: null, updatedAt: null },
      clients: [],
    })),
  };
}

/** An axios-shaped failure, the way the API client rethrows a backend 4xx. */
function apiError(status: number, data: unknown): Error {
  return Object.assign(new Error("Request failed"), {
    response: { status, data },
  });
}

function revision(
  packageId: number,
  revisionNumber: number,
  status: PackageRevision["status"] = "published",
): PackageRevision {
  return {
    packageId,
    revision: revisionNumber,
    status,
    files: [],
    createdAt: "2026-10-30T10:00:00.000Z",
    publishedAt: "2026-10-30T10:00:00.000Z",
  };
}

function mockPublishedFile(content = "extends Node") {
  vi.mocked(packagesApi.getRevisionFile).mockResolvedValue(
    encoder.encode(content).buffer,
  );
}

describe("useRoomPackages", () => {
  let fs: ReturnType<typeof createFakeFs>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__wiredEditorBridge;
    fs = createFakeFs();
    vi.mocked(createPackageFileSystem).mockReturnValue(fs.files);
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus());
    vi.mocked(packagesApi.createScriptingPackage).mockResolvedValue(
      roomPackage(7, "New"),
    );
    vi.mocked(packagesApi.checkPackageSlugAvailability).mockResolvedValue({
      slug: "new",
      available: true,
      global: { available: true },
    });
    vi.mocked(packagesApi.createPackageRevision).mockResolvedValue(
      revision(5, 3, "draft"),
    );
    vi.mocked(packagesApi.uploadRevisionFileAsUint8Array).mockImplementation(
      async (_id, _revision, entry) => ({
        size: entry.size,
        sha256: entry.sha256,
      }),
    );
    vi.mocked(packagesApi.publishPackageRevision).mockResolvedValue(
      revision(5, 3),
    );
    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue(
      roomPackage(5, "Demo"),
    );
    vi.mocked(packagesApi.deleteScriptingPackage).mockResolvedValue(undefined);
    vi.mocked(packagesApi.copyWorkshopPackageToRoom).mockResolvedValue(
      roomPackage(9, "Shop Demo", "shop_demo"),
    );
    vi.mocked(packagesApi.publishPackageToWorkshop).mockResolvedValue({
      mode: "updated",
      package: workshopPackage(100, "demo"),
    });
    vi.mocked(packagesApi.forkPackageToWorkshop).mockResolvedValue(
      roomPackage(11, "Demo", "demo_fork"),
    );
    mockPublishedFile();
  });

  /**
   * Mounts the hook with the bridge already registered and waits until the
   * package file system was connected and the first refresh settled.
   */
  async function startHook({
    editor = makeEditor(),
    packages = ONE_PACKAGE,
    rescan,
  }: {
    editor?: GodotEditorInstance;
    packages?: ScriptingPackage[];
    rescan?: () => void;
  } = {}) {
    bridgeWith(rescan);
    const hook = renderHook(() => useRoomPackages(1, packages));
    await act(async () => {
      hook.result.current.afterEditorStart(editor);
    });
    await waitFor(() => expect(hook.result.current.fsReady).toBe(true));
    await waitFor(() =>
      expect(vi.mocked(createPackageFileSystem)).toHaveBeenCalled(),
    );
    return hook;
  }

  it("does not mark the fs ready before the bridge appears", async () => {
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
      await act(async () => {
        hook.result.current.afterEditorStart(makeEditor());
      });

      expect(hook.result.current.fsReady).toBe(false);
      expect(createPackageFileSystem).not.toHaveBeenCalled();
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects when the bridge appears later", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      expect(result.current.fsReady).toBe(false);

      bridgeWith();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(result.current.fsReady).toBe(true);
      expect(createPackageFileSystem).toHaveBeenCalledWith({
        bridge: expect.objectContaining({ call: expect.any(Function) }),
        getEngine: expect.any(Function),
        projectRoot: PROJECT,
      });
      // Once on mount and once after the bridge connected.
      expect(gameApi.getRoomPackages).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the bridge wait on unmount", async () => {
    vi.useFakeTimers();
    try {
      // No bridge yet: the hook is inside the 120 s plugin wait.
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      // The polling chain is cancelled with the component instead of keeping
      // one timer alive for the rest of the timeout window.
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(gameApi.getRoomPackages).toHaveBeenCalledTimes(1);
      expect(createPackageFileSystem).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an error when the bridge never appears", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(result.current.error).toContain("Мост редактора не появился");
      expect(result.current.fsReady).toBe(false);
      expect(createPackageFileSystem).not.toHaveBeenCalled();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops readiness when a bridge call fails", async () => {
    const { result, unmount } = await startHook();
    fs.snapshot.mockRejectedValue(
      new EditorBridgeError("Мост редактора не ответил за 60000 мс"),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.fsReady).toBe(false);
    expect(result.current.error).toContain("Мост редактора недоступен");
    await expect(result.current.removePackage(5)).rejects.toThrow(
      /Редактор ещё не готов/,
    );
    unmount();
  });

  it("drops readiness when an action hits a transport error", async () => {
    const { result, unmount } = await startHook();
    fs.snapshot.mockRejectedValue(
      new EditorBridgeError("Мост редактора не ответил за 60000 мс"),
    );

    await act(async () => {
      await expect(
        result.current.downloadPackage(5),
      ).rejects.toBeInstanceOf(EditorBridgeError);
    });

    // The action's own catch must not bury the transport error that the guard
    // needs in order to drop readiness.
    expect(result.current.fsReady).toBe(false);
    expect(result.current.error).toContain("Мост редактора недоступен");
    unmount();
  });

  it("reconnects after a transport failure once the bridge answers again", async () => {
    vi.useFakeTimers();
    try {
      bridgeWith();
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.fsReady).toBe(true);

      fs.snapshot.mockRejectedValueOnce(
        new EditorBridgeError("Мост редактора не ответил за 60000 мс"),
      );
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.fsReady).toBe(false);
      expect(result.current.error).toContain("Мост редактора недоступен");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      // The 2 s loop probed the bridge with `sync` and only then declared the
      // file system ready again.
      expect(result.current.fsReady).toBe(true);
      expect(result.current.error).toBeNull();
      expect(createPackageFileSystem).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one reconnect loop and clears it on unmount", async () => {
    vi.useFakeTimers();
    try {
      bridgeWith();
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, TWO_PACKAGES),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.fsReady).toBe(true);

      const transport = new EditorBridgeError("Мост редактора недоступен");
      fs.snapshot.mockRejectedValue(transport);
      fs.sync.mockRejectedValue(transport);

      // Two actions fail in the same tick: the second loss must reuse the loop
      // the first one started instead of stacking another interval.
      await act(async () => {
        const first = result.current.downloadPackage(5);
        const second = result.current.downloadPackage(6);
        await expect(first).rejects.toBeInstanceOf(EditorBridgeError);
        await expect(second).rejects.toBeInstanceOf(EditorBridgeError);
      });
      expect(result.current.fsReady).toBe(false);

      const probes = fs.sync.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(fs.sync.mock.calls.length).toBe(probes + 1);

      unmount();
      const connections = vi.mocked(createPackageFileSystem).mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fs.sync.mock.calls.length).toBe(probes + 1);
      expect(createPackageFileSystem).toHaveBeenCalledTimes(connections);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a reconnect loop after unmount", async () => {
    vi.useFakeTimers();
    try {
      bridgeWith();
      fs.put("demo", HERO, "local draft");
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.fsReady).toBe(true);

      let rejectSnapshot: (error: unknown) => void = () => {};
      fs.snapshot.mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectSnapshot = reject;
        }),
      );
      const action = result.current.removePackage(5);
      await act(async () => {});
      const probes = fs.sync.mock.calls.length;
      const connections = vi.mocked(createPackageFileSystem).mock.calls.length;

      unmount();
      rejectSnapshot(
        new EditorBridgeError("Мост редактора не ответил за 60000 мс"),
      );
      await expect(action).rejects.toBeInstanceOf(EditorBridgeError);

      // Nothing was mounted to clear it, so a loop installed here would probe
      // forever. The drop after unmount must install nothing.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fs.sync.mock.calls.length).toBe(probes);
      expect(createPackageFileSystem).toHaveBeenCalledTimes(connections);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops readiness when a superseded load loses the bridge", async () => {
    const { result, unmount } = await startHook();
    let resolveFirst: (status: RoomPackagesStatus) => void = () => {};
    vi.mocked(gameApi.getRoomPackages).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    const stale = result.current.refresh();
    await act(async () => {
      await result.current.refresh();
    });
    fs.snapshot.mockRejectedValueOnce(
      new EditorBridgeError("Мост редактора не ответил за 60000 мс"),
    );

    await act(async () => {
      resolveFirst(roomStatus());
      await stale;
    });

    // The older load is stale for entry state, but a transport error is still
    // the truth about the bridge and must not be discarded.
    expect(result.current.fsReady).toBe(false);
    expect(result.current.error).toContain("Мост редактора недоступен");
    unmount();
  });

  it("does not mark the fs ready before the bridge answers a probe", async () => {
    vi.useFakeTimers();
    try {
      bridgeWith();
      fs.sync.mockRejectedValue(
        new EditorBridgeError("Мост редактора не ответил за 60000 мс"),
      );
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fs.sync).toHaveBeenCalledTimes(1);
      expect(result.current.fsReady).toBe(false);
      expect(result.current.error).toContain("Мост редактора недоступен");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries when the initial probe is rejected by the plugin", async () => {
    vi.useFakeTimers();
    try {
      bridgeWith();
      fs.sync.mockRejectedValueOnce(
        new EditorBridgeOperationError("sync не выполнен"),
      );
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // A rejected operation is not a transport loss: it is reported as a
      // package problem and readiness stays false…
      expect(result.current.fsReady).toBe(false);
      expect(result.current.error).toContain("Пакеты недоступны");
      expect(result.current.error).toContain("sync не выполнен");

      // …and the initial connect path keeps retrying, like a loop tick does.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(result.current.fsReady).toBe(true);
      expect(result.current.error).toBeNull();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps readiness when the plugin rejects a single operation", async () => {
    const { result, unmount } = await startHook();
    fs.put("demo", HERO, "local draft");
    fs.snapshot.mockRejectedValue(
      new EditorBridgeOperationError("staging не найден"),
    );

    await act(async () => {
      await expect(result.current.removePackage(5)).rejects.toThrow(
        /staging не найден/,
      );
    });

    // A rejected operation is not a dead bridge: the editor stays usable and
    // no reconnect loop is started.
    expect(result.current.fsReady).toBe(true);
    expect(result.current.actionFor(5).error).toContain(
      "Не удалось убрать пакет",
    );
    expect(createPackageFileSystem).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("awaits async exists", async () => {
    const { result, unmount } = await startHook();
    fs.exists.mockResolvedValue(false);

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() =>
      expect(
        result.current.entries.find((item) => item.packageId === 5)?.inEditor,
      ).toBe(false),
    );

    await act(async () => {
      await result.current.removePackage(5);
    });
    expect(fs.deletePackage).not.toHaveBeenCalled();

    await expect(result.current.adoptPackage(5)).rejects.toThrow(
      /каталог пакета не найден/,
    );
    unmount();
  });

  it("never writes packages into the editor on start", async () => {
    const { result, unmount } = await startHook();
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    expect(fs.has("demo", HERO)).toBe(false);
    expect(fs.createPackageDir).not.toHaveBeenCalled();
    expect(fs.replaceContents).not.toHaveBeenCalled();
    expect(packagesApi.getPackageManifest).not.toHaveBeenCalled();
    expect(packagesApi.getRevisionFile).not.toHaveBeenCalled();
    const entry = result.current.entries.find((item) => item.packageId === 5);
    expect(entry?.status).toBe("not-loaded");
    expect(entry?.publishedRevision).toBe(2);
    expect(entry?.loaded).toBe(false);
    expect(entry?.inEditor).toBe(false);
    expect(createPackageFileSystem).toHaveBeenCalledWith({
      bridge: expect.objectContaining({ call: expect.any(Function) }),
      getEngine: expect.any(Function),
      projectRoot: PROJECT,
    });
    unmount();
  });

  it("reads the live engine on every write", async () => {
    const editor = makeEditor();
    const { unmount } = await startHook({ editor });
    const options = vi.mocked(createPackageFileSystem).mock.calls[0][0];

    expect(options.getEngine()).toBe(editor.editor);

    // An engine restart replaces `editor.editor`; the getter must follow it
    // instead of capturing the instance the file system was built with.
    const restarted = {
      copyToFS: vi.fn(),
    } as unknown as typeof editor.editor;
    editor.editor = restarted;

    expect(options.getEngine()).toBe(restarted);
    unmount();
  });

  it("reports a reset editor as GodotFsError instead of TypeError", async () => {
    const editor = makeEditor();
    const { unmount } = await startHook({ editor });
    const options = vi.mocked(createPackageFileSystem).mock.calls[0][0];

    // The page restarted the engine and the hook lost the instance between
    // `prepareReplace` and the actual write.
    delete (editor as { editor?: unknown }).editor;

    expect(() => options.getEngine()).toThrow(GodotFsError);
    expect(() => options.getEngine()).not.toThrow(TypeError);
    unmount();
  });

  it("creates a new package as an empty directory and loads only it", async () => {
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus([]));
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.createPackage("New", 42, "0.1.0", "new");
    });

    expect(packagesApi.createScriptingPackage).toHaveBeenCalledWith({
      slug: "new",
      name: "New",
      version: "0.1.0",
      authorId: 42,
      roomId: 1,
    });
    expect(fs.createPackageDir).toHaveBeenCalledWith("new");
    expect(fs.has("new", HERO)).toBe(false);
    expect(fs.has("demo", HERO)).toBe(false);
    const entry = result.current.entries.find((item) => item.packageId === 7);
    expect(entry).toMatchObject({
      slug: "new",
      name: "New",
      status: "loaded",
      loaded: true,
      loadedRevision: 0,
      publishedRevision: null,
    });
    unmount();
  });

  it("checks slug availability through the API", async () => {
    vi.mocked(packagesApi.checkPackageSlugAvailability).mockResolvedValue({
      slug: "hero",
      available: false,
      reason: "taken",
      global: { available: false, reason: "taken" },
    });
    const { result, unmount } = await startHook();

    await expect(result.current.checkSlugAvailability("hero")).resolves.toEqual(
      {
        slug: "hero",
        available: false,
        reason: "taken",
        global: { available: false, reason: "taken" },
      },
    );
    expect(packagesApi.checkPackageSlugAvailability).toHaveBeenCalledWith(
      "hero",
      1,
      undefined,
    );
    unmount();
  });

  it("refuses to touch an editor directory when the package has no slug", async () => {
    const { result, unmount } = await startHook({
      packages: [roomPackage(5, "Demo", "")],
    });

    await expect(result.current.downloadPackage(5)).rejects.toThrow(
      /package_slug_missing:5/,
    );
    // No `str(id)` fallback: the invalid slug never reaches the editor.
    expect(fs.exists).not.toHaveBeenCalledWith("");
    expect(fs.snapshot).not.toHaveBeenCalledWith("");
    expect(fs.replaceContents).not.toHaveBeenCalled();
    unmount();
  });

  it("downloads a published revision and asks before overwriting local edits", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.downloadPackage(5);
    });

    expect(fs.read("demo", HERO)).toBe("extends Node");
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "loaded",
      loaded: true,
      loadedRevision: 2,
      localChanges: [],
    });

    fs.put("demo", HERO, "local edit");
    await act(async () => {
      await result.current.refresh();
    });
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "local-changes",
      localChanges: [HERO],
    });

    await expect(result.current.downloadPackage(5)).rejects.toBeInstanceOf(
      LocalChangesError,
    );
    expect(fs.read("demo", HERO)).toBe("local edit");

    await act(async () => {
      await result.current.downloadPackage(5, { force: true });
    });
    expect(fs.read("demo", HERO)).toBe("extends Node");
    unmount();
  });

  it("removes only the requested package directory", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockImplementation(
      async (id) => await manifestOf("extends Node", 2, id),
    );
    const { result, unmount } = await startHook({
      packages: TWO_PACKAGES,
    });
    fs.put("other", OTHER, "keep me");

    await act(async () => {
      await result.current.downloadPackage(5);
    });
    expect(fs.has("demo", HERO)).toBe(true);

    fs.put("demo", HERO, "local edit");
    await expect(result.current.removePackage(5)).rejects.toBeInstanceOf(
      LocalChangesError,
    );
    expect(fs.has("demo", HERO)).toBe(true);

    await act(async () => {
      await result.current.removePackage(5, { force: true });
    });

    expect(fs.has("demo", HERO)).toBe(false);
    expect(fs.has("other", OTHER)).toBe(true);
    expect(
      result.current.entries.find((item) => item.packageId === 5)?.status,
    ).toBe("not-loaded");
    unmount();
  });

  it("emits only a package loaded in this editor and takes a new baseline", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.downloadPackage(5);
    });

    fs.put("demo", HERO, "extends Node2D");
    await act(async () => {
      await result.current.emitPackage(5);
    });

    expect(packagesApi.createPackageRevision).toHaveBeenCalledWith(5, {
      files: [expect.objectContaining({ filepath: HERO })],
    });
    expect(packagesApi.uploadRevisionFileAsUint8Array).toHaveBeenCalledTimes(1);
    expect(packagesApi.publishPackageRevision).toHaveBeenCalledWith(5, 3);
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "loaded",
      loadedRevision: 3,
      localChanges: [],
    });

    await expect(result.current.emitPackage(99)).rejects.toThrow(
      /не загружен/,
    );
    unmount();
  });

  it("shows a new published revision without touching the editor files", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node", 2),
    );
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.downloadPackage(5);
    });
    const downloads = vi.mocked(packagesApi.getRevisionFile).mock.calls.length;

    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 5, revision: 3 }]),
    );
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node2D", 3),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "new-revision",
      publishedRevision: 3,
      loadedRevision: 2,
    });
    expect(fs.read("demo", HERO)).toBe("extends Node");
    expect(packagesApi.getRevisionFile).toHaveBeenCalledTimes(downloads);
    unmount();
  });

  it("keeps files left by a previous session and warns before replacing them", async () => {
    fs.put("demo", HERO, "stale draft");
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook();

    await waitFor(() => {
      expect(
        result.current.entries.find((item) => item.packageId === 5)?.status,
      ).toBe("local-changes");
    });

    await expect(result.current.downloadPackage(5)).rejects.toMatchObject({
      name: "LocalChangesError",
      files: [HERO],
    });
    expect(fs.read("demo", HERO)).toBe("stale draft");

    await act(async () => {
      await result.current.downloadPackage(5, { force: true });
    });
    expect(fs.read("demo", HERO)).toBe("extends Node");
    unmount();
  });

  it("adopts a leftover directory so its files can be emitted", async () => {
    fs.put("demo", HERO, "stale draft");
    const { result, unmount } = await startHook();

    await waitFor(() => {
      expect(
        result.current.entries.find((item) => item.packageId === 5)?.status,
      ).toBe("local-changes");
    });

    await act(async () => {
      await result.current.adoptPackage(5);
    });
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      loaded: true,
      loadedRevision: 0,
      localChanges: [],
      status: "new-revision",
    });

    await act(async () => {
      await result.current.emitPackage(5, { force: true });
    });
    expect(packagesApi.createPackageRevision).toHaveBeenCalledWith(5, {
      files: [expect.objectContaining({ filepath: HERO })],
    });
    expect(fs.read("demo", HERO)).toBe("stale draft");
    unmount();
  });

  it("asks before emitting over a newer published revision", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.downloadPackage(5);
    });

    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 5, revision: 3 }]),
    );
    await act(async () => {
      await result.current.refresh();
    });

    await expect(result.current.emitPackage(5)).rejects.toBeInstanceOf(
      NewerRevisionError,
    );
    expect(packagesApi.publishPackageRevision).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.emitPackage(5, { force: true });
    });
    expect(packagesApi.publishPackageRevision).toHaveBeenCalledWith(5, 3);
    unmount();
  });

  it("rejects overlapping actions on the same package", async () => {
    let resolveManifest: (manifest: PackageManifest) => void = () => {};
    vi.mocked(packagesApi.getPackageManifest).mockReturnValue(
      new Promise((resolve) => {
        resolveManifest = resolve;
      }),
    );
    const { result, unmount } = await startHook();

    const first = result.current.downloadPackage(5);
    await expect(result.current.downloadPackage(5)).rejects.toThrow(
      /уже выполняется/,
    );

    await act(async () => {
      resolveManifest(await manifestOf("extends Node"));
      await first;
    });
    unmount();
  });

  it("does not commit a superseded load into the package list", async () => {
    const { result, unmount } = await startHook();

    let resolveStale: (status: RoomPackagesStatus) => void = () => {};
    vi.mocked(gameApi.getRoomPackages).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    const stale = result.current.refresh();

    // The newer load wins and publishes package 6.
    vi.mocked(gameApi.getRoomPackages).mockResolvedValueOnce(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 6, revision: 4 },
      ]),
    );
    await act(async () => {
      await result.current.refresh();
    });

    // The stale response carries a package the newer one never saw.
    await act(async () => {
      resolveStale(
        roomStatus([
          { id: 5, revision: 2 },
          { id: 7, revision: 1 },
        ]),
      );
      await stale;
    });

    const ids = () => result.current.entries.map((item) => item.packageId);
    expect(ids()).toEqual([5, 6]);

    // The stale load must not have leaked into the package list either: a
    // later refresh still does not resurrect package 7.
    vi.mocked(gameApi.getRoomPackages).mockResolvedValueOnce(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 6, revision: 4 },
      ]),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(ids()).toEqual([5, 6]);
    unmount();
  });

  it("adds newly published room packages from the status endpoint", async () => {
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 6, revision: 4 },
      ]),
    );
    const { result, unmount } = await startHook();

    await waitFor(() =>
      expect(
        result.current.entries.find((item) => item.packageId === 6),
      ).toMatchObject({
        slug: "other",
        name: "Other",
        version: "",
        publishedRevision: 4,
        status: "not-loaded",
      }),
    );
    unmount();
  });

  it("asks Godot to rescan after package files change", async () => {
    const rescan = vi.fn();
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook({ rescan });

    await act(async () => {
      await result.current.createPackage("New", 42, "0.1.0", "new");
    });
    expect(rescan).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.downloadPackage(5);
    });
    expect(rescan).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.removePackage(5, { force: true });
    });
    expect(rescan).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("polls statuses without hashing editor files", async () => {
    vi.useFakeTimers();
    try {
      bridgeWith();
      const { result, unmount } = renderHook(() =>
        useRoomPackages(1, ONE_PACKAGE),
      );
      await act(async () => {
        result.current.afterEditorStart(makeEditor());
      });

      fs.reads.value = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_500);
      });

      expect(gameApi.getRoomPackages).toHaveBeenCalledTimes(3);
      expect(fs.reads.value).toBe(0);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("patches enabled and refreshes", async () => {
    const { result } = await startHook();
    const before = vi.mocked(gameApi.getRoomPackages).mock.calls.length;
    await act(async () => {
      await result.current.setPackageEnabled(5, false);
    });
    expect(packagesApi.updateScriptingPackage).toHaveBeenCalledWith(5, {
      enabled: false,
    });
    expect(vi.mocked(gameApi.getRoomPackages).mock.calls.length).toBe(
      before + 1,
    );
  });

  it("updates only metadata in the entry", async () => {
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus([]));
    vi.mocked(packagesApi.createScriptingPackage).mockResolvedValue(
      roomPackage(7, "Hero", "hero"),
    );
    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue({
      ...roomPackage(7, "Hero", "hero"),
      name: "Renamed",
      version: "1.2.3",
    });
    const { result, unmount } = await startHook({ packages: [] });

    await act(async () => {
      await result.current.createPackage("Hero", 42, "0.1.0", "hero");
    });
    await act(async () => {
      await result.current.updatePackageMetadata(7, { name: "Renamed" });
    });

    expect(packagesApi.updateScriptingPackage).toHaveBeenCalledWith(7, {
      name: "Renamed",
    });
    expect(result.current.entries[0]).toMatchObject({
      packageId: 7,
      slug: "hero",
      name: "Renamed",
      version: "1.2.3",
      status: "loaded",
      localChanges: [],
    });
    unmount();
  });

  it("keeps local changes and status when metadata changes", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.downloadPackage(5);
    });
    fs.put("demo", HERO, "local edit");
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entries[0].status).toBe("local-changes");

    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue({
      ...roomPackage(5, "Demo"),
      name: "Renamed",
      version: "1.2.3",
    });
    await act(async () => {
      await result.current.updatePackageMetadata(5, { version: "1.2.3" });
    });

    expect(result.current.entries[0]).toMatchObject({
      packageId: 5,
      slug: "demo",
      name: "Renamed",
      version: "1.2.3",
      status: "local-changes",
      localChanges: [HERO],
      loaded: true,
      loadedRevision: 2,
      publishedRevision: 2,
      enabled: true,
    });
    expect(fs.read("demo", HERO)).toBe("local edit");
    unmount();
  });

  it("reports a metadata failure on the package action", async () => {
    const { result, unmount } = await startHook();
    vi.mocked(packagesApi.updateScriptingPackage).mockRejectedValue(
      new Error("Request failed with status code 500"),
    );

    await act(async () => {
      await expect(
        result.current.updatePackageMetadata(5, { name: "Renamed" }),
      ).rejects.toThrow(/Не удалось изменить данные пакета/);
    });

    expect(result.current.actionFor(5).error).toContain(
      "Не удалось изменить данные пакета",
    );
    expect(result.current.entries[0]).toMatchObject({
      name: "Demo",
      version: "0.1.0",
    });

    // A successful retry clears the error left by the failed attempt.
    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue(
      roomPackage(5, "Renamed"),
    );
    await act(async () => {
      await result.current.updatePackageMetadata(5, { name: "Renamed" });
    });
    expect(result.current.actionFor(5).error).toBeNull();
    unmount();
  });

  it("trims metadata and rejects empty values before the API", async () => {
    const { result, unmount } = await startHook();

    await expect(
      result.current.updatePackageMetadata(5, { name: "   " }),
    ).rejects.toThrow("package_metadata_empty");
    await expect(
      result.current.updatePackageMetadata(5, { version: "" }),
    ).rejects.toThrow("package_metadata_empty");
    expect(packagesApi.updateScriptingPackage).not.toHaveBeenCalled();

    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue({
      ...roomPackage(5, "Demo"),
      name: "Trimmed",
    });
    await act(async () => {
      await result.current.updatePackageMetadata(5, { name: "  Trimmed  " });
    });
    expect(packagesApi.updateScriptingPackage).toHaveBeenCalledWith(5, {
      name: "Trimmed",
    });
    unmount();
  });

  it("renames the editor directory after a slug change and refreshes", async () => {
    const rescan = vi.fn();
    const { result, unmount } = await startHook({ rescan });
    fs.put("demo", HERO, "extends Node");
    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue(
      roomPackage(5, "Demo", "demo_v2"),
    );
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 5, revision: 2, slug: "demo_v2" }]),
    );

    await act(async () => {
      await result.current.updatePackageMetadata(5, { slug: "demo_v2" });
    });

    expect(packagesApi.updateScriptingPackage).toHaveBeenCalledWith(5, {
      slug: "demo_v2",
    });
    expect(fs.renamePackage).toHaveBeenCalledWith("demo", "demo_v2");
    // The refresh that follows the rename already asks for the new directory.
    expect(fs.snapshot).toHaveBeenCalledWith("demo_v2");
    expect(rescan).toHaveBeenCalled();
    expect(result.current.entries[0].slug).toBe("demo_v2");
    unmount();
  });

  it("keeps the baseline so a renamed package does not show local changes", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.downloadPackage(5);
    });
    expect(result.current.entries[0]).toMatchObject({
      loaded: true,
      loadedRevision: 2,
      status: "loaded",
    });

    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue(
      roomPackage(5, "Demo", "demo_v2"),
    );
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 5, revision: 2, slug: "demo_v2" }]),
    );
    await act(async () => {
      await result.current.updatePackageMetadata(5, { slug: "demo_v2" });
    });

    expect(result.current.entries[0]).toMatchObject({
      packageId: 5,
      slug: "demo_v2",
      status: "loaded",
      localChanges: [],
      loaded: true,
      loadedRevision: 2,
      publishedRevision: 2,
    });
    expect(fs.read("demo_v2", HERO)).toBe("extends Node");
    unmount();
  });

  it("surfaces dependents so the dialog can confirm", async () => {
    const { result, unmount } = await startHook();
    vi.mocked(packagesApi.updateScriptingPackage).mockRejectedValue(
      apiError(409, {
        code: "slug_in_use_by_dependents",
        reason: "dependents",
        dependents: [{ packageId: 9, name: "Level" }],
      }),
    );

    await act(async () => {
      await expect(
        result.current.updatePackageMetadata(5, { slug: "demo_v2" }),
      ).rejects.toBeInstanceOf(SlugRenameDependentsError);
    });

    expect(result.current.actionFor(5).error).toBeNull();
    expect(fs.renamePackage).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps the server rename when the directory move fails and retries idempotently", async () => {
    const { result, unmount } = await startHook();
    fs.put("demo", HERO, "extends Node");
    vi.mocked(packagesApi.updateScriptingPackage).mockResolvedValue(
      roomPackage(5, "Demo", "demo_v2"),
    );
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 5, revision: 2, slug: "demo_v2" }]),
    );
    fs.renamePackage.mockRejectedValueOnce(new Error("bridge"));

    await act(async () => {
      await expect(
        result.current.updatePackageMetadata(5, { slug: "demo_v2" }),
      ).rejects.toBeInstanceOf(PackageDirectoryRenameError);
    });
    // The backend rename stands; only the editor directory is left behind.
    expect(packagesApi.updateScriptingPackage).toHaveBeenCalledTimes(1);
    expect(fs.has("demo", HERO)).toBe(true);

    await act(async () => {
      await result.current.renamePackageDir(5, "demo", "demo_v2");
    });
    expect(fs.renamePackage).toHaveBeenCalledTimes(2);
    expect(fs.has("demo_v2", HERO)).toBe(true);
    expect(fs.has("demo", HERO)).toBe(false);
    expect(result.current.actionFor(5).error).toBeNull();
    unmount();
  });

  it("refuses a slug whose folder already has files", async () => {
    const { result, unmount } = await startHook();
    fs.exists.mockResolvedValue(true);
    fs.snapshot.mockResolvedValue({ [HERO]: "hash" });

    await act(async () => {
      await expect(
        result.current.updatePackageMetadata(5, { slug: "hero2" }),
      ).rejects.toThrow("slug_dir_exists");
    });
    expect(packagesApi.updateScriptingPackage).not.toHaveBeenCalled();
    unmount();
  });

  it("deletes the package, its editor directory and the entry", async () => {
    const { result } = await startHook();
    fs.put("demo", HERO, "extends Node");

    await act(async () => {
      await result.current.deletePackage(5);
    });

    expect(packagesApi.deleteScriptingPackage).toHaveBeenCalledWith(5);
    expect(fs.deletePackage).toHaveBeenCalledWith("demo");
    expect(await fs.files.exists("demo")).toBe(false);
    // The refresh after the delete still sees the old status response; the
    // tombstone must keep the deleted package out of the panel.
    expect(
      result.current.entries.find((entry) => entry.packageId === 5),
    ).toBeUndefined();
  });

  it("does not resurrect a deleted package from the room prop", async () => {
    bridgeWith();
    const { result, rerender } = renderHook(
      ({ packages }: { packages: ScriptingPackage[] }) =>
        useRoomPackages(1, packages),
      { initialProps: { packages: ONE_PACKAGE } },
    );
    await act(async () => {
      result.current.afterEditorStart(makeEditor());
    });
    await waitFor(() => expect(result.current.fsReady).toBe(true));
    await act(async () => {
      await result.current.deletePackage(5);
    });

    // A stale room snapshot (a new array with the deleted package) arrives.
    rerender({ packages: [roomPackage(5, "Demo")] });

    expect(
      result.current.entries.find((entry) => entry.packageId === 5),
    ).toBeUndefined();
  });

  it("drops entries missing from the polling response", async () => {
    const { result } = await startHook({ packages: TWO_PACKAGES });
    vi.mocked(gameApi.getRoomPackages).mockResolvedValueOnce(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 6, revision: 2 },
      ]),
    );
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));

    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 6, revision: 2 }]),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.entries.map((entry) => entry.packageId)).toEqual([6]);
  });

  it("exposes disabled entries with a disabled status", async () => {
    const { result } = await startHook();

    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([{ id: 5, revision: 0, enabled: false }]),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.entries[0]).toMatchObject({
      enabled: false,
      status: "disabled",
    });
  });

  it("adds a workshop package, downloads it and refreshes", async () => {
    const { result, unmount } = await startHook();
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 9, revision: 1 },
      ]),
    );
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node", 1, 9, "shop_demo"),
    );
    const loads = vi.mocked(gameApi.getRoomPackages).mock.calls.length;

    await act(async () => {
      await result.current.addFromWorkshop(100);
    });

    expect(packagesApi.copyWorkshopPackageToRoom).toHaveBeenCalledWith(100, 1);
    // The copy is listed again and its published files land in the editor.
    expect(vi.mocked(gameApi.getRoomPackages).mock.calls.length).toBe(
      loads + 2,
    );
    expect(fs.read("shop_demo", HERO)).toBe("extends Node");
    expect(
      result.current.entries.find((item) => item.packageId === 9),
    ).toMatchObject({ slug: "shop_demo", name: "Shop Demo", loaded: true });
    expect(result.current.actionFor(9).notice).toBe("Пакет добавлен в комнату");
    unmount();
  });

  it("publishes to the workshop without touching the room package", async () => {
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.publishToWorkshop(5, { name: "Workshop Demo" });
    });

    expect(packagesApi.publishPackageToWorkshop).toHaveBeenCalledWith(5, {
      name: "Workshop Demo",
    });
    expect(result.current.actionFor(5).notice).toBe(
      "Публикация в workshop обновлена",
    );

    vi.mocked(packagesApi.publishPackageToWorkshop).mockResolvedValue({
      mode: "created",
      package: workshopPackage(100, "demo"),
    });
    await act(async () => {
      await result.current.publishToWorkshop(5);
    });
    expect(packagesApi.publishPackageToWorkshop).toHaveBeenLastCalledWith(
      5,
      {},
    );
    expect(result.current.actionFor(5).notice).toBe(
      "Пакет опубликован в workshop",
    );

    // Publication is metadata only: no editor directory, file or revision moves.
    expect(fs.createPackageDir).not.toHaveBeenCalled();
    expect(fs.replaceContents).not.toHaveBeenCalled();
    expect(packagesApi.createPackageRevision).not.toHaveBeenCalled();
    expect(result.current.entries[0]).toMatchObject({
      name: "Demo",
      version: "0.1.0",
    });
    unmount();
  });

  it("throws WorkshopSlugTakenError for a workshop slug of another author", async () => {
    const taken = workshopPackage(100, "demo", 7);
    vi.mocked(packagesApi.publishPackageToWorkshop).mockRejectedValue({
      response: {
        data: {
          code: "workshop_slug_taken",
          slug: "demo",
          workshopPackage: taken,
        },
      },
    });
    const { result, unmount } = await startHook();

    const failure = await result.current
      .publishToWorkshop(5)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkshopSlugTakenError);
    expect(failure).toMatchObject({
      slug: "demo",
      workshopPackage: taken,
    });
    unmount();
  });

  it("explains a workshop dependency that only exists in a room", async () => {
    vi.mocked(packagesApi.publishPackageToWorkshop).mockRejectedValue({
      response: {
        data: { message: "package_dependency_not_global:hero" },
      },
    });
    const { result, unmount } = await startHook();

    const failure = await act(async () =>
      result.current.publishToWorkshop(5).catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("#hero");
    expect((failure as Error).message).not.toContain("Request failed");
    expect(result.current.actionFor(5).error).toBe((failure as Error).message);
    unmount();
  });

  it("explains a workshop dependency missing from the workshop", async () => {
    vi.mocked(packagesApi.publishPackageToWorkshop).mockRejectedValue({
      response: {
        data: { message: "package_dependency_unknown_slug:missing" },
      },
    });
    const { result, unmount } = await startHook();

    const failure = await result.current
      .publishToWorkshop(5)
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("#missing");
    expect((failure as Error).message).toContain("workshop");
    unmount();
  });

  it("explains invalid workshop tags using the echoed tag", async () => {
    vi.mocked(packagesApi.publishPackageToWorkshop).mockRejectedValue({
      response: { data: { code: "invalid_tags", tag: "Bad Tag" } },
    });
    const { result, unmount } = await startHook();

    const failure = await result.current
      .publishToWorkshop(5)
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("Bad Tag");
    unmount();
  });

  it("forks to a new slug and downloads the copy", async () => {
    const { result, unmount } = await startHook();
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 11, revision: 1 },
      ]),
    );
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node", 1, 11, "demo_fork"),
    );

    await act(async () => {
      await result.current.forkWorkshopPackage(5, "demo_fork");
    });

    expect(packagesApi.forkPackageToWorkshop).toHaveBeenCalledWith(
      5,
      "demo_fork",
    );
    expect(fs.read("demo_fork", HERO)).toBe("extends Node");
    expect(
      result.current.entries.find((item) => item.packageId === 11),
    ).toMatchObject({ slug: "demo_fork", loaded: true });
    expect(result.current.actionFor(11).notice).toBe(
      "Форк создан: demo_fork. Опубликуйте его в workshop отдельно",
    );
    unmount();
  });
});
