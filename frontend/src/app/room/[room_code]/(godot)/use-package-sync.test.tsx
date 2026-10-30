import { PackageManifest, RoomPackagesStatus } from "@wired-io/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/utils/sha256";
import type { GodotEditorInstance } from "./GodotEditorInstance";
import type { EmscriptenFs } from "./godot-packages-fs";
import {
  loadPackageBaseline,
  usePackageSync,
} from "./use-package-sync";

vi.mock("@/api/services/godot-game", () => ({
  getRoomPackages: vi.fn(),
}));

vi.mock("@/api/services/scripting-packages", () => ({
  getPackageManifest: vi.fn(),
  getRevisionFile: vi.fn(),
}));

import * as gameApi from "@/api/services/godot-game";
import * as packagesApi from "@/api/services/scripting-packages";

const encoder = new TextEncoder();

class FakeFs implements EmscriptenFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/"]);

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
}

const PROJECT = "/root/Wired";
const FILE = `${PROJECT}/packages/5/scripts/hero.gd`;

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

async function manifestOf(content: string, revision = 2): Promise<PackageManifest> {
  const data = encoder.encode(content);
  return {
    packageId: 5,
    name: "Demo",
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

function roomStatus(revision = 2): RoomPackagesStatus {
  return {
    roomId: 1,
    packages: [
      {
        packageId: 5,
        name: "Demo",
        revision,
        publishedAt: "2026-10-30T10:00:00.000Z",
        state: "published",
        runtime: { state: "pending", revision, error: null, updatedAt: null },
        clients: [],
      },
    ],
  };
}

describe("usePackageSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("downloads the published revision into the editor file system", async () => {
    const { fs, editor } = makeEditor();
    const manifest = await manifestOf("extends Node");
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus(2));
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(manifest);
    vi.mocked(packagesApi.getRevisionFile).mockResolvedValue(
      encoder.encode("extends Node").buffer,
    );

    const { result } = renderHook(() => usePackageSync(1));

    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });

    expect(result.current.phase).toBe("ready");
    expect(result.current.fsReady).toBe(true);
    expect(fs.read(FILE)).toBe("extends Node");
    expect(loadPackageBaseline(1, 5)?.revision).toBe(2);
  });

  it("does not replace files under a running editor without an explicit action", async () => {
    const { fs, editor } = makeEditor();
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus(2));
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node", 2),
    );
    vi.mocked(packagesApi.getRevisionFile).mockResolvedValue(
      encoder.encode("extends Node").buffer,
    );

    const { result } = renderHook(() => usePackageSync(1));

    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    expect(fs.read(FILE)).toBe("extends Node");

    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus(3));
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node2D", 3),
    );

    await act(async () => {
      await result.current.syncNow();
    });

    expect(result.current.phase).toBe("conflict");
    expect(result.current.entries[0].state).toBe("available");
    expect(fs.read(FILE)).toBe("extends Node");
    expect(packagesApi.getRevisionFile).toHaveBeenCalledTimes(1);

    vi.mocked(packagesApi.getRevisionFile).mockResolvedValue(
      encoder.encode("extends Node2D").buffer,
    );
    await act(async () => {
      await result.current.resolveConflict(5, "replace-published");
    });

    expect(fs.read(FILE)).toBe("extends Node2D");
    expect(loadPackageBaseline(1, 5)?.revision).toBe(3);
  });

  it("does not overwrite a local edit and replaces it only on request", async () => {
    const { fs, editor } = makeEditor();
    fs.put(FILE, "local edit");
    const manifest = await manifestOf("extends Node");
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus(2));
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(manifest);
    vi.mocked(packagesApi.getRevisionFile).mockResolvedValue(
      encoder.encode("extends Node").buffer,
    );

    const { result } = renderHook(() => usePackageSync(1));

    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });

    expect(result.current.phase).toBe("conflict");
    expect(result.current.conflicts[0].packageId).toBe(5);
    expect(fs.read(FILE)).toBe("local edit");

    await act(async () => {
      await result.current.resolveConflict(5, "replace-published");
    });

    expect(result.current.phase).toBe("ready");
    expect(fs.read(FILE)).toBe("extends Node");
    expect(loadPackageBaseline(1, 5)?.revision).toBe(2);
  });

  it("keeps local files when the user chooses them", async () => {
    const { fs, editor } = makeEditor();
    fs.put(FILE, "local edit");
    vi.mocked(gameApi.getRoomPackages).mockResolvedValue(roomStatus(2));
    vi.mocked(packagesApi.getPackageManifest).mockResolvedValue(
      await manifestOf("extends Node"),
    );
    vi.mocked(packagesApi.getRevisionFile).mockResolvedValue(
      encoder.encode("extends Node").buffer,
    );

    const { result } = renderHook(() => usePackageSync(1));

    await act(async () => {
      await result.current.beforeEditorStart(editor);
    });
    await act(async () => {
      await result.current.resolveConflict(5, "keep-local");
    });

    expect(result.current.phase).toBe("ready");
    expect(result.current.conflicts).toEqual([]);

    await act(async () => {
      await result.current.syncNow();
    });

    expect(fs.read(FILE)).toBe("local edit");
    expect(packagesApi.getRevisionFile).toHaveBeenCalledTimes(0);
  });
});
