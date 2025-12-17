"use client";

import { Button } from "@/components/animate-ui/components/buttons/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/animate-ui/components/radix/accordion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/animate-ui/components/radix/popover";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Editor,
  OnChange,
  type OnMount,
  type Monaco,
} from "@monaco-editor/react";
import type { WiredInstance } from "@wired-io/client";
import {
  PackageExecutionContext,
  ScriptAgent,
  ScriptsManagerEvents,
  ScriptsManagerNode,
  WiredInstanceState,
} from "@wired-io/shared";
import {
  ChevronDown,
  ChevronsUpDownIcon,
  InfoIcon,
  PackageIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import React, { useContext } from "react";
import { toast } from "sonner";
import { CodeEditor } from "./CodeEditor";
import { useRequestHandler } from "@/hooks/use-request-handler";
import {
  createScriptingPackage,
  deleteScriptingPackage,
  updateScriptingPackage,
} from "@/api/services/scripting-packages";
import { useUserStore } from "@/store/user-store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/animate-ui/components/radix/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  useCreateFile,
  useCreatePackage,
  useDeleteFile,
  useExecPackage,
  useRemovePackage,
  useRenameFile,
  useUpdatePackage,
  useUpdateScript,
} from "./editor-hooks";
import debounce from "just-debounce-it";
import { LiquidButton } from "@/components/animate-ui/components/buttons/liquid";
import { Spinner } from "@/components/ui/spinner";

export type EditorContextValue = {
  selectedFile: ScriptAgent | null;
  setSelectedFile: (file: ScriptAgent | null) => void;
  fileEditDialogRef: React.RefObject<FileEditDialogApi | null>;
  execPackage: ReturnType<typeof useExecPackage>;
  updatePackage: ReturnType<typeof useUpdatePackage>;
  removePackage: ReturnType<typeof useRemovePackage>;
  createFile: ReturnType<typeof useCreateFile>;
  deleteFile: ReturnType<typeof useDeleteFile>;
  renameFile: ReturnType<typeof useRenameFile>;
  updateScript: ReturnType<typeof useUpdateScript>;
};

const EditorContext = React.createContext<EditorContextValue>({
  selectedFile: null,
  setSelectedFile: () => {},
  fileEditDialogRef: React.createRef<FileEditDialogApi>(),
  execPackage: async () => {},
  updatePackage: async () => {},
  removePackage: async () => {},
  createFile: async () => {},
  deleteFile: async () => {},
  renameFile: async () => {},
  updateScript: async () => {},
});

export function useEditorContext() {
  return useContext(EditorContext);
}

export function WiredEditor({
  wiredInstance,
  state,
}: {
  wiredInstance: WiredInstance | null;
  state: WiredInstanceState;
}) {
  const user = useUserStore((state) => state);
  const editorRef = React.useRef<Parameters<OnMount>[0] | null>(null);
  const packageManagerNode = React.useRef<ScriptsManagerNode>(null);
  const [packages, setPackages] = React.useState<PackageExecutionContext[]>([]);
  const [selectedFile, setSelectedFile] = React.useState<ScriptAgent | null>(
    null
  );
  const [selectedPackage, setSelectedPackage] =
    React.useState<PackageExecutionContext | null>(null);

  const openFile = React.useCallback((file: ScriptAgent | null) => {
    setSelectedPackage(file?.scriptContext ?? null);
    setSelectedFile(file);
  }, []);

  const fileEditDialogRef = React.useRef<FileEditDialogApi>(null);

  const updatePackages = React.useCallback(
    (packs: PackageExecutionContext[]) => {
      setPackages(packs);
      for (const pack of packs) {
        const script = pack.scriptAgents.find(
          (s) => s.filepath == selectedFile?.filepath
        );
        if (script && pack.package.id == selectedPackage?.package.id) {
          openFile(script);
          break;
        }
      }
    },
    [setPackages, openFile, selectedFile]
  );

  React.useEffect(() => {
    if (wiredInstance) {
      if (state == "connected") {
        const packageManager =
          wiredInstance.wiredGlobal!.scene().scriptsManagerNode?.packageManager;
        packageManagerNode.current =
          wiredInstance.wiredGlobal!.scene().scriptsManagerNode || null;
        if (packageManager && packageManagerNode.current) {
          const packageExecuted = (pack: PackageExecutionContext) => {
            toast(`"${pack.package.name}" package executed`, {
              icon: <PackageIcon className="w-4 h-4" />,
            });
          };
          packageManagerNode.current.events.addListener(
            "packageExecuted",
            packageExecuted
          );
          updatePackages(packageManager.packages);
          packageManager.events.addListener("packagesChanged", updatePackages);
          return () => {
            packageManager.events.removeListener(updatePackages);
            if (packageManagerNode.current)
              packageManagerNode.current.events.removeListener(packageExecuted);
          };
        }
      }
    }
  }, [state, updatePackages, wiredInstance, packageManagerNode]);

  const addPackage = useCreatePackage(wiredInstance);
  const removePackage = useRemovePackage();
  const updatePackage = useUpdatePackage();
  const execPackage = useExecPackage(packageManagerNode);
  const newFile = useCreateFile(packageManagerNode, openFile);
  const renameFile = useRenameFile(packageManagerNode, openFile);
  const deleteFile = useDeleteFile(packageManagerNode, openFile);
  const updateScript = useUpdateScript(packageManagerNode);

  const ctxValue: EditorContextValue = {
    selectedFile,
    setSelectedFile: openFile,
    fileEditDialogRef,
    execPackage: execPackage,
    updatePackage: updatePackage,
    removePackage: removePackage,
    createFile: newFile,
    deleteFile: deleteFile,
    renameFile: renameFile,
    updateScript: updateScript,
  };

  const [isInitialMount, setIsInitialMount] = React.useState(true);
  React.useEffect(() => {
    if (packages.length > 0 && isInitialMount) {
      setIsInitialMount(false);
    }
  }, [packages.length, isInitialMount]);

  return (
    <EditorContext.Provider value={ctxValue}>
      <FileEditDialog ref={fileEditDialogRef} />
      <div className="grid grid-cols-[250px_1fr]">
        <div className="bg-neutral-900">
          <div className="max-h-[100vh] overflow-y-auto">
            <motion.div
              className="flex flex-col gap-2 p-2 overflow-y-auto"
              layout
            >
              <AnimatePresence mode="popLayout">
                {packages.map((pack, index) => (
                  <PackageCard
                    key={pack.package.id}
                    pack={pack}
                    index={index}
                    isInitialMount={isInitialMount}
                  />
                ))}
              </AnimatePresence>
              <Button onClick={addPackage}>
                <PlusIcon className="w-4 h-4" />
              </Button>
            </motion.div>
          </div>
        </div>
        <CodeEditor selectedFile={selectedFile} />
      </div>
    </EditorContext.Provider>
  );
}

export function PackageCard({
  pack,
  index,
  isInitialMount,
}: {
  pack: PackageExecutionContext;
  index: number;
  isInitialMount: boolean;
}) {
  const { fileEditDialogRef, execPackage, removePackage, updatePackage } =
    useEditorContext();
  const [isLoading, setIsLoading] = React.useState(false);

  const exec = React.useCallback(async () => {
    setIsLoading(true);
    try {
      await updatePackage(pack);
      await execPackage(pack);
    } catch (e) {
      console.error(e);
    }
    setIsLoading(false);
  }, [execPackage, updatePackage, pack]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      layout
      style={{ overflow: "hidden" }}
      variants={{
        hidden: {
          opacity: 0,
          height: 0,
          y: -20,
          scale: 0.95,
        },
        visible: {
          opacity: 1,
          height: "auto",
          y: 0,
          scale: 1,
          transition: {
            duration: 0.3,
            ease: [0.4, 0, 0.2, 1],
            delay: isInitialMount ? index * 0.1 : 0,
            height: {
              duration: 0.3,
              ease: [0.4, 0, 0.2, 1],
              delay: isInitialMount ? index * 0.1 : 0,
            },
          },
        },
      }}
      exit={{
        opacity: 0,
        height: 0,
        y: -20,
        scale: 0.95,
        transition: {
          duration: 0.2,
          height: {
            duration: 0.2,
          },
        },
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageIcon className="w-4 h-4" />
            {pack.package.name}
          </CardTitle>
          <CardAction className="flex items-center gap-2">
            <LiquidButton
              className=""
              size={"sm"}
              onClick={exec}
              filled={isLoading}
            >
              {isLoading ? <Spinner className="w-4 h-4" /> : null}
              {!isLoading ? <PlayIcon className="w-4 h-4" /> : null}
            </LiquidButton>
            <Popover>
              <PopoverTrigger asChild>
                <Button className="" size={"sm"}>
                  <InfoIcon className="w-4 h-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="right">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <PackageIcon className="w-4 h-4" />
                    {pack.package.name}
                  </div>
                  <div className="opacity-50">{pack.package.description}</div>
                  <div className="flex justify-between">
                    <div></div>
                    <div>
                      <Button
                        variant={"outline"}
                        className="text-red-500"
                        onClick={() => removePackage(pack)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </CardAction>
        </CardHeader>
        <CardContent className="">
          <Accordion type="single" collapsible>
            <AccordionItem value="files">
              <AccordionTrigger>files</AccordionTrigger>
              <AccordionContent>
                <ContextMenu>
                  <ContextMenuTrigger>
                    <div className="bg-neutral-800 p-4 rounded-lg flex flex-col gap-2">
                      {pack.scriptAgents.map((script) => (
                        <FileCard key={script.filepath} file={script} />
                      ))}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() =>
                        fileEditDialogRef.current?.createFile(pack, "/")
                      }
                    >
                      <PlusIcon /> New File...
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function FileCard({ file }: { file: ScriptAgent }) {
  const { selectedFile, setSelectedFile } = useEditorContext();

  const { fileEditDialogRef } = useEditorContext();

  const onClick = React.useCallback(() => {
    setSelectedFile(file);
  }, [file, setSelectedFile]);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <Button
          variant={selectedFile === file ? "default" : "outline"}
          onClick={onClick}
          className="justify-start w-full"
        >
          {file.filepath}
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() =>
            fileEditDialogRef.current?.renameFile(
              file.scriptContext,
              file.filepath
            )
          }
        >
          <PencilIcon /> Rename File...
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            fileEditDialogRef.current?.deleteFile(
              file.scriptContext,
              file.filepath
            )
          }
        >
          <TrashIcon /> Delete File...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export type FileEditDialogApi = {
  createFile: (pkg: PackageExecutionContext, filepath: string) => void;
  deleteFile: (pkg: PackageExecutionContext, filepath: string) => void;
  renameFile: (pkg: PackageExecutionContext, filepath: string) => void;
  close(): void;
};

export const FileEditDialog = React.forwardRef<FileEditDialogApi, {}>(
  (props, ref) => {
    const [open, setOpen] = React.useState(false);
    const [filepath, setFilepath] = React.useState("");
    const [newFilepath, setNewFilepath] = React.useState("");
    const [pkg, setPkg] = React.useState<PackageExecutionContext | null>(null);
    const [action, setAction] = React.useState<"create" | "rename" | "delete">(
      "create"
    );

    const { createFile, deleteFile, renameFile } = useEditorContext();

    React.useImperativeHandle(ref, () => ({
      createFile: (pkg: PackageExecutionContext, filepath: string) => {
        setPkg(pkg);
        setFilepath(filepath);
        setAction("create");
        setOpen(true);
      },
      renameFile: (pkg: PackageExecutionContext, filepath: string) => {
        setPkg(pkg);
        setFilepath(filepath);
        setNewFilepath(filepath);
        setAction("rename");
        setOpen(true);
      },
      deleteFile: (pkg: PackageExecutionContext, filepath: string) => {
        setPkg(pkg);
        setFilepath(filepath);
        setAction("delete");
        setOpen(true);
      },
      close: () => {
        setOpen(false);
      },
    }));

    const submit = React.useCallback(() => {
      if (action === "create") {
        createFile(pkg!, filepath, () => setOpen(false));
      }
      if (action === "rename") {
        renameFile(pkg!, filepath, newFilepath, () => setOpen(false));
      }
      if (action === "delete") {
        deleteFile(pkg!, filepath, () => setOpen(false));
      }
    }, [action, pkg, filepath, newFilepath]);

    React.useEffect(() => {
      if (open) {
        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            if (action === "create") {
              createFile(pkg!, filepath);
              setOpen(false);
            }
          }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("keydown", onKeyDown);
        };
      }
    }, [action, open, submit]);

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            {action === "create" && <DialogTitle>New File</DialogTitle>}
            {action === "rename" && <DialogTitle>Rename File</DialogTitle>}
            {action === "delete" && <DialogTitle>Delete File</DialogTitle>}
          </DialogHeader>
          {action === "create" && (
            <Field>
              <FieldLabel>Filepath</FieldLabel>
              <Input
                value={filepath}
                onChange={(e) => setFilepath(e.target.value)}
              />
            </Field>
          )}
          {action === "rename" && (
            <Field>
              <FieldLabel>New Filepath</FieldLabel>
              <Input
                value={newFilepath}
                onChange={(e) => setNewFilepath(e.target.value)}
              />
            </Field>
          )}
          <DialogFooter>
            {action === "create" && <Button onClick={submit}>Create</Button>}
            {action === "rename" && <Button onClick={submit}>Rename</Button>}
            {action === "delete" && <Button onClick={submit}>Delete</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
