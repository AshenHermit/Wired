"use client";

import * as React from "react";
import {
  CheckIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PackageIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  LocalChangesError,
  NewerRevisionError,
  type RoomPackageEntry,
  type RoomPackageStatus,
  type RoomPackagesController,
} from "./use-room-packages";

const STATUS_LABEL: Record<RoomPackageStatus, string> = {
  "not-loaded": "не загружен",
  loaded: "загружен",
  "new-revision": "есть новая ревизия",
  "local-changes": "локальные изменения",
  disabled: "отключён",
};

const STATUS_CLASS: Record<RoomPackageStatus, string> = {
  "not-loaded": "border-border bg-muted/50 text-muted-foreground",
  loaded: "border-border bg-secondary text-secondary-foreground",
  "new-revision": "border-foreground/25 bg-foreground/10 text-foreground",
  "local-changes": "border-border bg-muted text-foreground",
  disabled: "border-border/60 bg-transparent text-muted-foreground",
};

const BACKEND_LABEL: Record<string, string> = {
  published: "опубликован",
  pending: "ожидает применения",
  applied: "применён в runtime",
  ready: "готов у всех клиентов",
  failed: "ошибка применения",
  stale: "устарел",
};

const RUNTIME_LABEL: Record<string, string> = {
  pending: "runtime ещё применяет ревизию",
  applied: "runtime применил ревизию",
  failed: "runtime не смог применить ревизию",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function confirmation(pkg: RoomPackageEntry, changes: string[], verb: string) {
  const files = changes.slice(0, 5).join(", ");
  const rest = changes.length > 5 ? ` и ещё ${changes.length - 5}` : "";
  return `В пакете «${pkg.name}» есть локальные изменения: ${files}${rest}.\n\n${verb}?`;
}

function newerRevisionConfirmation(
  pkg: RoomPackageEntry,
  error: NewerRevisionError,
): string {
  return (
    `В пакете «${pkg.name}» уже опубликована ревизия ${error.publishedRevision}, ` +
    `а в редакторе ${
      error.loadedRevision === null || error.loadedRevision === 0
        ? "ревизия не загружена"
        : `ревизия ${error.loadedRevision}`
    }.\n\n` +
    `Emit опубликует файлы из редактора как новую ревизию и заменит ` +
    `опубликованную ревизию ${error.publishedRevision}. Продолжить?`
  );
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
            Отмена
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
  describeConflict: (error: unknown) => string | null,
) => Promise<void> {
  return React.useCallback(
    async (
      entry: RoomPackageEntry,
      action: ForceableAction,
      describeConflict: (error: unknown) => string | null,
    ): Promise<void> => {
      try {
        await action(entry.packageId);
      } catch (error) {
        const question = describeConflict(error);
        if (question === null) return;
        const accepted = await confirm({
          title: "Продолжить?",
          description: question,
          confirmLabel: "Продолжить",
        });
        if (!accepted) return;
        try {
          await action(entry.packageId, { force: true });
        } catch {
          // The panel already shows the error of the failed action.
        }
      }
    },
    [confirm],
  );
}

function PackageCard({
  entry,
  packages,
  onDownload,
  onRemove,
  onAdopt,
  onEmit,
  onToggle,
  onDelete,
}: {
  entry: RoomPackageEntry;
  packages: RoomPackagesController;
  onDownload: (entry: RoomPackageEntry) => void;
  onRemove: (entry: RoomPackageEntry) => void;
  onAdopt: (entry: RoomPackageEntry) => void;
  onEmit: (entry: RoomPackageEntry) => void;
  onToggle: (entry: RoomPackageEntry) => void;
  onDelete: (entry: RoomPackageEntry) => void;
}) {
  const action = packages.actionFor(entry.packageId);
  const disabled = !packages.fsReady || action.busy;

  return (
    <li className="rounded-lg border border-border bg-card p-4 text-sm text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2 text-base font-semibold">
              <PackageIcon className="size-4 text-muted-foreground" />
              {entry.name}
            </span>
            <span className="text-xs text-muted-foreground">#{entry.packageId}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[entry.status]}`}
            >
              {STATUS_LABEL[entry.status]}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {entry.version ? `версия ${entry.version}` : "версия не указана"}
            {entry.publishedRevision !== null
              ? ` · опубликована ревизия ${entry.publishedRevision}`
              : " · опубликованных ревизий нет"}
            {entry.loaded && entry.loadedRevision !== null
              ? ` · в редакторе ревизия ${entry.loadedRevision === 0 ? "не опубликована" : entry.loadedRevision}`
              : ""}
          </div>
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
                title="Оставить существующие файлы и разрешить их публикацию через Emit"
              >
                <FolderOpenIcon className="size-4" />
                Использовать каталог
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
                  ? "Опубликовать файлы каталога пакета"
                  : "Сначала скачайте пакет в редактор"
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
                aria-label="Действия с пакетом"
                title="Действия с пакетом"
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
                Скачать в редактор
              </DropdownMenuItem>
              {entry.inEditor && (
                <DropdownMenuItem
                  disabled={disabled}
                  onSelect={() => onRemove(entry)}
                >
                  <Trash2Icon className="size-4" />
                  Убрать из редактора
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={disabled}
                onSelect={() => onToggle(entry)}
              >
                <PowerIcon className="size-4" />
                {entry.enabled ? "Отключить" : "Включить"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={disabled}
                onSelect={() => onDelete(entry)}
              >
                <Trash2Icon className="size-4" />
                Удалить из комнаты
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!entry.enabled && (
        <div className="mt-3 text-xs text-muted-foreground">
          Пакет отключён в комнате и не участвует в игре. Файлы и ревизии
          сохранены — пакет можно включить обратно.
        </div>
      )}

      {entry.enabled && entry.backendState && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            Сервер:{" "}
            <span className="text-foreground">
              {BACKEND_LABEL[entry.backendState] ?? entry.backendState}
            </span>
          </span>
          {entry.runtimeState && (
            <span>
              {RUNTIME_LABEL[entry.runtimeState] ?? entry.runtimeState}
            </span>
          )}
          {entry.clientsTotal > 0 && (
            <span>
              клиенты: {entry.clientsReady}/{entry.clientsTotal} готовы
            </span>
          )}
        </div>
      )}

      {entry.runtimeError && (
        <div className="mt-2 text-xs text-destructive">
          Ошибка runtime: {entry.runtimeError}
        </div>
      )}

      {entry.localChanges.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-muted/50 p-2 text-xs text-foreground">
          <div className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon className="size-3.5" />
            {entry.loaded
              ? "Локальные изменения не опубликованы"
              : "В редакторе остались файлы прошлой сессии"}
          </div>
          <ul className="mt-1 space-y-0.5 font-mono text-muted-foreground">
            {entry.localChanges.slice(0, 5).map((filepath) => (
              <li key={filepath} className="truncate">
                {filepath}
              </li>
            ))}
            {entry.localChanges.length > 5 && (
              <li>и ещё {entry.localChanges.length - 5}…</li>
            )}
          </ul>
        </div>
      )}

      {action.progress && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Файлы: {action.progress.current}/{action.progress.total}
        </div>
      )}
      {action.notice && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-foreground">
          <CheckIcon className="size-3.5" />
          {action.notice}
        </div>
      )}
      {action.error && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          {action.error}
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
  authorId,
}: {
  packages: RoomPackagesController;
  authorId: number | null;
}) {
  const [name, setName] = React.useState("");
  const [version, setVersion] = React.useState("0.1.0");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  const { confirm, dialog } = useConfirmDialog();
  const runConfirmed = useConfirmedAction(confirm);

  const handleDownload = (entry: RoomPackageEntry) => {
    void runConfirmed(
      entry,
      packages.downloadPackage,
      (error) =>
        error instanceof LocalChangesError
          ? confirmation(
              entry,
              error.files,
              "Заменить локальные файлы опубликованной ревизией",
            )
          : null,
    );
  };

  const handleRemove = (entry: RoomPackageEntry) => {
    void runConfirmed(
      entry,
      packages.removePackage,
      (error) =>
        error instanceof LocalChangesError
          ? confirmation(
              entry,
              error.files,
              "Удалить каталог пакета из редактора вместе с локальными файлами",
            )
          : null,
    );
  };

  const handleEmit = (entry: RoomPackageEntry) => {
    void runConfirmed(
      entry,
      packages.emitPackage,
      (error) =>
        error instanceof NewerRevisionError
          ? newerRevisionConfirmation(entry, error)
          : null,
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
      title: "Удалить пакет из комнаты?",
      description: (
        <>
          Пакет <strong>{entry.name}</strong> (#{entry.packageId}) будет удалён
          вместе с ревизиями и артефактами. Отменить это нельзя.
        </>
      ),
      confirmLabel: "Удалить навсегда",
      destructive: true,
    });
    if (!accepted) return;
    try {
      await packages.deletePackage(entry.packageId);
    } catch {
      // The panel already shows the error of the failed action.
    }
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!authorId) {
      setCreateError("Войдите в аккаунт, чтобы создавать пакеты.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await packages.createPackage(name, authorId, version.trim() || "0.1.0");
      setName("");
    } catch (error) {
      setCreateError(messageOf(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Пакеты комнаты</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Пакеты не загружаются в редактор автоматически. Скачайте нужный
              пакет, отредактируйте его каталог{" "}
              <span className="font-mono text-foreground">
                packages/&lt;id&gt;
              </span>{" "}
              и нажмите Emit, чтобы опубликовать ревизию для игры.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void packages.refresh()}
            title="Проверить опубликованные ревизии и локальные изменения"
          >
            <RefreshCwIcon className="size-4" />
            Обновить
          </Button>
        </div>

        {!packages.fsReady && !packages.error && (
          <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
            Редактор ещё загружается. Список пакетов доступен, а действия с
            файлами станут доступны после запуска проекта Godot.
          </div>
        )}
        <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground">
          После создания, скачивания и удаления пакета панель автоматически
          просит Godot пересканировать файловую систему. Если каталог всё равно
          не появился во вкладке FileSystem, сохраните сцены и переоткройте
          проект: Project → Reload Current Project. После перезагрузки страницы
          набор загруженных пакетов сбрасывается.
        </div>
        {packages.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {packages.error}
          </div>
        )}

        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="package-name">Имя пакета</Label>
              <Input
                id="package-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Например, Hero Controller"
                required
              />
            </div>
            <div className="w-32 space-y-1.5">
              <Label htmlFor="package-version">Версия</Label>
              <Input
                id="package-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="0.1.0"
              />
            </div>
            <Button
              type="submit"
              disabled={creating || !packages.fsReady || !name.trim()}
            >
              {creating ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <PlusIcon className="size-4" />
              )}
              Создать пакет
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Новый пакет сразу появится в редакторе пустым каталогом. Остальные
            пакеты комнаты при этом не загружаются.
          </p>
          {createError && (
            <div className="mt-2 text-sm text-destructive">{createError}</div>
          )}
        </form>

        {packages.entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {packages.statusLoaded
              ? "В комнате пока нет пакетов. Создайте первый пакет."
              : "Загружаем список пакетов комнаты…"}
          </div>
        ) : (
          <ul className="space-y-3">
            {packages.entries.map((entry) => (
              <PackageCard
                key={entry.packageId}
                entry={entry}
                packages={packages}
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
              />
            ))}
          </ul>
        )}
        {dialog}
      </div>
    </div>
  );
}
