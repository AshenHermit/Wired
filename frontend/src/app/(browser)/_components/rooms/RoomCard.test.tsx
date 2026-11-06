import type { Room } from "@wired-io/shared";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithIntl as render } from "@/test/render-with-intl";
import { withApiPrefix } from "@/utils/variables";
import { RoomCard } from "./RoomCard";

const PREVIEW = `/media/${"e".repeat(64)}.webp`;

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 3,
    name: "Hero room",
    isPublic: true,
    description: "",
    type: "godot",
    parentRoomId: null,
    previewImage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    author: { id: 7, name: "Ann", picture: "p" },
    ...overrides,
  };
}

describe("RoomCard", () => {
  it("shows a left thumbnail when previewImage is set", () => {
    const { container } = render(
      <RoomCard room={room({ previewImage: PREVIEW })} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(withApiPrefix(PREVIEW));
    expect(screen.getByText("Hero room")).toBeTruthy();
  });

  it("keeps a text-only layout without previewImage", () => {
    const { container } = render(<RoomCard room={room()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Hero room")).toBeTruthy();
    expect(screen.getByText("Ann")).toBeTruthy();
  });
});
