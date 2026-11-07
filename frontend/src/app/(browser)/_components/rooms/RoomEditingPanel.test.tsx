import type { Room } from "@wired-io/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl as render } from "@/test/render-with-intl";

vi.mock("@/api/services/rooms", () => ({
  createRoom: vi.fn(),
  updateRoom: vi.fn(),
  deleteRoom: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import * as roomsApi from "@/api/services/rooms";
import {
  RoomEditingPanel,
  type RoomEditingPanelApi,
} from "./RoomEditingPanel";

function roomFixture(overrides: Partial<Room> = {}): Room {
  return {
    id: 7,
    name: "Hero room",
    isPublic: true,
    description: "desc",
    type: "godot",
    parentRoomId: null,
    previewImage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    author: { id: 1, name: "Ann", picture: "p" },
    ...overrides,
  };
}

async function openEdit(room: Room = roomFixture()) {
  const ref = createRef<RoomEditingPanelApi>();
  render(<RoomEditingPanel ref={ref} />, { locale: "en" });
  await act(async () => {
    ref.current!.edit(room);
  });
  return ref;
}

describe("RoomEditingPanel delete confirm", () => {
  beforeEach(() => {
    vi.mocked(roomsApi.deleteRoom).mockReset();
    vi.mocked(roomsApi.deleteRoom).mockResolvedValue(undefined);
  });

  it("shows a warning dialog and does not delete yet", async () => {
    await openEdit();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialogs = await screen.findAllByRole("dialog");
    const confirm = dialogs[dialogs.length - 1]!;
    expect(within(confirm).getByText("Delete room?")).toBeTruthy();
    expect(
      within(confirm).getByText(/Hero room.*packages, revisions, and artifacts/),
    ).toBeTruthy();
    expect(roomsApi.deleteRoom).not.toHaveBeenCalled();
  });

  it("does not call deleteRoom when the warning is cancelled", async () => {
    await openEdit();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialogs = await screen.findAllByRole("dialog");
    const confirm = dialogs[dialogs.length - 1]!;
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Delete room?")).toBeNull();
    });
    expect(roomsApi.deleteRoom).not.toHaveBeenCalled();
  });

  it("calls deleteRoom after the warning is confirmed", async () => {
    await openEdit();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialogs = await screen.findAllByRole("dialog");
    const confirm = dialogs[dialogs.length - 1]!;
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Delete room" }),
    );

    await waitFor(() => {
      expect(roomsApi.deleteRoom).toHaveBeenCalledWith(7);
    });
  });
});
