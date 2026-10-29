#!/usr/bin/env node
/**
 * Builds the Godot Web export consumed by the Game tab.
 *
 * Run from the repository root:
 *   pnpm export:game
 *
 * The export is a generated artifact (`packages/server/game_export/web` by
 * default, git-ignored) and deliberately lives OUTSIDE the Godot project:
 * `godot_project/_wired` is the base project served to every room editor and
 * to the runtime, so a build inside it would be imported, copied into the
 * editor FS on every room open and scanned by Godot. The backend serves the
 * output at `/game-export/*`, which the frontend proxies through `/api`.
 * Nothing has to be copied by hand.
 *
 * Configuration comes from the environment or `packages/server/.env`:
 *   GODOT_RUNTIME_PATH           Godot executable (required)
 *   GODOT_RUNTIME_PROJECT_PATH   project directory, default godot_project/_wired
 *   GODOT_GAME_EXPORT_DIR        export output, default game_export/web
 *
 * Uses only Node built-ins (Node >= 22), no extra dependencies.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');

function loadEnvFile(file) {
  if (!existsSync(file)) {
    return;
  }
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function fail(message) {
  console.error(`[export:game] ${message}`);
  process.exit(1);
}

loadEnvFile(path.join(SERVER_ROOT, '.env'));

const godot = process.env.GODOT_RUNTIME_PATH ?? '';
if (!godot) {
  fail(
    'GODOT_RUNTIME_PATH is not set. Add it to packages/server/.env or the environment.',
  );
}
if (!existsSync(godot)) {
  fail(`GODOT_RUNTIME_PATH does not point to a file: ${godot}`);
}

const projectPath = path.resolve(
  SERVER_ROOT,
  process.env.GODOT_RUNTIME_PROJECT_PATH ?? 'godot_project/_wired',
);
if (!existsSync(path.join(projectPath, 'project.godot'))) {
  fail(`No project.godot in ${projectPath}`);
}

// The output lives outside the Godot project on purpose: the project
// directory is shared by every room editor and by the runtime.
const destDir = path.resolve(
  SERVER_ROOT,
  process.env.GODOT_GAME_EXPORT_DIR ?? 'game_export/web',
);
const destFile = path.join(destDir, 'index.html');
mkdirSync(destDir, { recursive: true });

function run(args, label) {
  console.log(`[export:game] ${label}`);
  const result = spawnSync(godot, args, {
    cwd: projectPath,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} exited with code ${result.status}`);
  }
}

// Import first so a fresh checkout exports the same as a previously opened
// project; export does not always run the import step itself.
run(['--headless', '--path', projectPath, '--import'], 'Importing project');
run(
  [
    '--headless',
    '--path',
    projectPath,
    '--export-release',
    'Web',
    destFile,
  ],
  'Exporting Web build',
);

if (!existsSync(destFile)) {
  fail(`Export finished without writing ${destFile}`);
}

const files = ['index.html', 'index.js', 'index.wasm', 'index.pck'];
for (const name of files) {
  const file = path.join(destDir, name);
  if (!existsSync(file)) {
    fail(`Export is incomplete: ${name} is missing`);
  }
  const size = statSync(file).size;
  console.log(
    `[export:game] ${name.padEnd(12)} ${(size / 1024 / 1024).toFixed(2)} MiB`,
  );
}
console.log(`[export:game] ready: ${destDir}`);
