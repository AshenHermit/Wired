"use client";

import * as React from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  CheckIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  SettingsIcon,
  StoreIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import type { Room } from "@wired-io/shared";
import { PreviewThumbnail } from "@/components/media/PreviewThumbnail";
import { Button } from "@/components/ui/button";
import { useAppMessage, type AppMessage, type MessageKey } from "@/i18n/message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import { formatFileSize } from "@/utils/format-file-size";
import { CreatePackageDialog } from "./dialogs/CreatePackageDialog";
import {
  LocalChangesError,
  NewerRevisionError,
  type PackageActionState,
  type RoomPackageEntry,
  type RoomPackageStatus,
  type RoomPackagesController,
} from "./use-room-packages";
import {
  WorkshopBrowserDialog,
  WorkshopForkDialog,
  WorkshopPublishDialog,
} from "./dialogs/WorkshopDialogs";
import { PackageEditDialog } from "./dialogs/PackageEditDialog";
import { RoomAccessSettingsDialog } from "./dialogs/RoomAccessSettingsDialog";

const STATUS_LABEL_KEYS: Record<RoomPackageStatus, MessageKey> = {
  "not-loaded": "Packages.status.notLoaded",
  loaded: "Packages.status.loaded",
  "new-revision": "Packages.status.newRevision",
  "local-changes": "Packages.status.localChanges",
  disabled: "Packages.status.disabled",
};

const STATUS_CLASS: Record<RoomPackageStatus, string> = {
  "not-loaded": "border-border bg-muted/50 text-muted-foreground",
  loaded: "border-border bg-secondary text-secondary-foreground",
  "new-revision": "border-foreground/25 bg-foreground/10 text-foreground",
  "local-changes": "border-border bg-muted text-foreground",
  disabled: "border-border/60 bg-transparent text-muted-foreground",
};

const BACKEND_LABEL_KEYS: Record<string, MessageKey> = {
  published: "Packages.backend.published",
  pending: "Packages.backend.pending",
  applied: "Packages.backend.applied",
  ready: "Packages.backend.ready",
  failed: "Packages.backend.failed",
  stale: "Packages.backend.stale",
};

const RUNTIME_LABEL_KEYS: Record<string, MessageKey> = {
  pending: "Packages.runtime.pending",
  applied: "Packages.runtime.applied",
  failed: "Packages.runtime.failed",
};

function confirmation(
  pkg: RoomPackageEntry,
  changes: string[],
  verb: string,
  moreLabel: string,
): AppMessage {
  const files = changes.slice(0, 5).join(", ");
  const rest = changes.length > 5 ? ` ${moreLabel}` : "";
  return {
    key: "Packages.confirm.localChanges",
    values: { packageName: pkg.name, files, more: rest, verb },
  };
}

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
      onOpenChange={(open) => {
        if (!open) close(false);
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

type ForceableAction = (
  packageId: number,
  options?: { force?: boolean },
) => Promise<void>;

/**
 * Wraps one package action with the shared "confirm → retry force" policy:
 * download, remove and emit all fail once on local changes (or a newer
 * published revision), ask the user, and repeat only after a confirmation.
 */
function useConfirmedAction(
  confirm: Confirm,
): (
  entry: RoomPackageEntry,
  action: ForceableAction,
  describeConflict: (error: unknown) => AppMessage | null,
) => Promise<void> {
  const t = useTranslations("Packages");
  const format = useAppMessage();
  return React.useCallback(
    async (
      entry: RoomPackageEntry,
      action: ForceableAction,
      describeConflict: (error: unknown) => AppMessage | null,
    ): Promise<void> => {
      try {
        await action(entry.packageId);
      } catch (error) {
        const question = describeConflict(error);
        if (question === null) return;
        const accepted = await confirm({
          title: t("confirm.title"),
          description: format(question),
          confirmLabel: t("confirm.continue"),
        });
        if (!accepted) return;
        try {
          await action(entry.packageId, { force: true });
        } catch {
          // The panel already shows the error of the failed action.
        }
      }
    },
    [confirm, format, t],
  );
}

function PackageCard({
  entry,
  action,
  fsReady,
  canManagePackages,
  onDownload,
  onRemove,
  onAdopt,
  onEmit,
  onToggle,
  onDelete,
  onPublishToWorkshop,
  onEdit,
}: {
  entry: RoomPackageEntry;
  /** Progress, notice and error for this one package. */
  action: PackageActionState;
  /** Whether the editor bridge can move files at all. */
  fsReady: boolean;
  /** The viewer may write to this room, so the API will accept the action. */
  canManagePackages: boolean;
  onDownload: (entry: RoomPackageEntry) => void;
  onRemove: (entry: RoomPackageEntry) => void;
  onAdopt: (entry: RoomPackageEntry) => void;
  onEmit: (entry: RoomPackageEntry) => void;
  onToggle: (entry: RoomPackageEntry) => void;
  onDelete: (entry: RoomPackageEntry) => void;
  onPublishToWorkshop: (entry: RoomPackageEntry) => void;
  onEdit: (entry: RoomPackageEntry) => void;
}) {
  const format = useAppMessage();
  const t = useTranslations("Packages");
  const rootT = useTranslations();
  const numberFormat = useFormatter();
  const disabled = !fsReady || action.busy;
  const preview = entry.previewImage;
  const size =
    entry.sizeBytes === null ? null : formatFileSize(entry.sizeBytes);

  return (
    <li className="rounded-lg border border-border bg-card p-4 text-sm text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {preview ? <PreviewThumbnail src={preview} /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-base font-semibold">
              {entry.name}
            </span>
            <span
              className="font-mono text-xs text-muted-foreground"
              title={t("card.slugTitle")}
            >
              #{entry.slug}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[entry.status]}`}
            >
              {rootT(STATUS_LABEL_KEYS[entry.status])}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>
              {entry.version
                ? t("card.version", { version: entry.version })
                : t("card.versionMissing")}
            </span>
            <span>
              {entry.publishedRevision !== null
                ? t("card.published", {
                    revision: entry.publishedRevision,
                  })
                : t("card.publishedMissing")}
            </span>
            {size && (
              <span>
                {t(size.unit === "kb" ? "card.sizeKb" : "card.sizeMb", {
                  value: numberFormat.number(size.value, {
                    maximumFractionDigits: 1,
                  }),
                })}
              </span>
            )}
            {entry.loaded && entry.loadedRevision !== null && (
              <span>
                {t(
                  entry.loadedRevision === 0
                    ? "card.loadedUnpublished"
                    : "card.loaded",
                  { revision: entry.loadedRevision },
                )}
              </span>
            )}
          </div>
          {(entry.description || entry.tags.length > 0) && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              {entry.description && (
                <p className="line-clamp-2">{entry.description}</p>
              )}
              {entry.tags.length > 0 && (
                <p>{entry.tags.join(", ")}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {!entry.loaded &&
            entry.inEditor &&
            entry.localChanges.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => onAdopt(entry)}
                title={t("card.adoptTitle")}
              >
                <FolderOpenIcon className="size-4" />
                {t("card.adopt")}
              </Button>
            )}
          {entry.enabled && (
            <Button
              type="button"
              size="sm"
              disabled={disabled || !entry.loaded}
              onClick={() => onEmit(entry)}
              title={
                entry.loaded
                  ? t("card.emitTitle")
                  : t("card.emitMissingTitle")
              }
            >
              {action.busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <UploadIcon className="size-4" />
              )}
              Emit
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("card.actions")}
                title={t("card.actions")}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={disabled || entry.publishedRevision === null}
                onSelect={() => onDownload(entry)}
              >
                <DownloadIcon className="size-4" />
                {t("card.download")}
              </DropdownMenuItem>
              {entry.inEditor && (
                <DropdownMenuItem
                  disabled={disabled}
                  onSelect={() => onRemove(entry)}
                >
                  <Trash2Icon className="size-4" />
                  {t("card.remove")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={disabled}
                onSelect={() => onToggle(entry)}
              >
                <PowerIcon className="size-4" />
                {entry.enabled ? t("card.disable") : t("card.enable")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={disabled}
                onSelect={() => onEdit(entry)}
              >
                <PencilIcon className="size-4" />
                {t("card.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={
                  disabled || !canManagePackages || entry.publishedRevision === null
                }
                onSelect={() => onPublishToWorkshop(entry)}
                title={
                  entry.publishedRevision === null
                    ? t("card.publishUnavailable")
                    : undefined
                }
              >
                <StoreIcon className="size-4" />
                {t("card.publish")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={disabled}
                onSelect={() => onDelete(entry)}
              >
                <Trash2Icon className="size-4" />
                {t("card.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!entry.enabled && (
        <div className="mt-3 text-xs text-muted-foreground">
          {t("card.disabled")}
        </div>
      )}

      {entry.enabled && entry.backendState && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("card.server")}{" "}
            <span className="text-foreground">
              {BACKEND_LABEL_KEYS[entry.backendState]
                ? rootT(BACKEND_LABEL_KEYS[entry.backendState])
                : entry.backendState}
            </span>
          </span>
          {entry.runtimeState && (
            <span>
              {RUNTIME_LABEL_KEYS[entry.runtimeState]
                ? rootT(RUNTIME_LABEL_KEYS[entry.runtimeState])
                : entry.runtimeState}
            </span>
          )}
          {entry.clientsTotal > 0 && (
            <span>
              {t("card.clients", {
                ready: entry.clientsReady,
                total: entry.clientsTotal,
              })}
            </span>
          )}
        </div>
      )}

      {entry.runtimeError && (
        <div className="mt-2 text-xs text-destructive">
          {t("card.runtimeError", { error: entry.runtimeError })}
        </div>
      )}

      {entry.localChanges.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-muted/50 p-2 text-xs text-foreground">
          <div className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon className="size-3.5" />
            {entry.loaded
              ? t("card.localChanges")
              : t("card.leftoverFiles")}
          </div>
          <ul className="mt-1 space-y-0.5 font-mono text-muted-foreground">
            {entry.localChanges.slice(0, 5).map((filepath) => (
              <li key={filepath} className="truncate">
                {filepath}
              </li>
            ))}
            {entry.localChanges.length > 5 && (
              <li>
                {t("card.moreFiles", {
                  count: entry.localChanges.length - 5,
                })}
              </li>
            )}
          </ul>
        </div>
      )}

      {action.progress && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          {t("card.progress", {
            current: action.progress.current,
            total: action.progress.total,
          })}
        </div>
      )}
      {action.notice && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-foreground">
          <CheckIcon className="size-3.5" />
          {format(action.notice)}
        </div>
      )}
      {action.error && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          {format(action.error)}
        </div>
      )}
    </li>
  );
}

/**
 * Room packages panel: lists every package bound to the room, and only the
 * explicit buttons move files between the backend and the Godot editor FS.
 */
export function PackagesTab({
  packages,
  canManagePackages,
  canCreatePackages,
  viewerId,
  room,
  onRoomSaved,
}: {
  packages: RoomPackagesController;
  /** The viewer may write to this room, so the API will accept the action. */
  canManagePackages: boolean;
  /** The viewer may create packages in this room (creation policy). */
  canCreatePackages: boolean;
  /** The signed-in user, for deciding whether a workshop record is theirs. */
  viewerId: number | null;
  /** The full room, for the access settings dialog. */
  room: Room;
  /** Receives the room returned by the access settings save. */
  onRoomSaved: (room: Room) => void;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [workshopOpen, setWorkshopOpen] = React.useState(false);
  const openCreate = () => setCreateOpen(true);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [publishEntry, setPublishEntry] =
    React.useState<RoomPackageEntry | null>(null);
  const [forkEntry, setForkEntry] = React.useState<RoomPackageEntry | null>(
    null,
  );
  const [editEntry, setEditEntry] = React.useState<RoomPackageEntry | null>(
    null,
  );
  const t = useTranslations("Packages");
  const settingsT = useTranslations("RoomAccess");
  const format = useAppMessage();
  const { confirm, dialog } = useConfirmDialog();
  const runConfirmed = useConfirmedAction(confirm);

  const handleDownload = (entry: RoomPackageEntry) => {
    void runConfirmed(
      entry,
      packages.applyPublishedRevision,
      (error) =>
        error instanceof LocalChangesError
          ? confirmation(
              entry,
              error.files,
              t("confirm.replaceLocalFiles"),
              t("confirm.moreFiles", { count: error.files.length - 5 }),
            )
          : null,
    );
  };

  const handleRemove = (entry: RoomPackageEntry) => {
    void runConfirmed(
      entry,
      packages.removePackageDirectory,
      (error) =>
        error instanceof LocalChangesError
          ? confirmation(
              entry,
              error.files,
              t("confirm.removePackageDir"),
              t("confirm.moreFiles", { count: error.files.length - 5 }),
            )
          : null,
    );
  };

  const handleEmit = (entry: RoomPackageEntry) => {
    void runConfirmed(
      entry,
      packages.emitPackage,
      (error) => {
        if (!(error instanceof NewerRevisionError)) return null;
        const loaded =
          error.loadedRevision === null || error.loadedRevision === 0
            ? t("card.revisionNotLoaded")
            : t("card.loaded", { revision: error.loadedRevision });
        return {
          key: "Packages.confirm.newerRevision",
          values: {
            name: entry.name,
            published: error.publishedRevision,
            loaded,
          },
        };
      },
    );
  };

  const handleToggle = (entry: RoomPackageEntry) => {
    void packages
      .setPackageEnabled(entry.packageId, !entry.enabled)
      .catch(() => {
        // The panel already shows the error of the failed action.
      });
  };

  const handleDelete = async (entry: RoomPackageEntry) => {
    const accepted = await confirm({
      title: t("deleteDialog.title"),
      description: t.rich("deleteDialog.description", {
        name: entry.name,
        slug: entry.slug,
        strong: (chunks) => <strong>{chunks}</strong>,
        code: (chunks) => <span className="font-mono">{chunks}</span>,
      }),
      confirmLabel: t("deleteDialog.confirm"),
      destructive: true,
    });
    if (!accepted) return;
    try {
      await packages.deletePackageRecord(entry.packageId);
    } catch {
      // The panel already shows the error of the failed action.
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("title")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t.rich("description", {
                path: "packages/<slug>",
                code: (chunks) => (
                  <span className="font-mono text-foreground">{chunks}</span>
                ),
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {viewerId !== null && room.author?.id === viewerId && (
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label={settingsT("openSettings")}
                title={settingsT("openSettings")}
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setWorkshopOpen(true)}
            >
              <StoreIcon className="size-4" />
              Workshop
            </Button>
            <Button type="button" size="sm" onClick={openCreate}>
              <PlusIcon className="size-4" />
              {t("create")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void packages.refresh()}
              title={t("refreshTitle")}
            >
              <RefreshCwIcon className="size-4" />
              {t("refresh")}
            </Button>
          </div>
        </div>

        {!packages.fsReady && !packages.error && (
          <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
            {t("fsLoading")}
          </div>
        )}
        <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground">
          {t("rescan")}
        </div>
        {packages.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {format(packages.error)}
          </div>
        )}

        <CreatePackageDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          packages={packages}
          canCreatePackages={canCreatePackages}
          viewerId={viewerId}
        />

        {packages.entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {packages.statusLoaded ? (
              <div className="flex flex-col items-center gap-3">
                <p>{t("empty")}</p>
                <Button type="button" size="sm" onClick={openCreate}>
                  <PlusIcon className="size-4" />
                  {t("emptyCreate")}
                </Button>
              </div>
            ) : (
              t("loadingList")
            )}
          </div>
        ) : (
          <ul className="space-y-3">
            {packages.entries.map((entry) => (
              <PackageCard
                key={entry.packageId}
                entry={entry}
                action={packages.actionFor(entry.packageId)}
                fsReady={packages.fsReady}
                canManagePackages={canManagePackages}
                onDownload={handleDownload}
                onRemove={handleRemove}
                onAdopt={(pkg) =>
                  void packages.adoptPackage(pkg.packageId).catch(() => {
                    // The panel already shows the error of the failed action.
                  })
                }
                onEmit={handleEmit}
                onToggle={handleToggle}
                onDelete={(pkg) => void handleDelete(pkg)}
                onPublishToWorkshop={setPublishEntry}
                onEdit={setEditEntry}
              />
            ))}
          </ul>
        )}
        {dialog}
        <PackageEditDialog
          open={editEntry !== null}
          entry={editEntry}
          packages={packages}
          viewerId={viewerId}
          room={room}
          onOpenChange={(open) => {
            if (!open) setEditEntry(null);
          }}
        />
        <WorkshopBrowserDialog
          open={workshopOpen}
          onOpenChange={setWorkshopOpen}
          packages={packages}
        />
        <WorkshopPublishDialog
          open={publishEntry !== null}
          onOpenChange={(open) => {
            if (!open) setPublishEntry(null);
          }}
          entry={publishEntry}
          packages={packages}
          viewerId={viewerId}
          onFork={() => {
            const entry = publishEntry;
            setPublishEntry(null);
            if (entry) setForkEntry(entry);
          }}
        />
        <WorkshopForkDialog
          open={forkEntry !== null}
          onOpenChange={(open) => {
            if (!open) setForkEntry(null);
          }}
          entry={forkEntry}
          packages={packages}
        />
        <RoomAccessSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          room={room}
          onSaved={onRoomSaved}
        />
      </div>
    </div>
  );
}
