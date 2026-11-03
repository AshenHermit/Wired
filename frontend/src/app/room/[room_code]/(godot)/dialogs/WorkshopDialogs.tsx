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
import { WorkshopBrowser } from "@/components/packages/WorkshopBrowser";
import {
  slugHintClass,
  slugHintKey,
} from "@/components/packages/slug";
import { useSlugAvailability } from "@/components/packages/use-slug-availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppMessage, type AppMessage } from "@/i18n/message";
import {
  WorkshopActionError,
  WorkshopSlugTakenError,
  type RoomPackageEntry,
  type RoomPackagesController,
} from "../use-room-packages";

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
  const t = useTranslations("Workshop");
  const format = useAppMessage();
  const [pendingId, setPendingId] = React.useState<number | null>(null);
  const [error, setError] = React.useState<AppMessage | null>(null);

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
      console.error(cause);
      setError(
        cause instanceof WorkshopActionError
          ? cause.appMessage
          : { key: "Packages.errors.addFromWorkshopFailed" },
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("browserTitle")}</DialogTitle>
          <DialogDescription>{t("browserDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <WorkshopBrowser
            busyId={pendingId}
            onSelect={(workshopPackage) => void add(workshopPackage)}
          />
        </div>
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            {format(error)}
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
  viewerId,
  onFork,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: RoomPackageEntry | null;
  packages: RoomPackagesController;
  /** The signed-in user, for deciding whether a workshop record is theirs. */
  viewerId: number | null;
  onFork: () => void;
}) {
  const t = useTranslations("Workshop");
  const format = useAppMessage();
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
  const [error, setError] = React.useState<AppMessage | null>(null);

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
            : found.author?.id === viewerId
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
        console.error(cause);
        setLookup("error");
        setError({ key: "Packages.errors.workshopLookupFailed" });
      });
    return () => {
      cancelled = true;
    };
  }, [viewerId, lookupAttempt, open, packageId, slug]);

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
        console.error(cause);
        setError(
          cause instanceof WorkshopActionError
            ? cause.appMessage
            : { key: "Packages.errors.publishFailed" },
        );
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
            <DialogTitle>{t("publishTitle")}</DialogTitle>
            <DialogDescription>
              {t.rich("publishDescription", {
                slug,
                code: (chunks) => (
                  <span className="font-mono text-foreground">{chunks}</span>
                ),
              })}
            </DialogDescription>
          </DialogHeader>

          <dl className="space-y-3 text-sm">
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("name")}</dt>
              <dd className="font-medium">{details.name}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono">#{slug}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("version")}</dt>
              <dd>{details.version}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("description")}</dt>
              <dd className="whitespace-pre-wrap">
                {details.description.trim() || t("noDescription")}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("tags")}</dt>
              <dd>
                {details.tags.length > 0
                  ? details.tags.join(", ")
                  : t("noTags")}
              </dd>
            </div>
          </dl>

          <p className="text-xs text-muted-foreground">
            {t("metadataHint")}
          </p>

          <div className="text-xs">
            {lookup === "loading" && (
              <p className="text-muted-foreground">{t("checking")}</p>
            )}
            {lookup === "free" && (
              <p className="text-muted-foreground">{t("willCreate")}</p>
            )}
            {lookup === "mine" && (
              <p className="text-muted-foreground">{t("willUpdate")}</p>
            )}
            {taken && (
              <p className="text-destructive">
                {t("taken", {
                  author: existing?.author?.name ?? t("takenFallbackAuthor"),
                })}
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
                {t("checkAgain")}
              </Button>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {format(error)}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
            {taken ? (
              <Button type="button" onClick={onFork} disabled={submitting}>
                <StoreIcon className="size-4" />
                {t("createFork")}
              </Button>
            ) : (
              <Button type="submit" disabled={!canSubmit}>
                {submitting ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <StoreIcon className="size-4" />
                )}
                {t("publish")}
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
  const t = useTranslations("Workshop");
  const slugT = useTranslations();
  const common = useTranslations("Common");
  const format = useAppMessage();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<AppMessage | null>(null);

  const checkSlugAvailability = packages.checkSlugAvailability;

  /**
   * The slug must be free both inside the room and in the global workshop
   * scope; a response for a slug that already changed is ignored.
   */
  const slugAvailability = useSlugAvailability({
    slug,
    enabled: open,
    check: (candidate) => checkSlugAvailability(candidate, roomId),
    verdict: (result) =>
      result.available && result.global.available ? "available" : "taken",
  });
  const slugState = slugAvailability.state;

  React.useEffect(() => {
    if (!open) return;
    setSlug("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!entry || submitting || slugState !== "available") return;
    setSubmitting(true);
    setError(null);
    try {
      await packages.forkWorkshopPackage(entry.packageId, slug.trim());
      onOpenChange(false);
    } catch (cause) {
      console.error(cause);
      setError(
        cause instanceof WorkshopActionError
          ? cause.appMessage
          : { key: "Packages.errors.forkFailed" },
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("forkTitle")}</DialogTitle>
            <DialogDescription>
              {t.rich("forkDescription", {
                slug: entry?.slug ?? "",
                code: (chunks) => (
                  <span className="font-mono text-foreground">{chunks}</span>
                ),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="workshop-fork-slug">{t("newSlug")}</Label>
            <Input
              id="workshop-fork-slug"
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value.toLowerCase());
              }}
              placeholder={t("newSlugPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              disabled={submitting}
              autoFocus
            />
            {slugHintKey(slugState) && (
              <p className={`text-xs ${slugHintClass(slugState)}`}>
                {slugT(slugHintKey(slugState)!)}
              </p>
            )}
            {slugState === "error" && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={slugAvailability.retry}
              >
                {t("checkAgain")}
              </Button>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {format(error)}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {common("cancel")}
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
              {t("createFork")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
