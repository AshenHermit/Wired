"use client";

import { clamp } from "@/utils/math";
import { GODOT_EDITOR_URL } from "@/utils/variables";
import { ProjectInfo } from "@wired-io/shared";
import EventEmitter from "easy-event-emitter";

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
  video_driver = "";
  canvas: HTMLCanvasElement | null = null;
  events: EventEmitter<EditorEvents> = new EventEmitter<EditorEvents>();
  rootPath = "/home/web_user";
  persistentPaths = [this.rootPath];
  lastScale = 0;
  editor!: GodotEngine;
  OnEditorExit: ((code: number) => void) | null = null;
  projectInfo: ProjectInfo | null = null;

  constructor() {}
  async init() {
    this.events.emit("onLoadStatusChange", "loading");
    const editorConfig = this.createEditorConfig();
    this.editor = new window.Engine(editorConfig);
    if (!window.Engine.isWebGLAvailable()) {
      this.events.emit("onFailure", "WebGL not available");
      throw new Error("WebGL недоступен в этом браузере.");
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
            `Не удалось загрузить файл проекта ${filepath} (${response.status}).`
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
    if (this.video_driver) {
      args.push("--rendering-driver", this.video_driver);
    }
    await this.editor.start({ args: args, persistentDrops: true });
    this.events.emit("onLoadStatusChange", "ready");
  }
  setCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = this.canvas.parentElement?.clientWidth ?? 0;
    this.canvas.height = this.canvas.parentElement?.clientHeight ?? 0;
  }
  focus() {
    this.canvas?.focus();
  }
  replaceCanvas(from: HTMLCanvasElement) {
    const out = document.createElement("canvas");
    out.id = from.id;
    out.tabIndex = from.tabIndex;
    from.parentNode?.replaceChild(out, from);
    this.lastScale = 0;
    return out;
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
        this.canvas = this.replaceCanvas(this.canvas!);
        this.setCanvas(this.canvas);
        console.log("exited", this.OnEditorExit);
        if (this.OnEditorExit) {
          this.OnEditorExit(0);
        }
      },
      onExecute: this.Execute.bind(this),
      persistentPaths: this.persistentPaths,
      emscriptenPoolSize: concurrency,
      godotPoolSize: Math.floor(concurrency / 3), // Ensures at least 4 threads for the pool (see above).
    };
  }

  Execute(args: string[]) {
    const is_editor =
      args.filter(function (v) {
        return v === "--editor" || v === "-e";
      }).length !== 0;
    const is_project_manager =
      args.filter(function (v) {
        return v === "--project-manager";
      }).length !== 0;
    const is_game = !is_editor && !is_project_manager;
    if (this.video_driver) {
      args.push("--rendering-driver", this.video_driver);
    }
    if (!is_game) {
      this.OnEditorExit = () => {
        setTimeout(() => {
          this.editor.init().then(() => {
            this.OnEditorExit = function () {};
            this.editor.start({
              args: args,
              persistentDrops: is_project_manager,
              canvas: this.canvas,
            });
          });
        }, 100);
        this.OnEditorExit = null;
      };
    }
  }
  async clearPersistence() {
    function deleteDB(path: string) {
      return new Promise(function (resolve, reject) {
        const req = indexedDB.deleteDatabase(path);
        req.onsuccess = function () {
          resolve(void 0);
        };
        req.onerror = function (err) {
          reject(err);
        };
        req.onblocked = function (err) {
          reject(err);
        };
      });
    }
    return await deleteDB(this.rootPath);
  }
}
