import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RUNTIME_VERSION = '4.8-beta2';

const ASSETS = {
  'win32-x64': {
    name: 'Godot_v4.8-beta2_win64.exe.zip',
    size: 64_448_151,
    sha512: '23d6dc2561f95cf296ca88c18d843867dffe978ac23608e3e4eb3fd67c0745cf48a259d51c83650f47e9e42f23154e0f907a6a162ea6b0e47dddbb3d88aa4579',
    sourceExecutable: 'Godot_v4.8-beta2_win64.exe',
    executable: 'Godot.exe',
  },
  'win32-ia32': {
    name: 'Godot_v4.8-beta2_win32.exe.zip',
    size: 66_988_384,
    sha512: '595eff0b87386ba4815c4a7d7af92143e65a9a9290a4c62523af6c5d1fefcb1d6e03fbceca5812a2648a72106870ce024e9f8d90faab1ec96efeabd9f21f797e',
    sourceExecutable: 'Godot_v4.8-beta2_win32.exe',
    executable: 'Godot.exe',
  },
  'win32-arm64': {
    name: 'Godot_v4.8-beta2_windows_arm64.exe.zip',
    size: 64_850_220,
    sha512: 'e7a005cc01ca153ed9ff3d1f6753c4a19837b8c71fd56f4ab57ba718f91ec016a214952a0a4439d0a5fd38d1b68b967acc43f3e6525fb9e31122fcb5000e3bcf',
    sourceExecutable: 'Godot_v4.8-beta2_windows_arm64.exe',
    executable: 'Godot.exe',
  },
  'linux-x64': {
    name: 'Godot_v4.8-beta2_linux.x86_64.zip',
    size: 62_274_839,
    sha512: '77470f53a9039cd22837935380230220167e098324e82ec448ee4b1f943f00afc424885f7d6631f385123d7a630a9399b3cc1b0e1dad1a4ac45c6356b3a0aa45',
    sourceExecutable: 'Godot_v4.8-beta2_linux.x86_64',
    executable: 'godot',
  },
  'linux-arm64': {
    name: 'Godot_v4.8-beta2_linux.arm64.zip',
    size: 58_878_748,
    sha512: '3021a84b4d2e37bb704af5ed53a4b80ffa1e1f292f5ebcfc23d3ab1ef27d278e255777373254636415d2a2262065a4532555f0e5fadb224fe862f0ee167446ed',
    sourceExecutable: 'Godot_v4.8-beta2_linux.arm64',
    executable: 'godot',
  },
  'linux-x86_32': {
    name: 'Godot_v4.8-beta2_linux.x86_32.zip',
    size: 58_241_294,
    sha512: '7f0c16f0930c1d95bcd3281859203812cdcbaf3372daff5c17d82e3fe7f06bad8b74d20b27f8113e467f5d5041557b03bfa3878bf4fa7e3c10ff259144d2a432',
    sourceExecutable: 'Godot_v4.8-beta2_linux.x86_32',
    executable: 'godot',
  },
  'linux-arm32': {
    name: 'Godot_v4.8-beta2_linux.arm32.zip',
    size: 55_085_572,
    sha512: 'eff529cb217903d14c522e2951861790a79232695055497c9294d0901021151a563fb74217c0d630e29dfe56837fb124bf2ae7a62bb78a78c59f7737cf73ab9e',
    sourceExecutable: 'Godot_v4.8-beta2_linux.arm32',
    executable: 'godot',
  },
  'darwin-x64': {
    name: 'Godot_v4.8-beta2_macos.x86_64.zip',
    size: 67_913_304,
    sha512: 'c9280801da5d4ccfb34bd30089d2383e4c0d65c1d7f769291027aa6cff2f2fe8d41beb578fdc7e6de75e67d99caeae5b5f9c2568ff594dbc9fc10e4680413107',
    sourceExecutable: 'Godot.app/Contents/MacOS/Godot',
    executable: 'Godot.app/Contents/MacOS/Godot',
  },
  'darwin-arm64': {
    name: 'Godot_v4.8-beta2_macos.arm64.zip',
    size: 61_048_120,
    sha512: '91e14126ad880dc31983b11fe03817771acfb20286a7543f8cde0db1c8c63c1845bcf38cb2252318165b65ddd166b362aadf874892555f4eb5e37dbc486b171e',
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
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
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
  const digest = createHash('sha512').update(buffer).digest('hex');
  if (digest !== asset.sha512) {
    throw new Error(`неверная sha512 архива: ${digest}`);
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
