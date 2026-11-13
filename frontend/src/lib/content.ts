import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const CONTENT_ROOT = path.join(process.cwd(), 'content');

export type DocMeta = {
  slug: string;
  title: string;
  order: number;
};

export type Doc = DocMeta & {
  content: string;
};

export type DevlogMeta = {
  slug: string;
  title: string;
  date: string;
  summary: string;
  version: string;
};

export type DevlogEntry = DevlogMeta & {
  content: string;
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEVLOG_FILE_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

const docFrontMatterSchema = z.object({
  title: z.string().min(1),
  order: z.number().int().optional(),
});

const devlogFrontMatterSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'expected a semver version'),
  date: z.union([z.string(), z.date()]),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'front matter'}: ${issue.message}`)
    .join('; ');
}

function splitFrontMatter(
  fileName: string,
  raw: string,
): { data: unknown; content: string } {
  const match = raw.match(FRONT_MATTER);
  if (!match) {
    throw new Error(`${fileName}: missing YAML front matter`);
  }

  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch (error) {
    throw new Error(`${fileName}: ${errorMessage(error)}`);
  }

  const content = raw.slice(match[0].length).replace(/^(?:\r?\n)+/, '');
  return { data, content };
}

function normalizeDate(fileName: string, value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${fileName}: invalid date`);
    }
    return value.toISOString().slice(0, 10);
  }

  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${fileName}: expected a YYYY-MM-DD date, got "${value}"`);
  }

  return value;
}

export function parseDocFile(fileName: string, raw: string): Doc {
  const { data, content } = splitFrontMatter(fileName, raw);
  const parsed = docFrontMatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${fileName}: ${formatZodError(parsed.error)}`);
  }

  return {
    slug: fileName.replace(/\.md$/, ''),
    title: parsed.data.title,
    order: parsed.data.order ?? 0,
    content,
  };
}

export function parseDevlogFile(fileName: string, raw: string): DevlogEntry {
  const nameMatch = DEVLOG_FILE_NAME.exec(fileName);
  if (!nameMatch) {
    throw new Error(
      `${fileName}: expected a YYYY-MM-DD-<slug>.md file name`,
    );
  }

  const { data, content } = splitFrontMatter(fileName, raw);
  const parsed = devlogFrontMatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${fileName}: ${formatZodError(parsed.error)}`);
  }

  return {
    slug: nameMatch[2],
    title: parsed.data.title,
    date: normalizeDate(fileName, parsed.data.date),
    summary: parsed.data.summary,
    version: parsed.data.version,
    content,
  };
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return names
    .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
    .sort();
}

function assertUniqueSlugs<T extends { slug: string }>(
  entries: T[],
  fileNames: string[],
): void {
  const seen = new Map<string, string>();
  entries.forEach((entry, index) => {
    const previous = seen.get(entry.slug);
    if (previous) {
      throw new Error(
        `duplicate slug: ${entry.slug} in ${previous}, ${fileNames[index]}`,
      );
    }
    seen.set(entry.slug, fileNames[index]);
  });
}

async function readDir<T extends { slug: string }>(
  dir: string,
  parse: (fileName: string, raw: string) => T,
): Promise<T[]> {
  const fileNames = await listMarkdownFiles(dir);
  const entries = await Promise.all(
    fileNames.map(async (fileName) =>
      parse(fileName, await fs.readFile(path.join(dir, fileName), 'utf8')),
    ),
  );

  assertUniqueSlugs(entries, fileNames);
  return entries;
}

export async function readDocsDir(dir: string): Promise<Doc[]> {
  const docs = await readDir(dir, parseDocFile);
  return docs.sort(
    (a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'),
  );
}

export async function readDevlogDir(dir: string): Promise<DevlogEntry[]> {
  const entries = await readDir(dir, parseDevlogFile);
  return entries.sort(
    (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'ru'),
  );
}

export async function listDocs(): Promise<DocMeta[]> {
  const docs = await readDocsDir(path.join(CONTENT_ROOT, 'docs'));
  return docs.map(({ slug, title, order }) => ({ slug, title, order }));
}

export async function getDoc(slug: string): Promise<Doc | null> {
  const docs = await readDocsDir(path.join(CONTENT_ROOT, 'docs'));
  return docs.find((doc) => doc.slug === slug) ?? null;
}

export async function listDevlog(): Promise<DevlogMeta[]> {
  const entries = await readDevlogDir(path.join(CONTENT_ROOT, 'devlog'));
  return entries.map(({ slug, title, date, summary, version }) => ({
    slug,
    title,
    date,
    summary,
    version,
  }));
}

export async function getDevlogEntry(
  slug: string,
): Promise<DevlogEntry | null> {
  const entries = await readDevlogDir(path.join(CONTENT_ROOT, 'devlog'));
  return entries.find((entry) => entry.slug === slug) ?? null;
}

export async function latestDevlog(limit: number): Promise<DevlogMeta[]> {
  return (await listDevlog()).slice(0, limit);
}

async function validateDir<T extends { slug: string }>(
  dir: string,
  parse: (fileName: string, raw: string) => T,
): Promise<string[]> {
  const issues: string[] = [];
  let fileNames: string[];
  try {
    fileNames = await listMarkdownFiles(dir);
  } catch (error) {
    return [`${dir}: ${errorMessage(error)}`];
  }

  const seen = new Map<string, string>();
  for (const fileName of fileNames) {
    try {
      const entry = parse(
        fileName,
        await fs.readFile(path.join(dir, fileName), 'utf8'),
      );
      const previous = seen.get(entry.slug);
      if (previous) {
        issues.push(`duplicate slug: ${entry.slug} in ${previous}, ${fileName}`);
      } else {
        seen.set(entry.slug, fileName);
      }
    } catch (error) {
      issues.push(errorMessage(error));
    }
  }

  return issues;
}

export async function validateContent(): Promise<string[]> {
  const [docsIssues, devlogIssues] = await Promise.all([
    validateDir(path.join(CONTENT_ROOT, 'docs'), parseDocFile),
    validateDir(path.join(CONTENT_ROOT, 'devlog'), parseDevlogFile),
  ]);

  return [...docsIssues, ...devlogIssues];
}
