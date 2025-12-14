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
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import React, { useContext } from "react";
import { toast } from "sonner";
import { CodeEditor } from "./CodeEditor";

export type EditorContextValue = {
  selectedFile: ScriptAgent | null;
  setSelectedFile: (file: ScriptAgent | null) => void;
};

const EditorContext = React.createContext<EditorContextValue>({
  selectedFile: null,
  setSelectedFile: () => {},
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

  const ctxValue: EditorContextValue = {
    selectedFile,
    setSelectedFile: openFile,
  };

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
  }, [state, updatePackages]);

  const addPackage = React.useCallback(() => {
    if (packageManagerNode.current) {
      packageManagerNode.current.requestAddPackage({
        id: "",
        dependencies: [],
        description: "asdada d",
        name: "new",
        scripts: [
          {
            filepath: "main.ts",
            script: "//...",
          },
        ],
        version: "1.0.0",
      });
    }
  }, []);
  const removePackage = React.useCallback((pack: PackageExecutionContext) => {
    if (packageManagerNode.current) {
      packageManagerNode.current.requestRemovePackage(pack.getPackage());
    }
  }, []);
  const execPackage = React.useCallback((pack: PackageExecutionContext) => {
    if (packageManagerNode.current) {
      packageManagerNode.current.requestExecPackage(pack.getPackage());
    }
  }, []);

  const [isInitialMount, setIsInitialMount] = React.useState(true);
  React.useEffect(() => {
    if (packages.length > 0 && isInitialMount) {
      setIsInitialMount(false);
    }
  }, [packages.length, isInitialMount]);

  return (
    <EditorContext.Provider value={ctxValue}>
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
                    onExec={() => execPackage(pack)}
                    onRemove={() => removePackage(pack)}
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
  onRemove,
  onExec,
}: {
  pack: PackageExecutionContext;
  index: number;
  isInitialMount: boolean;
  onRemove: () => void;
  onExec: () => void;
}) {
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
            <Button className="" size={"sm"} onClick={onExec}>
              <PlayIcon className="w-4 h-4" />
            </Button>
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
                        onClick={onRemove}
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
              <AccordionContent className="bg-neutral-800 p-4 rounded-lg flex flex-col gap-2">
                {pack.scriptAgents.map((script) => (
                  <FileCard key={script.filepath} file={script} />
                ))}
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

  const onClick = React.useCallback(() => {
    setSelectedFile(file);
  }, [file, setSelectedFile]);

  return (
    <Button
      variant={selectedFile === file ? "default" : "outline"}
      onClick={onClick}
      className="justify-start"
    >
      {file.filepath}
    </Button>
  );
}
