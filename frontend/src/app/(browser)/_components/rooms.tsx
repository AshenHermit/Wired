"use client";

import {
  createRoom,
  deleteRoom,
  listRooms,
  updateRoom,
} from "@/api/services/rooms";
import type { Room } from "@wired-io/shared/api/types";
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
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useUserStore } from "@/store/user-store";
import {
  PlayIcon,
  PlusIcon,
  RefreshCcwIcon,
  WrenchIcon,
} from "lucide-react";
import React from "react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRequestHandler } from "@/hooks/use-request-handler";
import { Button } from "@/components/animate-ui/components/buttons/button";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import Link from "next/link";
import { encodeId } from "@/utils/hash-utils";

export function RoomCard({
  room,
  editingApi,
}: {
  room: Room;
  editingApi?: React.RefObject<RoomEditingPanelAPI | null>;
}) {
  const authorized = useUserStore((state) => state.authorized);
  const userId = useUserStore((state) => state.id);
  const canEdit = editingApi && authorized && userId === room.author?.id;
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
  description: z.string(),
});
export type RoomEditingFieldsInfer = z.infer<typeof RoomEditingFields>;

export const RoomEditingPanel = React.forwardRef<
  RoomEditingPanelAPI,
  RoomEditingProps
>(({ onChange }, ref) => {
  const [room, setRoom] = React.useState<Room | null>(null);
  const userId = useUserStore((state) => state.id);
  const [open, setOpen] = React.useState(false);
  const [operation, setOperation] = React.useState<"create" | "update">(
    "create"
  );

  const { register, handleSubmit, reset } =
    useForm<RoomEditingFieldsInfer>({
      resolver: zodResolver(RoomEditingFields),
      defaultValues: {
        name: "New Room",
        description: "",
      },
    });

  React.useImperativeHandle(ref, () => ({
    create: () => {
      setRoom(null);
      reset({ name: "", description: "" });
      setOperation("create");
      setOpen(true);
    },
    edit: (room: Room) => {
      setRoom(room);
      reset({ name: room.name, description: room.description });
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
        await createRoom({ ...data, type: "godot", authorId: userId });
        toast.success("Комната создана");
        setOpen(false);
        onChange?.();
      });
    },
    [handleRequest, onChange, userId]
  );

  const updateRoomCb = React.useCallback(
    async (data: RoomEditingFieldsInfer) => {
      if (room) {
        handleRequest(async () => {
          await updateRoom(room.id, { ...data });
          toast.success("Комната обновлена");
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
        toast.success("Комната удалена");
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

export function RoomEditing() {}

export function useRooms(ofUserId?: number) {
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const loadRooms = React.useCallback(async () => {
    try {
      setError(null);
      setRooms(await listRooms());
    } catch {
      setError("Не удалось загрузить список комнат.");
    }
  }, []);
  let filtered = rooms;
  if (ofUserId) {
    filtered = filtered.filter((room) => room.author?.id === ofUserId);
  }
  return { items: filtered, load: loadRooms, error };
}

export function RoomsList({
  forCurrentUser = false,
}: {
  forCurrentUser?: boolean;
}) {
  const userId = useUserStore((state) => state.id);
  const authorized = useUserStore((state) => state.authorized);
  const { items, load, error } = useRooms(forCurrentUser ? userId : undefined);
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
      {authorized ? (
        <RoomEditingPanel ref={editingApi} onChange={load} />
      ) : null}
      {error ? (
        <div className="text-center text-sm text-destructive w-full">
          {error}
        </div>
      ) : null}
      {items.length === 0 && !error ? (
        <div className="text-center text-sm text-muted-foreground w-full">
          {forCurrentUser ? "У вас пока нет комнат" : "Комнаты не найдены"}
        </div>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {items.map((room) => (
          <RoomCard key={room.id} room={room} editingApi={editingApi} />
        ))}
      </div>
      {forCurrentUser && authorized ? (
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
