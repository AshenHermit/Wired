import { User } from "@wired-io/shared";
import { updateUser } from "@/api/services/users";
import { Button } from "@/components/animate-ui/components/buttons/button";
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
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useRequestHandler } from "@/hooks/use-request-handler";
import { useUserStore } from "@/store/user-store";
import { zodResolver } from "@hookform/resolvers/zod";
import { PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";

export type UserEditingPanelApi = {
  edit: (user: User) => void;
  close: () => void;
};
export type UserEditingProps = {
  onChange?: (user: User) => void;
};

export const UserEditingFields = z.object({
  name: z.string().min(1),
});
export type UserEditingFieldsInfer = z.infer<typeof UserEditingFields>;

export const UserEditingPanel = React.forwardRef<
  UserEditingPanelApi,
  UserEditingProps
>(({ onChange }, ref) => {
  const [user, setUser] = React.useState<User | null>(null);
  const [open, setOpen] = React.useState(false);
  const t = useTranslations("Profile");
  const { formState, register, handleSubmit, control, reset } =
    useForm<UserEditingFieldsInfer>({
      resolver: zodResolver(UserEditingFields),
      defaultValues: {
        name: "",
      },
    });

  React.useImperativeHandle(ref, () => ({
    edit: (user: User) => {
      setUser(user);
      reset({ ...user });
      setOpen(true);
    },
    close: () => {
      setOpen(false);
    },
  }));

  const { handleRequest } = useRequestHandler({ toastOnError: true });

  const updateUserCb = React.useCallback(
    async (data: UserEditingFieldsInfer) => {
      if (user) {
        handleRequest(async () => {
          const updated = await updateUser(user.id, { ...data });
          toast.success(t("updated"));
          setOpen(false);
          onChange?.(updated);
        });
      }
    },
    [handleRequest, onChange, t, user]
  );
  return (
    <Dialog defaultOpen={open} onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel>{t("name")}</FieldLabel>
              <Input {...register("name")} placeholder={t("name")} />
            </Field>
          </FieldSet>
        </FieldGroup>
        <DialogFooter className="flex">
          <Button onClick={handleSubmit(updateUserCb)}>{t("update")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export function CurrentUserEditingButton() {
  const user = useUserStore((state) => state);
  const editingApi = React.useRef<UserEditingPanelApi>(null);

  return (
    <>
      <UserEditingPanel
        ref={editingApi}
        onChange={(updated) => user.setUser({ authorized: true, ...updated })}
      />
      <RippleButton
        size={"sm"}
        variant={"ghost"}
        onClick={() => editingApi.current?.edit(user)}
      >
        <PencilIcon />
        <RippleButtonRipples />
      </RippleButton>
    </>
  );
}
