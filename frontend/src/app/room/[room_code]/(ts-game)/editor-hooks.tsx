import {
  createScriptingPackage,
  deleteScriptingPackage,
  updateScriptingPackage,
} from "@/api/services/scripting-packages";
import { useRequestHandler } from "@/hooks/use-request-handler";
import { useUserStore } from "@/store/user-store";
import { WiredInstance } from "@wired-io/client";
import {
  CreateScriptingPackagePayload,
  PackageExecutionContext,
  ScriptAgent,
  ScriptsManagerNode,
  UpdateScriptingPackagePayload,
} from "@wired-io/shared";
import React from "react";
import { toast } from "sonner";

export type ScriptsManagerNodeRef = React.RefObject<ScriptsManagerNode | null>;
export type OpenFileCallback = (file: ScriptAgent | null) => void;

export function useCreatePackage(wiredInstance: WiredInstance | null) {
  const user = useUserStore((state) => state);
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const createPackage = React.useCallback(
    async (
      data: CreateScriptingPackagePayload,
      successCallback?: () => void,
    ) => {
      await handleRequest(async () => {
        if (wiredInstance) {
          await createScriptingPackage({
            ...data,
            roomId: wiredInstance?.roomId ?? 0,
            authorId: user.id,
          });
          toast.success("Package created successfully");
          successCallback?.();
        }
      });
    },
    [user, wiredInstance],
  );
  return createPackage;
}

export function useUpdatePackage() {
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const updatePackage = React.useCallback(
    async (
      id: number,
      data: UpdateScriptingPackagePayload,
      successCallback?: () => void,
    ) => {
      await handleRequest(async () => {
        await updateScriptingPackage(id, data);
        toast.success("Package updated successfully");
        successCallback?.();
      });
    },
    [],
  );
  return updatePackage;
}

export function useRemovePackage() {
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const removePackage = React.useCallback(
    async (id: number, successCallback?: () => void) => {
      await handleRequest(async () => {
        await deleteScriptingPackage(id);
        toast.success("Package removed successfully");
        successCallback?.();
      });
    },
    [],
  );
  return removePackage;
}

export function useExecPackage(packageManagerNode: ScriptsManagerNodeRef) {
  const execPackage = React.useCallback(
    async (pack: PackageExecutionContext) => {
      if (packageManagerNode.current) {
        await packageManagerNode.current.requestExecPackage(pack.getPackage());
      }
    },
    [],
  );

  return execPackage;
}

export function useCreateFile(
  packageManagerNode: ScriptsManagerNodeRef,
  openFile: OpenFileCallback,
) {
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const newFile = React.useCallback(
    async (
      pkg: PackageExecutionContext,
      filepath: string,
      successCallback?: () => void,
    ) => {
      handleRequest(async () => {
        if (packageManagerNode.current) {
          if (!filepath.startsWith("/")) filepath = "/" + filepath;
          if (filepath == "/") {
            throw new Error("Filepath cannot be empty");
          }
          if (pkg.findScriptByFilepath(filepath)) {
            throw new Error("File already exists");
          }
          const patch = {
            scripts: [
              ...pkg.package.scripts,
              {
                filepath,
                script: "",
              },
            ],
          };
          await updateScriptingPackage(pkg.package.id, patch);
          const pkgManager = packageManagerNode.current?.packageManager;
          pkgManager?.upsertPackage({ ...pkg.package, ...patch });
          setTimeout(() => {
            openFile(
              pkgManager
                ?.getPackageById(pkg.package.id)
                ?.findScriptByFilepath(filepath) ?? null,
            );
          }, 10);
          toast.success("File created successfully");
          successCallback?.();
        }
      });
    },
    [packageManagerNode, openFile],
  );
  return newFile;
}

export function useRenameFile(
  packageManagerNode: ScriptsManagerNodeRef,
  openFile: OpenFileCallback,
) {
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const renameFile = React.useCallback(
    async (
      pkg: PackageExecutionContext,
      filepath: string,
      newFilepath: string,
      successCallback?: () => void,
    ) => {
      handleRequest(async () => {
        if (!newFilepath.startsWith("/")) newFilepath = "/" + newFilepath;
        if (newFilepath == "/") {
          throw new Error("Filepath cannot be empty");
        }
        const file = pkg.findScriptByFilepath(filepath);
        if (!file) {
          throw new Error("File not found");
        }
        if (file.filepath != newFilepath) {
          if (pkg.findScriptByFilepath(newFilepath))
            throw new Error("File already exists");
        }
        file.filepath = newFilepath;
        const patch = {
          scripts: [...pkg.getPackage().scripts],
        };
        await updateScriptingPackage(pkg.package.id, patch);
        toast.success("File renamed successfully");
        successCallback?.();
      });
    },
    [packageManagerNode, openFile],
  );
  return renameFile;
}

export function useUpdateScript(packageManagerNode: ScriptsManagerNodeRef) {
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const updateFile = React.useCallback(
    async (
      pkg: PackageExecutionContext,
      filepath: string,
      successCallback?: () => void,
    ) => {
      handleRequest(async () => {
        const file = pkg.findScriptByFilepath(filepath);
        if (!file) {
          throw new Error("File not found");
        }
        const patch = {
          scripts: [...pkg.getPackage().scripts],
        };
        await updateScriptingPackage(pkg.package.id, patch);
        toast.success("File updated successfully");
        successCallback?.();
      });
    },
    [packageManagerNode],
  );
  return updateFile;
}

export function useDeleteFile(
  packageManagerNode: ScriptsManagerNodeRef,
  openFile: OpenFileCallback,
) {
  const { handleRequest } = useRequestHandler({ toastOnError: true });
  const deleteFile = React.useCallback(
    async (
      pkg: PackageExecutionContext,
      filepath: string,
      successCallback?: () => void,
    ) => {
      handleRequest(async () => {
        const file = pkg.findScriptByFilepath(filepath);
        if (!file) {
          throw new Error("File not found");
        }
        const patch = {
          scripts: pkg.package.scripts.filter(
            (script) => script.filepath !== filepath,
          ),
        };
        await updateScriptingPackage(pkg.package.id, patch);
        toast.success("File deleted successfully");
        openFile(null);
        successCallback?.();
      });
    },
    [packageManagerNode, openFile],
  );
  return deleteFile;
}
