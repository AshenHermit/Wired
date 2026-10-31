import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RUNTIME_VERSION = '4.7.2-stable';

const ASSETS = {
  'win32-x64': {
    name: 'Godot_v4.7.2-stable_win64.exe.zip',
    size: 86_013_866,
    sha256: '731980f9608d61333e5baf54a2ef17210acc7a538446c0cb9969f002aca1e953',
    sourceExecutable: 'Godot_v4.7.2-stable_win64.exe',
    executable: 'Godot.exe',
  },
  'win32-ia32': {
    name: 'Godot_v4.7.2-stable_win32.exe.zip',
    size: 87_837_088,
    sha256: '187ff56a73e6fc4b82ed22a87d72915a63c74abc9defe8b2e29a0098b5f8eea2',
    sourceExecutable: 'Godot_v4.7.2-stable_win32.exe',
    executable: 'Godot.exe',
  },
  'win32-arm64': {
    name: 'Godot_v4.7.2-stable_windows_arm64.exe.zip',
    size: 84_263_370,
    sha256: '2d206e0b1d2366eb3508971c670c52333dcd7218b818102d77ca7ceaa86892ba',
    sourceExecutable: 'Godot_v4.7.2-stable_windows_arm64.exe',
    executable: 'Godot.exe',
  },
  'linux-x64': {
    name: 'Godot_v4.7.2-stable_linux.x86_64.zip',
    size: 77_860_424,
    sha256: 'cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4',
    sourceExecutable: 'Godot_v4.7.2-stable_linux.x86_64',
    executable: 'godot',
  },
  'linux-arm64': {
    name: 'Godot_v4.7.2-stable_linux.arm64.zip',
    size: 77_008_699,
    sha256: '5dd0d86405cf7e8adf79fb6377b38ba682a2846cb378ffe5364f38c01ad29b9d',
    sourceExecutable: 'Godot_v4.7.2-stable_linux.arm64',
    executable: 'godot',
  },
  'linux-x86_32': {
    name: 'Godot_v4.7.2-stable_linux.x86_32.zip',
    size: 78_111_204,
    sha256: '05d7b8ef72c1d1f15eee82a585867ec0e18ad31501a4b7ce0974c111720c36b9',
    sourceExecutable: 'Godot_v4.7.2-stable_linux.x86_32',
    executable: 'godot',
  },
  'linux-arm32': {
    name: 'Godot_v4.7.2-stable_linux.arm32.zip',
    size: 74_780_990,
    sha256: '974393f85c108f62d7754369b9d1ed4c82645aefdd2ea72c3d125c7bec18b030',
    sourceExecutable: 'Godot_v4.7.2-stable_linux.arm32',
    executable: 'godot',
  },
  'darwin-universal': {
    name: 'Godot_v4.7.2-stable_macos.universal.zip',
    size: 170_622_178,
    sha256: 'c58a24e31d720be9d62f60cb5627c4e695fb72f21b0cfe1bc9ccaa9a3b3ba63e',
    sourceExecutable: 'Godot.app/Contents/MacOS/Godot',
    executable: 'Godot.app/Contents/MacOS/Godot',
  },
};

const PLATFORM_KEYS = {
  win32: { x64: 'win32-x64', ia32: 'win32-ia32', arm64: 'win32-arm64' },
  linux: {
    x64: 'linux-x64',
    arm64: 'linux-arm64',
    ia32: 'linux-x86_32',
    arm: 'linux-arm32',
  },
  darwin: { x64: 'darwin-universal', arm64: 'darwin-universal' },
};

export function selectRuntimeAsset(platform = process.platform, arch = process.arch) {
  const platformKey = PLATFORM_KEYS[platform]?.[arch];
  if (!platformKey) {
    throw new Error(
      `Нет официальной сборки Godot для платформы ${platform}/${arch}`,
    );
  }
  return { platform: platformKey, ...ASSETS[platformKey] };
}

export function verifyRuntimeArchive(buffer, asset) {
  if (buffer.length !== asset.size) {
    throw new Error(
      `неверный размер архива: ожидалось ${asset.size} байт, получено ${buffer.length}`,
    );
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== asset.sha256) {
    throw new Error(`неверная sha256 архива: ${digest}`);
  }
}

export async function downloadRuntimeArchive(asset, fetchImpl = fetch) {
  const url = `https://github.com/godotengine/godot-builds/releases/download/${RUNTIME_VERSION}/${asset.name}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `не удалось скачать ${asset.name}: HTTP ${response.status} ${response.statusText ?? ''}`.trim(),
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  verifyRuntimeArchive(buffer, asset);
  return buffer;
}

export function installRuntime({
  runtimeDir,
  sourceDir,
  version,
  platform,
  executable,
  sourceExecutable,
}) {
  const directory = `${version}-${platform}`;
  const versionDir = join(runtimeDir, directory);
  const installedExecutable = join(versionDir, executable);
  const sourcePath = join(versionDir, sourceExecutable);

  rmSync(versionDir, { recursive: true, force: true });
  try {
    mkdirSync(versionDir, { recursive: true });
    cpSync(sourceDir, versionDir, { recursive: true });
    if (!existsSync(sourcePath)) {
      throw new Error(`В архиве нет файла ${sourceExecutable}`);
    }
    if (sourceExecutable !== executable) {
      mkdirSync(dirname(installedExecutable), { recursive: true });
      renameSync(sourcePath, installedExecutable);
    }
    if (!existsSync(installedExecutable)) {
      throw new Error(`Не удалось установить ${executable}`);
    }
    if (process.platform === 'linux') {
      chmodSync(installedExecutable, 0o755);
    }

    const manifest = {
      version,
      platform,
      directory,
      executable: `${directory}/${executable}`,
    };
    const manifestPath = join(runtimeDir, 'runtime.json');
    const temporary = `${manifestPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, manifestPath);
    return manifest;
  } catch (error) {
    rmSync(versionDir, { recursive: true, force: true });
    throw error;
  }
}

export function readRuntimeManifest(runtimeDir) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(runtimeDir, 'runtime.json'), 'utf8'),
    );
    if (
      typeof manifest.version !== 'string' ||
      typeof manifest.platform !== 'string' ||
      typeof manifest.directory !== 'string' ||
      typeof manifest.executable !== 'string'
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function resolveRuntimeExecutable(runtimeDir) {
  const manifest = readRuntimeManifest(runtimeDir);
  if (!manifest) {
    return '';
  }
  const executable = join(runtimeDir, manifest.executable);
  return existsSync(executable) ? executable : '';
}

export function isRuntimeInstalled(
  runtimeDir,
  version,
  platform,
  manifest = readRuntimeManifest(runtimeDir),
) {
  return Boolean(
    manifest &&
      manifest.version === version &&
      manifest.platform === platform &&
      existsSync(join(runtimeDir, manifest.executable)),
  );
}
