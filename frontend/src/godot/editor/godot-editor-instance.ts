"use client";

import { clamp } from "@/utils/math";
import { GODOT_EDITOR_URL } from "@/utils/variables";
import { ProjectInfo } from "@wired-io/shared";
import EventEmitter from "easy-event-emitter";

/**
 * Browser-side owner of the Godot WASM editor: it creates the engine, feeds the
 * project files into its file system and restarts it after an editor exit.
 *
 * It is deliberately framework-agnostic (no JSX, no React import) and lives
 * outside the room route so the state layer (`room-packages`) can depend on the
 * engine handle without importing a route-segment file.
 */

export interface GodotEngine {
  init(path?: string): Promise<void>;
  start(options: {
    args: string[];
    persistentDrops?: boolean;
    canvas?: HTMLCanvasElement | null;
  }): Promise<void>;
  copyToFS(path: string, data: Uint8Array): void;
}

type GodotEngineConstructor = {
  new (config: Record<string, unknown>): GodotEngine;
  isWebGLAvailable(): boolean;
};

declare global {
  interface Window {
    Engine: GodotEngineConstructor;
  }
}

export type EditorLoadStatus =
  | "loading"
  | "downloading project"
  | "starting"
  | "ready"
  | "error";
export type EditorProgressStatus =
  | "progress"
  | "indeterminate"
  | "notice"
  | "hidden";
export type EditorEvents = {
  onLoadStatusChange: EditorLoadStatus;
  onProgressStatusChange: EditorProgressStatus;
  onProgressValueChange: number;
  onFailure: string;
};

export class GodotEditorInstance {
  videoDriver = "";
  canvas: HTMLCanvasElement | null = null;
  events: EventEmitter<EditorEvents> = new EventEmitter<EditorEvents>();
  rootPath = "/home/web_user";
  persistentPaths = [this.rootPath];
  editor!: GodotEngine;
  onEditorExit: ((code: number) => void) | null = null;
  projectInfo: ProjectInfo | null = null;

  async init() {
    this.events.emit("onLoadStatusChange", "loading");
    const editorConfig = this.createEditorConfig();
    this.editor = new window.Engine(editorConfig);
    if (!window.Engine.isWebGLAvailable()) {
      this.events.emit("onFailure", "WebGL not available");
      throw new Error("webgl_unavailable");
    }
    this.events.emit("onProgressStatusChange", "indeterminate");
    await this.editor.init(`${GODOT_EDITOR_URL}/godot.editor`);
  }
  async downloadProject(project: ProjectInfo) {
    this.events.emit("onLoadStatusChange", "downloading project");
    this.events.emit("onProgressStatusChange", "progress");
    this.events.emit("onProgressValueChange", 0);
    this.projectInfo = project;
    const filepaths = project.filepaths;
    if (filepaths.length === 0) {
      this.events.emit("onProgressValueChange", 1);
      return;
    }
    const total = filepaths.length;
    let completed = 0;
    let next = 0;
    // Bounded concurrency: the project has ~80 files and a serial fetch is
    // needlessly slow, while unbounded parallel requests trip rate limits.
    const downloadNext = async (): Promise<void> => {
      while (next < total) {
        const filepath = filepaths[next++];
        const response = await fetch(`${project.baseUrl}${filepath}`);
        if (!response.ok) {
          throw new Error(
            `project_file_failed:${filepath}:${response.status}`
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        this.editor.copyToFS(
          `${this.rootPath}/${project.name}/${filepath}`,
          new Uint8Array(arrayBuffer)
        );
        completed++;
        this.events.emit(
          "onProgressValueChange",
          parseFloat((completed / total).toFixed(2))
        );
      }
    };
    const workers = Array.from(
      { length: Math.min(6, total) },
      () => downloadNext()
    );
    await Promise.all(workers);
    this.events.emit("onProgressStatusChange", "indeterminate");
    this.events.emit("onProgressValueChange", 1);
  }
  async start() {
    this.events.emit("onLoadStatusChange", "starting");
    try {
      // Avoid user creating project in the persistent root folder.
      this.editor.copyToFS(`${this.rootPath}/keep`, new Uint8Array());
    } catch {
      // File exists
    }
    const args: string[] = ["--single-window"];
    if (this.projectInfo) {
      args.push(
        "--editor",
        "--path",
        `${this.rootPath}/${this.projectInfo.name}`
      );
    } else {
      args.push("--project-manager");
    }
    if (this.videoDriver) {
      args.push("--rendering-driver", this.videoDriver);
    }
    await this.editor.start({ args: args, persistentDrops: true });
    this.events.emit("onLoadStatusChange", "ready");
  }
  /**
   * The canvas belongs to React: it is mounted once and its ref must keep
   * pointing at the node that is actually in the document. Only the drawing
   * buffer is reset here, the element itself is never replaced.
   */
  setCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = this.canvas.parentElement?.clientWidth ?? 0;
    this.canvas.height = this.canvas.parentElement?.clientHeight ?? 0;
  }

  createEditorConfig() {
    const concurrency = clamp(navigator.hardwareConcurrency ?? 1, 12, 24);
    return {
      unloadAfterInit: false,
      onProgress: (current: number, total: number) => {
        if (total > 0) {
          this.events.emit("onProgressValueChange", current / total);
          this.events.emit("onProgressStatusChange", "progress");
          if (current === total) {
            // wait for progress bar animation
            setTimeout(() => {
              this.events.emit("onProgressStatusChange", "indeterminate");
            }, 100);
          }
        } else {
          this.events.emit("onProgressStatusChange", "indeterminate");
        }
      },
      canvas: this.canvas,
      canvasResizePolicy: 0,
      onExit: () => {
        // Reuse the React-owned canvas instead of swapping it in the DOM:
        // replacing the node detached the component's ref and the next React
        // render recreated an empty canvas for the restarted engine.
        if (this.canvas) {
          this.setCanvas(this.canvas);
        }
        this.onEditorExit?.(0);
      },
      onExecute: this.execute.bind(this),
      persistentPaths: this.persistentPaths,
      emscriptenPoolSize: concurrency,
      godotPoolSize: Math.floor(concurrency / 3), // Ensures at least 4 threads for the pool (see above).
    };
  }

  /**
   * Engine hook: Godot calls it before starting a session, both for the first
   * launch and for a restart.
   */
  execute(args: string[]) {
    const isEditor = args.some(
      (value) => value === "--editor" || value === "-e",
    );
    const isProjectManager = args.includes("--project-manager");
    const isGame = !isEditor && !isProjectManager;
    if (this.videoDriver) {
      args.push("--rendering-driver", this.videoDriver);
    }
    if (isGame) {
      // A game run does not restart the engine when it exits.
      this.onEditorExit = null;
      return;
    }

    // The editor (and the project manager) restart themselves in the same
    // mode after the engine exits. The callback is one-shot: it clears itself
    // before scheduling, so one exit starts exactly one new session.
    this.onEditorExit = () => {
      this.onEditorExit = null;
      void this.restart(args, { persistentDrops: isProjectManager });
    };
  }

  /**
   * Restarts the engine in place. Drag-and-drop survives the restart only in
   * the project manager; an editor session is restarted without it.
   */
  private async restart(
    args: string[],
    options: { persistentDrops: boolean }
  ) {
    // Give the engine a moment to finish tearing the previous session down
    // before initialising a new instance in the persistent FS.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.editor.init();
    await this.editor.start({ args, ...options, canvas: this.canvas });
  }
}
