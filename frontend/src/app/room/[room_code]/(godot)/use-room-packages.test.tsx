import {
  PackageManifest,
  PackageRevision,
  RoomPackagesStatus,
  ScriptingPackage,
} from "@wired-io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/utils/sha256";
import type { GodotEditorInstance } from "./GodotEditorInstance";
import {
  LocalChangesError,
  NewerRevisionError,
  useRoomPackages,
} from "./use-room-packages";

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

const encoder = new TextEncoder();

class FakeFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/"]);
  reads = 0;

  mkdirTree(path: string) {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  writeFile(path: string, data: Uint8Array) {
    const index = path.lastIndexOf("/");
    const dir = index <= 0 ? "/" : path.slice(0, index);
    if (!this.dirs.has(dir)) throw new Error(`ENOENT: ${dir}`);
    this.files.set(path, Uint8Array.from(data));
  }

  readFile(path: string) {
    this.reads += 1;
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return Uint8Array.from(data);
  }

  readdir(path: string) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const entry of [...this.dirs, ...this.files.keys()]) {
      if (entry === path || !entry.startsWith(prefix)) continue;
      names.add(entry.slice(prefix.length).split("/")[0]);
    }
    return [...names];
  }

  stat(path: string) {
    if (this.dirs.has(path)) return { mode: 0o040755, size: 0 };
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return { mode: 0o100644, size: data.byteLength };
  }

  unlink(path: string) {
    this.files.delete(path);
  }

  rmdir(path: string) {
    this.dirs.delete(path);
  }

  rename(oldPath: string, newPath: string) {
    const prefix = `${oldPath}/`;
    this.mkdirTree(newPath);
    for (const dir of [...this.dirs]) {
      if (!dir.startsWith(prefix)) continue;
      this.dirs.delete(dir);
      this.mkdirTree(`${newPath}/${dir.slice(prefix.length)}`);
    }
    for (const file of [...this.files.keys()]) {
      if (!file.startsWith(prefix)) continue;
      const contents = this.files.get(file)!;
      this.files.delete(file);
      const target = `${newPath}/${file.slice(prefix.length)}`;
      this.mkdirTree(target.slice(0, target.lastIndexOf("/")));
      this.files.set(target, contents);
    }
    this.dirs.delete(oldPath);
  }

  put(path: string, content: string) {
    this.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    this.files.set(path, encoder.encode(content));
  }

  read(path: string) {
    return new TextDecoder().decode(this.readFile(path));
  }

  has(path: string) {
    return this.files.has(path);
  }
}

const PROJECT = "/root/Wired";
const FILE = `${PROJECT}/packages/5/scripts/hero.gd`;
const OTHER_FILE = `${PROJECT}/packages/6/scripts/other.gd`;

function makeEditor() {
  const fs = new FakeFs();
  fs.put(`${PROJECT}/project.godot`, "config_version=5");
  const editor = {
    rootPath: "/root",
    projectInfo: { name: "Wired" },
    editor: { rtenv: { FS: fs } },
  } as unknown as GodotEditorInstance;
  return { fs, editor };
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
        filepath: "scripts/hero.gd",
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
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("never writes packages into the editor on start", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });

    expect(result.current.fsReady).toBe(true);
    expect(fs.has(FILE)).toBe(false);
    expect(packagesApi.getPackageManifest).not.toHaveBeenCalled();
    expect(packagesApi.getRevisionFile).not.toHaveBeenCalled();
    const entry = result.current.entries.find((item) => item.packageId === 5);
    expect(entry?.status).toBe("not-loaded");
    expect(entry?.publishedRevision).toBe(2);
    expect(entry?.loaded).toBe(false);
  });

  it("creates a new package as an empty directory and loads only it", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus([]));

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    await act(async () => {
      await result.current.createPackage("New", 42);
    });

    expect(packagesApi.createScriptingPackage).toHaveBeenCalledWith({
      name: "New",
      version: "0.1.0",
      authorId: 42,
      roomId: 1,
    });
    expect(fs.dirs.has(`${PROJECT}/packages/7`)).toBe(true);
    expect(fs.has(FILE)).toBe(false);
    const entry = result.current.entries.find((item) => item.packageId === 7);
    expect(entry).toMatchObject({
      name: "New",
      status: "loaded",
      loaded: true,
      loadedRevision: 0,
      publishedRevision: null,
    });
  });

  it("downloads a published revision and asks before overwriting local edits", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    await act(async () => {
      await result.current.downloadPackage(5);
    });

    expect(fs.read(FILE)).toBe("extends Node");
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "loaded",
      loaded: true,
      loadedRevision: 2,
      localChanges: [],
    });

    fs.put(FILE, "local edit");
    await act(async () => {
      await result.current.refresh();
    });
    expect(
      result.current.entries.find((item) => item.packageId === 5),
    ).toMatchObject({
      status: "local-changes",
      localChanges: ["scripts/hero.gd"],
    });

    await expect(result.current.downloadPackage(5)).rejects.toBeInstanceOf(
      LocalChangesError,
    );
    expect(fs.read(FILE)).toBe("local edit");

    await act(async () => {
      await result.current.downloadPackage(5, { force: true });
    });
    expect(fs.read(FILE)).toBe("extends Node");
  });

  it("removes only the requested package directory", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(packagesApi.getPackageManifest).mockImplementation(
      async (id) => await manifestOf("extends Node", 2, id),
    );
    fs.put(OTHER_FILE, "keep me");

    const { result } = renderHook(() => useRoomPackages(1, TWO_PACKAGES));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    await act(async () => {
      await result.current.downloadPackage(5);
    });
    expect(fs.has(FILE)).toBe(true);

    fs.put(FILE, "local edit");
    await expect(result.current.removePackage(5)).rejects.toBeInstanceOf(
      LocalChangesError,
    );
    expect(fs.has(FILE)).toBe(true);

    await act(async () => {
      await result.current.removePackage(5, { force: true });
    });

    expect(fs.has(FILE)).toBe(false);
    expect(fs.has(OTHER_FILE)).toBe(true);
    expect(
      result.current.entries.find((item) => item.packageId === 5)?.status,
    ).toBe("not-loaded");
  });

  it("emits only a package loaded in this editor and takes a new baseline", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    await act(async () => {
      await result.current.downloadPackage(5);
    });

    fs.put(FILE, "extends Node2D");
    await act(async () => {
      await result.current.emitPackage(5);
    });

    expect(packagesApi.createPackageRevision).toHaveBeenCalledWith(5, {
      files: [
        expect.objectContaining({ filepath: "scripts/hero.gd" }),
      ],
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
  });

  it("shows a new published revision without touching the editor files", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node", 2),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
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
    mockPublishedFile("extends Node2D");
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
    expect(fs.read(FILE)).toBe("extends Node");
    expect(packagesApi.getRevisionFile).toHaveBeenCalledTimes(downloads);
  });

  it("keeps files left by a previous session and warns before replacing them", async () => {
    const { fs, editor } = makeEditor();
    fs.put(FILE, "stale draft");
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    await waitFor(() => {
      expect(
        result.current.entries.find((item) => item.packageId === 5)?.status,
      ).toBe("local-changes");
    });

    await expect(result.current.downloadPackage(5)).rejects.toMatchObject({
      name: "LocalChangesError",
      files: ["scripts/hero.gd"],
    });
    expect(fs.read(FILE)).toBe("stale draft");

    await act(async () => {
      await result.current.downloadPackage(5, { force: true });
    });
    expect(fs.read(FILE)).toBe("extends Node");
  });

  it("adopts a leftover directory so its files can be emitted", async () => {
    const { fs, editor } = makeEditor();
    fs.put(FILE, "stale draft");

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
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
      files: [expect.objectContaining({ filepath: "scripts/hero.gd" })],
    });
    expect(fs.read(FILE)).toBe("stale draft");
  });

  it("asks before emitting over a newer published revision", async () => {
    const { editor } = makeEditor();
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
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
  });

  it("rejects overlapping actions on the same package", async () => {
    const { editor } = makeEditor();
    let resolveManifest: (manifest: PackageManifest) => void = () => {};
    vi.mocked(packagesApi.getPackageManifest).mockReturnValue(
      new Promise((resolve) => {
        resolveManifest = resolve;
      }),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });

    const first = result.current.downloadPackage(5);
    await expect(result.current.downloadPackage(5)).rejects.toThrow(
      /уже выполняется/,
    );

    await act(async () => {
      resolveManifest(await manifestOf("extends Node"));
      await first;
    });
  });

  it("adds newly published room packages from the status endpoint", async () => {
    const { editor } = makeEditor();
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(
      roomStatus([
        { id: 5, revision: 2 },
        { id: 6, revision: 4 },
      ]),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });

    expect(
      result.current.entries.find((item) => item.packageId === 6),
    ).toMatchObject({
      name: "Other",
      version: "",
      publishedRevision: 4,
      status: "not-loaded",
    });
  });

  it("asks Godot to rescan after package files change", async () => {
    const { editor } = makeEditor();
    const rescan = vi.fn();
    Object.assign(window, { __wiredEditorBridge: { rescan } });
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );

    const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });

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

    delete (window as { __wiredEditorBridge?: unknown }).__wiredEditorBridge;
  });

  it("polls statuses without hashing editor files", async () => {
    vi.useFakeTimers();
    try {
      const { fs, editor } = makeEditor();
      const { result } = renderHook(() => useRoomPackages(1, ONE_PACKAGE));
      await act(async () => {
        await result.current.beforeEditorStart(editor);
      });

      fs.put(FILE, "local draft");
      fs.reads = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_500);
      });

      expect(gameApi.getRoomPackages).toHaveBeenCalledTimes(3);
      expect(fs.reads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
