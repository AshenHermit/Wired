"use client";

import * as React from "react";
import type {
  PackageSlugAvailability,
  PackageSyncStatus,
  ScriptingPackage,
  UpdateScriptingPackagePayload,
  WorkshopPackageMetadata,
  WorkshopPublishResult,
} from "@wired-io/shared";
import type { AppMessage } from "@/i18n/message";
import {
  checkPackageSlugAvailability,
  copyWorkshopPackageToRoom,
  createScriptingPackage,
  deleteScriptingPackage,
  forkPackageToWorkshop,
  publishPackageToWorkshop,
  updateScriptingPackage,
} from "@/api/services/scripting-packages";
import {
  EditorBridgeError,
  requestEditorRescan,
} from "@/godot/bridge/editor-bridge";
import type { PackageFileSystem } from "@/godot/bridge/godot-packages-fs";
import {
  changedPackageFiles,
  publishPackageFiles,
  reconcilePackageRevision,
  type PackageBaseline,
} from "@/godot/bridge/package-sync";
import {
  LocalChangesError,
  NewerRevisionError,
  PackageDirectoryRenameError,
  PackagesActionError,
  SlugRenameDependentsError,
  WorkshopActionError,
  WorkshopSlugTakenError,
  deleteConflictMessage,
  errorMessage,
  workshopErrorData,
  workshopErrorDiagnostic,
  workshopErrorMessage,
  workshopFailure,
} from "./errors";
import { requireFileSystem } from "./model";
import type { PackageActionState } from "./model";
import type { RoomPackagesAction } from "./reducer";

/**
 * The panel state the explicit package actions read and write.
 *
 * The actions only ever see these seams, so they can live apart from the
 * transport, the polling loop and the reducer that own them.
 */
export interface PackageActionParams {
  roomId: number;
  dispatch: React.Dispatch<RoomPackagesAction>;
  guarded: <T>(task: () => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
  isPackageDirOccupied: (slug: string) => Promise<boolean>;
  setAction: (packageId: number, patch: Partial<PackageActionState>) => void;
  slugOf: (packageId: number) => string;
  filesRef: { current: PackageFileSystem | null };
  loadedRef: { current: Map<number, PackageBaseline> };
  snapshotsRef: { current: Map<number, Record<string, string>> };
  remoteRef: { current: Map<number, PackageSyncStatus> };
  createdSlugsRef: { current: Map<number, string> };
  inFlightRef: { current: Set<number> };
}

export interface PackageActions {
  createPackage: (input: {
    name: string;
    version: string;
    slug: string;
  }) => Promise<ScriptingPackage>;
  checkSlugAvailability: (
    slug: string,
    targetRoomId?: number,
    excludeId?: number,
  ) => Promise<import("@wired-io/shared").PackageSlugAvailability>;
  updatePackageMetadata: (
    packageId: number,
    patch: UpdateScriptingPackagePayload,
  ) => Promise<ScriptingPackage>;
  renamePackageDir: (
    packageId: number,
    fromSlug: string,
    toSlug: string,
  ) => Promise<void>;
  applyPublishedRevision: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  removePackageDirectory: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  setPackageEnabled: (packageId: number, enabled: boolean) => Promise<void>;
  deletePackageRecord: (packageId: number) => Promise<void>;
  adoptPackage: (packageId: number) => Promise<void>;
  emitPackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  copyFromWorkshop: (workshopPackageId: number) => Promise<ScriptingPackage>;
  publishToWorkshop: (
    packageId: number,
    metadata?: WorkshopPackageMetadata,
  ) => Promise<WorkshopPublishResult>;
  forkWorkshopPackage: (
    packageId: number,
    slug: string,
  ) => Promise<ScriptingPackage>;
}

/** Every explicit action the package panel can perform on one room. */
export function usePackageActions({
  roomId,
  dispatch,
  guarded,
  refresh,
  isPackageDirOccupied,
  setAction,
  slugOf,
  filesRef,
  loadedRef,
  snapshotsRef,
  remoteRef,
  createdSlugsRef,
  inFlightRef,
}: PackageActionParams): PackageActions {
  const createPackage = React.useCallback(
    ({
      name,
      version,
      slug,
    }: {
      name: string;
      version: string;
      slug: string;
    }): Promise<ScriptingPackage> =>
      guarded(async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          throw new PackagesActionError({ key: "Packages.errors.nameRequired" });
        }
        const trimmedSlug = slug.trim();
        if (!trimmedSlug) {
          throw new PackagesActionError({ key: "Packages.errors.slugRequired" });
        }
        const files = requireFileSystem(filesRef.current);
        if (await isPackageDirOccupied(trimmedSlug)) {
          // A leftover folder from a package deleted in another session would
          // silently become this package's content.
          throw new PackagesActionError({
            key: "Packages.errors.dirOccupied",
            values: { slug: trimmedSlug },
          });
        }
        let created: ScriptingPackage;
        try {
          created = await createScriptingPackage({
            slug: trimmedSlug,
            name: trimmed,
            version,
            roomId,
          });
        } catch (cause) {
          console.error(cause);
          throw new PackagesActionError({
            key: "Packages.errors.createFailed",
          });
        }
        try {
          await files.createPackageDir(created.slug);
          requestEditorRescan();
        } catch (cause) {
          if (cause instanceof EditorBridgeError) throw cause;
          console.error(cause);
          throw new PackagesActionError({
            key: "Packages.errors.createDirFailed",
          });
        }

        loadedRef.current.set(created.id, { revision: 0, files: {} });
        dispatch({ type: "created", package: created });
        setAction(created.id, {
          notice: { key: "Packages.notices.created" },
        });
        await refresh();
        return created;
      }),
    [filesRef, guarded, isPackageDirOccupied, refresh, roomId, setAction],
  );

  /**
   * Availability is advisory for the creation, edit and fork forms; the server
   * still rejects a taken slug. Slugs are room-scoped, so the room is part
   * of the question, and the global workshop scope is reported separately.
   */
  const checkSlugAvailability = React.useCallback(
    (
      slug: string,
      targetRoomId: number = roomId,
      excludeId?: number,
    ): Promise<PackageSlugAvailability> =>
      checkPackageSlugAvailability(slug, targetRoomId, excludeId),
    [roomId],
  );

  /**
   * Metadata lives in the room package list only: the editor files, the
   * stored status and the runtime state are untouched. A slug change is the
   * exception РІР‚вЂќ the backend rewrites every stored reference, so the editor
   * directory is renamed to match, after the PATCH succeeded.
   */
  const updatePackageMetadata = React.useCallback(
    async (
      packageId: number,
      patch: UpdateScriptingPackagePayload,
    ): Promise<ScriptingPackage> => {
      const payload: UpdateScriptingPackagePayload = {};
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new Error("package_metadata_empty");
        payload.name = name;
      }
      if (patch.version !== undefined) {
        const version = patch.version.trim();
        if (!version) throw new Error("package_metadata_empty");
        payload.version = version;
      }
      if (patch.slug !== undefined) {
        const slug = patch.slug.trim();
        if (!slug) throw new Error("package_metadata_empty");
        payload.slug = slug;
      }
      if (patch.description !== undefined) {
        payload.description = patch.description.trim();
      }
      if (patch.tags !== undefined) {
        payload.tags = patch.tags;
      }
      if (patch.confirmSlugRename !== undefined) {
        payload.confirmSlugRename = patch.confirmSlugRename;
      }
      if (Object.keys(payload).length === 0) {
        throw new Error("package_metadata_empty");
      }

      const previousSlug = slugOf(packageId);
      const renaming =
        payload.slug !== undefined && payload.slug !== previousSlug;
      if (renaming && (await isPackageDirOccupied(payload.slug!))) {
        // The bridge would merge into or refuse the target folder, and the
        // server rename cannot be undone, so refuse before any request.
        throw new Error("slug_dir_exists");
      }

      let updated: ScriptingPackage;
      try {
        updated = await updateScriptingPackage(packageId, payload);
      } catch (cause) {
        const data = workshopErrorData(cause);
        if (data?.code === "slug_in_use_by_dependents") {
          throw new SlugRenameDependentsError(
            (data.dependents ?? []).map((dependent) => ({
              packageId: dependent.packageId ?? 0,
              name: dependent.name ?? `#${dependent.packageId ?? "?"}`,
            })),
          );
        }
        console.error(cause);
        setAction(packageId, {
          error: { key: "Packages.errors.updateMetadataFailed" },
        });
        throw new Error("package_update_failed");
      }
      dispatch({ type: "updated", package: updated });
      // The slug is addressable before the state mirror re-renders.
      createdSlugsRef.current.set(packageId, updated.slug);

      if (renaming) {
        const files = filesRef.current;
        if (files && (await files.exists(previousSlug))) {
          try {
            await files.renamePackage(previousSlug, updated.slug);
          } catch (cause) {
            if (cause instanceof EditorBridgeError) throw cause;
            throw new PackageDirectoryRenameError(
              packageId,
              previousSlug,
              updated.slug,
              cause,
            );
          }
        }
        // Rescan only once the directory carries its new name.
        requestEditorRescan();
      }

      // A successful retry must not leave the previous failure on the card.
      setAction(packageId, { error: null });
      await refresh();
      return updated;
    },
    [filesRef, isPackageDirOccupied, refresh, setAction, slugOf],
  );

  /** Moves the editor directory after a slug change that already happened. */
  const renamePackageDir = React.useCallback(
    async (
      packageId: number,
      fromSlug: string,
      toSlug: string,
    ): Promise<void> => {
      const files = requireFileSystem(filesRef.current);
      try {
        // Idempotent: a previous attempt may have moved the folder and then
        // failed while syncing. A leftover target directory is not a reason to
        // skip the move: `rename` reuses an empty one and reports
        // `slug_target_not_empty` for a non-empty one.
        if (await files.exists(fromSlug)) {
          await files.renamePackage(fromSlug, toSlug);
        }
      } catch (cause) {
        if (cause instanceof EditorBridgeError) throw cause;
        throw new PackageDirectoryRenameError(
          packageId,
          fromSlug,
          toSlug,
          cause,
        );
      }
      requestEditorRescan();
      setAction(packageId, { error: null });
      await refresh();
    },
    [filesRef, refresh, setAction],
  );

  const beginAction = React.useCallback(
    (packageId: number) => {
      if (inFlightRef.current.has(packageId)) {
        throw new Error(`package_action_in_progress:${packageId}`);
      }
      inFlightRef.current.add(packageId);
      setAction(packageId, {
        busy: true,
        progress: null,
        notice: null,
        error: null,
      });
    },
    [setAction],
  );

  const endAction = React.useCallback(
    (packageId: number) => {
      inFlightRef.current.delete(packageId);
      setAction(packageId, { busy: false, progress: null });
    },
    [setAction],
  );

  /**
   * Reports a failed action on the card and rethrows it as a coded error. The
   * bridge already carries the message the editor wants to show, so its
   * failures pass through untouched.
   */
  const failAction = React.useCallback(
    (
      packageId: number,
      cause: unknown,
      error: AppMessage,
      code: string,
    ): never => {
      if (cause instanceof EditorBridgeError) throw cause;
      console.error(cause);
      setAction(packageId, { error });
      throw new Error(`${code}:${errorMessage(cause)}`);
    },
    [setAction],
  );

  const applyPublishedRevision = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const slug = slugOf(packageId);
          const baseline = loadedRef.current.get(packageId) ?? null;
          const current = await files.snapshot(slug);
          const changed = baseline
            ? changedPackageFiles(baseline.files, current)
            : Object.keys(current);
          if (!options.force && changed.length > 0) {
            throw new LocalChangesError(packageId, changed);
          }

          const result = await reconcilePackageRevision(
            packageId,
            slug,
            files,
            null,
            {
              force: true,
              onProgress: (currentCount, total) =>
                setAction(packageId, {
                  progress: { current: currentCount, total },
                }),
            },
          );
          if (result.status === "conflict") {
            throw new Error("package_revision_conflict");
          }
          requestEditorRescan();
          loadedRef.current.set(packageId, {
            revision: result.revision,
            files: result.files,
          });
          setAction(packageId, {
            notice: {
              key: "Packages.notices.downloaded",
              values: { revision: result.revision },
            },
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof LocalChangesError) throw cause;
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.downloadFailed" },
            "package_download_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  /**
   * Copies a workshop record into this room. The copy is independent: it keeps
   * the workshop slug (slugs are room-scoped), comes from the server with its
   * published revision, and is downloaded into the editor like any other
   * package. A failed download leaves the copy created and reports why.
   */
  const copyFromWorkshop = React.useCallback(
    (workshopPackageId: number): Promise<ScriptingPackage> =>
      guarded(async () => {
        let created: ScriptingPackage;
        try {
          created = await copyWorkshopPackageToRoom(workshopPackageId, roomId);
        } catch (cause) {
          throw workshopFailure(
            cause,
            { key: "Packages.errors.copyFromWorkshopFailed" },
            "workshop_add_failed",
          );
        }
        dispatch({ type: "created", package: created });
        createdSlugsRef.current.set(created.id, created.slug);
        await refresh();
        await applyPublishedRevision(created.id).catch(() => undefined);
        // The download writes its own notice, so the reason of the copy is set
        // last to stay visible on the card.
        setAction(created.id, {
          notice: { key: "Packages.notices.addedToRoom" },
        });
        return created;
      }),
    [applyPublishedRevision, guarded, refresh, roomId, setAction],
  );

  /**
   * Publishes the latest published revision of a room package into the global
   * workshop record. It only touches the global record: the room package, its
   * files and its revision stay exactly as they are.
   */
  const publishToWorkshop = React.useCallback(
    (
      packageId: number,
      metadata: WorkshopPackageMetadata = {},
    ): Promise<WorkshopPublishResult> =>
      guarded(async () => {
        try {
          const result = await publishPackageToWorkshop(packageId, metadata);
          setAction(packageId, {
            error: null,
            notice: {
              key:
                result.mode === "created"
                  ? "Packages.notices.published"
                  : "Packages.notices.publishUpdated",
            },
          });
          return result;
        } catch (cause) {
          const data = workshopErrorData(cause);
          if (data?.code === "workshop_slug_taken" && data.workshopPackage) {
            // Not a failure on the card: the dialog turns this into the fork
            // offer instead.
            setAction(packageId, { error: null });
            throw new WorkshopSlugTakenError(
              data.slug ?? slugOf(packageId),
              data.workshopPackage,
            );
          }
          console.error(cause);
          const message = workshopErrorMessage(cause, {
            key: "Packages.errors.publishFailed",
          });
          setAction(packageId, { error: message });
          throw new WorkshopActionError(
            message,
            `workshop_publish_failed:${workshopErrorDiagnostic(cause)}`,
          );
        }
      }),
    [guarded, setAction, slugOf],
  );

  /**
   * Forks a room package under a new slug. The copy stays in the room, keeps
   * the original parent and rewrites its self-references on the server; it is
   * downloaded like any other package, and publishing it is a separate step.
   */
  const forkWorkshopPackage = React.useCallback(
    (packageId: number, slug: string): Promise<ScriptingPackage> =>
      guarded(async () => {
        let created: ScriptingPackage;
        try {
          created = await forkPackageToWorkshop(packageId, slug.trim());
        } catch (cause) {
          throw workshopFailure(
            cause,
            { key: "Packages.errors.forkFailed" },
            "workshop_fork_failed",
          );
        }
        dispatch({ type: "created", package: created });
        createdSlugsRef.current.set(created.id, created.slug);
        await refresh();
        await applyPublishedRevision(created.id).catch(() => undefined);
        setAction(created.id, {
          notice: {
            key: "Packages.notices.forked",
            values: { slug: created.slug },
          },
        });
        return created;
      }),
    [applyPublishedRevision, guarded, refresh, setAction],
  );

  const removePackageDirectory = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const slug = slugOf(packageId);
          if (!(await files.exists(slug))) {
            loadedRef.current.delete(packageId);
            await refresh();
            return;
          }

          const baseline = loadedRef.current.get(packageId) ?? null;
          const current = await files.snapshot(slug);
          const changed = baseline
            ? changedPackageFiles(baseline.files, current)
            : Object.keys(current);
          if (!options.force && changed.length > 0) {
            throw new LocalChangesError(packageId, changed);
          }

          await files.deletePackage(slug);
          requestEditorRescan();
          loadedRef.current.delete(packageId);
          setAction(packageId, {
            notice: { key: "Packages.notices.removedFromEditor" },
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof LocalChangesError) throw cause;
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.removeFailed" },
            "package_remove_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  const setPackageEnabled = React.useCallback(
    (packageId: number, enabled: boolean): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          await updateScriptingPackage(packageId, { enabled });
          setAction(packageId, {
            notice: {
              key: enabled
                ? "Packages.notices.enabled"
                : "Packages.notices.disabled",
            },
          });
          await refresh();
        } catch (cause) {
          failAction(
            packageId,
            cause,
            {
              key: enabled
                ? "Packages.errors.enableFailed"
                : "Packages.errors.disableFailed",
            },
            enabled ? "package_enable_failed" : "package_disable_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, guarded, refresh, setAction],
  );

  const deletePackageRecord = React.useCallback(
    (packageId: number): Promise<void> =>
      guarded(async () => {
        const slug = slugOf(packageId);
        beginAction(packageId);
        try {
          try {
            await deleteScriptingPackage(packageId);
          } catch (cause) {
            console.error(cause);
            setAction(packageId, {
              error: deleteConflictMessage(cause) ?? {
                key: "Packages.errors.deleteFailed",
              },
            });
            throw new Error("package_delete_failed");
          }

          // The editor directory is local state, not the package itself: a
          // failed cleanup must not make the deleted package look present.
          try {
            const files = filesRef.current;
            if (files) {
              await files.deletePackage(slug);
              requestEditorRescan();
            }
          } catch {
            // The editor may be gone; the package is already deleted.
          }
          snapshotsRef.current.delete(packageId);
          loadedRef.current.delete(packageId);
          createdSlugsRef.current.delete(packageId);
          dispatch({ type: "removed", ids: [packageId] });
          setAction(packageId, {
            notice: { key: "Packages.notices.deleted" },
          });
          await refresh();
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  const adoptPackage = React.useCallback(
    (packageId: number): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const slug = slugOf(packageId);
          if (!(await files.exists(slug))) {
            throw new Error("package_directory_missing");
          }
          const snapshot = await files.snapshot(slug);
          loadedRef.current.set(packageId, { revision: 0, files: snapshot });
          setAction(packageId, {
            notice: { key: "Packages.notices.adopted" },
          });
          await refresh();
        } catch (cause) {
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.adoptFailed" },
            "package_adopt_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  const emitPackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        const files = requireFileSystem(filesRef.current);
        const baseline = loadedRef.current.get(packageId);
        if (!baseline) {
          throw new Error("package_not_loaded");
        }

        const remote = remoteRef.current.get(packageId);
        if (
          !options.force &&
          remote &&
          remote.revision > baseline.revision
        ) {
          throw new NewerRevisionError(
            packageId,
            baseline.revision,
            remote.revision,
          );
        }

        const slug = slugOf(packageId);
        beginAction(packageId);
        try {
          const result = await publishPackageFiles(
            packageId,
            slug,
            files,
            (current, total) =>
              setAction(packageId, { progress: { current, total } }),
          );
          const snapshot = await files.snapshot(slug);
          loadedRef.current.set(packageId, {
            revision: result.revision.revision,
            files: snapshot,
          });
          setAction(packageId, {
            notice: {
              key: "Packages.notices.emitPublished",
              values: {
                revision: result.revision.revision,
                uploaded: result.uploaded,
              },
            },
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof NewerRevisionError) throw cause;
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.emitFailed" },
            "package_emit_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  return {
    createPackage,
    checkSlugAvailability,
    updatePackageMetadata,
    renamePackageDir,
    applyPublishedRevision,
    removePackageDirectory,
    setPackageEnabled,
    deletePackageRecord,
    adoptPackage,
    emitPackage,
    copyFromWorkshop,
    publishToWorkshop,
    forkWorkshopPackage,
  };
}
