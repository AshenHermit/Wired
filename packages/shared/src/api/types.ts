export type User = {
  id: number;
  email: string;
  name: string;
  service: "email" | "google" | "vk" | "yandex" | "github";
  picture: string;
  rooms?: Room[];
  contributedRooms?: Room[];
  scriptingPackages?: ScriptingPackage[];
  contributedPackages?: ScriptingPackage[];
};

/**
 * The part of a user a payload may carry.
 *
 * Rooms, packages and workshop listings embed their author and contributors,
 * and those endpoints answer anonymous callers, so they project the record down
 * to what every reader may see. The signed-in user's own record (`/users/profile`
 * and login) keeps the full `User`.
 */
export type PublicUser = Pick<User, "id" | "name" | "picture">;

/**
 * One file of a package revision. `filepath` is a relative POSIX path inside
 * the package directory (no `..`, no drive letters, no leading slash).
 * `sha256` is the lowercase hex digest of the raw bytes.
 */
export type PackageFileEntry = {
  filepath: string;
  size: number;
  sha256: string;
};

export type PackageRevisionStatus = "draft" | "published" | "discarded";

export type PackageRevision = {
  packageId: number;
  revision: number;
  status: PackageRevisionStatus;
  files: PackageFileEntry[];
  createdAt: string;
  publishedAt: string | null;
};

/** Revision returned when a draft is created, plus files the server lacks. */
export type PackageRevisionDraft = PackageRevision & { missing: string[] };

/**
 * The authoritative description of a published package revision. Clients
 * download every file listed here, verify `sha256`, and remove files of the
 * previous revision from the managed package directory only.
 */
export type PackageManifest = {
  packageId: number;
  slug: string;
  name: string;
  revision: number;
  files: PackageFileEntry[];
  totalSize: number;
  publishedAt: string;
};

export type PackageRuntimeDependency = {
  packageId: number;
  revision: number;
  name: string;
  /**
   * Stable identity of the dependency's own runtime artifact. Every artifact
   * lives under `<revision>-<artifactKey>/`, so a same-revision publish of the
   * dependency changes this key and forces a fresh client path.
   */
  artifactKey: string;
};

export type PackageRuntimeManifest = {
  packageId: number;
  slug: string;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  files: PackageFileEntry[];
  totalSize: number;
  dependencies: PackageRuntimeDependency[];
  /** Stable identity of this artifact, derived from its resolved closure. */
  artifactKey: string;
  /** scene filepath -> "<packageId>:<filepath>" dependencies, including itself */
  sceneDependencies: Record<string, string[]>;
  download: { token: string; expiresAt: number };
};

export type CreatePackageRevisionPayload = {
  files: PackageFileEntry[];
};

export type RoomAccessMode = "all" | "author" | "users";

export type Room = {
  id: number;
  name: string;
  type: GameRoomsType;
  description: string;
  isPublic: boolean;
  parentRoomId: number | null;
  /** Optional preview image URL (`/media/<hash>.<ext>`), or null when cleared. */
  previewImage: string | null;
  createdAt: string;
  updatedAt: string;
  author?: PublicUser;
  contributors?: PublicUser[];
  scriptingPackages?: ScriptingPackage[];
  packageManagementAccess?: RoomAccessMode;
  packageManagementUserIds?: number[];
  packageCreationAccess?: RoomAccessMode;
  packageCreationUserIds?: number[];
  readAccess?: RoomAccessMode;
  readUserIds?: number[];
};

export type ScriptingPackage = {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  enabled: boolean;
  dependencies: string[];
  /** Optional preview image URL (`/media/<hash>.<ext>`), or null when cleared. */
  previewImage: string | null;
  createdAt: string;
  updatedAt: string;
  author?: PublicUser;
  contributors?: PublicUser[];
  room?: Room;
  parentPackage?: ScriptingPackage;
  childrenPackages?: ScriptingPackage[];
  editingAccess?: RoomAccessMode;
  editingUserIds?: number[];
};

// DTOs / payloads
export type CreateRoomPayload = {
  name: string;
  /** Only the types a client may create; legacy `ts-game` rows stay readable. */
  type: CreatableRoomType;
  isPublic?: boolean;
  description?: string;
  parentRoomId?: number;
  previewImage?: string | null;
};

/**
 * The mutable room fields. `authorId` and `type` are deliberately absent: the
 * author always comes from the authenticated request and the type is fixed at
 * creation, so accepting them here would only advertise fields the server
 * silently drops.
 */
export type UpdateRoomPayload = {
  name?: string;
  isPublic?: boolean;
  description?: string;
  parentRoomId?: number;
  /** Set to a `/media/...` URL or `null` to clear; omit to leave unchanged. */
  previewImage?: string | null;
};

export type UpdateRoomAccessPayload = {
  packageManagementAccess?: RoomAccessMode;
  packageManagementUserIds?: number[];
  packageCreationAccess?: RoomAccessMode;
  packageCreationUserIds?: number[];
  readAccess?: RoomAccessMode;
  readUserIds?: number[];
};

export type CreateScriptingPackagePayload = {
  slug: string;
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  dependencies?: string[];
  previewImage?: string | null;
  /** The author is always the authenticated caller, never a payload field. */
  roomId?: number;
  parentPackageId?: number;
};

export type UpdateScriptingPackagePayload =
  Partial<Omit<CreateScriptingPackagePayload, "slug">> & {
    enabled?: boolean;
    /** Renames the package; a no-op when it equals the current slug. */
    slug?: string;
    /** Optional confirmation for a rename that published dependents point to. */
    confirmSlugRename?: boolean;
  };

export type UpdatePackageAccessPayload = {
  editingAccess?: RoomAccessMode;
  editingUserIds?: number[];
};

/**
 * Authoring rule for package slugs, enforced by the server DTOs and mirrored by
 * the editor dialogs: lowercase latin letters, digits or `_`, at least one
 * letter, at most 64 characters.
 */
export const PACKAGE_SLUG_PATTERN = /^(?=.*[a-z])[a-z0-9_]+$/;
export const PACKAGE_SLUG_MAX_LENGTH = 64;

export function isValidPackageSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= PACKAGE_SLUG_MAX_LENGTH &&
    PACKAGE_SLUG_PATTERN.test(slug)
  );
}

/**
 * Response of `GET /scripting-packages/slug-availability`. Room slugs are only
 * unique inside their room, so the global workshop scope is reported separately
 * and always checked by the caller.
 */
export type PackageSlugAvailability = {
  slug: string;
  available: boolean;
  reason?: "taken";
  global: { available: boolean; reason?: "taken" };
};

export type WorkshopPackageSummary = {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  previewImage?: string | null;
  author?: PublicUser;
  revision: number;
  /**
   * Sum of `files[].size` of the listing's published revision. Dependencies
   * are not included.
   */
  sizeBytes: number;
  publishedAt: string;
  updatedAt: string;
};

export type WorkshopListing = { items: WorkshopPackageSummary[]; total: number };

export type WorkshopTagCount = { tag: string; count: number };

export type WorkshopTagListing = {
  items: WorkshopTagCount[];
  total: number;
};

export type WorkshopPackageMetadata = {
  name?: string;
  version?: string;
  description?: string;
  tags?: string[];
};

export type WorkshopPublishResult = {
  mode: "created" | "updated";
  package: WorkshopPackageSummary;
};

export type WorkshopForkPayload = { slug: string };
export type RoomCopyPayload = { roomId: number };

/**
 * Update body for the current user. Declared explicitly instead of derived
 * from a create payload, because the email and the password are not editable
 * through the same route that creates an account.
 */
export type UpdateUserPayload = {
  password?: string;
  name?: string;
  picture?: string;
};

export type GameRoomsType = "godot" | "ts-game";
export const GAME_ROOMS_TYPES: GameRoomsType[] = ["godot", "ts-game"];

// ts-game оставлен только для чтения старых комнат.
export const AVAILABLE_GAME_ROOMS_TYPES = ["godot"] as const;

/** The room types a client may actually create. */
export type CreatableRoomType = (typeof AVAILABLE_GAME_ROOMS_TYPES)[number];

export type ProjectInfo = {
  name: string;
  baseUrl: string;
  filepaths: string[];
};

/**
 * Lifecycle of the Godot server dedicated to a room, as exposed to clients.
 * `idle` means the backend has no runtime for the room yet; reading the status
 * never starts one.
 */
export type GameRoomRuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type GameRoomRuntimeStatus = {
  roomId: number;
  state: GameRoomRuntimeState;
  endpoint: string | null;
  /** Confirmed Godot peers, not handshake attempts. */
  activePlayers: number;
  error: string | null;
};

/**
 * One-time connection material for the Godot client. The ticket is
 * short-lived and single-use: every join or reconnect must request a new one.
 * It is delivered to the Web build over postMessage, never in a URL.
 */
export type GameRoomConnection = {
  roomId: number;
  endpoint: string;
  ticket: string;
  /** Unix timestamp in seconds. */
  ticketExpiresAt: number;
  activePlayers: number;
};

/**
 * Path the backend serves the editor's base project from: the manifest itself,
 * and every project file beneath it. Shared so a rename on one side breaks the
 * build instead of leaving the client asking for a route nobody serves.
 */
export const GODOT_PROJECT_ROUTE = "godot-project/wired";

/**
 * Codes the game-connection endpoint may put in an error body. Lives here so a
 * rename on either side breaks the build instead of the client's retry policy.
 */
export const GAME_CONNECTION_ERROR_CODES = [
  "config",
  "room_not_running",
  "room_stopping",
  "start_failed",
  "ticket_secret_missing",
  "handshake_window_expired",
  "invalid_room",
  "rate_limited",
  "packages_pending",
  "packages_failed",
] as const;

export type GameConnectionErrorCode =
  (typeof GAME_CONNECTION_ERROR_CODES)[number];

export function isGameConnectionErrorCode(
  value: unknown
): value is GameConnectionErrorCode {
  return GAME_CONNECTION_ERROR_CODES.includes(
    value as GameConnectionErrorCode
  );
}

/**
 * Application state of one published package revision on one target. The
 * manifest is the source of truth; these states are best-effort bookkeeping
 * that a receiver reconciles against the manifest after reconnects.
 */
export type PackageRuntimeSyncState = 'pending' | 'applied' | 'failed';

export type PackageClientSyncState = 'pending' | 'ready' | 'failed';

export type PackageRevisionSyncState =
  | 'published'
  | 'pending'
  | 'applied'
  | 'ready'
  | 'failed'
  | 'stale';

export type PackageRuntimeSyncStatus = {
  state: PackageRuntimeSyncState;
  /** Revision the runtime was asked to apply. */
  revision: number;
  error: string | null;
  /** Set when the runtime confirms application or reports a failure. */
  updatedAt: string | null;
};

export type PackageClientSyncStatus = {
  peer: number;
  state: PackageClientSyncState;
  revision: number;
  error: string | null;
  updatedAt: string;
};

/**
 * State of the latest published revision of one package for one room. A
 * revision is `published` after the backend fixed the files, `pending` while
 * the runtime downloads it, `applied` once the runtime confirmed it (clients
 * may still be catching up), `ready` when every authenticated client reported
 * that revision, and `failed` when the runtime or a client reported an error.
 * `stale` means a newer revision is published but not dispatched yet.
 */
export type PackageSyncStatus = {
  packageId: number;
  slug: string;
  name: string;
  enabled: boolean;
  revision: number;
  /**
   * Sum of `files[].size` of the latest published revision of this package.
   * Dependencies are not included. `null` when no revision is published.
   */
  sizeBytes: number | null;
  publishedAt: string | null;
  state: PackageRevisionSyncState;
  runtime: PackageRuntimeSyncStatus;
  clients: PackageClientSyncStatus[];
};

export type RoomPackagesStatus = {
  roomId: number;
  packages: PackageSyncStatus[];
};

/**
 * Progress of one package being delivered to a running room. `loadedBytes`
 * and `totalBytes` are byte counts of the transferred payload; `status`
 * tracks the transfer lifecycle: `loading` while bytes arrive, `complete`
 * when the full payload is delivered, and `error` if the transfer failed.
 * `errorMessage` is only present when `status === 'error'`.
 */
export type PackageProgressPayload = {
  packageId: string;
  name: string;
  loadedBytes: number;
  totalBytes: number;
  status: 'loading' | 'complete' | 'error';
  errorMessage?: string;
};

/**
 * One package that takes part in a running game: an unpublished package has no
 * revision to apply, and a disabled one is deliberately out of the room.
 */
export type ActivePackage = { packageId: number; revision: number };

/** The packages the runtime is expected to have loaded. */
export function activePackages(status: RoomPackagesStatus): ActivePackage[] {
  return status.packages
    .filter((entry) => entry.enabled && entry.revision > 0)
    .map(({ packageId, revision }) => ({ packageId, revision }));
}

/**
 * Whether the runtime has applied every active package at or beyond its
 * published revision. Vacuously true when nothing is active.
 */
export function packagesApplied(status: RoomPackagesStatus): boolean {
  return activePackages(status).every(({ packageId, revision }) => {
    const entry = status.packages.find(
      (candidate) => candidate.packageId === packageId,
    );
    return (
      entry !== undefined &&
      entry.runtime.state === "applied" &&
      entry.runtime.revision >= revision
    );
  });
}
