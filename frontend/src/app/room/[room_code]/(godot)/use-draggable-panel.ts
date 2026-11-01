"use client";

import * as React from "react";

export const ROOM_TABS_POSITION_KEY = "wired.room-tabs.position.v1";

export type PanelSize = { width: number; height: number };
export type PanelPosition = { x: number; y: number };

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

export function clampPanelPosition({
  x,
  y,
  panel,
  viewport,
  margin = 0,
}: {
  x: number;
  y: number;
  panel: PanelSize;
  viewport: PanelSize;
  margin?: number;
}): PanelPosition {
  const maxX = Math.max(margin, viewport.width - panel.width - margin);
  const maxY = Math.max(margin, viewport.height - panel.height - margin);

  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

function readStoredPosition(storageKey: string): PanelPosition | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PanelPosition> | null;
    if (
      parsed &&
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return { x: parsed.x, y: parsed.y };
    }

    window.localStorage.removeItem(storageKey);
    return null;
  } catch {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Storage may be unavailable; the panel still works without persistence.
    }
    return null;
  }
}

export function useDraggablePanel({
  storageKey,
  initialPosition,
  margin = 0,
}: {
  storageKey: string;
  initialPosition: (viewport: PanelSize) => PanelPosition;
  margin?: number;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const positionRef = React.useRef<PanelPosition | null>(null);
  const initialPositionRef = React.useRef(initialPosition);
  const [position, setPosition] = React.useState<PanelPosition | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  React.useEffect(() => {
    initialPositionRef.current = initialPosition;
  }, [initialPosition]);

  const pointerIdRef = React.useRef<number | null>(null);
  const startPointerRef = React.useRef<PanelPosition>({ x: 0, y: 0 });
  const startPositionRef = React.useRef<PanelPosition>({ x: 0, y: 0 });

  const updatePosition = React.useCallback((next: PanelPosition) => {
    positionRef.current = next;
    setPosition(next);
  }, []);

  const getBounds = React.useCallback(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    return {
      panel: {
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    };
  }, []);

  const clampToViewport = React.useCallback(
    (next: PanelPosition) => {
      const { panel, viewport } = getBounds();
      return clampPanelPosition({ ...next, panel, viewport, margin });
    },
    [getBounds, margin],
  );

  const persist = React.useCallback(
    (next: PanelPosition) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Ignore storage failures; dragging still works for this session.
      }
    },
    [storageKey],
  );

  useIsomorphicLayoutEffect(() => {
    const { viewport } = getBounds();
    const stored = readStoredPosition(storageKey);
    const initial = stored ?? initialPositionRef.current(viewport);
    updatePosition(clampToViewport(initial));
  }, [clampToViewport, getBounds, storageKey, updatePosition]);

  React.useEffect(() => {
    const handleResize = () => {
      const current = positionRef.current;
      if (!current) {
        return;
      }

      const next = clampToViewport(current);
      updatePosition(next);
      persist(next);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampToViewport, persist, updatePosition]);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      pointerIdRef.current = event.pointerId;
      startPointerRef.current = { x: event.clientX, y: event.clientY };
      startPositionRef.current = positionRef.current ?? { x: 0, y: 0 };
      setIsDragging(true);
    },
    [],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      const next = clampToViewport({
        x: startPositionRef.current.x + (event.clientX - startPointerRef.current.x),
        y: startPositionRef.current.y + (event.clientY - startPointerRef.current.y),
      });
      updatePosition(next);
    },
    [clampToViewport, updatePosition],
  );

  const finishDrag = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      pointerIdRef.current = null;
      setIsDragging(false);

      if (positionRef.current) {
        persist(positionRef.current);
      }
    },
    [persist],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 1 : 10;
      const delta: PanelPosition = { x: 0, y: 0 };

      switch (event.key) {
        case "ArrowLeft":
          delta.x = -step;
          break;
        case "ArrowRight":
          delta.x = step;
          break;
        case "ArrowUp":
          delta.y = -step;
          break;
        case "ArrowDown":
          delta.y = step;
          break;
        default:
          return;
      }

      event.preventDefault();
      const current = positionRef.current ?? { x: 0, y: 0 };
      const next = clampToViewport({
        x: current.x + delta.x,
        y: current.y + delta.y,
      });
      updatePosition(next);
      persist(next);
    },
    [clampToViewport, persist, updatePosition],
  );

  const style: React.CSSProperties = {
    transform: position
      ? `translate3d(${position.x}px, ${position.y}px, 0)`
      : undefined,
    visibility: position ? "visible" : "hidden",
  };

  return {
    panelRef,
    gripProps: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
      onKeyDown: handleKeyDown,
      style: { touchAction: "none" as const },
    },
    position,
    isDragging,
    style,
  };
}
