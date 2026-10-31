#!/usr/bin/env node
/**
 * Downloads the pinned official Godot web editor and installs it into
 * `packages/server/godot_editor` (or `GODOT_EDITOR_PATH`).
 *
 * Run from the repository root:
 *   pnpm fetch:editor
 *
 * The editor build is no longer committed: `pnpm install && pnpm fetch:editor`
 * is the clean-checkout setup, and Docker runs the same script at build time.
 * The version, archive name, byte size and sha512 are pinned below; any
 * mismatch aborts before the destination is touched.
 *
 * Usage:
 *   node scripts/fetch-godot-editor.mjs [--force]
 *
 *   GODOT_EDITOR_PATH  install directory (default `<server>/godot_editor`)
 *   --force            reinstall even when VERSION already matches
 *
 * Uses only Node built-ins (Node >= 20), no extra dependencies.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractZip } from './lib/unzip.mjs';

const VERSION = '4.7.2-stable';
const ZIP_NAME = `Godot_v${VERSION}_web_editor.zip`;
const ZIP_URL = `https://github.com/godotengine/godot/releases/download/${VERSION}/${ZIP_NAME}`;
const ZIP_SIZE = 54031095;
const ZIP_SHA512 =
  '03ad6b4b4d96f0f7d85bf4fdcf29535891b79d52ee94a11e96895463a2745347b8f601b455e7a58135bf641df43fc25296bc257bbfce593d477dfa64a2272268';

/** Files the editor cannot start without; validated before the swap. */
const CORE_FILES = ['godot.editor.js', 'godot.editor.wasm', 'godot.editor.html'];

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const destDir = path.resolve(
  process.env.GODOT_EDITOR_PATH ?? path.join(SERVER_ROOT, 'godot_editor'),
);
const force = process.argv.includes('--force');

function log(message) {
  console.log(`[fetch:editor] ${message}`);
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function isInstalled() {
  const versionFile = path.join(destDir, 'VERSION');
  if (!existsSync(versionFile)) {
    return false;
  }
  if (readFileSync(versionFile, 'utf8').trim() !== VERSION) {
    return false;
  }
  return existsSync(path.join(destDir, 'godot.editor.wasm'));
}

async function download() {
  log(`Скачивание ${ZIP_NAME}`);
  const response = await fetch(ZIP_URL);
  if (!response.ok) {
    throw new Error(
      `не удалось скачать ${ZIP_NAME}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== ZIP_SIZE) {
    throw new Error(
      `неверный размер архива: ожидалось ${ZIP_SIZE} байт, получено ${buffer.length}`,
    );
  }

  const digest = createHash('sha512').update(buffer).digest('hex');
  if (digest !== ZIP_SHA512) {
    throw new Error(`неверная sha512 архива: ${digest}`);
  }

  log(`Размер: ${buffer.length} байт (${mib(buffer.length)})`);
  log(`sha512: ${digest}`);
  return buffer;
}

const STALE_EDITOR_PREFIX = 'godot.editor.';
const BACKUP_DIR_PREFIX = '.editor-backup-';

function existingEditorFiles() {
  if (!existsSync(destDir)) {
    return [];
  }
  return readdirSync(destDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(STALE_EDITOR_PREFIX))
    .map((entry) => entry.name);
}

function removeEditorFiles() {
  for (const name of existingEditorFiles()) {
    rmSync(path.join(destDir, name), { force: true });
  }
}

/** Moves the current editor aside so a failed install can be rolled back. */
function moveEditorAside(backupDir) {
  for (const name of existingEditorFiles()) {
    renameSync(path.join(destDir, name), path.join(backupDir, name));
  }
  // VERSION goes too: an interrupted install must not keep advertising the
  // old version over a half-replaced set, and rollback restores it.
  const versionFile = path.join(destDir, 'VERSION');
  if (existsSync(versionFile)) {
    renameSync(versionFile, path.join(backupDir, 'VERSION'));
  }
}

function restoreBackup(backupDir) {
  // Drop whatever the failed install moved in, then put the old set back:
  // the destination must never mix old and new core files.
  removeEditorFiles();
  for (const name of readdirSync(backupDir)) {
    moveFile(path.join(backupDir, name), path.join(destDir, name));
  }
  rmSync(backupDir, { recursive: true, force: true });
}

function moveFile(source, target) {
  // rename can fail across volumes (temp dir on another disk); fall back to
  // copy + delete. Remove the target first so Windows does not refuse.
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

function writeVersion() {
  writeFileSync(path.join(destDir, 'VERSION'), `${VERSION}\n`);
}

function assertCoreFiles(dir) {
  for (const name of CORE_FILES) {
    if (!existsSync(path.join(dir, name))) {
      throw new Error(`установка неполная: отсутствует ${name}`);
    }
  }
}

async function main() {
  if (!force && isInstalled()) {
    log(`Редактор уже на ${VERSION}`);
    return;
  }

  const buffer = await download();

  // Unpack into a scratch directory and validate there: the real destination
  // is only modified once we know the archive is complete.
  const tempDir = mkdtempSync(path.join(tmpdir(), 'wired-godot-editor-'));
  try {
    const files = extractZip(buffer, tempDir);
    log(`Распаковано файлов: ${files.length}`);
    assertCoreFiles(tempDir);

    mkdirSync(destDir, { recursive: true });
    const backupDir = mkdtempSync(path.join(destDir, BACKUP_DIR_PREFIX));
    try {
      moveEditorAside(backupDir);
      for (const name of files) {
        if (name === 'VERSION') {
          continue; // the version file is generated here, never trusted
        }
        const target = path.join(destDir, name);
        mkdirSync(path.dirname(target), { recursive: true });
        moveFile(path.join(tempDir, name), target);
      }
      // Only a complete new set may replace the old one, and VERSION is the
      // last write: an interrupted install never advertises itself.
      assertCoreFiles(destDir);
      writeVersion();
    } catch (error) {
      try {
        restoreBackup(backupDir);
      } catch (restoreError) {
        const reason =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        console.error(`[fetch:editor] не удалось восстановить предыдущий редактор: ${reason}`);
      }
      throw error;
    }
    rmSync(backupDir, { recursive: true, force: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  assertCoreFiles(destDir);
  log(`Готово: ${VERSION}`);
  log(`Каталог редактора: ${destDir}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fetch:editor] ${message}`);
  process.exitCode = 1;
}
