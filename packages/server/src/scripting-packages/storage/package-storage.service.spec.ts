import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import { PackagePathError } from './package-path';
import { sha256Hex } from './package-hash';
import { PackageStorageService } from './package-storage.service';
import { rewriteSlugReferences } from './package-slug-rewrite';

const entry = (filepath: string, data: Buffer): PackageFileEntry => ({
  filepath,
  size: data.byteLength,
  sha256: sha256Hex(data),
});

describe('PackageStorageService', () => {
  let root: string;
  let storage: PackageStorageService;
  const commit = jest.fn(async () => undefined);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wired-packages-'));
    storage = new PackageStorageService({
      storage: { packagesFilesDir: root, dir: root },
    } as unknown as AppConfigService);
    commit.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('draft files', () => {
    it('writes nested files and reports their real size and sha256', async () => {
      const data = Buffer.from('extends Node\n');

      const result = await storage.saveDraftFile(7, 1, 'scripts/hero.gd', data);

      expect(result).toEqual({
        size: data.byteLength,
        sha256: sha256Hex(data),
      });
      expect(storage.draftRevisionDir(7, 1)).toBe(
        path.join(root, '7', 'drafts', '1'),
      );
      expect(
        readFileSync(
          path.join(storage.draftRevisionDir(7, 1), 'scripts', 'hero.gd'),
        ),
      ).toEqual(data);
      await expect(storage.listDraftFiles(7, 1)).resolves.toEqual([
        'scripts/hero.gd',
      ]);
    });

    it('refuses to write outside the revision directory', async () => {
      await expect(
        storage.saveDraftFile(7, 1, '../escape.gd', Buffer.from('x')),
      ).rejects.toThrow(PackagePathError);
      await expect(
        storage.saveDraftFile(7, 1, '/etc/passwd', Buffer.from('x')),
      ).rejects.toThrow(PackagePathError);
    });

    it('reads a stored draft file as text', async () => {
      await storage.saveDraftFile(
        7,
        1,
        'scripts/hero.gd',
        Buffer.from('extends Node\n'),
      );

      await expect(storage.readDraftFile(7, 1, 'scripts/hero.gd')).resolves.toBe(
        'extends Node\n',
      );
    });

    it('rejects reading a draft file that was never uploaded', async () => {
      await expect(
        storage.readDraftFile(7, 1, 'scripts/missing.gd'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('publishRevision', () => {
    it('publishes a revision only when every declared file is present', async () => {
      const hero = Buffer.from('hero');
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'hero.gd', hero);

      await expect(
        storage.publishRevision(
          7,
          1,
          [entry('hero.gd', hero), entry('a.txt', data)],
          commit,
        ),
      ).rejects.toThrow(/missing/i);
      expect(commit).not.toHaveBeenCalled();
    });

    it('rejects a file whose sha256 does not match the manifest', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);

      await expect(
        storage.publishRevision(
          7,
          1,
          [
            {
              filepath: 'a.txt',
              size: data.byteLength,
              sha256: 'c'.repeat(64),
            },
          ],
          commit,
        ),
      ).rejects.toThrow(/sha-?256/i);
      expect(commit).not.toHaveBeenCalled();
    });

    it('rejects a file whose size does not match the manifest', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);

      await expect(
        storage.publishRevision(
          7,
          1,
          [
            {
              filepath: 'a.txt',
              size: data.byteLength + 1,
              sha256: sha256Hex(data),
            },
          ],
          commit,
        ),
      ).rejects.toThrow(/size/i);
      expect(commit).not.toHaveBeenCalled();
    });

    it('rejects files that are not declared in the manifest', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.saveDraftFile(7, 1, 'stray.txt', Buffer.from('stray'));

      await expect(
        storage.publishRevision(7, 1, [entry('a.txt', data)], commit),
      ).rejects.toThrow(/unexpected|stray/i);
      expect(commit).not.toHaveBeenCalled();
    });

    it('rejects publishing a revision that was never uploaded', async () => {
      const data = Buffer.from('payload');

      await expect(
        storage.publishRevision(7, 1, [entry('a.txt', data)], commit),
      ).rejects.toThrow(BadRequestException);
      expect(commit).not.toHaveBeenCalled();
    });

    it('moves the draft into an immutable published revision', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'scenes/a.tscn', data);

      await storage.publishRevision(
        7,
        1,
        [entry('scenes/a.tscn', data)],
        commit,
      );

      expect(commit).toHaveBeenCalledTimes(1);
      await expect(
        storage.readPublishedFile(7, 1, 'scenes/a.tscn'),
      ).resolves.toEqual(data);
      await expect(
        readdirPromise(storage.draftRevisionDir(7, 1)),
      ).rejects.toThrow();
      await expect(
        storage.saveDraftFile(7, 1, 'scenes/a.tscn', Buffer.from('again')),
      ).resolves.toBeDefined();
    });

    it('refuses to overwrite an already published revision', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.publishRevision(7, 1, [entry('a.txt', data)], commit);
      await storage.saveDraftFile(7, 1, 'a.txt', data);

      await expect(
        storage.publishRevision(7, 1, [entry('a.txt', data)], commit),
      ).rejects.toThrow(ConflictException);
    });

    it('rolls back to a draft when the database commit fails', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      const failingCommit = jest.fn(async () => {
        throw new Error('db down');
      });

      await expect(
        storage.publishRevision(7, 1, [entry('a.txt', data)], failingCommit),
      ).rejects.toThrow('db down');

      await expect(storage.listDraftFiles(7, 1)).resolves.toEqual(['a.txt']);
      await expect(storage.readPublishedFile(7, 1, 'a.txt')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('published files', () => {
    it('never serves files that are outside the revision directory', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.publishRevision(7, 1, [entry('a.txt', data)], commit);

      await expect(
        storage.readPublishedFile(7, 1, '../../7/drafts/1/a.txt'),
      ).rejects.toThrow(PackagePathError);
      await expect(storage.readPublishedFile(7, 1, 'b.txt')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('discards only the requested draft directory', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.publishRevision(7, 1, [entry('a.txt', data)], commit);
      await storage.saveDraftFile(7, 2, 'a.txt', Buffer.from('v2'));

      await storage.discardDraft(7, 2);

      await expect(storage.listDraftFiles(7, 2)).resolves.toEqual([]);
      await expect(storage.readPublishedFile(7, 1, 'a.txt')).resolves.toEqual(
        data,
      );
    });

    it('keeps other packages untouched', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.publishRevision(7, 1, [entry('a.txt', data)], commit);
      await storage.saveDraftFile(8, 1, 'b.txt', Buffer.from('other'));
      await storage.discardDraft(8, 1);

      await expect(storage.readPublishedFile(7, 1, 'a.txt')).resolves.toEqual(
        data,
      );
    });
  });

  describe('rewriteRevision', () => {
    it('rewrites a published revision and keeps a backup until finished', async () => {
      const original = Buffer.from('res://packages/old/a.gd');
      await storage.saveDraftFile(7, 1, 'a.gd', original);
      await storage.publishRevision(7, 1, [entry('a.gd', original)], commit);

      const files = await storage.rewriteRevision(
        7,
        1,
        'published',
        (filepath, data) => rewriteSlugReferences(filepath, data, 'old', 'new'),
      );

      expect(files).toEqual([
        entry('a.gd', Buffer.from('res://packages/new/a.gd')),
      ]);
      await expect(storage.readPublishedFile(7, 1, 'a.gd')).resolves.toEqual(
        Buffer.from('res://packages/new/a.gd'),
      );
      expect(
        existsSync(path.join(storage.packageRootDir(7), 'revisions', '1.old')),
      ).toBe(true);

      await storage.finishRewrite(7, 1, 'published');

      expect(
        existsSync(path.join(storage.packageRootDir(7), 'revisions', '1.old')),
      ).toBe(false);
    });

    it('returns null for a draft directory that was never uploaded', async () => {
      await expect(
        storage.rewriteRevision(7, 2, 'draft', (filepath, data) => data),
      ).resolves.toBeNull();
    });

    it('restores the original bytes when the rewrite is aborted', async () => {
      const original = Buffer.from('res://packages/old/a.gd');
      await storage.saveDraftFile(7, 3, 'a.gd', original);

      await storage.rewriteRevision(7, 3, 'draft', (filepath, data) =>
        rewriteSlugReferences(filepath, data, 'old', 'new'),
      );
      await storage.abortRewrite(7, 3, 'draft');

      await expect(storage.readDraftFile(7, 3, 'a.gd')).resolves.toBe(
        'res://packages/old/a.gd',
      );
    });

    it('restores a backup left behind by a crash before the commit', async () => {
      const original = Buffer.from('res://packages/old/a.gd');
      await storage.saveDraftFile(7, 4, 'a.gd', original);
      const dir = storage.draftRevisionDir(7, 4);
      renameSync(dir, `${dir}.old`);

      const files = await storage.rewriteRevision(
        7,
        4,
        'draft',
        (filepath, data) => rewriteSlugReferences(filepath, data, 'old', 'new'),
      );

      expect(files).toEqual([
        entry('a.gd', Buffer.from('res://packages/new/a.gd')),
      ]);
    });
  });

  describe('removePackage', () => {
    it('removes drafts, published revisions, pins and runtime artifacts', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.publishRevision(7, 1, [entry('a.txt', data)], commit);
      await storage.writePinnedDependencies(7, 1, new Map([[8, 2]]));
      await storage.saveDraftFile(7, 2, 'b.txt', Buffer.from('b'));
      await mkdir(path.join(root, '7', 'runtime', 'v1', '5', '1', 'k'), {
        recursive: true,
      });
      writeFileSync(
        path.join(root, '7', 'runtime', 'v1', '5', '1', 'k', 'main.gd'),
        'x',
      );

      await storage.removePackage(7);

      expect(existsSync(path.join(root, '7'))).toBe(false);
      await expect(storage.readPublishedFile(7, 1, 'a.txt')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('keeps other packages untouched', async () => {
      const data = Buffer.from('payload');
      await storage.saveDraftFile(7, 1, 'a.txt', data);
      await storage.publishRevision(7, 1, [entry('a.txt', data)], commit);
      await storage.saveDraftFile(8, 1, 'b.txt', Buffer.from('other'));

      await storage.removePackage(7);

      expect(existsSync(path.join(root, '8'))).toBe(true);
      await expect(storage.listDraftFiles(8, 1)).resolves.toEqual(['b.txt']);
    });

    it('is idempotent for a package without files', async () => {
      await expect(storage.removePackage(42)).resolves.toBeUndefined();
    });
  });

  it('writes a file into a directory that does not exist yet', async () => {
    await mkdir(path.join(root, '7'), { recursive: true });
    writeFileSync(path.join(root, '7', 'keep.txt'), 'keep');

    await storage.saveDraftFile(7, 3, 'deep/a/b/c.txt', Buffer.from('x'));

    expect(readFileSync(path.join(root, '7', 'keep.txt'), 'utf8')).toBe('keep');
  });
});

function readdirPromise(dir: string) {
  return readdir(dir);
}
