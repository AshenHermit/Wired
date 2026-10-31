import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const TEMPLATES_VERSION = '4.7.2-stable';
export const TEMPLATES_DIRECTORY = '4.7.2.stable';
export const WEB_TEMPLATES = ['web_debug.zip', 'web_release.zip'];

export const TEMPLATES_ASSET = Object.freeze({
  name: 'Godot_v4.7.2-stable_export_templates.tpz',
  size: 1_281_349_702,
  sha256:
    'f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011',
  url: 'https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz',
});

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

export function exportTemplatesDirectory({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Godot', 'export_templates', TEMPLATES_DIRECTORY);
  }
  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Godot',
      'export_templates',
      TEMPLATES_DIRECTORY,
    );
  }
  if (platform === 'linux') {
    const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    return path.join(dataHome, 'godot', 'export_templates', TEMPLATES_DIRECTORY);
  }
  throw new Error(`Нет известного каталога шаблонов Godot для платформы ${platform}`);
}

export function hasWebTemplates(templatesDir) {
  return WEB_TEMPLATES.every((name) => isFile(path.join(templatesDir, name)));
}

export function verifyTemplatesArchive(buffer, asset = TEMPLATES_ASSET) {
  if (buffer.length !== asset.size) {
    throw new Error(
      `Неверный размер архива шаблонов: ожидалось ${asset.size} байт, получено ${buffer.length}`,
    );
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== asset.sha256) {
    throw new Error(
      `Неверная sha256 архива шаблонов: ожидалось ${asset.sha256}, получено ${digest}`,
    );
  }
}

export function installWebTemplates({ extractedDir, templatesDir }) {
  const sourceDir = path.join(extractedDir, 'templates');
  const sources = WEB_TEMPLATES.map((name) => path.join(sourceDir, name));
  for (const source of sources) {
    if (!isFile(source)) {
      throw new Error(`В архиве шаблонов нет файла ${source}`);
    }
  }

  mkdirSync(templatesDir, { recursive: true });
  const staged = sources.map((source, index) => {
    const target = path.join(templatesDir, WEB_TEMPLATES[index]);
    const temporary = `${target}.wired-${process.pid}-${Date.now()}-${index}.tmp`;
    copyFileSync(source, temporary);
    return { target, temporary };
  });

  const backups = [];
  const committed = [];
  try {
    for (const { target, temporary } of staged) {
      const backup = `${target}.wired-${process.pid}-${Date.now()}.bak`;
      if (existsSync(target)) {
        copyFileSync(target, backup);
        backups.push({ target, backup });
      }
      renameSync(temporary, target);
      committed.push(target);
    }
    for (const { backup } of backups) {
      rmSync(backup, { force: true });
    }
  } catch (error) {
    for (const target of committed) {
      const backup = backups.find((item) => item.target === target)?.backup;
      if (backup) {
        renameSync(backup, target);
      } else {
        rmSync(target, { force: true });
      }
    }
    for (const { temporary } of staged) {
      rmSync(temporary, { force: true });
    }
    for (const { backup } of backups) {
      rmSync(backup, { force: true });
    }
    throw error;
  }
}
