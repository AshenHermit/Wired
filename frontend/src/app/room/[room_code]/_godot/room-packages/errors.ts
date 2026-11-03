import type { WorkshopPackageSummary } from "@wired-io/shared";
import { apiErrorBody } from "@/i18n/api-error";
import type { AppMessage } from "@/i18n/message";

export { errorMessage } from "@/utils/errors";

/**
 * Raised when an explicit package action would replace or delete local files.
 * The panel asks the user for confirmation and repeats the action with
 * `force: true`.
 */
export class LocalChangesError extends Error {
  constructor(
    public readonly packageId: number,
    public readonly files: string[],
  ) {
    super(`local_changes:${packageId}`);
    this.name = "LocalChangesError";
  }
}

/**
 * Raised when Emit would replace a published revision the panel already knows
 * about. The panel asks for confirmation and repeats the action with `force`.
 */
export class NewerRevisionError extends Error {
  constructor(
    public readonly packageId: number,
    public readonly loadedRevision: number | null,
    public readonly publishedRevision: number,
  ) {
    super(`newer_revision:${packageId}`);
    this.name = "NewerRevisionError";
  }
}

/**
 * The backend refuses to rename a slug that published packages point at. The
 * dialog lists them and repeats the PATCH with `confirmSlugRename: true`.
 */
export class SlugRenameDependentsError extends Error {
  constructor(
    public readonly dependents: { packageId: number; name: string }[],
  ) {
    super("slug_rename_dependents");
    this.name = "SlugRenameDependentsError";
  }
}

/**
 * The backend renamed the package, but the editor directory still has the old
 * name. Nothing is rolled back: the dialog offers `renamePackageDir` as an
 * idempotent retry. The bridge failure is kept as `cause` so the retry can be
 * diagnosed instead of only reporting the slug that failed.
 */
export class PackageDirectoryRenameError extends Error {
  constructor(
    public readonly packageId: number,
    public readonly fromSlug: string,
    public readonly toSlug: string,
    cause: unknown,
  ) {
    super(`package_directory_rename_failed:${fromSlug}`, { cause });
    this.name = "PackageDirectoryRenameError";
  }
}

/**
 * The workshop slug belongs to another author. The panel cannot update that
 * record, so it offers a fork under a new slug instead; the record is carried
 * along so the dialog can name its author and open the fork form.
 */
export class WorkshopSlugTakenError extends Error {
  constructor(
    public readonly slug: string,
    public readonly workshopPackage: WorkshopPackageSummary,
  ) {
    super(`workshop_slug_taken:${slug}`);
    this.name = "WorkshopSlugTakenError";
  }
}

/**
 * A validation failure the user can fix in the create/edit form. The panel
 * renders `appMessage`; `message` stays a diagnostic code.
 */
export class PackagesActionError extends Error {
  constructor(public readonly appMessage: AppMessage) {
    super(appMessage.key);
    this.name = "PackagesActionError";
  }
}

/** A workshop failure that carries both its translated reason and a diagnostic. */
export class WorkshopActionError extends Error {
  constructor(
    public readonly appMessage: AppMessage,
    diagnostic: string,
  ) {
    super(diagnostic);
    this.name = "WorkshopActionError";
  }
}

type WorkshopErrorData = {
  code?: string;
  slug?: string;
  tag?: string;
  message?: string | string[];
  workshopPackage?: WorkshopPackageSummary;
  dependents?: { packageId?: number; name?: string }[];
};

/** The structured body the backend attaches to a workshop conflict. */
export function workshopErrorData(error: unknown): WorkshopErrorData | null {
  return apiErrorBody<WorkshopErrorData>(error);
}

/**
 * The workshop actions show a translated reason for the codes a user can act
 * on; every other failure falls back to the shared unexpected error.
 */
export function workshopErrorMessage(
  error: unknown,
  fallback: AppMessage = { key: "Errors.unexpected" },
): AppMessage {
  const data = workshopErrorData(error);

  switch (data?.code) {
    case "package_not_published":
      return { key: "Packages.errors.notPublished" };
    case "slug_taken":
      return { key: "Packages.errors.slugTakenWorkshop" };
    case "publish_conflict":
      return { key: "Packages.errors.publishConflict" };
    case "invalid_tags":
      return data.tag
        ? { key: "Packages.errors.invalidTag", values: { tag: data.tag } }
        : { key: "Packages.errors.invalidTags" };
    case "package_dependency_not_global":
      return {
        key: "Packages.errors.dependencyNotGlobal",
        values: { slug: data.slug ?? "" },
      };
    case "package_dependency_unknown_slug":
      return {
        key: "Packages.errors.dependencyUnknownSlug",
        values: { slug: data.slug ?? "" },
      };
  }

  console.error(error);
  return fallback;
}

/** A short, non-translated reason used for thrown errors and console logs. */
export function workshopErrorDiagnostic(error: unknown): string {
  const data = workshopErrorData(error);
  if (!data?.code) return "workshop_failed";
  return data.code === "invalid_tags" && data.tag
    ? `invalid_tags:${data.tag}`
    : data.code;
}

/**
 * The backend refuses to delete a package that enabled packages still depend
 * on. Its 409 payload names them, which is far more useful than the generic
 * "Request failed with status code 409".
 */
export function deleteConflictMessage(error: unknown): AppMessage | null {
  const data = apiErrorBody<{
    code?: string;
    dependents?: { packageId?: number; name?: string }[];
  }>(error);
  if (data?.code !== "package_has_dependents" || !data.dependents?.length) {
    return null;
  }
  return {
    key: "Packages.errors.deleteConflict",
    values: {
      names: data.dependents
        .map((dependent) => dependent.name ?? `#${dependent.packageId}`)
        .join(", "),
    },
  };
}

/** A workshop action failure: the translated reason plus a diagnostic code. */
export function workshopFailure(
  cause: unknown,
  fallback: AppMessage,
  code: string,
): WorkshopActionError {
  return new WorkshopActionError(
    workshopErrorMessage(cause, fallback),
    `${code}:${workshopErrorDiagnostic(cause)}`,
  );
}
