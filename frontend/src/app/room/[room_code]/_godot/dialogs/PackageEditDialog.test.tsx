import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/test/render-with-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room, ScriptingPackage } from "@wired-io/shared";

vi.mock("@/api/services/scripting-packages", () => ({
  getScriptingPackage: vi.fn(),
  updatePackageAccess: vi.fn(),
  listWorkshopTags: vi.fn(),
}));

import * as packagesApi from "@/api/services/scripting-packages";
import { PackageEditDialog } from "./PackageEditDialog";
import {
  SlugRenameDependentsError,
  type RoomPackageEntry,
} from "../use-room-packages";

function packageFixture(
  overrides: Partial<ScriptingPackage> = {},
): ScriptingPackage {
  return {
    id: 5,
    slug: "hero",
    name: "Hero",
    version: "0.1.0",
    description: "",
    tags: [],
    enabled: true,
    dependencies: [],
    previewImage: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    author: { id: 1, name: "author", picture: "" },
    contributors: [],
    editingAccess: "author",
    editingUserIds: [],
    ...overrides,
  };
}

function entry(overrides: Partial<RoomPackageEntry> = {}): RoomPackageEntry {
  return {
    packageId: 5,
    slug: "hero",
    name: "Hero",
    version: "0.1.0",
    description: "",
    tags: [],
    previewImage: null,
    status: "loaded",
    enabled: true,
    loaded: true,
    inEditor: true,
    publishedRevision: 2,
    loadedRevision: 2,
    publishedAt: "2026-10-30T10:00:00.000Z",
    sizeBytes: null,
    localChanges: [],
    backendState: "ready",
    runtimeState: "applied",
    runtimeError: null,
    clientsReady: 1,
    clientsTotal: 1,
    ...overrides,
  };
}

function roomFixture(overrides: Partial<Room> = {}): Room {
  return {
    id: 1,
    name: "Room",
    type: "godot",
    description: "",
    isPublic: false,
    parentRoomId: null,
    previewImage: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    packageManagementAccess: "author",
    packageManagementUserIds: [],
    packageCreationAccess: "author",
    packageCreationUserIds: [],
    ...overrides,
  };
}

describe("PackageEditDialog", () => {
  beforeEach(() => {
    vi.mocked(packagesApi.getScriptingPackage).mockReset();
    vi.mocked(packagesApi.getScriptingPackage).mockResolvedValue(
      packageFixture(),
    );
    vi.mocked(packagesApi.listWorkshopTags).mockResolvedValue({
      items: [],
      total: 0,
    });
  });

  it("confirms a dependent rewrite only through the warning's own button", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockRejectedValueOnce(
        new SlugRenameDependentsError([{ packageId: 9, name: "Boss" }]),
      )
      .mockResolvedValueOnce(undefined);
    const renamePackageDir = vi.fn();
    const checkSlugAvailability = vi
      .fn()
      .mockResolvedValue({ available: true });
    const onOpenChange = vi.fn();

    render(
      <PackageEditDialog
        open
        onOpenChange={onOpenChange}
        entry={entry()}
        packages={{
          checkSlugAvailability,
          updatePackageMetadata,
          renamePackageDir,
        }}
        viewerId={1}
        room={roomFixture()}
      />,
      { locale: "en" },
    );

    fireEvent.change(await screen.findByLabelText("Slug"), {
      target: { value: "hero_two" },
    });

    // The availability probe is debounced, so wait until Save is enabled.
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(save);

    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenCalledTimes(1),
    );
    expect(updatePackageMetadata.mock.calls[0]![1]).toMatchObject({
      slug: "hero_two",
    });
    expect(updatePackageMetadata.mock.calls[0]![1]).not.toHaveProperty(
      "confirmSlugRename",
    );

    // The refusal is reported with the packages that point at the old slug.
    expect(await screen.findByText("Boss")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // Enter (a form submit) must not turn the pending warning into a rewrite.
    fireEvent.submit(document.querySelector("form")!);
    expect(updatePackageMetadata).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Rename and update references" }),
    );
    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenCalledTimes(2),
    );
    expect(updatePackageMetadata.mock.calls[1]![1]).toMatchObject({
      slug: "hero_two",
      confirmSlugRename: true,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("drops the warning when the slug is edited again", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockRejectedValueOnce(
        new SlugRenameDependentsError([{ packageId: 9, name: "Boss" }]),
      );
    const checkSlugAvailability = vi
      .fn()
      .mockResolvedValue({ available: true });

    render(
      <PackageEditDialog
        open
        onOpenChange={vi.fn()}
        entry={entry()}
        packages={{
          checkSlugAvailability,
          updatePackageMetadata,
          renamePackageDir: vi.fn(),
        }}
        viewerId={1}
        room={roomFixture()}
      />,
      { locale: "en" },
    );

    const slug = await screen.findByLabelText("Slug");
    fireEvent.change(slug, { target: { value: "hero_two" } });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(save);

    expect(await screen.findByText("Boss")).toBeTruthy();

    // The warning described "hero_two"; a different slug is a different rename.
    fireEvent.change(slug, { target: { value: "hero_three" } });
    await waitFor(() =>
      expect(screen.queryByText("Boss")).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled(),
    );
  });
});
