"use client";

import {
  createRoom,
  deleteRoom,
  updateRoom,
} from "@/api/services/rooms";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import { Button } from "@/components/animate-ui/components/buttons/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { useRequestHandler } from "@/hooks/use-request-handler";
import type { Room } from "@wired-io/shared";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

export type RoomEditingPanelApi = {
  create: () => void;
  edit: (room: Room) => void;
  close: () => void;
};

export type RoomEditingProps = {
  onChange?: () => void;
};

const RoomEditingFields = z.object({
  name: z.string().min(1),
  description: z.string(),
});
type RoomEditingFieldsInfer = z.infer<typeof RoomEditingFields>;

/**
 * The create/edit/delete dialog for one room, driven imperatively by the list
 * so the dialog itself owns no selection state.
 */
export const RoomEditingPanel = React.forwardRef<
  RoomEditingPanelApi,
  RoomEditingProps
>(({ onChange }, ref) => {
  const [room, setRoom] = React.useState<Room | null>(null);
  const [open, setOpen] = React.useState(false);
  const [operation, setOperation] = React.useState<"create" | "update">(
    "create"
  );
  const t = useTranslations("Rooms");

  const { register, handleSubmit, reset } = useForm<RoomEditingFieldsInfer>({
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
    edit: (next: Room) => {
      setRoom(next);
      reset({ name: next.name, description: next.description });
      setOperation("update");
      setOpen(true);
    },
    close: () => {
      setOpen(false);
    },
  }));

  const { handleRequest } = useRequestHandler({ toastOnError: true });

  const createRoomCb = (data: RoomEditingFieldsInfer) => {
    handleRequest(async () => {
      await createRoom({ ...data, type: "godot" });
      toast.success(t("created"));
      setOpen(false);
      onChange?.();
    }, { errorMessage: { key: "Rooms.errors.create" } });
  };

  const updateRoomCb = (data: RoomEditingFieldsInfer) => {
    if (!room) return;
    handleRequest(async () => {
      await updateRoom(room.id, { ...data });
      toast.success(t("updated"));
      setOpen(false);
      onChange?.();
    }, { errorMessage: { key: "Rooms.errors.update" } });
  };

  const deleteRoomCb = () => {
    if (!room) return;
    handleRequest(async () => {
      await deleteRoom(room.id);
      toast.success(t("deleted"));
      setOpen(false);
      onChange?.();
    }, { errorMessage: { key: "Rooms.errors.delete" } });
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {operation === "create" ? t("createTitle") : t("editTitle")}
          </DialogTitle>
          <DialogDescription>
            {operation === "create"
              ? t("createDescription")
              : t("editDescription")}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel>{t("name")}</FieldLabel>
              <Input
                {...register("name")}
                placeholder={t("namePlaceholder")}
              />
            </Field>
            <Field>
              <FieldLabel>{t("description")}</FieldLabel>
              <Textarea
                {...register("description")}
                placeholder={t("descriptionPlaceholder")}
              />
            </Field>
          </FieldSet>
        </FieldGroup>
        <DialogFooter className="flex !justify-between">
          {operation === "create" ? (
            <Button onClick={handleSubmit(createRoomCb)}>{t("create")}</Button>
          ) : (
            <>
              <Button onClick={deleteRoomCb} variant={"destructive"}>
                {t("delete")}
              </Button>
              <Button onClick={handleSubmit(updateRoomCb)}>
                {t("update")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
RoomEditingPanel.displayName = "RoomEditingPanel";
