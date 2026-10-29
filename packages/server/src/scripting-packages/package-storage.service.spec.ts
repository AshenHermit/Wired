import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import { PackagePathError } from './package-path';
import { sha256Hex } from './package-hash';
import { PackageStorageService } from './package-storage.service';

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
