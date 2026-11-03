"use client";

import { Loader2Icon } from "lucide-react";
import * as React from "react";
import { getScriptingPackage } from "@/api/services/scripting-packages";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import {
  SLUG_CHECK_DEBOUNCE_MS,
  SLUG_HINT,
  isSlugValid,
  slugHintClass,
  type SlugCheckState,
} from "@/components/packages/slug";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  PackageDirectoryRenameError,
  SlugRenameDependentsError,
  type RoomPackageEntry,
  type RoomPackagesController,
} from "./use-room-packages";
import { parseTags } from "./workshop-dialogs";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DetailsState = "loading" | "ready" | "error";

/**
 * The only place where package metadata is edited: name, version, slug,
 * description and tags. The slug is validated against the room scope while
 * ignoring the package itself, and a rename that published dependents point to
 * asks for an explicit confirmation before their files are rewritten.
 *
 * The server rename and the editor directory rename are two steps: when the
 * directory move fails the panel keeps the server state and offers the
 * idempotent retry.
 */
export function PackageEditDialog({
  open,
  onOpenChange,
  entry,
  packages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: RoomPackageEntry | null;
  packages: RoomPackagesController;
}) {
  const [name, setName] = React.useState("");
  const [version, setVersion] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [detailsState, setDetailsState] =
    React.useState<DetailsState>("loading");
  const [detailsAttempt, setDetailsAttempt] = React.useState(0);
  const [slugState, setSlugState] = React.useState<SlugCheckState>("idle");
  const [slugCheckAttempt, setSlugCheckAttempt] = React.useState(0);
  const [dependents, setDependents] = React.useState<
    { packageId: number; name: string }[] | null
  >(null);
  const [dirError, setDirError] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const checkSlugAvailability = packages.checkSlugAvailability;

  React.useEffect(() => {
    if (!open || !entry) return;
    setName(entry.name);
    setVersion(entry.version);
    setSlug(entry.slug);
    setDescription(entry.description);
    setTags(entry.tags.join(", "));
    setSlugState("available");
    setDependents(null);
    setDirError(false);
    setError(null);
    setSubmitting(false);
    setDetailsAttempt(0);
    setDetailsState("loading");
  }, [open, entry]);

  React.useEffect(() => {
    if (!open || !entry) return;
    let cancelled = false;
    setDetailsState("loading");
    void getScriptingPackage(entry.packageId)
      .then((pkg) => {
        if (cancelled) return;
        setDescription(pkg.description ?? "");
        setTags((pkg.tags ?? []).join(", "));
        setDetailsState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDetailsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, entry, detailsAttempt]);

  React.useEffect(() => {
    if (!open || !entry) return;
    const trimmed = slug.trim();
    if (trimmed === entry.slug) {
      setSlugState("available");
      return;
    }
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
      void checkSlugAvailability(trimmed, undefined, entry.packageId)
        .then((result) => {
          if (cancelled) return;
          setSlugState(result.available ? "available" : "taken");
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
  }, [checkSlugAvailability, entry, open, slug, slugCheckAttempt]);

  const handleSlugChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value.toLowerCase();
    setSlug(next);
    const trimmed = next.trim();
    setSlugState(
      !trimmed
        ? "idle"
        : trimmed === entry?.slug
          ? "available"
          : isSlugValid(trimmed)
            ? "checking"
            : "invalid",
    );
  };

  const retrySlugCheck = () => {
    if (!slug.trim() || !isSlugValid(slug.trim())) return;
    setSlugCheckAttempt((attempt) => attempt + 1);
  };

  const canSubmit =
    detailsState === "ready" &&
    slugState === "available" &&
    name.trim().length > 0 &&
    version.trim().length > 0 &&
    !submitting;

  const save = async (confirmRename: boolean) => {
    if (!entry) return;
    setSubmitting(true);
    setError(null);
    try {
      await packages.updatePackageMetadata(entry.packageId, {
        name: name.trim(),
        version: version.trim(),
        slug: slug.trim(),
        description: description.trim(),
        tags: parseTags(tags),
        ...(confirmRename ? { confirmSlugRename: true } : {}),
      });
      onOpenChange(false);
    } catch (failure) {
      if (failure instanceof SlugRenameDependentsError) {
        setDependents(failure.dependents);
      } else if (failure instanceof PackageDirectoryRenameError) {
        setDirError(true);
      } else {
        setError(messageOf(failure));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const retryDirectory = async () => {
    if (!entry) return;
    setSubmitting(true);
    setError(null);
    try {
      await packages.renamePackageDir(entry.packageId, entry.slug, slug.trim());
      setDirError(false);
      onOpenChange(false);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!submitting}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            void save(dependents !== null);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Редактировать пакет</DialogTitle>
            <DialogDescription>
              Имя, версия, slug, описание и теги. Slug задаёт каталог{" "}
              <span className="font-mono text-foreground">
                packages/&lt;slug&gt;
              </span>{" "}
              в редакторе; при изменении папка переименовывается.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-name">Имя пакета</Label>
              <Input
                id="package-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={submitting}
                placeholder="Например, Hero Controller"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-version">Версия</Label>
              <Input
                id="package-edit-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                disabled={submitting}
                placeholder="0.1.0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-slug">Slug</Label>
              <Input
                id="package-edit-slug"
                value={slug}
                onChange={handleSlugChange}
                disabled={submitting}
                placeholder="hero_controller"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
              {SLUG_HINT[slugState] && (
                <p className={`text-xs ${slugHintClass(slugState)}`}>
                  {SLUG_HINT[slugState]}
                </p>
              )}
              {slugState === "error" && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={retrySlugCheck}
                >
                  Проверить снова
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-description">Описание</Label>
              <Textarea
                id="package-edit-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={submitting || detailsState !== "ready"}
                placeholder="Что делает пакет"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-tags">Теги</Label>
              <Input
                id="package-edit-tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                disabled={submitting || detailsState !== "ready"}
                placeholder="gameplay, hero"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Через запятую или пробел.
              </p>
            </div>
            {detailsState === "loading" && (
              <p className="text-xs text-muted-foreground">
                Загружаем описание и теги пакета…
              </p>
            )}
            {detailsState === "error" && (
              <div className="space-y-1">
                <p className="text-xs text-destructive">
                  Не удалось загрузить описание и теги пакета.
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={() => setDetailsAttempt((attempt) => attempt + 1)}
                >
                  Повторить
                </Button>
              </div>
            )}
          </div>

          {dependents && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
              <p>На slug ссылаются пакеты:</p>
              <ul className="mt-1 list-disc pl-5">
                {dependents.map((dependent) => (
                  <li key={dependent.packageId}>{dependent.name}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Их опубликованные файлы будут переписаны на новый slug. В
                редакторах участников ссылки обновятся после повторного
                скачивания пакетов.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={submitting}
                onClick={() => void save(true)}
              >
                Переименовать и обновить ссылки
              </Button>
            </div>
          )}

          {dirError && (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <p>
                Сервер уже переименован, папка в редакторе — нет. Файлы не
                потеряны: повторите перенос папки.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => void retryDirectory()}
              >
                Повторить переименование папки
              </Button>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Публикация под новым slug создаст новую запись в workshop; старая
            останется, пока её не удалят.
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
