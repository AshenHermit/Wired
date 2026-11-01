import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGodotProjectInfo } from "@/api/services/godot-game";
import { GodotEditor } from "./GodotEditor";
import { GodotEditorInstance } from "./GodotEditorInstance";

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

type EngineConfig = {
  canvas?: HTMLCanvasElement | null;
  onExit?: () => void;
  onExecute?: (args: string[]) => void;
};

type EngineInstance = {
  config: EngineConfig;
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
    config: EngineConfig;
    constructor(config: EngineConfig) {
      this.config = config;
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

  it("keeps the React-owned canvas mounted across engine exits", async () => {
    const instances = installEngine();

    render(<GodotEditor roomId={7} />);
    await waitFor(() => expect(instances).toHaveLength(1));

    const canvas = document.getElementById("editor-canvas") as HTMLCanvasElement;
    const parent = canvas.parentElement;
    const onExit = instances[0].config.onExit;
    expect(onExit).toBeTypeOf("function");

    // The editor reports an exit twice (for example a quit and a restart):
    // the node React holds must stay mounted the whole time.
    act(() => onExit?.());
    act(() => onExit?.());

    expect(document.getElementById("editor-canvas")).toBe(canvas);
    expect(canvas.parentElement).toBe(parent);
    expect(document.querySelectorAll("#editor-canvas")).toHaveLength(1);
  });

  it("restarts the editor once after an editor-mode exit", async () => {
    const instances = installEngine();
    const editor = new GodotEditorInstance();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    editor.setCanvas(canvas);

    try {
      await editor.init();
      editor.Execute(["--editor", "--path", "/home/web_user/room-7/wired"]);
      expect(editor.OnEditorExit).toBeTypeOf("function");

      await act(async () => {
        editor.OnEditorExit?.(0);
      });
      // The restart waits 100 ms for the previous engine to tear down.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      expect(instances).toHaveLength(1);
      expect(instances[0].init).toHaveBeenCalledTimes(2);
      expect(instances[0].start).toHaveBeenCalledWith({
        args: ["--editor", "--path", "/home/web_user/room-7/wired"],
        persistentDrops: false,
        canvas,
      });
      // One-shot: the exit handler is gone, so a second exit cannot start yet
      // another engine.
      expect(editor.OnEditorExit).toBeNull();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(instances[0].start).toHaveBeenCalledTimes(1);
    } finally {
      canvas.remove();
    }
  });

  it("does not restart a game run and keeps the project manager persistent", async () => {
    const instances = installEngine();
    const editor = new GodotEditorInstance();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    editor.setCanvas(canvas);

    try {
      editor.Execute([]);
      expect(editor.OnEditorExit).toBeNull();

      await editor.init();
      editor.Execute(["--project-manager"]);
      await act(async () => {
        editor.OnEditorExit?.(0);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      expect(instances).toHaveLength(1);
      expect(instances[0].init).toHaveBeenCalledTimes(2);
      expect(instances[0].start).toHaveBeenCalledWith({
        args: ["--project-manager"],
        persistentDrops: true,
        canvas,
      });
    } finally {
      canvas.remove();
    }
  });

  it("reuses the same canvas node on repeated onExit and setCanvas", () => {
    const host = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.id = "editor-canvas";
    host.appendChild(canvas);
    document.body.appendChild(host);

    const editor = new GodotEditorInstance();
    editor.setCanvas(canvas);
    const config = editor.createEditorConfig();
    const exit = vi.fn();
    editor.OnEditorExit = exit;

    try {
      config.onExit?.();
      editor.setCanvas(canvas);
      config.onExit?.();

      expect(exit).toHaveBeenCalledTimes(2);
      expect(editor.canvas).toBe(canvas);
      expect(canvas.parentElement).toBe(host);
      expect(host.querySelectorAll("canvas")).toHaveLength(1);
    } finally {
      host.remove();
    }
  });
});
