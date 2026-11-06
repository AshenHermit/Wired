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

function Harness({
  initial,
  onRender,
}: {
  initial?: (v: { width: number; height: number }) => { x: number; y: number };
  onRender?: () => void;
}) {
  const { panelRef, gripProps, style } = useDraggablePanel({
    storageKey: ROOM_TABS_POSITION_KEY,
    initialPosition: initial ?? (() => ({ x: 0, y: 0 })),
  });
  onRender?.();
  return (
    <div data-testid="panel" ref={panelRef} style={style}>
      <button type="button" data-testid="grip" {...gripProps} />
    </div>
  );
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

  it("tracks the pointer outside the grip and persists on release", () => {
    render(<Harness initial={() => ({ x: 100, y: 50 })} />);
    const grip = screen.getByTestId("grip");

    fireEvent.pointerDown(grip, {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 150,
      clientY: 120,
    });

    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(150px, 70px, 0)",
    );
    expect(localStorage.getItem(ROOM_TABS_POSITION_KEY)).toBeNull();

    fireEvent.pointerUp(document, { pointerId: 1 });

    expect(localStorage.getItem(ROOM_TABS_POSITION_KEY)).toBe(
      JSON.stringify({ x: 150, y: 70 }),
    );
  });

  it("clamps a drag at the viewport edges", () => {
    render(<Harness initial={() => ({ x: 700, y: 700 })} />);
    const grip = screen.getByTestId("grip");

    fireEvent.pointerDown(grip, {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 600,
      clientY: 600,
    });

    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(800px, 764px, 0)",
    );
  });

  it("moves with arrow keys, using Shift for a fine step", () => {
    render(<Harness initial={() => ({ x: 100, y: 50 })} />);
    const grip = screen.getByTestId("grip");

    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });

    expect(screen.getByTestId("panel").style.transform).toBe(
      "translate3d(111px, 50px, 0)",
    );
    expect(localStorage.getItem(ROOM_TABS_POSITION_KEY)).toBe(
      JSON.stringify({ x: 111, y: 50 }),
    );
  });

  it("does not re-render on every pointer move", () => {
    const onRender = vi.fn();
    render(<Harness initial={() => ({ x: 100, y: 50 })} onRender={onRender} />);
    const grip = screen.getByTestId("grip");

    fireEvent.pointerDown(grip, {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    const rendersAfterPointerDown = onRender.mock.calls.length;

    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 120,
      clientY: 110,
    });
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 140,
      clientY: 120,
    });

    expect(onRender.mock.calls.length).toBe(rendersAfterPointerDown);
  });
});
