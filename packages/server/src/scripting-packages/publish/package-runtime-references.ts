import path from 'path';
import {
  PackageSlugIndex,
  resolvePackageTarget,
} from '../storage/package-slug-index';

/** A text file decoded from a package revision, keyed by its package-relative path. */
export interface PackageTextFile {
  filepath: string;
  text: string;
}

/** A reference from one package file to another package's file. */
export interface PackageFileReference {
  packageId: number;
  filepath: string;
}

/** A package reference as authored: either a numeric id or a slug. */
export interface RawPackageFileReference {
  target: string;
  filepath: string;
}

const TEXT_FILE_EXTENSIONS = new Set(['.tscn', '.tres', '.gd']);

const SCENE_EXTENSION = '.tscn';

/**
 * `res://packages/<target>/<path>` inside any single- or double-quoted literal.
 * The target is a numeric id or a slug; path validation allows numeric legacy
 * slugs (`^[a-z0-9_]+$`, 1-64 chars), so digits are still interpreted as an id
 * when the reference is resolved. The same grammar collects raw references and
 * rewrites them, so it lives in one place.
 */
export const PACKAGE_REFERENCE_RE =
  /(["'])res:\/\/packages\/([a-z0-9_]{1,64})\/([^"'\r\n]+)\1/g;

/** Absolute `res://packages/<target>/<path>` written out of a quoted literal. */
const PACKAGE_PATH_RE = /^res:\/\/packages\/([a-z0-9_]{1,64})\/([^"'\r\n]+)$/;

/** A `path="..."` attribute or a `preload("...")` / `load("...")` argument. */
const REFERENCE_PATH_RE =
  /\b(?:path\s*=\s*|(?:preload|load)\s*\(\s*)(["'])([^"'\r\n]+)\1/g;

/** One ` uid="..."` attribute on an `[ext_resource ...]` line. */
const EXT_RESOURCE_UID_RE = /\suid="[^"]*"/;

/**
 * Whole-line comments are not code: `#` in GDScript and `;` in `.tscn`/`.tres`.
 * A quoted package reference there is documentation, never a dependency.
 */
const COMMENT_PREFIXES = ['#', ';'];

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Splits `text` into lines and applies `transform` to every line that is not a
 * whole-line comment. Splitting on `\n` keeps `\r` intact, so CRLF files are
 * rebuilt byte-for-byte outside the transformed spans.
 *
 * Quoted references inside multi-line strings are still collected and
 * rewritten: only comments are excluded.
 */
function mapCodeLines(
  text: string,
  transform: (line: string) => string,
): string {
  return text
    .split('\n')
    .map((line) => (isCommentLine(line) ? line : transform(line)))
    .join('\n');
}

/**
 * Package files that the editor treats as text: scenes, resources and GDScript
 * scripts. Anything else (textures, audio, ...) is binary and never decoded.
 */
export function isTextPackageFile(filepath: string): boolean {
  const ext = path.posix.extname(filepath.toLowerCase());
  return TEXT_FILE_EXTENSIONS.has(ext);
}

/**
 * Decodes the bytes of a text package file as strict UTF-8. Editor-authored
 * text is always UTF-8; a mismatched byte sequence means the file is not
 * actually text and must not be parsed as such.
 */
export function decodePackageText(filepath: string, data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error(`package_text_not_utf8:${filepath}`);
  }
}

/**
 * Collects every raw `res://packages/<target>/<path>` reference inside quoted
 * string literals in real code, keeping the target exactly as authored (a
 * numeric id or a slug). Whole-line comments are skipped, so a commented-out
 * reference neither creates a dependency nor blocks publishing. Paths are
 * normalized and deduplicated by `target:filepath`, keeping first-seen order.
 *
 * Resolution against the slug index is a separate step
 * ({@link resolvePackageReferences}), so an unknown slug is reported rather
 * than silently dropped.
 */
export function collectRawPackageReferences(
  text: string,
): RawPackageFileReference[] {
  const refs: RawPackageFileReference[] = [];
  const seen = new Set<string>();
  mapCodeLines(text, (line) => {
    for (const match of line.matchAll(PACKAGE_REFERENCE_RE)) {
      assertSafeRawPath(match[3]);
      const filepath = normalizeReferencePath(match[3]);
      if (filepath === null) {
        continue;
      }
      const target = match[2];
      const key = `${target}:${filepath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({ target, filepath });
    }
    return line;
  });
  return refs;
}

/**
 * Resolves raw references to package ids in the referencing room's namespace,
 * falling back to the global namespace. Numeric targets are ids, everything
 * else is looked up room-first; an unresolved slug is returned in `unknown`
 * (deduplicated, first-seen order) so the caller can raise
 * `package_dependency_unknown_slug:<slug>`. References that resolve to the same
 * package file — a package referenced once by id and once by slug — are
 * deduplicated.
 */
export function resolvePackageReferences(
  refs: RawPackageFileReference[],
  index: PackageSlugIndex,
  roomId: number | null,
): { resolved: PackageFileReference[]; unknown: string[] } {
  const resolved: PackageFileReference[] = [];
  const unknown: string[] = [];
  const seenResolved = new Set<string>();
  const seenUnknown = new Set<string>();
  for (const ref of refs) {
    const packageId = resolvePackageTarget(ref.target, index, roomId);
    if (packageId === null) {
      if (!seenUnknown.has(ref.target)) {
        seenUnknown.add(ref.target);
        unknown.push(ref.target);
      }
      continue;
    }
    const key = `${packageId}:${ref.filepath}`;
    if (seenResolved.has(key)) {
      continue;
    }
    seenResolved.add(key);
    resolved.push({ packageId, filepath: ref.filepath });
  }
  return { resolved, unknown };
}

/**
 * Rejects a closure in which two packages share one slug. A slug addresses a
 * package in the artifact namespace, so a duplicate would make one of the two
 * unreachable (a shadow) and rewrite both to the same runtime directory.
 */
export function assertUniquePackageSlugs(
  slugByPackage: ReadonlyMap<number, string>,
): void {
  const seen = new Map<string, number>();
  for (const [packageId, slug] of slugByPackage) {
    if (seen.has(slug)) {
      throw new Error(`package_slug_shadowed:${slug}`);
    }
    seen.set(slug, packageId);
  }
}

/**
 * Rewrites every `res://packages/<target>/` reference inside a quoted string
 * literal to the artifact-keyed runtime location of the pinned revision:
 * `user://wired/rooms/<roomId>/packages/<slug>/<revision>-<artifactKey>/`.
 *
 * The slug and key come from the referenced package's own closure, so a root
 * and its dependencies agree on the same library directory. There is no
 * numeric fallback: a package without a slug cannot be addressed at runtime.
 * Whole-line comments are left untouched; quoted references in multi-line
 * strings are rewritten. Throws when a quoted reference targets a package with
 * no pinned revision or no slug.
 */
export function rewritePackageReferences(
  text: string,
  options: {
    roomId: number;
    revisionByPackage: ReadonlyMap<number, number>;
    artifactKeyByPackage: ReadonlyMap<number, string>;
    slugByPackage: ReadonlyMap<number, string>;
  },
): string {
  const index: PackageSlugIndex = {
    byId: new Map(
      [...options.slugByPackage].map(([id, slug]) => [
        id,
        { slug, roomId: options.roomId },
      ]),
    ),
    byRoomSlug: new Map(
      [...options.slugByPackage].map(
        ([id, slug]) => [`${options.roomId}:${slug}`, id] as [string, number],
      ),
    ),
    byGlobalSlug: new Map(
      [...options.slugByPackage].map(
        ([id, slug]) => [slug, id] as [string, number],
      ),
    ),
  };
  return mapCodeLines(text, (line) =>
    line.replace(
      PACKAGE_REFERENCE_RE,
      (match, quote: string, target: string, rest: string) => {
        assertSafeRawPath(rest);
        const id = resolvePackageTarget(target, index, options.roomId);
        if (id === null) {
          throw new Error(`package_reference_not_rewritable:${target}`);
        }
        const revision = options.revisionByPackage.get(id);
        const artifactKey = options.artifactKeyByPackage.get(id);
        const slug = options.slugByPackage.get(id);
        if (
          revision === undefined ||
          artifactKey === undefined ||
          slug === undefined
        ) {
          throw new Error(`package_reference_not_rewritable:${id}`);
        }
        return `${quote}user://wired/rooms/${options.roomId}/packages/${slug}/${revision}-${artifactKey}/${rest}${quote}`;
      },
    ),
  );
}

/**
 * Removes the `uid="..."` attribute from every `[ext_resource ...]` line so a
 * rewritten scene does not reference the editor's `.godot` uid cache. The
 * scene's own uid and any other line type are left untouched.
 */
export function stripExtResourceUids(filepath: string, text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.trimStart().startsWith('[ext_resource')
        ? line.replace(EXT_RESOURCE_UID_RE, '')
        : line,
    )
    .join('\n');
}

/**
 * Computes, for each `.tscn` scene in `files`, the transitive set of files it
 * reaches through quoted relative paths and absolute `res://packages/<target>/...`
 * references, in depth-first discovery order. Relative paths resolve against
 * the directory of the referencing file and stay within its own package;
 * cross-package targets are resolved through `index` (a numeric target is an
 * id, anything else a slug resolved in `roomId` first) and looked up in
 * `dependencies`. Each entry is the stable key `"<packageId>:<filepath>"`.
 * Targets without a known package or file are skipped — their absence is
 * validated later.
 */
export function buildSceneDependencies(
  packageId: number,
  files: PackageTextFile[],
  dependencies: ReadonlyMap<number, readonly PackageTextFile[]>,
  index: PackageSlugIndex,
  roomId: number | null,
): Record<string, string[]> {
  const byKey = new Map<string, { packageId: number; file: PackageTextFile }>();
  const addPackageFiles = (
    pkg: number,
    list: readonly PackageTextFile[],
  ): void => {
    for (const file of list) {
      byKey.set(`${pkg}:${file.filepath}`, { packageId: pkg, file });
    }
  };
  addPackageFiles(packageId, files);
  for (const [pkg, list] of dependencies) {
    addPackageFiles(pkg, list);
  }

  const result: Record<string, string[]> = {};

  for (const scene of files) {
    if (path.posix.extname(scene.filepath.toLowerCase()) !== SCENE_EXTENSION) {
      continue;
    }

    const keys: string[] = [];
    const visited = new Set<string>();

    const visit = (pkg: number, filepath: string): void => {
      const key = `${pkg}:${filepath}`;
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      keys.push(key);

      const entry = byKey.get(key);
      if (!entry) {
        return;
      }

      const dir = path.posix.dirname(filepath);
      for (const ref of collectReferences(entry.file.text, index, roomId)) {
        if (ref.kind === 'package') {
          const target = byKey.get(`${ref.packageId}:${ref.filepath}`);
          if (target) {
            visit(target.packageId, target.file.filepath);
          }
        } else {
          const resolved = path.posix.normalize(
            path.posix.join(dir, ref.filepath),
          );
          const target = byKey.get(`${pkg}:${resolved}`);
          if (target) {
            visit(pkg, resolved);
          }
        }
      }
    };

    visit(packageId, scene.filepath);
    result[scene.filepath] = keys;
  }

  return result;
}

type Reference =
  | { kind: 'package'; packageId: number; filepath: string }
  | { kind: 'relative'; filepath: string };

/** Collects the paths a text file references via `path="..."` or preload/load. */
function collectReferences(
  text: string,
  index: PackageSlugIndex,
  roomId: number | null,
): Reference[] {
  const refs: Reference[] = [];
  for (const line of text.split('\n')) {
    if (isCommentLine(line)) {
      continue;
    }
    for (const match of line.matchAll(REFERENCE_PATH_RE)) {
      const raw = match[2];
      if (raw.startsWith('res://')) {
        const parsed = parsePackagePath(raw, index, roomId);
        if (parsed) {
          refs.push({
            kind: 'package',
            packageId: parsed.packageId,
            filepath: parsed.filepath,
          });
        }
        // Other res:// targets are not package files and are not resolvable here.
      } else {
        const filepath = normalizeReferencePath(raw);
        if (filepath !== null) {
          refs.push({ kind: 'relative', filepath });
        }
      }
    }
  }
  return refs;
}

/**
 * Resolves an absolute `res://packages/<target>/<path>` to its package id in
 * the referencing room's namespace. An unknown slug returns `null`: the
 * manifest build already rejected unknown references, and an unresolvable
 * target contributes no dependency here.
 */
function parsePackagePath(
  raw: string,
  index: PackageSlugIndex,
  roomId: number | null,
): PackageFileReference | null {
  const match = PACKAGE_PATH_RE.exec(raw);
  if (!match) {
    return null;
  }
  const packageId = resolvePackageTarget(match[1], index, roomId);
  if (packageId === null) {
    return null;
  }
  const filepath = normalizeReferencePath(match[2]);
  if (filepath === null) {
    return null;
  }
  return { packageId, filepath };
}

/** Normalizes a path out of a reference, rejecting empty results. */
function normalizeReferencePath(raw: string): string | null {
  let filepath = path.posix.normalize(raw);
  if (filepath.startsWith('/')) {
    filepath = filepath.slice(1);
  }
  return filepath.length === 0 ? null : filepath;
}

/**
 * Rejects a raw captured reference path that would address something other
 * than the intended package file: a `.`/`..` segment escapes the package
 * directory (or normalizes ambiguously), and a backslash is a Windows
 * separator that Godot never uses in `res://paths` and that would survive the
 * rewrite into an artifact path.
 */
function assertSafeRawPath(raw: string): void {
  if (
    raw.includes('\\') ||
    raw.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`package_reference_invalid_path:${raw}`);
  }
}
