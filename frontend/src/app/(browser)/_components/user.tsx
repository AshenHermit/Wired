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
import React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";

export type UserEditingPanelAPI = {
  edit: (user: User) => void;
  close: () => void;
};
export type UserEditingProps = {
  onChange?: () => void;
};

export const UserEditingFields = z.object({
  name: z.string().min(1),
});
export type UserEditingFieldsInfer = z.infer<typeof UserEditingFields>;

export const UserEditingPanel = React.forwardRef<
  UserEditingPanelAPI,
  UserEditingProps
>(({ onChange }, ref) => {
  const [user, setUser] = React.useState<User | null>(null);
  const [open, setOpen] = React.useState(false);
  const { formState, register, handleSubmit, control, reset } =
    useForm<UserEditingFieldsInfer>({
      resolver: zodResolver(UserEditingFields),
      defaultValues: {
        name: "",
      },
    });

  React.useImperativeHandle(ref, () => ({
    edit: (room: User) => {
      setUser(room);
      reset({ ...room });
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
          await updateUser(user.id, { ...data });
          toast.success("Profile updated successfully");
          setOpen(false);
          onChange?.();
        });
      }
    },
    [handleRequest, onChange, user]
  );
  return (
    <Dialog defaultOpen={open} onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
        </DialogHeader>

        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input {...register("name")} placeholder="Name" />
            </Field>
          </FieldSet>
        </FieldGroup>
        <DialogFooter className="flex">
          <Button onClick={handleSubmit(updateUserCb)}>Update</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export function CurrentUserEditingButton() {
  const user = useUserStore((state) => state);
  const editingApi = React.useRef<UserEditingPanelAPI>(null);

  return (
    <>
      <UserEditingPanel ref={editingApi} onChange={user.loadUser} />
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
