"use client";

import { GODOT_EDITOR_URL, GODOT_PROJECT_ZIP_URL } from "@/utils/variables";
import Script from "next/script";
import React from "react";
import {
  EditorLoadStatus,
  EditorProgressStatus,
  GodotEditorInstance,
} from "./GodotEditorInstance";
import { Spinner } from "@/components/ui/spinner";
import { getGodotProjectInfo } from "@/api/services/godot-game";
import { useGodotRoomContext } from "./GodotRoomProvider";

export type GodotEditorApi = {
  editorRef: React.RefObject<GodotEditorInstance | null>;
};

export const GodotEditor = React.forwardRef<GodotEditorApi, {}>(
  (props, ref) => {
    const editorInstanceRef = React.useRef<GodotEditorInstance | null>(null);
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const [scriptsLoaded, setScriptsLoaded] = React.useState(false);
    const [status, setStatus] = React.useState<EditorLoadStatus>("loading");
    const [progressStatus, setProgressStatus] =
      React.useState<EditorProgressStatus>("hidden");
    const [progressValue, setProgressValue] = React.useState<number>(0);

    const loadEditor = React.useCallback(
      async (editor: GodotEditorInstance) => {
        await editor.clearPersistence();
        await editor.init();
        const projectInfo = await getGodotProjectInfo();
        await editor.downloadProject(projectInfo);
        await editor.start();
      },
      []
    );
    const { setEditorApi } = useGodotRoomContext();

    const editorApi: GodotEditorApi = React.useMemo(
      () => ({
        editorRef: editorInstanceRef,
      }),
      [editorInstanceRef]
    );

    React.useImperativeHandle(ref, () => editorApi, [editorApi]);

    React.useEffect(() => {
      setEditorApi(editorApi);
    }, [editorApi]);

    React.useEffect(() => {
      if (scriptsLoaded && canvasRef.current) {
        editorInstanceRef.current = new GodotEditorInstance();
        editorInstanceRef.current.events.addListener(
          "onLoadStatusChange",
          setStatus
        );
        editorInstanceRef.current.events.addListener(
          "onProgressStatusChange",
          setProgressStatus
        );
        editorInstanceRef.current.events.addListener(
          "onProgressValueChange",
          setProgressValue
        );
        editorInstanceRef.current.setCanvas(canvasRef.current);
        (window as any).editor = editorInstanceRef.current;

        loadEditor(editorInstanceRef.current);

        return () => {
          if (editorInstanceRef.current) {
            editorInstanceRef.current.events.removeListener(setStatus);
            editorInstanceRef.current.events.removeListener(setProgressStatus);
            editorInstanceRef.current.events.removeListener(setProgressValue);
          }
        };
      }
    }, [scriptsLoaded]);

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
            <div className="text-white text-2xl font-bold">{status}</div>
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
);
