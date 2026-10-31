import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGodotProjectInfo } from "@/api/services/godot-game";
import { GodotEditor } from "./GodotEditor";

vi.mock("@/api/services/godot-game", () => ({
  getGodotProjectInfo: vi.fn(),
}));

/**
 * Mirrors `next/script`: a `src` that already ran is kept in a module-level
 * cache, so a remounted component is never "loaded" again. `onLoad` fires for
 * the first mount only, while `onReady` fires on every mount.
 */
const scriptProps = vi.hoisted(() => ({
  current: null as { onLoad?: () => void; onReady?: () => void } | null,
}));

vi.mock("next/script", () => ({
  default: (props: { onLoad?: () => void; onReady?: () => void }) => {
    scriptProps.current = props;
    return null;
  },
}));

type EngineInstance = {
  init: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  copyToFS: ReturnType<typeof vi.fn>;
};

function installEngine() {
  const instances: EngineInstance[] = [];
  class FakeEngine {
    static isWebGLAvailable() {
      return true;
    }
    init = vi.fn(async () => {});
    start = vi.fn(async () => {});
    copyToFS = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  window.Engine = FakeEngine as unknown as typeof window.Engine;
  return instances;
}

describe("GodotEditor script readiness", () => {
  beforeEach(() => {
    scriptProps.current = null;
    vi.mocked(getGodotProjectInfo).mockReset();
    vi.mocked(getGodotProjectInfo).mockResolvedValue({
      name: "wired",
      baseUrl: "/api/godot-project/wired/",
      filepaths: [],
    });
  });

  afterEach(() => {
    delete (window as unknown as { Engine?: unknown }).Engine;
  });

  it("starts the editor on a remount where next/script only reports onReady", async () => {
    // Navigating back into the room re-mounts the component while the script
    // is already in the page: window.Engine exists, onLoad never fires again.
    const instances = installEngine();

    render(<GodotEditor roomId={7} />);

    await waitFor(() => expect(instances).toHaveLength(1));
    await waitFor(() => expect(instances[0].start).toHaveBeenCalled());
    expect(screen.queryByText("loading")).toBeNull();
  });

  it("starts the editor once next/script reports the script is ready", async () => {
    render(<GodotEditor roomId={7} />);
    expect(scriptProps.current?.onReady).toBeTypeOf("function");

    const instances = installEngine();
    act(() => scriptProps.current?.onReady?.());

    await waitFor(() => expect(instances).toHaveLength(1));
  });

  it("creates a single engine under StrictMode", async () => {
    // The Godot glue keeps one shared `init` promise per document: a second
    // instance created by StrictMode's double-invoked effect never gets an
    // engine of its own and fails on the first copyToFS.
    const instances = installEngine();

    render(
      <StrictMode>
        <GodotEditor roomId={7} />
      </StrictMode>,
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(instances).toHaveLength(1);
  });
});
