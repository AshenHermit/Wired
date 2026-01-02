"use client";

import { getLibsTypes, getWiredIoTypes } from "@/api/services/getTypes";
import { TypeFile } from "@wired-io/shared";
import { Editor, Monaco, OnChange, OnMount } from "@monaco-editor/react";
import { ScriptAgent } from "@wired-io/shared";
import React from "react";

let registeredLibraries = false;
export function updateCompilerOptions(monaco: Monaco, packageNames: string[]) {
  const paths: Record<string, string[]> = {
    "@wired-io": [monaco.Uri.file("node_modules/@types/wired-io").toString()],
    "@box2d": [monaco.Uri.file("node_modules/@types/box2d").toString()],
  };
  for (const packageName of packageNames) {
    paths[`/${packageName}/*`] = [
      monaco.Uri.file(`/${packageName}`).toString() + "/*",
    ];
  }
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
    paths: paths,
  });
}
export async function registerLibraries(monaco: Monaco) {
  if (registeredLibraries) return;

  // Configure Monaco TypeScript compiler options for better module resolution
  updateCompilerOptions(monaco, []);

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
  console.log(monaco);

  registeredLibraries = true;
  return allLibs;
}

function normalizeFilepath(filepath: string): string {
  return filepath.startsWith("/") ? filepath : "/" + filepath;
}

function getPackageFilePath(packageName: string, filepath: string): string {
  return `/${packageName}${normalizeFilepath(filepath)}`;
}

function createPackageExtraLibs(
  monaco: Monaco,
  packageName: string,
  scriptAgents: ScriptAgent[]
): { content: string; filePath: string }[] {
  return scriptAgents.map((script) => {
    const fullPath = getPackageFilePath(packageName, script.filepath);
    return {
      content: script.script,
      filePath: monaco.Uri.file(fullPath).toString(),
    };
  });
}

export function CodeEditor({
  selectedFile,
  onChange,
}: {
  selectedFile: ScriptAgent | null;
  onChange?: (value: string) => void;
}) {
  const editorRef = React.useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = React.useRef<Parameters<OnMount>[1] | null>(null);
  const [allLibs, setAllLibs] = React.useState<
    { content: string; filePath: string }[]
  >([]);

  React.useEffect(() => {
    if (monacoRef.current && selectedFile && editorRef.current) {
      const monaco = monacoRef.current;

      // Dispose all existing models
      for (const model of monaco.editor.getModels()) {
        model.dispose();
      }

      // Build package file paths with absolute paths (starting with /)
      const packageName = selectedFile.scriptContext.package.name;
      const packageFiles = createPackageExtraLibs(
        monaco,
        packageName,
        selectedFile.scriptContext.scriptAgents
      );

      // Update compiler options to support absolute paths for this package
      updateCompilerOptions(
        monaco,
        selectedFile.scriptContext.packageManager.packages.map(
          (p) => p.package.name
        )
      );

      // Combine type libraries with package files and set all at once
      const allExtraLibs = [...allLibs, ...packageFiles];
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(allExtraLibs);

      // Create models for all package files
      for (const script of selectedFile.scriptContext.scriptAgents) {
        const fullPath = getPackageFilePath(packageName, script.filepath);
        const uri = monaco.Uri.file(fullPath);
        const model = monaco.editor.createModel(
          script.script,
          "typescript",
          uri
        );
        if (script === selectedFile) {
          editorRef.current?.setModel(model);
        }
      }
    }
  }, [selectedFile, allLibs]);

  const handleEditorDidMount: OnMount = async (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    (window as any).MONACO_EDITOR = editor;
    (window as any).MONACO = monaco;
    const libs = await registerLibraries(monaco);
    if (libs) {
      setAllLibs(libs);
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(libs);
      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    }
  };
  const handleEditorValueChange: OnChange = (value, event) => {
    if (typeof value === "string" && selectedFile && monacoRef.current) {
      selectedFile.script = value;
      onChange?.(value);

      // Update extraLib for all package files so Monaco can see the changes across files
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
