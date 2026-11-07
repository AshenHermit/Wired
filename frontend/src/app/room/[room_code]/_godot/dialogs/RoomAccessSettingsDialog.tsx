"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import type {
  PublicUser,
  Room,
  RoomAccessMode,
  UpdateRoomAccessPayload,
} from "@wired-io/shared";
import { updateRoomAccess } from "@/api/services/rooms";
import { UserPicker } from "@/components/access/UserPicker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const MODES: { value: RoomAccessMode; labelKey: "modeAll" | "modeAuthor" | "modeUsers" }[] = [
  { value: "all", labelKey: "modeAll" },
  { value: "author", labelKey: "modeAuthor" },
  { value: "users", labelKey: "modeUsers" },
];

/**
 * One access policy section: a mode selector plus, when the mode is `users`,
 * the user picker that resolves the selected ids. The `availableUsers` list is
 * the room's already-resolved users (contributors); unresolved ids fall back to
 * numeric chips inside {@link UserPicker}.
 */
function AccessSection({
  title,
  mode,
  onModeChange,
  userIds,
  onUserIdsChange,
  availableUsers,
  disabled,
}: {
  title: string;
  mode: RoomAccessMode;
  onModeChange: (mode: RoomAccessMode) => void;
  userIds: number[];
  onUserIdsChange: (userIds: number[]) => void;
  availableUsers: PublicUser[];
  disabled: boolean;
}) {
  const t = useTranslations("RoomAccess");

  return (
    <section className="space-y-2.5 rounded-lg border border-border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="space-y-1.5">
        <Label>{t("modeLabel")}</Label>
        <div className="flex flex-wrap gap-1">
          {MODES.map(({ value, labelKey }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={mode === value ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onModeChange(value)}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
      </div>
      {mode === "users" && (
        <UserPicker
          selectedUserIds={userIds}
          onChange={onUserIdsChange}
          selectedUsers={availableUsers}
          disabled={disabled}
        />
      )}
    </section>
  );
}

/**
 * Room-level access settings: who may manage the room's packages and who may
 * create new ones. The author can never be locked out — the server re-grants
 * the author in `author`/`users` modes, so the dialog never offers to remove
 * them explicitly.
 */
export function RoomAccessSettingsDialog({
  open,
  onOpenChange,
  room,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Full room; source of the current access fields. */
  room: Room;
  /**
   * Receives the room returned by the save request. The parent owns the room
   * object, so it must replace it — otherwise reopening the dialog would seed
   * from the pre-save policy fields.
   */
  onSaved: (room: Room) => void;
}) {
  const t = useTranslations("RoomAccess");
  const common = useTranslations("Common");

  const [managementMode, setManagementMode] =
    React.useState<RoomAccessMode>("author");
  const [managementUserIds, setManagementUserIds] = React.useState<number[]>(
    [],
  );
  const [creationMode, setCreationMode] =
    React.useState<RoomAccessMode>("author");
  const [creationUserIds, setCreationUserIds] = React.useState<number[]>([]);
  const [readMode, setReadMode] = React.useState<RoomAccessMode>("all");
  const [readUserIds, setReadUserIds] = React.useState<number[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(false);

  // Re-seed local state from the room whenever the dialog is reopened, so a
  // save made elsewhere (or a stale room object) never leaves stale defaults.
  React.useEffect(() => {
    if (!open) return;
    setManagementMode(room.packageManagementAccess ?? "author");
    setManagementUserIds(room.packageManagementUserIds ?? []);
    setCreationMode(room.packageCreationAccess ?? "author");
    setCreationUserIds(room.packageCreationUserIds ?? []);
    setReadMode(room.readAccess ?? "all");
    setReadUserIds(room.readUserIds ?? []);
    setError(false);
  }, [open, room]);

  // The room only carries resolved contributors, so these are the ids whose
  // names the picker can seed; any other selected id renders as a numeric chip.
  const contributors = React.useMemo(
    () => room.contributors ?? [],
    [room.contributors],
  );
  const managementAvailable = React.useMemo(
    () => contributors.filter((user) => managementUserIds.includes(user.id)),
    [contributors, managementUserIds],
  );
  const creationAvailable = React.useMemo(
    () => contributors.filter((user) => creationUserIds.includes(user.id)),
    [contributors, creationUserIds],
  );
  const readAvailable = React.useMemo(
    () => contributors.filter((user) => readUserIds.includes(user.id)),
    [contributors, readUserIds],
  );

  const save = async () => {
    const payload: UpdateRoomAccessPayload = {
      packageManagementAccess: managementMode,
      packageManagementUserIds: managementUserIds,
      packageCreationAccess: creationMode,
      packageCreationUserIds: creationUserIds,
      readAccess: readMode,
      readUserIds: readUserIds,
    };
    setSaving(true);
    setError(false);
    try {
      const updated = await updateRoomAccess(room.id, payload);
      onSaved(updated);
      onOpenChange(false);
    } catch (failure) {
      console.error(failure);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <AccessSection
            title={t("packageManagement")}
            mode={managementMode}
            onModeChange={setManagementMode}
            userIds={managementUserIds}
            onUserIdsChange={setManagementUserIds}
            availableUsers={managementAvailable}
            disabled={saving}
          />
          <AccessSection
            title={t("packageCreation")}
            mode={creationMode}
            onModeChange={setCreationMode}
            userIds={creationUserIds}
            onUserIdsChange={setCreationUserIds}
            availableUsers={creationAvailable}
            disabled={saving}
          />
          <AccessSection
            title={t("roomRead")}
            mode={readMode}
            onModeChange={setReadMode}
            userIds={readUserIds}
            onUserIdsChange={setReadUserIds}
            availableUsers={readAvailable}
            disabled={saving}
          />
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            {t("saveFailed")}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {common("cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
