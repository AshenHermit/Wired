import {
  PackageManifest,
  PackageRevision,
  RoomPackagesStatus,
  ScriptingPackage,
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
  createPackageRevision: vi.fn(),
  uploadRevisionFileAsUint8Array: vi.fn(),
  publishPackageRevision: vi.fn(),
  getPackageManifest: vi.fn(),
  getRevisionFile: vi.fn(),
}));

import * as gameApi from "@/api/services/godot-game";
import * as packagesApi from "@/api/services/scripting-packages";
import {
  createPackageFileSystem,
  type CollectedPackageFile,
  type PackageFileSystem,
} from "./godot-packages-fs";
import {
  LocalChangesError,
  NewerRevisionError,
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
  const dirs = new Set<number>();
  const trees = new Map<number, Map<string, Uint8Array>>();
  const reads = { value: 0 };

  const tree = (packageId: number): Map<string, Uint8Array> => {
    const existing = trees.get(packageId);
    if (existing) return existing;
    const created = new Map<string, Uint8Array>();
    trees.set(packageId, created);
    return created;
  };

  const exists = vi.fn(
    async (packageId: number): Promise<boolean> => dirs.has(packageId),
  );
  const createPackageDir = vi.fn(async (packageId: number): Promise<void> => {
    dirs.add(packageId);
    tree(packageId);
  });
  const snapshot = vi.fn(
    async (packageId: number): Promise<Record<string, string>> => {
      const hashes: Record<string, string> = {};
      for (const [filepath, contents] of tree(packageId)) {
        reads.value += 1;
        hashes[filepath] = await sha256Hex(contents);
      }
      return hashes;
    },
  );
  const collectFiles = vi.fn(
    async (packageId: number): Promise<CollectedPackageFile[]> => {
      const collected: CollectedPackageFile[] = [];
      for (const [filepath, contents] of tree(packageId)) {
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
      packageId: number,
      contents: Map<string, Uint8Array>,
    ): Promise<{ written: string[]; deleted: string[] }> => {
      const previous = tree(packageId);
      const deleted = [...previous.keys()].filter(
        (filepath) => !contents.has(filepath),
      );
      const written = [...contents.keys()];
      dirs.add(packageId);
      trees.set(
        packageId,
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
  const deletePackage = vi.fn(async (packageId: number): Promise<void> => {
    dirs.delete(packageId);
    trees.delete(packageId);
  });
  const sync = vi.fn(async (): Promise<void> => {});

  const files: PackageFileSystem = {
    exists,
    createPackageDir,
    snapshot,
    collectFiles,
    replaceContents,
    deletePackage,
    sync,
    packageDir: (packageId: number) => `${PROJECT}/packages/${packageId}`,
  };

  return {
    files,
    exists,
    createPackageDir,
    snapshot,
    collectFiles,
    replaceContents,
    deletePackage,
    sync,
    reads,
    put(packageId: number, filepath: string, content: string) {
      dirs.add(packageId);
      tree(packageId).set(filepath, encoder.encode(content));
    },
    has(packageId: number, filepath: string): boolean {
      return trees.get(packageId)?.has(filepath) ?? false;
    },
    read(packageId: number, filepath: string): string {
      const contents = trees.get(packageId)?.get(filepath);
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

function roomPackage(id: number, name: string): ScriptingPackage {
  return {
    id,
    name,
    version: "0.1.0",
    description: "",
    dependencies: [],
    scripts: [],
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
  };
}

const ONE_PACKAGE = [roomPackage(5, "Demo")];
const TWO_PACKAGES = [roomPackage(5, "Demo"), roomPackage(6, "Other")];

async function manifestOf(
  content: string,
  revision = 2,
  packageId = 5,
): Promise<PackageManifest> {
  const data = encoder.encode(content);
  return {
    packageId,
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
  packages: { id: number; revision: number }[] = [{ id: 5, revision: 2 }],
): RoomPackagesStatus {
  return {
    roomId: 1,
    packages: packages.map(({ id, revision }) => ({
      packageId: id,
      name: id === 5 ? "Demo" : "Other",
      revision,
      publishedAt: "2026-10-30T10:00:00.000Z",
      state: "published",
      runtime: { state: "pending", revision, error: null, updatedAt: null },
      clients: [],
    })),
  };
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
      fs.put(5, HERO, "local draft");
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

  it("keeps readiness when the plugin rejects a single operation", async () => {
    const { result, unmount } = await startHook();
    fs.put(5, HERO, "local draft");
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

    expect(fs.has(5, HERO)).toBe(false);
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

  it("creates a new package as an empty directory and loads only it", async () => {
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus([]));
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.createPackage("New", 42);
    });

    expect(packagesApi.createScriptingPackage).toHaveBeenCalledWith({
      name: "New",
      version: "0.1.0",
      authorId: 42,
      roomId: 1,
    });
    expect(fs.createPackageDir).toHaveBeenCalledWith(7);
    expect(fs.has(7, HERO)).toBe(false);
    expect(fs.has(5, HERO)).toBe(false);
    const entry = result.current.entries.find((item) => item.packageId === 7);
    expect(entry).toMatchObject({
      name: "New",
      status: "loaded",
      loaded: true,
      loadedRevision: 0,
      publishedRevision: null,
    });
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

    expect(fs.read(5, HERO)).toBe("extends Node");
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "loaded",
      loaded: true,
      loadedRevision: 2,
      localChanges: [],
    });

    fs.put(5, HERO, "local edit");
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
    expect(fs.read(5, HERO)).toBe("local edit");

    await act(async () => {
      await result.current.downloadPackage(5, { force: true });
    });
    expect(fs.read(5, HERO)).toBe("extends Node");
    unmount();
  });

  it("removes only the requested package directory", async () => {
    vi.mocked(packagesApi.getPackageManifest).mockImplementation(
      async (id) => await manifestOf("extends Node", 2, id),
    );
    const { result, unmount } = await startHook({
      packages: TWO_PACKAGES,
    });
    fs.put(6, OTHER, "keep me");

    await act(async () => {
      await result.current.downloadPackage(5);
    });
    expect(fs.has(5, HERO)).toBe(true);

    fs.put(5, HERO, "local edit");
    await expect(result.current.removePackage(5)).rejects.toBeInstanceOf(
      LocalChangesError,
    );
    expect(fs.has(5, HERO)).toBe(true);

    await act(async () => {
      await result.current.removePackage(5, { force: true });
    });

    expect(fs.has(5, HERO)).toBe(false);
    expect(fs.has(6, OTHER)).toBe(true);
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

    fs.put(5, HERO, "extends Node2D");
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
    expect(fs.read(5, HERO)).toBe("extends Node");
    expect(packagesApi.getRevisionFile).toHaveBeenCalledTimes(downloads);
    unmount();
  });

  it("keeps files left by a previous session and warns before replacing them", async () => {
    fs.put(5, HERO, "stale draft");
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
    expect(fs.read(5, HERO)).toBe("stale draft");

    await act(async () => {
      await result.current.downloadPackage(5, { force: true });
    });
    expect(fs.read(5, HERO)).toBe("extends Node");
    unmount();
  });

  it("adopts a leftover directory so its files can be emitted", async () => {
    fs.put(5, HERO, "stale draft");
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
    expect(fs.read(5, HERO)).toBe("stale draft");
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
      await result.current.createPackage("New", 42);
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
});
