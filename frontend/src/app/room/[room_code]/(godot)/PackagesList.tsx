"use client";
import { Button } from "@/components/animate-ui/components/buttons/button";
import { ScriptingPackage } from "@wired-io/shared";
import { PlusIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
export function PackagesList() {
  return (
    <motion.div
              className="flex flex-col gap-2 p-2 overflow-y-auto"
              layout
            >
              <AnimatePresence mode="popLayout">
                {[].map((pack, index) => (
                  <PackageCard
                    key={pack.package.id}
                    pack={pack}
                    index={index}
                    isInitialMount={isInitialMount}
                  />
                ))}
              </AnimatePresence>
              <Button
                onClick={() => packageEditDialogRef.current?.createPackage()}
              >
                <PlusIcon className="w-4 h-4" />
              </Button>
            </motion.div>
  );
}

export function PackageCard({
    pack,
    index,
    isInitialMount,
  }: {
    pack: ScriptingPackage;
    index: number;
    isInitialMount: boolean;
  }) {
    const {
      fileEditDialogRef,
      packageEditDialogRef,
      execPackage,
      updatePackage,
    } = useEditorContext();
    const [isLoading, setIsLoading] = React.useState(false);
  
    const exec = React.useCallback(async () => {
      setIsLoading(true);
      try {
        await updatePackage(pack.package.id, pack.getPackage());
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
              <Tooltip>
                <TooltipTrigger>
                  <LiquidButton
                    className=""
                    size={"sm"}
                    onClick={exec}
                    filled={isLoading}
                  >
                    {isLoading ? <Spinner className="w-4 h-4" /> : null}
                    {!isLoading ? <PlayIcon className="w-4 h-4" /> : null}
                  </LiquidButton>
                </TooltipTrigger>
                <TooltipContent>отправить на сервер и запустить</TooltipContent>
              </Tooltip>
              <Popover>
                <PopoverTrigger asChild>
                  <Button className="" size={"sm"}>
                    <InfoIcon className="w-4 h-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="right">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 justify-between">
                      <div className="flex items-center gap-2">
                        <PackageIcon className="w-4 h-4" />
                        {pack.package.name}
                      </div>
                      <Button
                        variant={"outline"}
                        size={"sm"}
                        onClick={() =>
                          packageEditDialogRef.current?.editPackage(pack)
                        }
                      >
                        <PencilIcon className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="opacity-50">{pack.package.description}</div>
                    <div className="flex justify-between">
                      <div></div>
                      <div>
                        <Button
                          variant={"outline"}
                          className="text-red-500"
                          onClick={() =>
                            packageEditDialogRef.current?.deletePackage(pack)
                          }
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