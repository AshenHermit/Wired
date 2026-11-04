import { describe, expect, it, vi } from "vitest";
import {
  checkPackageSlugAvailability,
  deleteScriptingPackage,
  getRevisionFile,
  lookupWorkshopPackage,
  uploadRevisionFile,
} from "./scripting-packages";

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    getFile: vi.fn(),
    post: vi.fn(),
    postFile: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../api-client/api-client", () => ({ apiClient }));

describe("package file paths", () => {
  it("encodes every segment but keeps the separators", async () => {
    const file = new File([new Uint8Array([1])], "hero.txt");

    await uploadRevisionFile(3, 2, "ui/hero card.gd", file);

    expect(apiClient.postFile).toHaveBeenCalledWith(
      "scripting-packages/3/revisions/2/files/ui/hero%20card.gd",
      file,
    );
  });

  it("reads a revision file through the same encoding", () => {
    getRevisionFile(3, 2, "tex/a?b.png");

    expect(apiClient.getFile).toHaveBeenCalledWith(
      "scripting-packages/3/revisions/2/files/tex/a%3Fb.png",
    );
  });
});

describe("checkPackageSlugAvailability", () => {
  it("sends only the slug when there is no room or exclusion", () => {
    checkPackageSlugAvailability("hero");

    expect(apiClient.get).toHaveBeenCalledWith(
      "scripting-packages/slug-availability",
      { slug: "hero" },
    );
  });

  it("passes the room and the excluded package when given", () => {
    // Renaming a package has to exclude its own current row, otherwise it
    // would always look taken.
    checkPackageSlugAvailability("hero", 4, 9);

    expect(apiClient.get).toHaveBeenCalledWith(
      "scripting-packages/slug-availability",
      { slug: "hero", roomId: 4, excludeId: 9 },
    );
  });
});

describe("lookupWorkshopPackage", () => {
  it("unwraps the package from the envelope", async () => {
    apiClient.get.mockResolvedValueOnce({ package: { id: 5 } });

    await expect(lookupWorkshopPackage("hero")).resolves.toEqual({ id: 5 });
  });

  it("resolves null when the workshop has no such slug", async () => {
    apiClient.get.mockResolvedValueOnce({ package: null });

    await expect(lookupWorkshopPackage("missing")).resolves.toBeNull();
  });
});

describe("deleteScriptingPackage", () => {
  it("delegates to the client without awaiting it", () => {
    const pending = Promise.resolve(undefined);
    apiClient.delete.mockReturnValueOnce(pending);

    expect(deleteScriptingPackage(8)).toBe(pending);
    expect(apiClient.delete).toHaveBeenCalledWith("scripting-packages/8");
  });
});
