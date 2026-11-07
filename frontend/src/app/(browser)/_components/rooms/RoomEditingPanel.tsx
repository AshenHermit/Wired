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
import { ImageUploadField } from "@/components/media/ImageUploadField";
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

type ConfirmRequest = {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  resolve: (value: boolean) => void;
};

type Confirm = (next: Omit<ConfirmRequest, "resolve">) => Promise<boolean>;

/**
 * Promise-based confirmation rendered with the animate-ui dialog, so the
 * panel never falls back to the browser's blocking `window.confirm`.
 */
function useConfirmDialog(): { confirm: Confirm; dialog: React.ReactNode } {
  const t = useTranslations("Common");
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);
  const requestRef = React.useRef<ConfirmRequest | null>(null);

  const confirm = React.useCallback<Confirm>((next) => {
    return new Promise<boolean>((resolve) => {
      const pending = { ...next, resolve };
      requestRef.current = pending;
      setRequest(pending);
    });
  }, []);

  const close = React.useCallback((value: boolean) => {
    const pending = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    pending?.resolve(value);
  }, []);

  const dialog = (
    <Dialog
      open={request !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close(false);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {request?.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex !justify-between">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => close(true)}
          >
            {request?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}

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
    "create",
  );
  const [previewImage, setPreviewImage] = React.useState<string | null>(null);
  const t = useTranslations("Rooms");
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

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
      setPreviewImage(null);
      reset({ name: "", description: "" });
      setOperation("create");
      setOpen(true);
    },
    edit: (next: Room) => {
      setRoom(next);
      setPreviewImage(next.previewImage ?? null);
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
    handleRequest(
      async () => {
        await createRoom({ ...data, type: "godot", previewImage });
        toast.success(t("created"));
        setOpen(false);
        onChange?.();
      },
      { errorMessage: { key: "Rooms.errors.create" } },
    );
  };

  const updateRoomCb = (data: RoomEditingFieldsInfer) => {
    if (!room) return;
    handleRequest(
      async () => {
        await updateRoom(room.id, { ...data, previewImage });
        toast.success(t("updated"));
        setOpen(false);
        onChange?.();
      },
      { errorMessage: { key: "Rooms.errors.update" } },
    );
  };

  const deleteRoomCb = () => {
    if (!room) return;
    void (async () => {
      const ok = await confirm({
        title: t("deleteDialog.title"),
        description: t("deleteDialog.description", { name: room.name }),
        confirmLabel: t("deleteDialog.confirm"),
        destructive: true,
      });
      if (!ok) return;
      handleRequest(
        async () => {
          await deleteRoom(room.id);
          toast.success(t("deleted"));
          setOpen(false);
          onChange?.();
        },
        { errorMessage: { key: "Rooms.errors.delete" } },
      );
    })();
  };

  return (
    <>
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
              <Field>
                <FieldLabel>{t("preview")}</FieldLabel>
                <ImageUploadField
                  value={previewImage}
                  onChange={setPreviewImage}
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
      {confirmDialog}
    </>
  );
});
RoomEditingPanel.displayName = "RoomEditingPanel";
