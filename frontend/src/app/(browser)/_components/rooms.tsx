"use client";

import {
  createRoom,
  deleteRoom,
  listRooms,
  updateRoom,
} from "@/api/services/rooms";
import { GAME_ROOMS_TYPES } from "@wired-io/shared/api/types";
import type { GameRoomsType, Room } from "@wired-io/shared/api/types";
import { LiquidButton } from "@/components/animate-ui/components/buttons/liquid";
import {
  RippleButton,
  RippleButtonRipples,
} from "@/components/animate-ui/components/buttons/ripple";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/animate-ui/components/radix/sheet";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useUserStore } from "@/store/user-store";
import {
  PlayIcon,
  PlusIcon,
  PlusSquareIcon,
  RefreshCcwIcon,
  WrenchIcon,
} from "lucide-react";
import React from "react";
import { toast } from "sonner";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRequestHandler } from "@/hooks/use-request-handler";
import { Button } from "@/components/animate-ui/components/buttons/button";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import Link from "next/link";
import { encodeId } from "@/utils/hash-utils";
import {
  Tabs,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/animate/tabs";
import { TabsContent } from "@/components/animate-ui/primitives/animate/tabs";
import { cn } from "@/lib/utils";
import { PhaserLogo } from "@/icons/phaser_logo";
import { GodotLogo } from "@/icons/godot_logo";

export function RoomCard({
  room,
  editingApi,
}: {
  room: Room;
  editingApi?: React.RefObject<RoomEditingPanelAPI | null>;
}) {
  const user = useUserStore((state) => state);
  const canEdit = editingApi && user.authorized && user.id === room.author?.id;
  return (
    <Card className="min-h-32">
      <CardHeader>
        <CardTitle>{room.name}</CardTitle>
      </CardHeader>
      <CardFooter className="flex justify-between">
        <div>{room.author?.name}</div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <RippleButton
              variant={"outline"}
              onClick={() => editingApi.current?.edit(room)}
            >
              <WrenchIcon />
              <RippleButtonRipples />
            </RippleButton>
          ) : null}
          <LiquidButton asChild>
            <Link href={`/room/${encodeId("room", room.id)}`}>
              <PlayIcon />
            </Link>
          </LiquidButton>
        </div>
      </CardFooter>
    </Card>
  );
}

export type RoomEditingPanelAPI = {
  create: () => void;
  edit: (room: Room) => void;
  close: () => void;
};
export type RoomEditingProps = {
  onChange?: () => void;
};

export const RoomEditingFields = z.object({
  name: z.string().min(1),
  type: z.enum(GAME_ROOMS_TYPES),
  description: z.string(),
});
export type RoomEditingFieldsInfer = z.infer<typeof RoomEditingFields>;

export const RoomEditingPanel = React.forwardRef<
  RoomEditingPanelAPI,
  RoomEditingProps
>(({ onChange }, ref) => {
  const [room, setRoom] = React.useState<Room | null>(null);
  const user = useUserStore((state) => state);
  const [open, setOpen] = React.useState(false);
  const [operation, setOperation] = React.useState<"create" | "update">(
    "create"
  );

  const { formState, register, handleSubmit, control, reset } =
    useForm<RoomEditingFieldsInfer>({
      resolver: zodResolver(RoomEditingFields),
      defaultValues: {
        name: "New Room",
        description: "",
        type: "ts-game",
      },
    });

  React.useImperativeHandle(ref, () => ({
    create: () => {
      setRoom(null);
      reset({ name: "", description: "", type: "ts-game" });
      setOperation("create");
      setOpen(true);
    },
    edit: (room: Room) => {
      setRoom(room);
      reset({ ...room });
      setOperation("update");
      setOpen(true);
    },
    close: () => {
      setOpen(false);
    },
  }));

  const { handleRequest } = useRequestHandler({ toastOnError: true });

  const createRoomCb = React.useCallback(
    async (data: RoomEditingFieldsInfer) => {
      handleRequest(async () => {
        await createRoom({ ...data, authorId: user.id });
        toast.success("Room created successfully");
        setOpen(false);
        onChange?.();
      });
    },
    [handleRequest, onChange, user.id]
  );

  const updateRoomCb = React.useCallback(
    async (data: RoomEditingFieldsInfer) => {
      if (room) {
        handleRequest(async () => {
          await updateRoom(room.id, { ...data });
          toast.success("Room updated successfully");
          setOpen(false);
          onChange?.();
        });
      }
    },
    [handleRequest, onChange, room]
  );

  const deleteRoomCb = React.useCallback(async () => {
    if (room) {
      handleRequest(async () => {
        await deleteRoom(room.id);
        toast.success("Room deleted successfully");
        setOpen(false);
        onChange?.();
      });
    }
  }, [handleRequest, onChange, room]);

  return (
    <Dialog defaultOpen={open} onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {operation === "create" ? "Create Room" : "Edit Room"}
          </DialogTitle>
          <DialogDescription>
            {operation === "create" ? "Create a new room" : "Edit the room"}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input {...register("name")} placeholder="Room Name" />
            </Field>
            <Field>
              <FieldLabel>Game Type</FieldLabel>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <GameTypeSelect
                    value={field.value}
                    onChange={field.onChange}
                    disabled={operation === "update"}
                  />
                )}
              />
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea
                {...register("description")}
                placeholder="Room Description"
              />
            </Field>
          </FieldSet>
        </FieldGroup>
        <DialogFooter className="flex !justify-between">
          {operation === "create" ? (
            <>
              <Button onClick={handleSubmit(createRoomCb)}>Create</Button>
            </>
          ) : (
            <>
              <Button onClick={deleteRoomCb} variant={"destructive"}>
                Delete
              </Button>
              <Button onClick={handleSubmit(updateRoomCb)}>Update</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const GameTypeSelect = ({
  value,
  onChange,
  disabled,
}: {
  value: GameRoomsType;
  onChange: (value: GameRoomsType) => void;
  disabled?: boolean;
}) => {
  return (
    <div className="relative">
      <Tabs
        className={cn("w-44", disabled && "opacity-50 pointer-events-none")}
        value={value}
        onValueChange={(value) => {
          onChange(value as GameRoomsType);
        }}
      >
        <TabsList>
          <TabsTrigger
            value={"ts-game"}
            className="data-[active=false]:opacity-50"
          >
            <PhaserLogo height={64} width={100} className="!w-24 !h-6" />
            ts-game
          </TabsTrigger>
          <TabsTrigger
            value={"godot"}
            className="data-[active=false]:opacity-50"
          >
            <GodotLogo className="!w-6 !h-6" />
            Godot
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
};

export function RoomEditing() {}

export function useRooms(ofUserId?: number) {
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const loadRooms = React.useCallback(async () => {
    const rooms = await listRooms();
    setRooms(rooms);
  }, []);
  let filtered = rooms;
  if (ofUserId) {
    filtered = filtered.filter((room) => room.author?.id === ofUserId);
  }
  return { items: filtered, load: loadRooms };
}

export function RoomsList({
  forCurrentUser = false,
}: {
  forCurrentUser?: boolean;
}) {
  const user = useUserStore((state) => state);
  const { items, load } = useRooms(forCurrentUser ? user.id : undefined);
  const editingApi = React.useRef<RoomEditingPanelAPI>(null);

  React.useEffect(() => {
    load();
  }, [load]);
  return (
    <>
      <div>
        <Button variant={"outline"} onClick={load}>
          <RefreshCcwIcon />
        </Button>
      </div>
      {user.authorized ? (
        <RoomEditingPanel ref={editingApi} onChange={load} />
      ) : null}
      {items.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground w-full">
          {forCurrentUser ? "You don't have any rooms" : "No rooms found"}
        </div>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {items.map((room) => (
          <RoomCard key={room.id} room={room} editingApi={editingApi} />
        ))}
      </div>
      {forCurrentUser && user.authorized ? (
        <div className="flex justify-center">
          <RippleButton
            variant="default"
            className="w-fit"
            size={"lg"}
            onClick={() => editingApi.current?.create()}
          >
            <PlusIcon />
            ADD ONE
            <PlusIcon />
            <RippleButtonRipples />
          </RippleButton>
        </div>
      ) : null}
    </>
  );
}
