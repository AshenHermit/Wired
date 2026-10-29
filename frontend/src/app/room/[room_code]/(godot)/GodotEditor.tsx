"use client";

import { GODOT_EDITOR_URL } from "@/utils/variables";
import Script from "next/script";
import React from "react";
import {
  EditorLoadStatus,
  EditorProgressStatus,
  GodotEditorInstance,
} from "./GodotEditorInstance";
import { Spinner } from "@/components/ui/spinner";
import { getGodotProjectInfo } from "@/api/services/godot-game";

export function GodotEditor({ roomId }: { roomId: number }) {
  const editorInstanceRef = React.useRef<GodotEditorInstance | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [scriptsLoaded, setScriptsLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<EditorLoadStatus>("loading");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [progressStatus, setProgressStatus] =
    React.useState<EditorProgressStatus>("hidden");
  const [progressValue, setProgressValue] = React.useState<number>(0);

  const loadEditor = React.useCallback(
    async (editor: GodotEditorInstance) => {
      try {
        // Persistence is scoped per room: rooms must not see each other's
        // files, and a reload must not throw away the room's own drafts.
        editor.rootPath = `/home/web_user/room-${roomId}`;
        editor.persistentPaths = [editor.rootPath];
        await editor.init();
        const projectInfo = await getGodotProjectInfo();
        await editor.downloadProject(projectInfo);
        await editor.start();
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Не удалось запустить редактор."
        );
        setStatus("error");
      }
    },
    [roomId]
  );
  const handleFailure = React.useCallback((message: string) => {
    setErrorMessage(message);
    setStatus("error");
  }, []);

  React.useEffect(() => {
    if (scriptsLoaded && canvasRef.current) {
      const editor = new GodotEditorInstance();
      editorInstanceRef.current = editor;
      editor.events.addListener("onLoadStatusChange", setStatus);
      editor.events.addListener("onProgressStatusChange", setProgressStatus);
      editor.events.addListener("onProgressValueChange", setProgressValue);
      editor.events.addListener("onFailure", handleFailure);
      editor.setCanvas(canvasRef.current);

      void loadEditor(editor);

      return () => {
        editor.events.removeAllListeners();
        if (editorInstanceRef.current === editor) {
          editorInstanceRef.current = null;
        }
      };
    }
  }, [handleFailure, loadEditor, scriptsLoaded]);

  return (
    <>
      <Script
        src={`${GODOT_EDITOR_URL}/godot.editor.js`}
        onLoad={() => setScriptsLoaded(true)}
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
          <div className="text-white text-2xl font-bold">
            {status === "error" ? "Ошибка редактора" : status}
          </div>
          {status === "error" && errorMessage && (
            <div className="text-white/80 text-sm max-w-lg text-center mt-2">
              {errorMessage}
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
