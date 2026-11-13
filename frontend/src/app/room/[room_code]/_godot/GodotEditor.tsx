"use client";

import { GODOT_EDITOR_URL } from "@/utils/variables";
import Script from "next/script";
import React from "react";
import { useTranslations } from "next-intl";
import { useAppMessage, type AppMessage } from "@/i18n/message";
import {
  EditorLoadStatus,
  EditorProgressStatus,
  GodotEditorInstance,
} from "@/godot/editor/godot-editor-instance";
import { Spinner } from "@/components/ui/spinner";
import { getGodotProjectInfo } from "@/api/services/godot-game";
import {
  godotEditorSessionRoot,
  prepareGodotEditorStorage,
} from "@/godot/bridge/godot-editor-storage";

type EditorMessage = AppMessage | { raw: string };

export function GodotEditor({
  roomId,
  afterStart,
}: {
  roomId: number;
  /**
   * Runs after the editor reported ready. Must not delay `ready`: the panel
   * uses it to connect the packages bridge in the background.
   */
  afterStart?: (editor: GodotEditorInstance) => void;
}) {
  const t = useTranslations("Editor");
  const format = useAppMessage();
  const editorInstanceRef = React.useRef<GodotEditorInstance | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // The engine script is fetched once per document. `next/script` keeps that in
  // a module-level cache and never fires `onLoad` again when the component
  // re-mounts, so deriving readiness from `onLoad` alone left the editor stuck
  // on "loading" after navigating out of the room and back. Read the global
  // that the script defines and rely on `onReady`, which runs on every mount.
  //
  // The probe runs in an effect instead of a state initializer on purpose: the
  // engine must be created by an effect that is *not* part of the initial mount,
  // because React StrictMode double-invokes mount effects and the Godot glue
  // keeps one shared `init` promise per document — a second instance created
  // that way never gets its own engine ("Engine must be inited before copying
  // files").
  const [scriptsLoaded, setScriptsLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<EditorLoadStatus>("loading");
  const [errorMessage, setErrorMessage] =
    React.useState<EditorMessage | null>(null);
  const [progressStatus, setProgressStatus] =
    React.useState<EditorProgressStatus>("hidden");
  const [progressValue, setProgressValue] = React.useState<number>(0);

  const loadEditor = React.useCallback(
    async (editor: GodotEditorInstance) => {
      try {
        // Drop the previous session before the engine mounts its file system:
        // project files, the import cache and the editor layout live in
        // IndexedDB and must not leak into this launch. Memoized per document,
        // so remounting the editor in the same tab keeps the current session.
        await prepareGodotEditorStorage();
        // Persistence is scoped per room and per document: rooms must not see
        // each other's files, and a reload must start from scratch. Inside the
        // document the directory is reused, so the editor restart that Godot
        // performs after an exit still finds the project it had before.
        editor.rootPath = godotEditorSessionRoot(roomId);
        editor.persistentPaths = [editor.rootPath];
        await editor.init();
        const projectInfo = await getGodotProjectInfo();
        await editor.downloadProject(projectInfo);
        await editor.start();
        // The editor is already ready here; connecting the package bridge is
        // deliberately fire-and-forget so it can never block the first frame.
        // A failure in that callback must not turn a running editor into an
        // error screen.
        try {
          afterStart?.(editor);
        } catch (error) {
          console.error("Godot editor afterStart callback failed", error);
        }
      } catch (error) {
        console.error(error);
        setErrorMessage({ key: "Editor.startFailed" });
        setStatus("error");
      }
    },
    [afterStart, roomId]
  );
  const handleFailure = React.useCallback((message: string) => {
    setErrorMessage({ raw: message });
    setStatus("error");
  }, []);

  // Callbacks are read through a ref: the packages hook recreates them between
  // renders, and the editor must not be rebuilt just because a callback changed.
  const callbacksRef = React.useRef({ loadEditor, handleFailure });
  React.useEffect(() => {
    callbacksRef.current = { loadEditor, handleFailure };
  }, [handleFailure, loadEditor]);

  React.useEffect(() => {
    if (typeof window.Engine !== "undefined") {
      setScriptsLoaded(true);
    }
  }, []);
  React.useEffect(() => {
    if (!scriptsLoaded || !canvasRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    const editor = new GodotEditorInstance();
    editorInstanceRef.current = editor;
    editor.events.addListener("onLoadStatusChange", setStatus);
    editor.events.addListener("onProgressStatusChange", setProgressStatus);
    editor.events.addListener("onProgressValueChange", setProgressValue);
    editor.events.addListener("onFailure", (message: string) =>
      callbacksRef.current.handleFailure(message)
    );
    editor.setCanvas(canvas);

    void callbacksRef.current.loadEditor(editor);

    return () => {
      editor.events.removeAllListeners();
      if (editorInstanceRef.current === editor) {
        editorInstanceRef.current = null;
      }
    };
  }, [scriptsLoaded]);

  const statusLabel =
    status === "error"
      ? t("error")
      : status === "loading"
        ? t("status.loading")
        : status === "downloading project"
          ? t("status.downloadingProject")
          : t("status.starting");
  const messageText =
    errorMessage == null
      ? null
      : "raw" in errorMessage
        ? errorMessage.raw
        : format(errorMessage);

  return (
    <>
      <Script
        src={`${GODOT_EDITOR_URL}/godot.editor.js`}
        onReady={() => setScriptsLoaded(true)}
      />
      <div className="absolute top-0 left-0 w-full h-full">
        <canvas
          ref={canvasRef}
          id="editor-canvas"
          tabIndex={1}
          className="w-full h-full"
        />
      </div>
      {status != "ready" && (
        <div className="absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center">
          <div className="text-white text-2xl font-bold">{statusLabel}</div>
          {status === "error" && messageText && (
            <div className="text-white/80 text-sm max-w-lg text-center mt-2">
              {messageText}
            </div>
          )}
          {progressStatus == "progress" && (
            <>
              <div className="text-white text-2xl font-bold">
                {progressValue * 100}%
              </div>
              <Spinner />
            </>
          )}
          {progressStatus == "indeterminate" && <Spinner />}
        </div>
      )}
    </>
  );
}
