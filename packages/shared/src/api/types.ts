export type TypeFile = {
  filepath: string;
  content: string;
};

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

export type ScriptFile = {
  filepath: string;
  script: string;
};

export type PhysicalFile = {
  filepath: string;
  hash?: string;
};

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

/**
 * The authoritative description of a published package revision. Clients
 * download every file listed here, verify `sha256`, and remove files of the
 * previous revision from the managed package directory only.
 */
export type PackageManifest = {
  packageId: number;
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

export type Room = {
  id: number;
  name: string;
  type: GameRoomsType;
  description: string;
  isPublic: boolean;
  parentRoomId: number | null;
  createdAt: string;
  updatedAt: string;
  author?: User;
  contributors?: User[];
  scriptingPackages?: ScriptingPackage[];
};

export type ScriptingPackage = {
  id: number;
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  scripts: ScriptFile[];
  createdAt: string;
  updatedAt: string;
  author?: User;
  contributors?: User[];
  room?: Room;
  parentPackage?: ScriptingPackage;
  childrenPackages?: ScriptingPackage[];
};

// DTOs / payloads
export type CreateRoomPayload = {
  name: string;
  type: GameRoomsType;
  isPublic?: boolean;
  description?: string;
  authorId?: number;
  parentRoomId?: number;
};

export type UpdateRoomPayload = Partial<CreateRoomPayload>;

export type CreateScriptingPackagePayload = {
  name: string;
  version: string;
  description?: string;
  dependencies?: string[];
  scripts?: ScriptFile[];
  authorId?: number;
  roomId?: number;
  parentPackageId?: number;
};

export type UpdateScriptingPackagePayload =
  Partial<CreateScriptingPackagePayload>;

export type CreateUserPayload = {
  email: string;
  password: string;
  name: string;
  picture?: string;
};

export type UpdateUserPayload = Partial<Omit<CreateUserPayload, "email">>;

export type GameRoomsType = "godot" | "ts-game";
export const GAME_ROOMS_TYPES: GameRoomsType[] = ["godot", "ts-game"];

// ts-game оставлен только для чтения старых комнат.
export const AVAILABLE_GAME_ROOMS_TYPES = ["godot"] as const;

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
  name: string;
  revision: number;
  publishedAt: string;
  state: PackageRevisionSyncState;
  runtime: PackageRuntimeSyncStatus;
  clients: PackageClientSyncStatus[];
};

export type RoomPackagesStatus = {
  roomId: number;
  packages: PackageSyncStatus[];
};
