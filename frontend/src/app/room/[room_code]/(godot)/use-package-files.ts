"use client";

import { useGodotRoomContext } from "./GodotRoomProvider";
import {
  GodotFsError,
  createPackageFileSystem,
  type PackageFileSystem,
} from "./godot-packages-fs";

/**
 * Access to the package files of the running Godot editor.
 *
 * UI components call this instead of reaching for `window.editor` themselves:
 * the hook checks that the editor file system is ready and returns a bridge
 * bound to the currently open project.
 */
export function usePackageFiles() {
  const { editorApi } = useGodotRoomContext();

  // A plain closure, not useCallback: the bridge must be built at call time,
  // because the editor instance appears only after the WASM editor starts.
  return (): PackageFileSystem => {
    const instance = editorApi.editorRef.current;
    if (!instance) {
      throw new GodotFsError(
        "Редактор Godot ещё не загружен: пакеты станут доступны после открытия проекта"
      );
    }
    return createPackageFileSystem(instance);
  };
}
