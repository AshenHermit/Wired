import { PackageFileEntry, PackageManifest } from "@wired-io/shared";
import { describe, expect, it, vi } from "vitest";
import {
  EditorBridgeOperationError,
  type EditorBridgeClient,
} from "./editor-bridge";
import {
  GodotFsError,
  applyPackageRevision,
  assertPackageSlug,
  assertRelativePackagePath,
  createPackageFileSystem,
  type PackageEngine,
  type PackageFileSystem,
} from "./godot-packages-fs";
import { sha256Hex } from "@/utils/sha256";

const projectRoot = "/home/web_user/Wired";
const stagingPath = `${projectRoot}/packages/.hero.staging`;
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
function makeWorkspace(
  overrides: Record<string, Handler> = {},
  options: { getEngine?: () => PackageEngine } = {},
) {
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
    getEngine: options.getEngine ?? (() => engine),
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

describe("assertPackageSlug", () => {
  it("accepts lowercase slugs and legacy numeric slugs", () => {
    for (const slug of ["hero", "hero_2", "7"]) {
      expect(assertPackageSlug(slug)).toBe(slug);
    }
  });

  it("rejects unsafe, uppercase or overlong slugs", () => {
    for (const slug of [
      "Hero",
      "../escape",
      "",
      "hero-2",
      "hero/2",
      "a".repeat(65),
    ]) {
      expect(() => assertPackageSlug(slug)).toThrow("Недопустимый slug пакета");
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

    const collected = await files.collectFiles("demo");

    expect(bridge.call).toHaveBeenCalledWith("collect", {
      packageSlug: "demo",
    });
    expect(collected).toHaveLength(1);
    expect(collected[0].entry).toEqual({
      filepath: "main.gd",
      size: 4,
      sha256: "a".repeat(64),
    });
    expect([...collected[0].contents]).toEqual([116, 101, 115, 116]);
  });

  it("decodes binary payloads and wrapped base64 without a JS string", async () => {
    // 0x00 0xff 0x80 0x0a are not valid UTF-8 text, and the plugin may wrap a
    // long payload. Both must survive decoding byte for byte.
    const bytes = [0x00, 0xff, 0x80, 0x0a, 0x7f];
    const encoded = btoa(String.fromCharCode(...bytes));
    const wrapped = `${encoded.slice(0, 4)}\n${encoded.slice(4)}`;
    const { files } = makeWorkspace({
      collect: () => ({
        files: [
          {
            filepath: "assets/icon.png",
            size: bytes.length,
            sha256: "b".repeat(64),
            contents_base64: wrapped,
          },
        ],
      }),
    });

    const collected = await files.collectFiles("demo");

    expect([...collected[0].contents]).toEqual(bytes);
  });

  it("rejects a malformed base64 payload as GodotFsError", async () => {
    const { files } = makeWorkspace({
      collect: () => ({
        files: [
          {
            filepath: "main.gd",
            size: 4,
            sha256: "a".repeat(64),
            contents_base64: "not base64!*",
          },
        ],
      }),
    });

    await expect(files.collectFiles("demo")).rejects.toBeInstanceOf(GodotFsError);
  });

  it("writes staging then swaps", async () => {
    const { files, tree, order } = makeWorkspace({
      replace: () => ({ written: ["main.gd", "scenes/a.tscn"], deleted: ["old.gd"] }),
    });

    const result = await files.replaceContents(
      "hero",
      new Map([
        ["main.gd", data("main")],
        ["scenes/a.tscn", data("[gd_scene]")],
      ]),
    );

    expect(result).toEqual({
      written: ["main.gd", "scenes/a.tscn"],
      deleted: ["old.gd"],
    });
    expect(tree.get("packages/.hero.staging/main.gd")).toEqual(data("main"));
    expect(tree.get("packages/.hero.staging/scenes/a.tscn")).toEqual(
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
      files.replaceContents("hero", new Map([["main.gd", data("main")]])),
    ).rejects.toThrow("staging не найден");

    expect(order).not.toContain("sync");
  });

  it("rejects an invalid staging path from the bridge", async () => {
    const { files, engine, order } = makeWorkspace({
      prepareReplace: () => ({ staging_path: "" }),
    });

    const replacement = files.replaceContents(
      "hero",
      new Map([["main.gd", data("main")]]),
    );

    await expect(replacement).rejects.toBeInstanceOf(GodotFsError);
    await expect(replacement).rejects.toThrow(/некорректный каталог staging/);
    expect(engine.copyToFS).not.toHaveBeenCalled();
    expect(order).not.toContain("replace");
    expect(order).not.toContain("sync");
  });

  it("rejects an absolute staging path outside the package tree", async () => {
    const { files, engine, order } = makeWorkspace({
      prepareReplace: () => ({
        staging_path: "/home/web_user/other/.hero.staging",
      }),
    });

    const replacement = files.replaceContents(
      "hero",
      new Map([["main.gd", data("main")]]),
    );

    await expect(replacement).rejects.toBeInstanceOf(GodotFsError);
    await expect(replacement).rejects.toThrow(/некорректный каталог staging/);
    expect(engine.copyToFS).not.toHaveBeenCalled();
    expect(order).not.toContain("replace");
    expect(order).not.toContain("sync");
  });

  it("rejects a staging path of another package", async () => {
    const { files, engine, order } = makeWorkspace({
      prepareReplace: () => ({
        staging_path: `${projectRoot}/packages/.demo.staging`,
      }),
    });

    const replacement = files.replaceContents(
      "hero",
      new Map([["main.gd", data("main")]]),
    );

    await expect(replacement).rejects.toThrow(/некорректный каталог staging/);
    expect(engine.copyToFS).not.toHaveBeenCalled();
    expect(order).not.toContain("replace");
    expect(order).not.toContain("sync");
  });

  it("reports a reset editor as GodotFsError before creating staging", async () => {
    // The engine getter used by the panel throws GodotFsError when the editor
    // instance was reset between `prepareReplace` and `copyToFS`.
    const { files, bridge, order, tree } = makeWorkspace(
      {},
      {
        getEngine: () => {
          throw new GodotFsError(
            "Файловая система Godot-редактора ещё не готова: дождитесь загрузки проекта",
          );
        },
      },
    );

    const replacement = files.replaceContents(
      "hero",
      new Map([["main.gd", data("main")]]),
    );

    await expect(replacement).rejects.toBeInstanceOf(GodotFsError);
    await expect(replacement).rejects.toThrow(/ещё не готова/);
    // Nothing was staged: the plugin was never asked to prepare a directory.
    expect(bridge.call).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(tree.size).toBe(0);
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

    const collected = await files.collectFiles("hero");

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

    await expect(files.exists("demo")).resolves.toBe(false);
    await expect(files.snapshot("demo")).resolves.toEqual(hashes);
    expect(bridge.call).toHaveBeenCalledWith("exists", {
      packageSlug: "demo",
    });
    expect(bridge.call).toHaveBeenCalledWith("snapshot", {
      packageSlug: "demo",
    });
  });

  it("creates and addresses a package directory by slug", async () => {
    const { files, bridge, order, syncHandler } = makeWorkspace();

    await files.createPackageDir("hero");

    expect(files.packageDir("hero")).toBe(`${projectRoot}/packages/hero`);
    expect(bridge.call).toHaveBeenCalledWith(
      "createDir",
      expect.objectContaining({ packageSlug: "hero" }),
    );
    expect(order).toEqual(["createDir", "sync"]);
    expect(syncHandler).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid slug before calling the bridge", async () => {
    const { files, bridge, order } = makeWorkspace();

    await expect(files.createPackageDir("../escape")).rejects.toBeInstanceOf(
      GodotFsError,
    );
    expect(bridge.call).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("creates and deletes the package directory through the bridge", async () => {
    const { files, bridge, order, syncHandler } = makeWorkspace();

    await files.createPackageDir("demo");
    await files.deletePackage("demo");

    expect(order).toEqual(["createDir", "sync", "delete", "sync"]);
    expect(syncHandler).toHaveBeenCalledTimes(2);
    expect(bridge.call).toHaveBeenCalledWith("delete", {
      packageSlug: "demo",
    });
    expect(files.packageDir("demo")).toBe(`${projectRoot}/packages/demo`);
  });

  it("renames a package directory through the bridge and syncs", async () => {
    const { files, bridge, order, syncHandler } = makeWorkspace({
      rename: () => ({ rewritten: ["a.gd"] }),
    });

    await expect(files.renamePackage("hero", "hero2")).resolves.toEqual([
      "a.gd",
    ]);

    expect(bridge.call).toHaveBeenCalledWith("rename", {
      packageSlug: "hero",
      newSlug: "hero2",
    });
    expect(order).toEqual(["rename", "sync"]);
    expect(syncHandler).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid slugs before renaming", async () => {
    const { files, bridge } = makeWorkspace();

    await expect(files.renamePackage("Hero", "hero2")).rejects.toBeInstanceOf(
      GodotFsError,
    );
    await expect(files.renamePackage("hero", "../hero2")).rejects.toBeInstanceOf(
      GodotFsError,
    );
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("uses the live engine", async () => {
    const workspace = makeWorkspace();
    const firstEngine = workspace.engine;
    const nextEngine = makeEngine(workspace.tree, workspace.order);
    workspace.swapEngine(nextEngine);

    await workspace.files.replaceContents(
      "hero",
      new Map([["main.gd", data("main")]]),
    );

    expect(firstEngine.copyToFS).not.toHaveBeenCalled();
    expect(nextEngine.copyToFS).toHaveBeenCalledWith(
      `${stagingPath}/main.gd`,
      data("main"),
    );
    expect(workspace.tree.get("packages/.hero.staging/main.gd")).toEqual(
      data("main"),
    );
  });
});

describe("applyPackageRevision", () => {
  const manifest: PackageManifest = {
    packageId: 7,
    slug: "hero",
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
