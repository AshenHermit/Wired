import { Editor, type OnMount } from "@monaco-editor/react";
import type { WiredInstance } from "@wired-io/client";
import React from "react";

export function WiredEditor({
  wiredInstanceRef,
}: {
  wiredInstanceRef: React.RefObject<WiredInstance | null>;
}) {
  const editorRef = React.useRef<Parameters<OnMount>[0] | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
  };

  return (
    <Editor
      height="100vh"
      defaultLanguage="typescript"
      defaultValue="// some comment"
      onMount={handleEditorDidMount}
    />
  );
}
