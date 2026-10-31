#!/usr/bin/env node
/**
 * Downloads the pinned official Godot 4.7.2 export templates and installs the
 * Web templates into Godot's per-user template directory.
 *
 * Run from the repository root:
 *   pnpm fetch:templates
 *
 * Only `web_debug.zip` and `web_release.zip` are extracted; the archive is
 * ~1.2 GiB and contains every platform. The archive size and sha256 are pinned
 * in `lib/export-templates.mjs`.
 *
 * Usage:
 *   node scripts/fetch-godot-templates.mjs [--force]
 *
 *   --force   reinstall even when both web templates already exist
 *
 * Uses only Node built-ins (Node >= 22), no extra dependencies.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TEMPLATES_ASSET,
  TEMPLATES_VERSION,
  WEB_TEMPLATES,
  exportTemplatesDirectory,
  hasWebTemplates,
  installWebTemplates,
  verifyTemplatesArchive,
} from './lib/export-templates.mjs';
import { extractZip } from './lib/unzip.mjs';

const force = process.argv.includes('--force');

function log(message) {
  console.log(`[fetch:templates] ${message}`);
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function downloadTemplates() {
  log(`Скачиваем ${TEMPLATES_ASSET.name} (${mib(TEMPLATES_ASSET.size)})…`);
  const response = await fetch(TEMPLATES_ASSET.url);
  if (!response.ok) {
    throw new Error(`не удалось скачать шаблоны: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  verifyTemplatesArchive(buffer, TEMPLATES_ASSET);
  log(`Скачано: ${buffer.length} байт (${mib(buffer.length)})`);
  return buffer;
}

async function main() {
  const templatesDir = exportTemplatesDirectory();
  if (!force && hasWebTemplates(templatesDir)) {
    log(`Web-шаблоны уже установлены: ${TEMPLATES_VERSION}`);
    log(`Каталог: ${templatesDir}`);
    return;
  }

  const buffer = await downloadTemplates();
  const wanted = new Set(WEB_TEMPLATES.map((name) => `templates/${name}`));
  const tempDir = mkdtempSync(path.join(tmpdir(), 'wired-godot-templates-'));
  try {
    const files = extractZip(buffer, tempDir, {
      match: (name) => wanted.has(name),
    });
    log(`Распаковано файлов: ${files.length}`);
    installWebTemplates({ extractedDir: tempDir, templatesDir });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  log(`Готово: ${TEMPLATES_VERSION}`);
  log(`Каталог: ${templatesDir}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fetch:templates] ${message}`);
  if (
    process.platform === 'win32' &&
    (error?.code === 'EPERM' || error?.code === 'EBUSY')
  ) {
    console.error(
      '[fetch:templates] Закройте запущенный Godot и повторите установку.',
    );
  }
  process.exitCode = 1;
}
