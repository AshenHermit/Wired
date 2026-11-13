import {
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
  PackageRevisionDraft,
} from "@wired-io/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CollectedPackageFile,
  type PackageFileSystem,
} from "./godot-packages-fs";
import {
  planPackageSync,
  publishPackageFiles,
  reconcilePackageRevision,
  overwritePackageRevision,
  type PackageBaseline,
} from "./package-sync";
import { sha256Hex } from "@/utils/sha256";

vi.mock("@/api/services/scripting-packages", () => ({
  createPackageRevision: vi.fn(),
  uploadRevisionFileAsUint8Array: vi.fn(),
  publishPackageRevision: vi.fn(),
  getPackageManifest: vi.fn(),
  getRevisionFile: vi.fn(),
}));

import * as api from "@/api/services/scripting-packages";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const projectRoot = "/home/web_user/Wired";

/** Package files by package slug and package-relative path. */
type PackageTree = Map<string, Map<string, string>>;

function put(
  tree: PackageTree,
  slug: string,
  filepath: string,
  contents: string
): void {
  const files = tree.get(slug) ?? new Map<string, string>();
  files.set(filepath, contents);
  tree.set(slug, files);
}

/**
 * In-memory stand-in for `PackageFileSystem`. The bridge and the editor plugin
 * are covered by `godot-packages-fs.test.ts`; here only the calls `package-sync`
 * makes matter, so every method is a spy backed by a simple package tree keyed
 * by slug.
 */
function makeFiles() {
  const tree: PackageTree = new Map();

  const files: PackageFileSystem = {
    packageDir: vi.fn((slug: string) => `${projectRoot}/packages/${slug}`),
    exists: vi.fn(async (slug: string) => tree.has(slug)),
    createPackageDir: vi.fn(async (slug: string) => {
      tree.set(slug, new Map());
    }),
    snapshot: vi.fn(async (slug: string) => {
      const hashes: Record<string, string> = {};
      for (const [filepath, contents] of tree.get(slug) ?? []) {
        hashes[filepath] = await sha256Hex(encoder.encode(contents));
      }
      return hashes;
    }),
    collectFiles: vi.fn(async (slug: string) => {
      const collected: CollectedPackageFile[] = [];
      const packageFiles = tree.get(slug) ?? new Map<string, string>();
      for (const filepath of [...packageFiles.keys()].sort()) {
        const contents = encoder.encode(packageFiles.get(filepath) ?? "");
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
    }),
    replaceContents: vi.fn(
      async (slug: string, contents: Map<string, Uint8Array>) => {
        const next = new Map<string, string>();
        for (const [filepath, bytes] of contents) {
          next.set(filepath, decoder.decode(bytes));
        }
        const previous = tree.get(slug) ?? new Map<string, string>();
        tree.set(slug, next);
        return {
          written: [...next.keys()].sort(),
          deleted: [...previous.keys()]
            .filter((filepath) => !next.has(filepath))
            .sort(),
        };
      }
    ),
    deletePackage: vi.fn(async (slug: string) => {
      tree.delete(slug);
    }),
    renamePackage: vi.fn(async (from: string, to: string) => {
      const contents = tree.get(from);
      if (!contents) return [];
      tree.set(to, contents);
      tree.delete(from);
      return [];
    }),
    flushFilesystem: vi.fn(async () => {}),
    dispose: vi.fn(),
  };

  return { tree, files };
}

async function entry(filepath: string, content: string): Promise<PackageFileEntry> {
  return {
    filepath,
    size: encoder.encode(content).byteLength,
    sha256: await sha256Hex(encoder.encode(content)),
  };
}

const revision = (revisionNumber: number, status: "draft" | "published"): PackageRevision => ({
  packageId: 5,
  revision: revisionNumber,
  status,
  files: [],
  createdAt: "2026-10-29T00:00:00.000Z",
  publishedAt: status === "published" ? "2026-10-29T00:01:00.000Z" : null,
});

/**
 * A draft response from the git path lists the files the server already has
 * content for. Omitting `missing` simulates an older server that never
 * reported it, so every file must be uploaded.
 */
const draftResponse = (
  revisionNumber: number,
  missing?: string[]
): PackageRevisionDraft =>
  missing
    ? { ...revision(revisionNumber, "draft"), missing }
    : ({ ...revision(revisionNumber, "draft") } as PackageRevisionDraft);

describe("publishPackageFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads every file of the package directory and publishes the revision", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "scripts/hero.gd", "extends Node");
    put(tree, "hero", "scenes/hero.tscn", "[gd_scene]");
    vi.mocked(api.createPackageRevision).mockResolvedValue(
      draftResponse(3, ["scenes/hero.tscn", "scripts/hero.gd"])
    );
    vi.mocked(api.uploadRevisionFileAsUint8Array).mockImplementation(
      async (_packageId, _revision, file) => ({
        size: file.size,
        sha256: file.sha256,
      })
    );
    vi.mocked(api.publishPackageRevision).mockResolvedValue(
      revision(3, "published")
    );

    const result = await publishPackageFiles(7, "hero", files);

    expect(files.collectFiles).toHaveBeenCalledWith("hero");
    expect(api.createPackageRevision).toHaveBeenCalledWith(7, {
      files: [
        await entry("scenes/hero.tscn", "[gd_scene]"),
        await entry("scripts/hero.gd", "extends Node"),
      ],
    });
    const uploadedPaths = vi
      .mocked(api.uploadRevisionFileAsUint8Array)
      .mock.calls.map(([packageId, revisionNumber, file]) => [
        packageId,
        revisionNumber,
        file.filepath,
      ]);
    expect(uploadedPaths).toEqual([
      [7, 3, "scenes/hero.tscn"],
      [7, 3, "scripts/hero.gd"],
    ]);
    expect(api.publishPackageRevision).toHaveBeenCalledWith(7, 3);
    expect(result.revision.status).toBe("published");
    expect(result.uploaded).toBe(2);
  });

  it("uploads only the files the server is missing", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "a.txt", "A");
    put(tree, "hero", "b.txt", "B");
    vi.mocked(api.createPackageRevision).mockResolvedValue(draftResponse(3, ["b.txt"]));
    vi.mocked(api.uploadRevisionFileAsUint8Array).mockImplementation(
      async (_packageId, _revision, file) => ({
        size: file.size,
        sha256: file.sha256,
      })
    );
    vi.mocked(api.publishPackageRevision).mockResolvedValue(
      revision(3, "published")
    );

    const result = await publishPackageFiles(1, "hero", files);

    expect(api.uploadRevisionFileAsUint8Array).toHaveBeenCalledTimes(1);
    expect(api.uploadRevisionFileAsUint8Array).toHaveBeenCalledWith(
      1,
      3,
      expect.objectContaining({ filepath: "b.txt" }),
      expect.anything()
    );
    expect(api.publishPackageRevision).toHaveBeenCalledWith(1, 3);
    expect(result.uploaded).toBe(1);
  });

  it("uploads everything when the server does not report missing files", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "a.txt", "A");
    put(tree, "hero", "b.txt", "B");
    vi.mocked(api.createPackageRevision).mockResolvedValue(draftResponse(3));
    vi.mocked(api.uploadRevisionFileAsUint8Array).mockImplementation(
      async (_packageId, _revision, file) => ({
        size: file.size,
        sha256: file.sha256,
      })
    );
    vi.mocked(api.publishPackageRevision).mockResolvedValue(
      revision(3, "published")
    );

    await publishPackageFiles(7, "hero", files);

    expect(api.uploadRevisionFileAsUint8Array).toHaveBeenCalledTimes(2);
  });

  it("stops before publishing when the server stored a different file", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "scripts/hero.gd", "extends Node");
    vi.mocked(api.createPackageRevision).mockResolvedValue(draftResponse(3));
    vi.mocked(api.uploadRevisionFileAsUint8Array).mockResolvedValue({
      size: 99,
      sha256: "b".repeat(64),
    });

    await expect(publishPackageFiles(7, "hero", files)).rejects.toThrow(
      /sha256|hash/i
    );

    expect(api.publishPackageRevision).not.toHaveBeenCalled();
  });

  it("refuses to publish an empty package", async () => {
    const { files } = makeFiles();

    await expect(publishPackageFiles(7, "hero", files)).rejects.toThrow(
      /no files/i
    );
    expect(api.createPackageRevision).not.toHaveBeenCalled();
  });
});

describe("overwritePackageRevision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads the latest manifest and applies it to the editor file system", async () => {
    const { tree, files } = makeFiles();
    const hero = await entry("scripts/hero.gd", "extends Node");
    const manifest: PackageManifest = {
      packageId: 5,
      slug: "hero",
      name: "Heroes",
      revision: 4,
      files: [hero],
      totalSize: hero.size,
      publishedAt: "2026-10-29T00:00:00.000Z",
    };
    vi.mocked(api.getPackageManifest).mockResolvedValue(manifest);
    vi.mocked(api.getRevisionFile).mockResolvedValue(
      encoder.encode("extends Node").buffer
    );

    const result = await overwritePackageRevision(5, "hero", files);

    expect(api.getRevisionFile).toHaveBeenCalledWith(5, 4, "scripts/hero.gd");
    expect(result.written).toEqual(["scripts/hero.gd"]);
    // The editor folder is addressed by the manifest slug, not the package id.
    expect(files.replaceContents).toHaveBeenCalledWith(
      "hero",
      expect.any(Map),
      expect.objectContaining({ onFileWritten: expect.any(Function) })
    );
    expect(tree.get("hero")?.get("scripts/hero.gd")).toBe("extends Node");
  });

  it("keeps the previous files when a download is corrupt", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "scripts/hero.gd", "extends Node");
    const hero = await entry("scripts/hero.gd", "extends Node");
    vi.mocked(api.getPackageManifest).mockResolvedValue({
      packageId: 5,
      slug: "hero",
      name: "Heroes",
      revision: 4,
      files: [hero],
      totalSize: hero.size,
      publishedAt: "2026-10-29T00:00:00.000Z",
    });
    vi.mocked(api.getRevisionFile).mockResolvedValue(
      encoder.encode("corrupted!!").buffer
    );

    await expect(overwritePackageRevision(5, "hero", files)).rejects.toThrow(
      /size|sha256/i
    );

    expect(tree.get("hero")?.get("scripts/hero.gd")).toBe("extends Node");
    expect(files.replaceContents).not.toHaveBeenCalled();
  });
});

function manifestOf(
  revisionNumber: number,
  files: Record<string, string>
): PackageManifest {
  const entries = Object.entries(files).map(([filepath, sha256]) => ({
    filepath,
    sha256,
    size: 9,
  }));
  return {
    packageId: 5,
    slug: "hero",
    name: "Heroes",
    revision: revisionNumber,
    files: entries,
    totalSize: entries.length,
    publishedAt: "2026-10-30T00:00:00.000Z",
  };
}

describe("planPackageSync", () => {
  it("applies a fresh package into an empty editor", () => {
    const plan = planPackageSync({}, manifestOf(1, { "hero.gd": "a" }), null);

    expect(plan.status).toBe("apply");
  });

  it("reports matching files at the same revision as up to date", () => {
    const baseline: PackageBaseline = {
      revision: 2,
      files: { "hero.gd": "a" },
    };

    const plan = planPackageSync(
      { "hero.gd": "a" },
      manifestOf(2, { "hero.gd": "a" }),
      baseline
    );

    expect(plan.status).toBe("up-to-date");
  });

  it("detects a local edit that the same revision would overwrite", () => {
    const plan = planPackageSync(
      { "hero.gd": "local" },
      manifestOf(2, { "hero.gd": "published" }),
      { revision: 2, files: { "hero.gd": "published" } }
    );

    expect(plan.status).toBe("conflict");
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        filepath: "hero.gd",
        reason: "modified",
        localSha256: "local",
        publishedSha256: "published",
      }),
    ]);
  });

  it("applies a new revision when local files still match the baseline", () => {
    const plan = planPackageSync(
      { "hero.gd": "old" },
      manifestOf(3, { "hero.gd": "new" }),
      { revision: 2, files: { "hero.gd": "old" } }
    );

    expect(plan.status).toBe("apply");
  });

  it("detects a local edit between revisions", () => {
    const plan = planPackageSync(
      { "hero.gd": "draft" },
      manifestOf(3, { "hero.gd": "new" }),
      { revision: 2, files: { "hero.gd": "old" } }
    );

    expect(plan.status).toBe("conflict");
    expect(plan.conflicts[0]).toMatchObject({ reason: "modified" });
  });

  it("detects an untracked local draft that would be deleted", () => {
    const plan = planPackageSync(
      { "notes.gd": "draft" },
      manifestOf(3, {}),
      { revision: 2, files: {} }
    );

    expect(plan.status).toBe("conflict");
    expect(plan.conflicts[0]).toMatchObject({
      filepath: "notes.gd",
      reason: "untracked",
    });
  });

  it("allows deleting a file that is unchanged from the baseline", () => {
    const plan = planPackageSync(
      { "old.gd": "old" },
      manifestOf(3, {}),
      { revision: 2, files: { "old.gd": "old" } }
    );

    expect(plan.status).toBe("apply");
  });

  it("does not guess when local files differ and no baseline exists", () => {
    const plan = planPackageSync(
      { "hero.gd": "unknown" },
      manifestOf(1, { "hero.gd": "published" }),
      null
    );

    expect(plan.status).toBe("conflict");
    expect(plan.conflicts[0]).toMatchObject({ reason: "modified" });
  });
});

describe("reconcilePackageRevision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps local edits and reports a conflict instead of overwriting", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "hero.gd", "local draft");
    vi.mocked(api.getPackageManifest).mockResolvedValue(
      manifestOf(4, { "hero.gd": await sha256Hex(encoder.encode("published")) })
    );
    vi.mocked(api.getRevisionFile).mockResolvedValue(
      encoder.encode("published").buffer
    );

    const result = await reconcilePackageRevision(5, "hero", files, {
      revision: 3,
      files: { "hero.gd": await sha256Hex(encoder.encode("old")) },
    });

    expect(result.status).toBe("conflict");
    expect(tree.get("hero")?.get("hero.gd")).toBe("local draft");
    expect(files.replaceContents).not.toHaveBeenCalled();
    expect(api.getRevisionFile).not.toHaveBeenCalled();
  });

  it("replaces local files when the user explicitly forces the revision", async () => {
    const { tree, files } = makeFiles();
    put(tree, "hero", "hero.gd", "local draft");
    vi.mocked(api.getPackageManifest).mockResolvedValue(
      manifestOf(4, { "hero.gd": await sha256Hex(encoder.encode("published")) })
    );
    vi.mocked(api.getRevisionFile).mockResolvedValue(
      encoder.encode("published").buffer
    );

    const result = await reconcilePackageRevision(
      5,
      "hero",
      files,
      { revision: 3, files: { "hero.gd": await sha256Hex(encoder.encode("old")) } },
      { force: true }
    );

    expect(result.status).toBe("applied");
    expect(files.replaceContents).toHaveBeenCalledWith(
      "hero",
      expect.any(Map),
      expect.objectContaining({ onFileWritten: expect.any(Function) })
    );
    expect(tree.get("hero")?.get("hero.gd")).toBe("published");
    expect(vi.mocked(files.snapshot).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(files.replaceContents).mock.invocationCallOrder[0]
    );
  });
});
