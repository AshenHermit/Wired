"use client";

import type { WorkshopPackageSummary } from "@wired-io/shared";
import { Loader2Icon, StoreIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
  getScriptingPackage,
  lookupWorkshopPackage,
} from "@/api/services/scripting-packages";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import { WorkshopBrowser } from "@/components/packages/workshop-browser";
import {
  SLUG_CHECK_DEBOUNCE_MS,
  isSlugValid,
  slugHintClass,
  slugHintKey,
  type SlugCheckState,
} from "@/components/packages/slug";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WorkshopSlugTakenError,
  type RoomPackageEntry,
  type RoomPackagesController,
} from "./use-room-packages";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The public workshop inside the package panel. Adding a record is a server
 * copy: the selected row shows a spinner while the copy is created and
 * downloaded, and a failure stays in the dialog instead of vanishing into an
 * unhandled rejection.
 */
export function WorkshopBrowserDialog({
  open,
  onOpenChange,
  packages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packages: RoomPackagesController;
}) {
  const [pendingId, setPendingId] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPendingId(null);
    setError(null);
  }, [open]);

  const add = async (workshopPackage: WorkshopPackageSummary) => {
    setPendingId(workshopPackage.id);
    setError(null);
    try {
      await packages.addFromWorkshop(workshopPackage.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Workshop</DialogTitle>
          <DialogDescription>
            Пакеты сообщества. Добавление создаст копию в этой комнате.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <WorkshopBrowser
            busyId={pendingId}
            onSelect={(workshopPackage) => void add(workshopPackage)}
          />
        </div>
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type LookupState = "loading" | "free" | "mine" | "taken" | "error";

type PreviewDetails = {
  name: string;
  version: string;
  description: string;
  tags: string[];
};

/**
 * Publishes the latest published revision of a room package into the global
 * workshop record. The dialog is a preview: metadata is edited in the package
 * edit dialog, so publishing only mirrors the room package's own fields.
 *
 * The dialog first looks up the record of the slug: an absent record is
 * created, the caller's own record is updated, and a record of another author
 * is not overwritten — the user is offered a fork instead.
 */
export function WorkshopPublishDialog({
  open,
  onOpenChange,
  entry,
  packages,
  authorId,
  onFork,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: RoomPackageEntry | null;
  packages: RoomPackagesController;
  authorId: number | null;
  onFork: () => void;
}) {
  const [lookup, setLookup] = React.useState<LookupState>("loading");
  const [existing, setExisting] =
    React.useState<WorkshopPackageSummary | null>(null);
  const [lookupAttempt, setLookupAttempt] = React.useState(0);
  const [details, setDetails] = React.useState<PreviewDetails>({
    name: "",
    version: "",
    description: "",
    tags: [],
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const packageId = entry?.packageId ?? null;
  const slug = entry?.slug ?? "";

  // The room package stands in until the details request answers, so the
  // preview never opens empty.
  React.useEffect(() => {
    if (!open || packageId === null) return;
    setExisting(null);
    setLookup("loading");
    setError(null);
    setDetails({
      name: entry?.name ?? "",
      version: entry?.version ?? "",
      description: entry?.description ?? "",
      tags: entry?.tags ?? [],
    });
  }, [entry, open, packageId]);

  React.useEffect(() => {
    if (!open || packageId === null) return;
    setError(null);

    let cancelled = false;
    // The record decides which action the button performs; the room package
    // carries the description and tags the preview shows.
    void lookupWorkshopPackage(slug)
      .then(async (found) => {
        if (cancelled) return;
        setExisting(found);
        setLookup(
          found === null
            ? "free"
            : found.author?.id === authorId
              ? "mine"
              : "taken",
        );
        if (found !== null) return;
        const roomPackage = await getScriptingPackage(packageId).catch(
          () => null,
        );
        if (cancelled || roomPackage === null) return;
        setDetails({
          name: roomPackage.name,
          version: roomPackage.version,
          description: roomPackage.description,
          tags: roomPackage.tags,
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        // Neither creation nor update can be offered safely: without the
        // lookup the dialog cannot tell whether a record already exists.
        setLookup("error");
        setError(`Не удалось проверить запись в workshop: ${messageOf(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [authorId, lookupAttempt, open, packageId, slug]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!entry || submitting || (lookup !== "free" && lookup !== "mine")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await packages.publishToWorkshop(entry.packageId);
      onOpenChange(false);
    } catch (cause) {
      if (cause instanceof WorkshopSlugTakenError) {
        // Someone created the same global slug meanwhile: offer the fork
        // without closing the dialog.
        setExisting(cause.workshopPackage);
        setLookup("taken");
      } else {
        setError(messageOf(cause));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const taken = lookup === "taken";
  const canSubmit = !submitting && (lookup === "free" || lookup === "mine");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Опубликовать в workshop</DialogTitle>
            <DialogDescription>
              Пакет{" "}
              <span className="font-mono text-foreground">#{slug}</span>{" "}
              публикуется как запись workshop с последней опубликованной
              ревизией. Пакет комнаты и его файлы не изменятся.
            </DialogDescription>
          </DialogHeader>

          <dl className="space-y-3 text-sm">
            <div className="space-y-1">
              <dt className="text-muted-foreground">Название</dt>
              <dd className="font-medium">{details.name}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono">#{slug}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Версия</dt>
              <dd>{details.version}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Описание</dt>
              <dd className="whitespace-pre-wrap">
                {details.description.trim() || "Без описания"}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Теги</dt>
              <dd>
                {details.tags.length > 0 ? details.tags.join(", ") : "Без тегов"}
              </dd>
            </div>
          </dl>

          <p className="text-xs text-muted-foreground">
            Метаданные меняются в диалоге «Редактировать пакет».
          </p>

          <div className="text-xs">
            {lookup === "loading" && (
              <p className="text-muted-foreground">
                Проверяем запись в workshop…
              </p>
            )}
            {lookup === "free" && (
              <p className="text-muted-foreground">
                Будет создана новая запись в workshop
              </p>
            )}
            {lookup === "mine" && (
              <p className="text-muted-foreground">Публикация обновится</p>
            )}
            {taken && (
              <p className="text-destructive">
                Slug занят: {existing?.author?.name ?? "другой автор"}
              </p>
            )}
            {lookup === "error" && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={() => setLookupAttempt((attempt) => attempt + 1)}
              >
                Проверить снова
              </Button>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Отмена
            </Button>
            {taken ? (
              <Button type="button" onClick={onFork} disabled={submitting}>
                <StoreIcon className="size-4" />
                Создать fork
              </Button>
            ) : (
              <Button type="submit" disabled={!canSubmit}>
                {submitting ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <StoreIcon className="size-4" />
                )}
                Опубликовать
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Forks a package under a new slug. The copy is created in the same room by
 * the server and only then downloaded; publishing the fork into the workshop
 * is a separate action of the new card.
 */
export function WorkshopForkDialog({
  open,
  onOpenChange,
  entry,
  roomId,
  packages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: RoomPackageEntry | null;
  roomId: number;
  packages: RoomPackagesController;
}) {
  const [slug, setSlug] = React.useState("");
  const t = useTranslations();
  const [slugState, setSlugState] = React.useState<SlugCheckState>("idle");
  const [slugCheckAttempt, setSlugCheckAttempt] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const checkSlugAvailability = packages.checkSlugAvailability;

  React.useEffect(() => {
    if (!open) return;
    setSlug("");
    setSlugState("idle");
    setSlugCheckAttempt(0);
    setSubmitting(false);
    setError(null);
  }, [open]);

  /**
   * The slug must be free both inside the room and in the global workshop
   * scope; a response for a slug that already changed is ignored.
   */
  React.useEffect(() => {
    if (!open) return;
    const trimmed = slug.trim();
    if (!trimmed) {
      setSlugState("idle");
      return;
    }
    if (!isSlugValid(trimmed)) {
      setSlugState("invalid");
      return;
    }
    setSlugState("checking");
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkSlugAvailability(trimmed, roomId)
        .then((available) => {
          if (cancelled) return;
          setSlugState(
            available.available && available.global.available
              ? "available"
              : "taken",
          );
        })
        .catch(() => {
          if (cancelled) return;
          setSlugState("error");
        });
    }, SLUG_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkSlugAvailability, open, roomId, slug, slugCheckAttempt]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!entry || submitting || slugState !== "available") return;
    setSubmitting(true);
    setError(null);
    try {
      await packages.forkWorkshopPackage(entry.packageId, slug.trim());
      onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Создать fork</DialogTitle>
            <DialogDescription>
              Создастся копия пакета{" "}
              <span className="font-mono text-foreground">
                #{entry?.slug ?? ""}
              </span>{" "}
              с новым slug в этой комнате; исходный пакет останется.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="workshop-fork-slug">Новый slug</Label>
            <Input
              id="workshop-fork-slug"
              value={slug}
              onChange={(event) => {
                const next = event.target.value.toLowerCase();
                setSlug(next);
                const trimmed = next.trim();
                setSlugState(
                  !trimmed
                    ? "idle"
                    : isSlugValid(trimmed)
                      ? "checking"
                      : "invalid",
                );
              }}
              placeholder="hero_controller_v2"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              disabled={submitting}
              autoFocus
            />
            {slugHintKey(slugState) && (
              <p className={`text-xs ${slugHintClass(slugState)}`}>
                {t(slugHintKey(slugState)!)}
              </p>
            )}
            {slugState === "error" && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={() => setSlugCheckAttempt((attempt) => attempt + 1)}
              >
                Проверить снова
              </Button>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Отмена
            </Button>
            <Button
              type="submit"
              disabled={submitting || slugState !== "available"}
            >
              {submitting ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <StoreIcon className="size-4" />
              )}
              Создать fork
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
