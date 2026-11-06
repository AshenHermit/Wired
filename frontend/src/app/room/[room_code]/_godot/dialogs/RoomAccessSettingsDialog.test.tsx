import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/test/render-with-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@wired-io/shared";

vi.mock("@/api/services/rooms", () => ({
  updateRoomAccess: vi.fn(),
}));

import * as roomsApi from "@/api/services/rooms";
import { RoomAccessSettingsDialog } from "./RoomAccessSettingsDialog";

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

describe("RoomAccessSettingsDialog", () => {
  beforeEach(() => {
    vi.mocked(roomsApi.updateRoomAccess).mockReset();
  });

  it("reports the saved room so the parent can refresh stale access fields", async () => {
    const saved = roomFixture({
      packageManagementAccess: "all",
      packageCreationAccess: "author",
    });
    vi.mocked(roomsApi.updateRoomAccess).mockResolvedValue(saved);
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <RoomAccessSettingsDialog
        open
        onOpenChange={onOpenChange}
        room={roomFixture()}
        onSaved={onSaved}
      />,
      { locale: "en" },
    );

    // Two AccessSections share the same mode labels; change package management.
    fireEvent.click(screen.getAllByRole("button", { name: "Everyone" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(roomsApi.updateRoomAccess).toHaveBeenCalledWith(1, {
        packageManagementAccess: "all",
        packageManagementUserIds: [],
        packageCreationAccess: "author",
        packageCreationUserIds: [],
      });
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("re-seeds from the room prop when reopened after the parent refreshes", () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(
      <RoomAccessSettingsDialog
        open
        onOpenChange={onOpenChange}
        room={roomFixture({ packageManagementAccess: "author" })}
        onSaved={onSaved}
      />,
      { locale: "en" },
    );

    expect(screen.queryByLabelText("Search users")).toBeNull();

    view.rerender(
      <RoomAccessSettingsDialog
        open={false}
        onOpenChange={onOpenChange}
        room={roomFixture({ packageManagementAccess: "author" })}
        onSaved={onSaved}
      />,
    );
    view.rerender(
      <RoomAccessSettingsDialog
        open
        onOpenChange={onOpenChange}
        room={roomFixture({
          packageManagementAccess: "users",
          packageManagementUserIds: [7],
        })}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByLabelText("Search users")).toBeTruthy();
  });
});
