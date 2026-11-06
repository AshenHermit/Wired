"use client";

import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useAppMessage, type AppMessage } from "@/i18n/message";
import { getScriptingPackage, updatePackageAccess } from "@/api/services/scripting-packages";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/animate-ui/components/radix/dialog";
import { slugHintClass, slugHintKey } from "@/components/packages/slug";
import { useSlugAvailability } from "@/components/packages/use-slug-availability";
import { TagInput } from "@/components/packages/TagInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  PackageDirectoryRenameError,
  SlugRenameDependentsError,
  type RoomPackageEntry,
  type RoomPackagesController,
} from "../use-room-packages";
import type { Room, RoomAccessMode, ScriptingPackage } from "@wired-io/shared";
import { UserPicker } from "@/components/access/UserPicker";

type DetailsState = "loading" | "ready" | "error";

const MODES: { value: RoomAccessMode; labelKey: "modeAll" | "modeAuthor" | "modeUsers" }[] = [
  { value: "all", labelKey: "modeAll" },
  { value: "author", labelKey: "modeAuthor" },
  { value: "users", labelKey: "modeUsers" },
];

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
  viewerId,
  room,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: RoomPackageEntry | null;
  /** Only the metadata actions this dialog drives. */
  packages: Pick<
    RoomPackagesController,
    "checkSlugAvailability" | "updatePackageMetadata" | "renamePackageDir"
  >;
  /** The signed-in user, for deciding whether they may administer this package's access. */
  viewerId: number | null;
  /** The full room, used to gate access edits on the room author. */
  room: Room;
}) {
  const [name, setName] = React.useState("");
  const t = useTranslations("Packages");
  const settingsT = useTranslations("RoomAccess");
  const common = useTranslations("Common");
  const slugT = useTranslations();
  const format = useAppMessage();
  const [version, setVersion] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagsInvalid, setTagsInvalid] = React.useState(false);
  const tagsInvalidRef = React.useRef(false);
  const [detailsState, setDetailsState] =
    React.useState<DetailsState>("loading");
  const [detailsAttempt, setDetailsAttempt] = React.useState(0);
  /** The full package fetched by `getScriptingPackage`, including access fields. */
  const [pkg, setPkg] = React.useState<ScriptingPackage | null>(null);
  const [dependents, setDependents] = React.useState<
    { packageId: number; name: string }[] | null
  >(null);
  const [dirError, setDirError] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<AppMessage | null>(null);
  /** Editing access: mode + selected user ids. */
  const [accessMode, setAccessMode] = React.useState<RoomAccessMode>("author");
  const [accessUserIds, setAccessUserIds] = React.useState<number[]>([]);
  const [accessSaving, setAccessSaving] = React.useState(false);
  const [accessError, setAccessError] = React.useState<AppMessage | null>(null);

  const checkSlugAvailability = packages.checkSlugAvailability;

  /** A rename is checked against the room scope, ignoring this package. */
  const slugAvailability = useSlugAvailability({
    slug,
    enabled: open && entry !== null,
    unchanged: entry?.slug,
    check: (candidate) =>
      checkSlugAvailability(candidate, undefined, entry?.packageId),
    verdict: (result) => (result.available ? "available" : "taken"),
  });
  const slugState = slugAvailability.state;

  React.useEffect(() => {
    if (!open || !entry) return;
    setName(entry.name);
    setVersion(entry.version);
    setSlug(entry.slug);
    setDescription(entry.description);
    setTags(entry.tags);
    setTagsInvalid(false);
    tagsInvalidRef.current = false;
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
        setPkg(pkg);
        setDescription(pkg.description ?? "");
        setTags(pkg.tags ?? []);
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

  // Re-seed the access draft whenever the package details arrive, so a stale
  // draft never survives a re-open or a refetch.
  React.useEffect(() => {
    if (!pkg) return;
    setAccessMode(pkg.editingAccess ?? "author");
    setAccessUserIds(pkg.editingUserIds ?? []);
    setAccessError(null);
  }, [pkg]);

  const canAdministerAccess =
    viewerId !== null &&
    pkg !== null &&
    (pkg.author?.id === viewerId || room.author?.id === viewerId);

  // The package only carries already-resolved contributors, so these are the
  // ids whose names the picker can seed; any other selected id renders as a
  // numeric chip inside UserPicker (accepted v1 limitation: no batch fetch-by-id).
  const contributors = React.useMemo(() => pkg?.contributors ?? [], [
    pkg?.contributors,
  ]);
  const accessAvailable = React.useMemo(
    () => contributors.filter((user) => accessUserIds.includes(user.id)),
    [contributors, accessUserIds],
  );

  const handleSlugChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSlug(event.target.value.toLowerCase());
  };

  const canSubmit =
    detailsState === "ready" &&
    slugState === "available" &&
    name.trim().length > 0 &&
    version.trim().length > 0 &&
    !tagsInvalid &&
    !submitting;

  const save = async (confirmRename: boolean) => {
    if (!entry || tagsInvalidRef.current) return;
    setSubmitting(true);
    setError(null);
    try {
      await packages.updatePackageMetadata(entry.packageId, {
        name: name.trim(),
        version: version.trim(),
        slug: slug.trim(),
        description: description.trim(),
        tags,
        ...(confirmRename ? { confirmSlugRename: true } : {}),
      });
      onOpenChange(false);
    } catch (failure) {
      if (failure instanceof SlugRenameDependentsError) {
        setDependents(failure.dependents);
      } else if (failure instanceof PackageDirectoryRenameError) {
        setDirError(true);
      } else {
        console.error(failure);
        setError({ key: "Packages.errors.saveFailed" });
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
      console.error(failure);
      setError({ key: "Packages.errors.directoryRenameFailed" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAccess = async () => {
    if (!entry) return;
    setAccessSaving(true);
    setAccessError(null);
    try {
      await updatePackageAccess(entry.packageId, {
        editingAccess: accessMode,
        editingUserIds: accessUserIds,
      });
      onOpenChange(false);
    } catch (failure) {
      console.error(failure);
      setAccessError({ key: "Packages.editDialog.accessSaveFailed" });
    } finally {
      setAccessSaving(false);
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
            <DialogTitle>{t("editDialog.title")}</DialogTitle>
            <DialogDescription>
              {t.rich("editDialog.description", {
                path: "packages/<slug>",
                code: (chunks) => (
                  <span className="font-mono text-foreground">{chunks}</span>
                ),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-name">
                {t("editDialog.name")}
              </Label>
              <Input
                id="package-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={submitting}
                placeholder={t("editDialog.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-version">
                {t("editDialog.version")}
              </Label>
              <Input
                id="package-edit-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                disabled={submitting}
                placeholder={t("editDialog.versionPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-slug">Slug</Label>
              <Input
                id="package-edit-slug"
                value={slug}
                onChange={handleSlugChange}
                disabled={submitting}
                placeholder={t("editDialog.slugPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
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
                  {t("editDialog.checkAgain")}
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-description">
                {t("editDialog.descriptionLabel")}
              </Label>
              <Textarea
                id="package-edit-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={submitting || detailsState !== "ready"}
                placeholder={t("editDialog.descriptionPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="package-edit-tags">
                {t("editDialog.tags")}
              </Label>
              <TagInput
                id="package-edit-tags"
                value={tags}
                onChange={setTags}
                onInvalidChange={(invalid) => {
                  tagsInvalidRef.current = invalid;
                  setTagsInvalid(invalid);
                }}
                disabled={submitting || detailsState !== "ready"}
              />
              <p className="text-xs text-muted-foreground">
                {t("editDialog.tagsHint")}
              </p>
            </div>
            {detailsState === "loading" && (
              <p className="text-xs text-muted-foreground">
                {t("editDialog.detailsLoading")}
              </p>
            )}
            {detailsState === "error" && (
              <div className="space-y-1">
                <p className="text-xs text-destructive">
                  {t("editDialog.detailsFailed")}
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={() => setDetailsAttempt((attempt) => attempt + 1)}
                >
                  {common("retry")}
                </Button>
              </div>
            )}
          </div>

          {dependents && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
              <p>{t("editDialog.dependentsTitle")}</p>
              <ul className="mt-1 list-disc pl-5">
                {dependents.map((dependent) => (
                  <li key={dependent.packageId}>{dependent.name}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("editDialog.dependentsDescription")}
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={submitting}
                onClick={() => void save(true)}
              >
                {t("editDialog.renameDependents")}
              </Button>
            </div>
          )}

          {dirError && (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <p>{t("editDialog.dirError")}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => void retryDirectory()}
              >
                {t("editDialog.retryDirectory")}
              </Button>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {format(error)}
            </div>
          )}

          {canAdministerAccess && (
            <section className="space-y-2.5 rounded-lg border border-border p-3">
              <h3 className="text-sm font-medium">
                {t("editDialog.accessTitle")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t("editDialog.accessDescription")}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="package-edit-access-mode">
                  {settingsT("modeLabel")}
                </Label>
                <div className="flex flex-wrap gap-1">
                  {MODES.map(({ value, labelKey }) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={accessMode === value ? "default" : "outline"}
                      disabled={accessSaving}
                      onClick={() => setAccessMode(value)}
                    >
                      {settingsT(labelKey)}
                    </Button>
                  ))}
                </div>
              </div>
              {accessMode === "users" && (
                <UserPicker
                  selectedUserIds={accessUserIds}
                  onChange={setAccessUserIds}
                  selectedUsers={accessAvailable}
                  disabled={accessSaving}
                />
              )}
              <Button
                type="button"
                disabled={accessSaving}
                onClick={() => void handleSaveAccess()}
              >
                {accessSaving ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : null}
                {t("editDialog.saveAccess")}
              </Button>
              {accessError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                  {format(accessError)}
                </div>
              )}
            </section>
          )}

          <p className="text-xs text-muted-foreground">
            {t("editDialog.publishNote")}
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {common("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              {t("editDialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
