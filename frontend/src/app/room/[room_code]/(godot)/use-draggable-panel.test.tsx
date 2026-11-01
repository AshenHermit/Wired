import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  ROOM_TABS_POSITION_KEY,
  clampPanelPosition,
  useDraggablePanel,
} from "./use-draggable-panel";

const panel = { width: 200, height: 36 };

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setViewport(1000, 800);
  localStorage.clear();
  rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      ...panel,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: panel.width,
      bottom: panel.height,
      toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
  rectSpy.mockRestore();
});

function Harness({ initial }: { initial?: (v: { width: number; height: number }) => { x: number; y: number } }) {
  const { panelRef, style } = useDraggablePanel({
    storageKey: ROOM_TABS_POSITION_KEY,
    initialPosition: initial ?? (() => ({ x: 0, y: 0 })),
  });
  return <div data-testid="panel" ref={panelRef} style={style} />;
}

describe("clampPanelPosition", () => {
  it("keeps a position inside the viewport", () => {
    expect(
      clampPanelPosition({ x: 100, y: 50, panel, viewport: { width: 1000, height: 800 } }),
    ).toEqual({ x: 100, y: 50 });
  });

  it("stops at the left and top edges", () => {
    expect(
      clampPanelPosition({ x: -40, y: -10, panel, viewport: { width: 1000, height: 800 } }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("stops at the right and bottom edges", () => {
    expect(
      clampPanelPosition({ x: 5000, y: 5000, panel, viewport: { width: 1000, height: 800 } }),
    ).toEqual({ x: 800, y: 764 });
  });

  it("pins a panel wider than the viewport to the left edge", () => {
    expect(
      clampPanelPosition({ x: 300, y: 10, panel, viewport: { width: 150, height: 100 } }),
    ).toEqual({ x: 0, y: 10 });
  });

  it("honours the margin on every edge", () => {
    expect(
      clampPanelPosition({ x: -50, y: 5000, panel, viewport: { width: 1000, height: 800 }, margin: 8 }),
    ).toEqual({ x: 8, y: 756 });
  });
});

describe("useDraggablePanel", () => {
  it("restores a stored position clamped to the current viewport", () => {
    localStorage.setItem(
      ROOM_TABS_POSITION_KEY,
      JSON.stringify({ x: 5000, y: -40 }),
    );
    render(<Harness />);
    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(800px, 0px, 0)",
    );
  });

  it("falls back to the initial position and drops corrupt storage", () => {
    localStorage.setItem(ROOM_TABS_POSITION_KEY, "{oops");
    render(<Harness initial={() => ({ x: 100, y: 20 })} />);
    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(100px, 20px, 0)",
    );
    expect(localStorage.getItem(ROOM_TABS_POSITION_KEY)).toBeNull();
  });

  it("re-clamps when the window shrinks", async () => {
    localStorage.setItem(
      ROOM_TABS_POSITION_KEY,
      JSON.stringify({ x: 800, y: 0 }),
    );
    render(<Harness />);
    setViewport(600, 800);
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(400px, 0px, 0)",
    );
  });
});
