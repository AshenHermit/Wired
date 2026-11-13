"use client";

import * as React from "react";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import { SlugField } from "@/components/packages/slug-field";
import { useSlugAvailability } from "@/components/packages/use-slug-availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppMessage, type AppMessage } from "@/i18n/message";
import {
  PackagesActionError,
  type RoomPackagesController,
} from "../use-room-packages";

/** Version a new package starts on, and the fallback for an empty field. */
const DEFAULT_VERSION = "0.1.0";

/**
 * Creates one package in the room. The form lives here rather than in
 * `PackagesTab` so the panel only wires buttons and the dialog owns its own
 * draft, submit state and slug probe.
 */
export function CreatePackageDialog({
  open,
  onOpenChange,
  packages,
  canCreatePackages,
  viewerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packages: Pick<
    RoomPackagesController,
    "createPackage" | "checkSlugAvailability" | "fsReady"
  >;
  /** The viewer may create packages in this room (creation policy). */
  canCreatePackages: boolean;
  /** The signed-in user, for the "log in" hint. */
  viewerId: number | null;
}) {
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [version, setVersion] = React.useState(DEFAULT_VERSION);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<AppMessage | null>(null);
  const t = useTranslations("Packages");
  const common = useTranslations("Common");
  const format = useAppMessage();
  const checkSlugAvailability = packages.checkSlugAvailability;

  /**
   * Availability is advisory: the server still rejects a taken slug on POST.
   * A room slug is free even when the workshop already uses it, so the two
   * scopes are reported separately.
   */
  const slugAvailability = useSlugAvailability({
    slug,
    enabled: open,
    check: (candidate) => checkSlugAvailability(candidate),
    verdict: (result) => (result.available ? "available" : "taken"),
  });
  const slugTakenInWorkshop = slugAvailability.result?.global.available === false;

  // Closing drops a half-typed package, so every open starts from a clean form.
  React.useEffect(() => {
    if (open) return;
    setName("");
    setSlug("");
    setVersion(DEFAULT_VERSION);
    setError(null);
    setCreating(false);
  }, [open]);

  const canCreate =
    canCreatePackages &&
    packages.fsReady &&
    name.trim().length > 0 &&
    slugAvailability.state === "available" &&
    !creating;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreatePackages) {
      setError({
        key:
          viewerId === null
            ? "Packages.errors.loginRequired"
            : "Packages.errors.notRoomMember",
      });
      return;
    }
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await packages.createPackage({
        name: name.trim(),
        version: version.trim() || DEFAULT_VERSION,
        slug: slug.trim(),
      });
      onOpenChange(false);
    } catch (cause) {
      if (!(cause instanceof PackagesActionError)) console.error(cause);
      setError(
        cause instanceof PackagesActionError
          ? cause.appMessage
          : { key: "Packages.errors.createFailed" },
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!creating}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("createDialog.title")}</DialogTitle>
            <DialogDescription>
              {t.rich("createDialog.description", {
                path: "packages/<slug>",
                code: (chunks) => (
                  <span className="font-mono text-foreground">{chunks}</span>
                ),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="package-create-name">
                {t("createDialog.name")}
              </Label>
              <Input
                id="package-create-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("createDialog.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-create-version">
                {t("createDialog.version")}
              </Label>
              <Input
                id="package-create-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder={t("createDialog.versionPlaceholder")}
              />
            </div>
            <SlugField
              id="package-create-slug"
              label="Slug"
              value={slug}
              onChange={setSlug}
              placeholder={t("createDialog.slugPlaceholder")}
              availability={slugAvailability}
              takenInWorkshop={
                slugTakenInWorkshop ? t("createDialog.slugTakenInWorkshop") : null
              }
              retryLabel={t("createDialog.checkAgain")}
            />
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
              disabled={creating}
            >
              {common("cancel")}
            </Button>
            <Button type="submit" disabled={!canCreate}>
              {creating ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <PlusIcon className="size-4" />
              )}
              {t("createDialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
