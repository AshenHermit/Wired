/**
 * Installs a validated editor file set into `destDir` with rollback.
 *
 * The swap is designed so that a failure (or a kill) never leaves a mix of
 * old and new core files:
 *
 * 1. `VERSION` is moved aside first, so `isEditorInstalled()` cannot accept
 *    a half-replaced set.
 * 2. Every destination file the install will overwrite, every stale
 *    `godot.editor.*` file, and `VERSION` are moved into a backup directory.
 * 3. The new files are moved in; `VERSION` is written last.
 * 4. On success the backup is deleted (and leftovers from earlier crashed
 *    installs are cleaned up). On failure only the files this call moved are
 *    restored — nothing that was never backed up is touched.
 *
 * Only Node built-ins are used (Node >= 20).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const VERSION_FILE = 'VERSION';
export const BACKUP_DIR_PREFIX = '.editor-backup-';
const STALE_EDITOR_PREFIX = 'godot.editor.';

function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), name));
    } else if (entry.isFile()) {
      files.push(name);
    }
  }
  return files.sort();
}

function staleEditorFiles(destDir) {
  return readdirSync(destDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(STALE_EDITOR_PREFIX))
    .map((entry) => entry.name);
}

function moveFile(source, target) {
  // rename can fail across volumes; fall back to copy + delete. Remove the
  // target first so Windows does not refuse.
  rmSync(target, { force: true });
  try {
    renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    copyFileSync(source, target);
    rmSync(source, { force: true });
  }
}

function cleanupBackupDirs(destDir) {
  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(BACKUP_DIR_PREFIX)) {
      rmSync(path.join(destDir, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * True when the destination holds this version and the wasm payload, i.e.
 * when a download can be skipped.
 */
export function isEditorInstalled({ destDir, version }) {
  const versionFile = path.join(destDir, VERSION_FILE);
  if (!existsSync(versionFile)) {
    return false;
  }
  if (readFileSync(versionFile, 'utf8').trim() !== version) {
    return false;
  }
  return existsSync(path.join(destDir, 'godot.editor.wasm'));
}

/**
 * Installs every file from `sourceDir` (a validated extraction directory)
 * into `destDir` and writes `VERSION`.
 *
 * @param {object} options
 * @param {string} options.destDir target directory (created if missing)
 * @param {string} options.sourceDir directory with the new file set
 * @param {string} options.version value written to `VERSION`
 * @param {{ beforeMove?: (name: string) => void, beforeBackup?: (name: string) => void }} [options.hooks]
 *   Test-only fault injection: `beforeBackup` runs before an existing file is
 *   moved aside, `beforeMove` before a new file is moved in. Throwing from
 *   either aborts the install and exercises the rollback path.
 * @returns {{ files: string[], version: string }}
 */
export function installEditorSet({ destDir, sourceDir, version, hooks = {} }) {
  if (!existsSync(sourceDir)) {
    throw new Error(`каталог с файлами редактора не найден: ${sourceDir}`);
  }
  const beforeMove = hooks.beforeMove ?? (() => {});
  const beforeBackup = hooks.beforeBackup ?? (() => {});

  const newFiles = listFiles(sourceDir).filter((name) => name !== VERSION_FILE);

  mkdirSync(destDir, { recursive: true });
  const backupDir = mkdtempSync(path.join(destDir, BACKUP_DIR_PREFIX));

  const movedAside = new Set();
  const installed = new Set();

  // Everything the install overwrites or removes must survive a rollback.
  const backupNames = new Set(
    newFiles.filter((name) => existsSync(path.join(destDir, name))),
  );
  for (const name of staleEditorFiles(destDir)) {
    backupNames.add(name);
  }
  if (existsSync(path.join(destDir, VERSION_FILE))) {
    backupNames.add(VERSION_FILE);
  }

  function moveAside(name) {
    beforeBackup(name);
    const target = path.join(backupDir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(path.join(destDir, name), target);
    movedAside.add(name);
  }

  function rollback() {
    // Remove only files this call installed; files that were never moved
    // aside stay exactly where they are.
    for (const name of installed) {
      rmSync(path.join(destDir, name), { force: true });
    }
    // Restore the saved set, VERSION last so it never advertises a partial
    // restore.
    const restore = [...movedAside].sort(
      (a, b) => (a === VERSION_FILE) - (b === VERSION_FILE),
    );
    for (const name of restore) {
      const target = path.join(destDir, name);
      mkdirSync(path.dirname(target), { recursive: true });
      moveFile(path.join(backupDir, name), target);
    }
    rmSync(backupDir, { recursive: true, force: true });
  }

  try {
    // VERSION first: from here on a kill cannot leave the old version
    // advertising a half-replaced set.
    if (backupNames.has(VERSION_FILE)) {
      moveAside(VERSION_FILE);
    }
    for (const name of [...backupNames].filter((n) => n !== VERSION_FILE).sort()) {
      moveAside(name);
    }

    for (const name of newFiles) {
      beforeMove(name);
      const target = path.join(destDir, name);
      mkdirSync(path.dirname(target), { recursive: true });
      moveFile(path.join(sourceDir, name), target);
      installed.add(name);
    }

    writeFileSync(path.join(destDir, VERSION_FILE), `${version}\n`);
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      const reason =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (откат не удался: ${reason})`);
    }
    throw error;
  }

  cleanupBackupDirs(destDir);
  return { files: newFiles, version };
}
