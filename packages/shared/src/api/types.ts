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

export type Room = {
  id: number;
  name: string;
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
