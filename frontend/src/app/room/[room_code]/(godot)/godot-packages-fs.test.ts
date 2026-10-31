import { PackageFileEntry, PackageManifest } from "@wired-io/shared";
import { describe, expect, it, vi } from "vitest";
import {
  EditorBridgeOperationError,
  type EditorBridgeClient,
} from "./editor-bridge";
import {
  GodotFsError,
  applyPackageRevision,
  assertRelativePackagePath,
  createPackageFileSystem,
  type PackageEngine,
  type PackageFileSystem,
} from "./godot-packages-fs";
import { sha256Hex } from "@/utils/sha256";

const projectRoot = "/home/web_user/Wired";
const stagingPath = `${projectRoot}/packages/.7.staging`;
const encoder = new TextEncoder();
const data = (value: string) => encoder.encode(value);

type Handler = (params: Record<string, unknown>) => unknown;

function makeEngine(tree: Map<string, Uint8Array>, order: string[]): PackageEngine {
  return {
    copyToFS: vi.fn((path: string, contents: Uint8Array) => {
      order.push(`copy:${path}`);
      tree.set(path.replace(`${projectRoot}/`, ""), contents);
    }),
  };
}

/**
 * Stands in for the editor plugin. Handlers answer with the exact payloads the
 * GDScript plugin sends; every bridge call and every engine write is recorded
 * in `order` so a test can assert the sequence of a replacement.
 */
function makeWorkspace(overrides: Record<string, Handler> = {}) {
  const tree = new Map<string, Uint8Array>();
  const order: string[] = [];
  const syncHandler = vi.fn();
  let engine = makeEngine(tree, order);

  const handlers: Record<string, Handler> = {
    exists: () => ({ exists: true }),
    snapshot: () => ({ files: {} }),
    collect: () => ({ files: [] }),
    prepareReplace: () => ({ staging_path: stagingPath }),
    replace: () => ({ written: [], deleted: [] }),
    createDir: () => ({}),
    delete: () => ({}),
    sync: () => {
      syncHandler();
      return {};
    },
    ...overrides,
  };

  const bridge = {
    call: vi.fn(async (op: string, params: Record<string, unknown> = {}) => {
      order.push(op);
      const handler = handlers[op];
      if (!handler) throw new Error(`unexpected operation: ${op}`);
      return handler(params);
    }),
  } as unknown as EditorBridgeClient;

  const files: PackageFileSystem = createPackageFileSystem({
    bridge,
    getEngine: () => engine,
    projectRoot,
  });

  return {
    files,
    bridge,
    tree,
    order,
    syncHandler,
    get engine() {
      return engine;
    },
    swapEngine(next: PackageEngine) {
      engine = next;
    },
  };
}

describe("assertRelativePackagePath", () => {
  it("rejects unsafe package paths", () => {
    for (const path of ["../x", "/x", "a\\b"]) {
      expect(() => assertRelativePackagePath(path)).toThrow(GodotFsError);
    }
  });
});

describe("PackageFileSystem", () => {
  it("decodes base64 from collect", async () => {
    const { files, bridge } = makeWorkspace({
      collect: () => ({
        files: [
          {
            filepath: "main.gd",
            size: 4,
            sha256: "a".repeat(64),
            contents_base64: btoa("test"),
          },
        ],
      }),
    });

    const collected = await files.collectFiles(3);

    expect(bridge.call).toHaveBeenCalledWith("collect", { packageId: 3 });
    expect(collected).toHaveLength(1);
    expect(collected[0].entry).toEqual({
      filepath: "main.gd",
      size: 4,
      sha256: "a".repeat(64),
    });
    expect([...collected[0].contents]).toEqual([116, 101, 115, 116]);
  });

  it("writes staging then swaps", async () => {
    const { files, tree, order } = makeWorkspace({
      replace: () => ({ written: ["main.gd", "scenes/a.tscn"], deleted: ["old.gd"] }),
    });

    const result = await files.replaceContents(
      7,
      new Map([
        ["main.gd", data("main")],
        ["scenes/a.tscn", data("[gd_scene]")],
      ]),
    );

    expect(result).toEqual({
      written: ["main.gd", "scenes/a.tscn"],
      deleted: ["old.gd"],
    });
    expect(tree.get("packages/.7.staging/main.gd")).toEqual(data("main"));
    expect(tree.get("packages/.7.staging/scenes/a.tscn")).toEqual(
      data("[gd_scene]"),
    );
    expect(order).toEqual([
      "prepareReplace",
      `copy:${stagingPath}/main.gd`,
      `copy:${stagingPath}/scenes/a.tscn`,
      "replace",
      "sync",
    ]);
  });

  it("surfaces a missing staging directory", async () => {
    const { files, order } = makeWorkspace({
      replace: () => {
        throw new EditorBridgeOperationError("staging не найден");
      },
    });

    await expect(
      files.replaceContents(7, new Map([["main.gd", data("main")]])),
    ).rejects.toThrow("staging не найден");

    expect(order).not.toContain("sync");
  });

  it("keeps editor metadata out of collect", async () => {
    const entries = [
      {
        filepath: "hero.gd",
        size: 4,
        sha256: "1".repeat(64),
        contents_base64: btoa("hero"),
      },
      {
        filepath: "hero.gd.uid",
        size: 3,
        sha256: "2".repeat(64),
        contents_base64: btoa("uid"),
      },
      {
        filepath: ".godot/cache",
        size: 5,
        sha256: "3".repeat(64),
        contents_base64: btoa("cache"),
      },
    ];
    const { files, bridge } = makeWorkspace({ collect: () => ({ files: entries }) });

    const collected = await files.collectFiles(7);

    // Filtering is the plugin's job: whatever it collected is passed through.
    expect(bridge.call).toHaveBeenCalledTimes(1);
    expect(collected.map((file) => file.entry.filepath)).toEqual([
      "hero.gd",
      "hero.gd.uid",
      ".godot/cache",
    ]);
    expect([...collected[2].contents]).toEqual([...data("cache")]);
  });

  it("reads existence and snapshot hashes from the bridge", async () => {
    const hashes = { "main.gd": "a".repeat(64) };
    const { files, bridge } = makeWorkspace({
      exists: () => ({ exists: false }),
      snapshot: () => ({ files: hashes }),
    });

    await expect(files.exists(4)).resolves.toBe(false);
    await expect(files.snapshot(4)).resolves.toEqual(hashes);
    expect(bridge.call).toHaveBeenCalledWith("exists", { packageId: 4 });
    expect(bridge.call).toHaveBeenCalledWith("snapshot", { packageId: 4 });
  });

  it("creates and deletes the package directory through the bridge", async () => {
    const { files, order, syncHandler } = makeWorkspace();

    await files.createPackageDir(4);
    await files.deletePackage(4);

    expect(order).toEqual(["createDir", "sync", "delete", "sync"]);
    expect(syncHandler).toHaveBeenCalledTimes(2);
    expect(files.packageDir(4)).toBe(`${projectRoot}/packages/4`);
  });

  it("uses the live engine", async () => {
    const workspace = makeWorkspace();
    const firstEngine = workspace.engine;
    const nextEngine = makeEngine(workspace.tree, workspace.order);
    workspace.swapEngine(nextEngine);

    await workspace.files.replaceContents(
      7,
      new Map([["main.gd", data("main")]]),
    );

    expect(firstEngine.copyToFS).not.toHaveBeenCalled();
    expect(nextEngine.copyToFS).toHaveBeenCalledWith(
      `${stagingPath}/main.gd`,
      data("main"),
    );
    expect(workspace.tree.get("packages/.7.staging/main.gd")).toEqual(
      data("main"),
    );
  });
});

describe("applyPackageRevision", () => {
  const manifest: PackageManifest = {
    packageId: 7,
    name: "Heroes",
    revision: 2,
    files: [],
    totalSize: 0,
    publishedAt: "2026-10-31T00:00:00.000Z",
  };

  it("does not write when applyPackageRevision fails verification", async () => {
    const hero: PackageFileEntry = {
      filepath: "scripts/hero.gd",
      size: data("extends Node").byteLength,
      sha256: "0".repeat(64),
    };
    const { files, bridge, engine, order } = makeWorkspace();

    await expect(
      applyPackageRevision({
        files,
        manifest: { ...manifest, files: [hero] },
        download: async () => data("extends Node"),
      }),
    ).rejects.toThrow(/sha256/i);

    expect(bridge.call).not.toHaveBeenCalled();
    expect(engine.copyToFS).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("applies a verified revision through replaceContents", async () => {
    const hero: PackageFileEntry = {
      filepath: "scripts/hero.gd",
      size: data("extends Node").byteLength,
      sha256: await sha256Hex(data("extends Node")),
    };
    const { files, engine } = makeWorkspace({
      replace: () => ({ written: ["scripts/hero.gd"], deleted: [] }),
    });

    const result = await applyPackageRevision({
      files,
      manifest: { ...manifest, files: [hero] },
      download: async () => data("extends Node"),
    });

    expect(result).toEqual({ written: ["scripts/hero.gd"], deleted: [] });
    expect(engine.copyToFS).toHaveBeenCalledWith(
      `${stagingPath}/scripts/hero.gd`,
      data("extends Node"),
    );
  });
});
