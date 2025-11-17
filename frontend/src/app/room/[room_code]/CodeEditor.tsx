"use client";

import { getLibsTypes, getWiredIoTypes } from "@/api/services/getTypes";
import { TypeFile } from "@/api/services/types";
import { Editor, Monaco, OnChange, OnMount } from "@monaco-editor/react";
import { ScriptAgent } from "@wired-io/shared";
import React from "react";

let registeredLibraries = false;
export async function registerLibraries(monaco: Monaco) {
  if (registeredLibraries) return;

  // Configure Monaco TypeScript compiler options for better module resolution
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
    jsx: monaco.languages.typescript.JsxEmit.React,
    reactNamespace: "React",
    // allowJs: true,
    typeRoots: ["node_modules/@types"],
    paths: {
      "@wired-io": [monaco.Uri.file("node_modules/@types/wired-io").toString()],
      "@box2d": [monaco.Uri.file("node_modules/@types/box2d").toString()],
    },
  });

  const extraLibs: TypeFile[] = await getWiredIoTypes();
  extraLibs.push(...(await getLibsTypes()));

  // Filter out package.json and separate module declaration file from type files
  const typeFilesOnly = extraLibs.filter((lib) =>
    lib.filepath.endsWith(".d.ts")
  );

  const moduleDeclarationFile = typeFilesOnly.find((lib) =>
    lib.filepath.endsWith("/module.d.ts")
  );
  const otherTypeFiles = typeFilesOnly.filter(
    (lib) => !lib.filepath.endsWith("/module.d.ts")
  );

  // Sort files to ensure proper dependency resolution:
  // 1. index.d.ts first (main entry point)
  // 2. Then files in shallow directories before deep ones
  // 3. Then alphabetically
  // 4. module.d.ts last (depends on all other files)
  const sortedTypeFiles = [...otherTypeFiles].sort((a, b) => {
    // Put index.d.ts first
    if (a.filepath.endsWith("/index.d.ts")) return -1;
    if (b.filepath.endsWith("/index.d.ts")) return 1;
    // Sort by directory depth (shallow first)
    const depthA = a.filepath.split("/").length;
    const depthB = b.filepath.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    // Then alphabetically
    return a.filepath.localeCompare(b.filepath);
  });

  // Build final array: type files first, then module declaration
  const allLibs = [
    ...sortedTypeFiles.map((lib) => ({
      content: lib.content,
      filePath: monaco.Uri.file(lib.filepath).toString(),
    })),
    ...(moduleDeclarationFile
      ? [
          {
            content: moduleDeclarationFile.content,
            filePath: monaco.Uri.file(
              moduleDeclarationFile.filepath
            ).toString(),
          },
        ]
      : []),
  ];

  // Use setExtraLibs to register all files at once in correct order
  monaco.languages.typescript.typescriptDefaults.setExtraLibs(allLibs);
  console.log(monaco);

  registeredLibraries = true;
}

export function CodeEditor({
  selectedFile,
}: {
  selectedFile: ScriptAgent | null;
}) {
  const editorRef = React.useRef<Parameters<OnMount>[0] | null>(null);

  React.useEffect(() => {
    setTimeout(() => {
      if (editorRef.current && selectedFile) {
        editorRef.current.setValue(selectedFile.script);
      }
    }, 100);
  }, [selectedFile]);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerLibraries(monaco);
  };
  const handleEditorValueChange: OnChange = (value, event) => {
    if (typeof value === "string" && selectedFile) {
      selectedFile.script = value;
    }
  };

  return (
    <Editor
      height="100vh"
      defaultLanguage="typescript"
      theme="vs-dark"
      defaultValue=""
      onChange={handleEditorValueChange}
      onMount={handleEditorDidMount}
    />
  );
}
