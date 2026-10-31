#!/usr/bin/env node
/**
 * Downloads the pinned official Godot runtime for the current platform into
 * `packages/server/godot_runtime` (git-ignored).
 *
 * Run from the repository root:
 *   pnpm fetch:runtime
 *
 * The version, archive name, byte size and sha256 are pinned in
 * `lib/runtime-install.mjs`; any mismatch aborts before the install directory
 * is touched. Existing `GODOT_RUNTIME_PATH` still wins at runtime, so a local
 * `.env` override is not changed by this script.
 *
 * Usage:
 *   node scripts/fetch-godot-runtime.mjs [--force]
 *
 *   --force   reinstall even when runtime.json already matches
 *
 * Uses only Node built-ins (Node >= 22), no extra dependencies.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RUNTIME_VERSION,
  downloadRuntimeArchive,
  installRuntime,
  isRuntimeInstalled,
  resolveRuntimeExecutable,
  selectRuntimeAsset,
} from './lib/runtime-install.mjs';
import { extractZip } from './lib/unzip.mjs';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const runtimeDir = path.join(SERVER_ROOT, 'godot_runtime');
const force = process.argv.includes('--force');

function log(message) {
  console.log(`[fetch:runtime] ${message}`);
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const asset = selectRuntimeAsset();

  if (!force && isRuntimeInstalled(runtimeDir, RUNTIME_VERSION, asset.platform)) {
    log(`Runtime уже установлен: ${RUNTIME_VERSION} (${asset.platform})`);
    log(`Исполняемый файл: ${resolveRuntimeExecutable(runtimeDir)}`);
    return;
  }

  log(`Платформа: ${asset.platform}`);
  const buffer = await downloadRuntimeArchive(asset);
  log(`Скачано: ${buffer.length} байт (${mib(buffer.length)})`);
  log(`sha256: ${asset.sha256}`);

  const tempDir = mkdtempSync(path.join(tmpdir(), 'wired-godot-runtime-'));
  let manifest;
  try {
    const files = extractZip(buffer, tempDir);
    log(`Распаковано файлов: ${files.length}`);
    manifest = installRuntime({
      runtimeDir,
      sourceDir: tempDir,
      version: RUNTIME_VERSION,
      platform: asset.platform,
      executable: asset.executable,
      sourceExecutable: asset.sourceExecutable,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const executable = path.join(runtimeDir, manifest.executable);
  if (!existsSync(executable)) {
    throw new Error(`установка неполная: отсутствует ${executable}`);
  }
  log(`Готово: ${RUNTIME_VERSION}`);
  log(`Исполняемый файл: ${executable}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fetch:runtime] ${message}`);
  if (
    process.platform === 'win32' &&
    (error?.code === 'EPERM' || error?.code === 'EBUSY')
  ) {
    console.error(
      '[fetch:runtime] Закройте запущенный Godot и повторите установку.',
    );
  }
  process.exitCode = 1;
}
