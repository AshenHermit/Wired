import path from 'path';

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

const TEXT_FILE_EXTENSIONS = new Set(['.tscn', '.tres', '.gd']);

const SCENE_EXTENSION = '.tscn';

/** `res://packages/<id>/<path>` inside any single- or double-quoted literal. */
const PACKAGE_REFERENCE_RE = /(["'])res:\/\/packages\/(\d+)\/([^"'\r\n]+)\1/g;

/** Absolute `res://packages/<id>/<path>` written out of a quoted literal. */
const PACKAGE_PATH_RE = /^res:\/\/packages\/(\d+)\/([^"'\r\n]+)$/;

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
 * Collects every `res://packages/<id>/<path>` reference inside quoted string
 * literals in real code. Whole-line comments are skipped, so a commented-out
 * reference neither creates a dependency nor blocks publishing. Paths are
 * normalized and deduplicated, keeping first-seen order.
 */
export function collectPackageReferences(text: string): PackageFileReference[] {
  const refs: PackageFileReference[] = [];
  const seen = new Set<string>();
  mapCodeLines(text, (line) => {
    for (const match of line.matchAll(PACKAGE_REFERENCE_RE)) {
      assertSafeRawPath(match[3]);
      const filepath = normalizeReferencePath(match[3]);
      if (filepath === null) {
        continue;
      }
      const packageId = Number(match[2]);
      const key = `${packageId}:${filepath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({ packageId, filepath });
    }
    return line;
  });
  return refs;
}

/**
 * Rewrites every `res://packages/<id>/` reference inside a quoted string
 * literal to the artifact-keyed runtime location of the pinned revision:
 * `user://wired/rooms/<roomId>/packages/<id>/<revision>-<artifactKey>/`.
 *
 * The key comes from the referenced package's own closure, so a root and its
 * dependencies agree on the same library directory. Whole-line comments are
 * left untouched; quoted references in multi-line strings are rewritten.
 * Throws when a quoted reference targets a package with no pinned revision.
 */
export function rewritePackageReferences(
  text: string,
  options: {
    roomId: number;
    revisionByPackage: ReadonlyMap<number, number>;
    artifactKeyByPackage: ReadonlyMap<number, string>;
  },
): string {
  return mapCodeLines(text, (line) =>
    line.replace(
      PACKAGE_REFERENCE_RE,
      (match, quote: string, idGroup: string, rest: string) => {
        assertSafeRawPath(rest);
        const id = Number(idGroup);
        const revision = options.revisionByPackage.get(id);
        const artifactKey = options.artifactKeyByPackage.get(id);
        if (revision === undefined || artifactKey === undefined) {
          throw new Error(`package_reference_not_rewritable:${id}`);
        }
        return `${quote}user://wired/rooms/${options.roomId}/packages/${id}/${revision}-${artifactKey}/${rest}${quote}`;
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
 * reaches through quoted relative paths and absolute `res://packages/<id>/...`
 * references, in depth-first discovery order. Relative paths resolve against
 * the directory of the referencing file and stay within its own package;
 * cross-package targets come from `dependencies`. Each entry is the stable key
 * `"<packageId>:<filepath>"`. Targets without a known file are skipped — their
 * absence is validated later.
 */
export function buildSceneDependencies(
  packageId: number,
  files: PackageTextFile[],
  dependencies: ReadonlyMap<number, readonly PackageTextFile[]>,
): Record<string, string[]> {
  const byKey = new Map<string, { packageId: number; file: PackageTextFile }>();
  const index = (pkg: number, list: readonly PackageTextFile[]): void => {
    for (const file of list) {
      byKey.set(`${pkg}:${file.filepath}`, { packageId: pkg, file });
    }
  };
  index(packageId, files);
  for (const [pkg, list] of dependencies) {
    index(pkg, list);
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
      for (const ref of collectReferences(entry.file.text)) {
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
function collectReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  for (const line of text.split('\n')) {
    if (isCommentLine(line)) {
      continue;
    }
    for (const match of line.matchAll(REFERENCE_PATH_RE)) {
      const raw = match[2];
      if (raw.startsWith('res://')) {
        const parsed = parsePackagePath(raw);
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

function parsePackagePath(raw: string): PackageFileReference | null {
  const match = PACKAGE_PATH_RE.exec(raw);
  if (!match) {
    return null;
  }
  const filepath = normalizeReferencePath(match[2]);
  if (filepath === null) {
    return null;
  }
  return { packageId: Number(match[1]), filepath };
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
 * Rejects a raw captured reference path that contains a `.` or `..` segment.
 * Such a path would address files outside the referenced package directory
 * (or normalize ambiguously), so it must fail before normalization collapses
 * the offending segment and the rewrite preserves it verbatim.
 */
function assertSafeRawPath(raw: string): void {
  if (raw.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`package_reference_invalid_path:${raw}`);
  }
}
