/**
 * Godot's web export persists its virtual file system in IndexedDB, and the
 * database name is the mount point from `persistentPaths`. Wired mounts one
 * room-scoped directory under the editor root, so every database below that
 * root belongs to the editor and holds a previous session: project files, the
 * `.godot` import cache and the editor layout/open scenes.
 *
 * Each document gets a fresh session directory. A page reload therefore starts
 * from an empty file system, while an engine restart inside the same document
 * (Godot restarts the editor after it exits) still reads the project it wrote
 * before. The previous databases are deleted before the first
 * `Engine.init()`, when this document has not mounted its own yet.
 */

export const GODOT_EDITOR_FS_ROOT = "/home/web_user";

const SESSION_ID = (() => {
  try {
    return globalThis.crypto?.randomUUID?.() ?? randomSuffix();
  } catch {
    return randomSuffix();
  }
})();

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12) || "session";
}

/**
 * The persistent root used by the editor in this document. The session id
 * keeps every page load's file system separate from the previous ones.
 */
export function godotEditorSessionRoot(roomId: number): string {
  return `${GODOT_EDITOR_FS_ROOT}/room-${roomId}/${SESSION_ID}`;
}

/** Whether an IndexedDB database name is an editor file system mount point. */
export function isGodotEditorDatabase(name: string): boolean {
  return (
    name === GODOT_EDITOR_FS_ROOT ||
    name.startsWith(`${GODOT_EDITOR_FS_ROOT}/`)
  );
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // An open connection (for example the engine of a room opened earlier in
      // the same document) blocks the deletion. Launching the editor matters
      // more than a stale database, so never wait for a `blocked` request.
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  if (typeof factory.databases !== "function") {
    // Known database name used by the stock editor page and by older builds.
    return [GODOT_EDITOR_FS_ROOT];
  }
  try {
    const databases = await factory.databases();
    const names = databases
      .map((database) => database.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && isGodotEditorDatabase(name),
      );
    return names.length > 0 ? names : [GODOT_EDITOR_FS_ROOT];
  } catch {
    return [GODOT_EDITOR_FS_ROOT];
  }
}

/**
 * Removes every Godot editor file system database. Safe when IndexedDB is
 * unavailable (server rendering, private modes): the editor then simply starts
 * with its in-memory file system.
 */
export async function clearGodotEditorStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory) return;
  const names = await databaseNames(factory);
  await Promise.allSettled(
    names.map((name) => deleteDatabase(factory, name)),
  );
}

const prepared = new WeakMap<IDBFactory, Promise<void>>();

/**
 * Clears the previous sessions once per document, before the editor mounts its
 * own file system. Memoized per `IDBFactory` so a remount in the same document
 * never deletes the database the running editor is writing to, while a caller
 * that passes its own factory still gets the work done on that factory rather
 * than inheriting a promise started with someone else's.
 */
export function prepareGodotEditorStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory) return Promise.resolve();
  const existing = prepared.get(factory);
  if (existing) return existing;
  const run = clearGodotEditorStorage(factory).catch(() => {});
  prepared.set(factory, run);
  return run;
}
