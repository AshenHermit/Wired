import { PackageFileEntry, PackageManifest } from "@wired-io/shared";
import { describe, expect, it, vi } from "vitest";
import {
  GodotFsError,
  PackageFileSystem,
  applyPackageRevision,
  type EmscriptenFs,
} from "./godot-packages-fs";
import { sha256Hex } from "@/utils/sha256";

/**
 * Minimal in-memory stand-in for the Emscripten FS exposed by the Godot editor
 * build. It mirrors the semantics that matter here: writeFile does not create
 * missing directories, readdir lists direct children, and stat reports the
 * mode bits that separate directories from files.
 */
class FakeFs implements EmscriptenFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/"]);
  syncCalls = 0;
  failWrites: (path: string) => boolean = () => false;

  private addDir(path: string) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  mkdirTree(path: string) {
    this.addDir(path);
  }

  writeFile(path: string, data: Uint8Array) {
    if (!this.dirs.has(dirname(path))) {
      throw new Error(`ENOENT: no such directory ${dirname(path)}`);
    }
    if (this.failWrites(path)) {
      throw new Error(`ENOSPC: cannot write ${path}`);
    }
    this.files.set(path, Uint8Array.from(data));
  }

  readFile(path: string) {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: no such file ${path}`);
    return Uint8Array.from(data);
  }

  readdir(path: string) {
    if (!this.dirs.has(path)) throw new Error(`ENOENT: ${path}`);
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
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  rmdir(path: string) {
    if (!this.dirs.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  rename(oldPath: string, newPath: string) {
    if (!this.dirs.has(oldPath) && !this.files.has(oldPath)) {
      throw new Error(`ENOENT: ${oldPath}`);
    }
    const prefix = `${oldPath}/`;
    for (const dir of [...this.dirs]) {
      if (dir === oldPath) {
        this.dirs.delete(dir);
        this.addDir(newPath);
      } else if (dir.startsWith(prefix)) {
        this.dirs.delete(dir);
        this.addDir(`${newPath}/${dir.slice(prefix.length)}`);
      }
    }
    for (const file of [...this.files.keys()]) {
      if (!file.startsWith(prefix)) continue;
      const contents = this.files.get(file)!;
      this.files.delete(file);
      const target = `${newPath}/${file.slice(prefix.length)}`;
      this.addDir(dirname(target));
      this.files.set(target, contents);
    }
  }

  syncfs(populate: boolean, callback: (error?: unknown) => void) {
    this.syncCalls += 1;
    expect(populate).toBe(false);
    callback();
  }

  put(path: string, content: string) {
    this.addDir(dirname(path));
    this.files.set(path, new TextEncoder().encode(content));
  }

  read(path: string) {
    return new TextDecoder().decode(this.readFile(path));
  }

  has(path: string) {
    return this.files.has(path);
  }
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

const encoder = new TextEncoder();
const data = (value: string) => encoder.encode(value);

function makeFs() {
  const fs = new FakeFs();
  fs.put("/home/web_user/Wired/project.godot", "config_version=5");
  fs.put("/home/web_user/Wired/_wired/scripts/global/global.gd", "extends Node");
  return { fs, files: new PackageFileSystem(fs, "/home/web_user/Wired") };
}

const entry = async (filepath: string, content: string): Promise<PackageFileEntry> => ({
  filepath,
  size: data(content).byteLength,
  sha256: await sha256Hex(data(content)),
});

describe("PackageFileSystem", () => {
  it("creates an empty package directory and persists it", async () => {
    const { fs, files } = makeFs();

    await files.createPackageDir(3);

    expect(fs.dirs.has("/home/web_user/Wired/packages/3")).toBe(true);
    expect(fs.syncCalls).toBe(1);
    await expect(files.listFiles(3)).resolves.toEqual([]);
  });

  it("reports whether a package directory exists", () => {
    const { files } = makeFs();

    expect(files.exists(3)).toBe(false);
    files.writeFile(3, "hero.gd", data("extends Node"));
    expect(files.exists(3)).toBe(true);
  });

  it("writes and reads nested package files", () => {
    const { fs, files } = makeFs();

    files.writeFile(3, "scripts/hero.gd", data("extends Node"));

    expect(fs.read("/home/web_user/Wired/packages/3/scripts/hero.gd")).toBe(
      "extends Node"
    );
    expect([...files.readFile(3, "scripts/hero.gd")]).toEqual([
      ...data("extends Node"),
    ]);
  });

  it("refuses paths that leave the package directory", () => {
    const { files } = makeFs();

    expect(() => files.writeFile(3, "../4/hero.gd", data("x"))).toThrow(
      GodotFsError
    );
    expect(() => files.writeFile(3, "/etc/passwd", data("x"))).toThrow(
      GodotFsError
    );
    expect(() => files.readFile(3, "a/../../b.gd")).toThrow(GodotFsError);
  });

  it("lists package files recursively as sorted relative paths", async () => {
    const { files } = makeFs();
    files.writeFile(3, "scenes/b.tscn", data("b"));
    files.writeFile(3, "scripts/hero.gd", data("hero"));
    files.writeFile(3, "package.json", data("{}"));

    await expect(files.listFiles(3)).resolves.toEqual([
      "package.json",
      "scenes/b.tscn",
      "scripts/hero.gd",
    ]);
  });

  it("lists nothing for a package that was never written", async () => {
    const { files } = makeFs();
    await expect(files.listFiles(9)).resolves.toEqual([]);
  });

  it("reports a missing file with a readable error", () => {
    const { files } = makeFs();
    expect(() => files.readFile(3, "missing.gd")).toThrow(GodotFsError);
  });

  it("prunes stale files only inside the managed package directory", async () => {
    const { fs, files } = makeFs();
    files.writeFile(3, "keep.gd", data("keep"));
    files.writeFile(3, "old/stale.gd", data("stale"));
    files.writeFile(4, "other-package.gd", data("other"));

    const deleted = await files.prune(3, ["keep.gd"]);

    expect(deleted).toEqual(["old/stale.gd"]);
    expect(await files.listFiles(3)).toEqual(["keep.gd"]);
    expect(fs.has("/home/web_user/Wired/packages/4/other-package.gd")).toBe(
      true
    );
    expect(fs.has("/home/web_user/Wired/project.godot")).toBe(true);
    expect(fs.has("/home/web_user/Wired/_wired/scripts/global/global.gd")).toBe(
      true
    );
  });

  it("removes directories that became empty after pruning", async () => {
    const { fs, files } = makeFs();
    files.writeFile(3, "old/deep/stale.gd", data("stale"));

    await files.prune(3, []);

    expect(fs.dirs.has("/home/web_user/Wired/packages/3/old/deep")).toBe(false);
    expect(fs.dirs.has("/home/web_user/Wired/packages/3/old")).toBe(false);
    expect(fs.dirs.has("/home/web_user/Wired/packages/3")).toBe(true);
  });

  it("collects every package file with its size and sha256", async () => {
    const { files } = makeFs();
    files.writeFile(3, "scripts/hero.gd", data("extends Node"));

    const collected = await files.collectFiles(3);

    expect(collected.map((file) => file.entry)).toEqual([
      {
        filepath: "scripts/hero.gd",
        size: "extends Node".length,
        sha256: await sha256Hex(data("extends Node")),
      },
    ]);
    expect([...collected[0].contents]).toEqual([...data("extends Node")]);
  });

  it("snapshots source hashes without editor metadata", async () => {
    const { files } = makeFs();
    files.writeFile(3, "hero.gd", data("extends Node"));
    files.writeFile(3, "hero.gd.uid", data("uid"));

    const snapshot = await files.snapshot(3);

    expect(snapshot).toEqual({
      "hero.gd": await sha256Hex(data("extends Node")),
    });
  });

  it("flushes writes to the persistent file system", async () => {    const { fs, files } = makeFs();
    await files.sync();
    expect(fs.syncCalls).toBe(1);
  });

  it("fails clearly when the editor file system is not ready", () => {
    expect(() => new PackageFileSystem(undefined as never, "/x")).toThrow(
      GodotFsError
    );
  });
});

describe("applyPackageRevision", () => {
  const manifest: PackageManifest = {
    packageId: 3,
    name: "Heroes",
    revision: 2,
    files: [],
    totalSize: 0,
    publishedAt: "2026-10-29T00:00:00.000Z",
  };

  it("writes verified files and prunes files of the previous revision", async () => {
    const { files } = makeFs();
    files.writeFile(3, "old.gd", data("old"));
    const hero = await entry("scripts/hero.gd", "extends Node");
    const scene = await entry("scenes/hero.tscn", "[gd_scene]");

    const result = await applyPackageRevision({
      files,
      manifest: { ...manifest, files: [hero, scene] },
      download: async (filepath) =>
        data(filepath === hero.filepath ? "extends Node" : "[gd_scene]"),
    });

    expect(result.written).toEqual(["scenes/hero.tscn", "scripts/hero.gd"]);
    expect(result.deleted).toEqual(["old.gd"]);
    expect(await files.listFiles(3)).toEqual([
      "scenes/hero.tscn",
      "scripts/hero.gd",
    ]);
  });

  it("changes nothing when a downloaded file does not match its hash", async () => {
    const { files } = makeFs();
    files.writeFile(3, "keep.gd", data("keep"));
    const hero = await entry("scripts/hero.gd", "extends Node");

    await expect(
      applyPackageRevision({
        files,
        manifest: { ...manifest, files: [hero] },
        download: async () => data("tamperedNode"),
      })
    ).rejects.toThrow(/sha-?256/i);

    expect(await files.listFiles(3)).toEqual(["keep.gd"]);
  });

  it("changes nothing when a downloaded file has the wrong size", async () => {
    const { files } = makeFs();
    const hero = await entry("scripts/hero.gd", "extends Node");

    await expect(
      applyPackageRevision({
        files,
        manifest: { ...manifest, files: [hero] },
        download: async () => data("extends Node!"),
      })
    ).rejects.toThrow(/size/i);

    expect(await files.listFiles(3)).toEqual([]);
  });

  it("keeps the previous revision when staging fails in the middle", async () => {
    const { fs, files } = makeFs();
    files.writeFile(3, "keep.gd", data("keep"));
    const first = await entry("a.gd", "a");
    const last = await entry("z.gd", "z");
    fs.failWrites = (path) => path.endsWith("/z.gd");

    await expect(
      applyPackageRevision({
        files,
        manifest: { ...manifest, files: [first, last] },
        download: async (filepath) =>
          data(filepath === first.filepath ? "a" : "z"),
      })
    ).rejects.toThrow(GodotFsError);

    expect(await files.listFiles(3)).toEqual(["keep.gd"]);
    expect([...fs.files.keys()].filter((path) => path.includes(".staging"))).toEqual(
      []
    );
  });

  it("carries editor metadata over and never publishes it", async () => {
    const { files } = makeFs();
    files.writeFile(3, "hero.gd", data("old"));
    files.writeFile(3, "hero.gd.uid", data("uid-local"));
    files.writeFile(3, "art.png.import", data("[remap]"));
    const hero = await entry("hero.gd", "extends Node");

    const result = await applyPackageRevision({
      files,
      manifest: { ...manifest, files: [hero] },
      download: async () => data("extends Node"),
    });

    expect(result.deleted).toEqual([]);
    expect(await files.listFiles(3)).toEqual([
      "art.png.import",
      "hero.gd",
      "hero.gd.uid",
    ]);
    expect([...files.readFile(3, "hero.gd.uid")]).toEqual([
      ...data("uid-local"),
    ]);
  });

  it("collects only package sources, not editor metadata", async () => {
    const { files } = makeFs();
    files.writeFile(3, "hero.gd", data("extends Node"));
    files.writeFile(3, "hero.gd.uid", data("uid"));
    files.writeFile(3, "art.png.import", data("[remap]"));
    files.writeFile(3, ".godot/cache", data("cache"));

    const collected = await files.collectFiles(3);

    expect(collected.map((file) => file.entry.filepath)).toEqual(["hero.gd"]);
  });

  it("prunes nothing outside the package when the manifest is empty", async () => {
    const { fs, files } = makeFs();
    files.writeFile(3, "old.gd", data("old"));

    await applyPackageRevision({
      files,
      manifest: { ...manifest, files: [] },
      download: vi.fn(),
    });

    expect(await files.listFiles(3)).toEqual([]);
    expect(fs.has("/home/web_user/Wired/project.godot")).toBe(true);
  });

  it("reports download progress per file", async () => {
    const { files } = makeFs();
    const hero = await entry("scripts/hero.gd", "extends Node");
    const scene = await entry("scenes/hero.tscn", "[gd_scene]");
    const onProgress = vi.fn();

    await applyPackageRevision({
      files,
      manifest: { ...manifest, files: [hero, scene] },
      download: async (filepath) =>
        data(filepath === hero.filepath ? "extends Node" : "[gd_scene]"),
      onProgress,
    });

    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });
});
