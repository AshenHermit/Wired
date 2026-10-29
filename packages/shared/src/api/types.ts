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
