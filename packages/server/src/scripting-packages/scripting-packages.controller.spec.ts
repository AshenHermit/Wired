import {
  BadRequestException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
} from '@wired-io/shared';
import { PassThrough } from 'stream';
import { Response } from 'express';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';
import { User } from 'src/database/entities/user.entity';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageRevisionsService } from './package-revisions.service';
import { ScriptingPackagesService } from './scripting-packages.service';

describe('ScriptingPackagesController revisions API', () => {
  const user = { id: 11 } as User;
  const request = { user } as AuthenticatedRequest;
  const file: PackageFileEntry = {
    filepath: 'scripts/hero.gd',
    size: 3,
    sha256: 'a'.repeat(64),
  };
  const revision: PackageRevision = {
    packageId: 7,
    revision: 2,
    status: 'draft',
    files: [file],
    createdAt: '2026-10-29T00:00:00.000Z',
    publishedAt: null,
  };

  let packagesService: { assertPackageEditing: jest.Mock };
  let revisionsService: Record<string, jest.Mock>;
  let delivery: Record<string, jest.Mock>;
  let readUrls: { verifyToken: jest.Mock };
  let response: Response & { set: jest.Mock };
  let controller: ScriptingPackagesController;

  beforeEach(() => {
    packagesService = { assertPackageEditing: jest.fn() };
    revisionsService = {
      createDraft: jest.fn(async () => revision),
      uploadFile: jest.fn(async () => ({ size: 3, sha256: file.sha256 })),
      publish: jest.fn(async () => ({ ...revision, status: 'published' })),
      list: jest.fn(async () => [revision]),
      getManifest: jest.fn(),
      getManifestForRevision: jest.fn(),
      readPublishedFile: jest.fn(async () => Buffer.from('abc')),
      resolvePublishedFile: jest.fn(async () => ({
        path: __filename,
        size: 3,
      })),
    };
    delivery = {
      getRuntimeManifest: jest.fn(),
      resolveRuntimeFile: jest.fn(() =>
        Promise.resolve({ path: __filename, size: 3 }),
      ),
    };
    readUrls = { verifyToken: jest.fn(() => true) };
    response = Object.assign(new PassThrough(), {
      set: jest.fn(),
    }) as unknown as Response & { set: jest.Mock };
    controller = new ScriptingPackagesController(
      packagesService as unknown as ScriptingPackagesService,
      revisionsService as unknown as PackageRevisionsService,
      delivery as unknown as PackageDeliveryService,
      readUrls as unknown as PackageReadUrlService,
    );
  });

  it('requires editing rights before creating a draft revision', async () => {
    const payload = { files: [file] };

    await expect(controller.createRevision(request, 7, payload)).resolves.toBe(
      revision,
    );

    expect(packagesService.assertPackageEditing).toHaveBeenCalledWith(user, 7);
    expect(revisionsService.createDraft).toHaveBeenCalledWith(7, payload);
  });

  it('requires editing rights before uploading a revision file', async () => {
    const upload = {
      buffer: Buffer.from('abc'),
      size: 3,
      originalname: 'hero.gd',
    } as Express.Multer.File;

    await controller.uploadRevisionFile(
      request,
      7,
      2,
      ['scripts', 'hero.gd'],
      upload,
    );

    expect(packagesService.assertPackageEditing).toHaveBeenCalledWith(user, 7);
    expect(revisionsService.uploadFile).toHaveBeenCalledWith(
      7,
      2,
      'scripts/hero.gd',
      Buffer.from('abc'),
    );
  });

  it('rejects an upload without a file body', async () => {
    await expect(
      controller.uploadRevisionFile(
        request,
        7,
        2,
        ['a.txt'],
        undefined as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(revisionsService.uploadFile).not.toHaveBeenCalled();
  });

  it('requires editing rights before publishing', async () => {
    await controller.publishRevision(request, 7, 2);

    expect(packagesService.assertPackageEditing).toHaveBeenCalledWith(user, 7);
    expect(revisionsService.publish).toHaveBeenCalledWith(7, 2);
  });

  it('lists published revisions without editing rights', async () => {
    await expect(
      controller.listRevisions({ user: null } as never, 7, undefined),
    ).resolves.toEqual([revision]);
    expect(packagesService.assertPackageEditing).not.toHaveBeenCalled();
    expect(revisionsService.list).toHaveBeenCalledWith(7, {
      includeDrafts: false,
    });
  });

  it('treats includeDrafts=0 as a public listing', async () => {
    await expect(
      controller.listRevisions({ user: null } as never, 7, '0'),
    ).resolves.toEqual([revision]);
    expect(packagesService.assertPackageEditing).not.toHaveBeenCalled();
    expect(revisionsService.list).toHaveBeenCalledWith(7, {
      includeDrafts: false,
    });
  });

  it('lists drafts only for users with editing rights', async () => {
    await expect(controller.listRevisions(request, 7, '1')).resolves.toEqual([
      revision,
    ]);

    expect(packagesService.assertPackageEditing).toHaveBeenCalledWith(user, 7);
    expect(revisionsService.list).toHaveBeenCalledWith(7, {
      includeDrafts: true,
    });
  });

  it('refuses drafts for anonymous readers', async () => {
    await expect(
      controller.listRevisions({ user: null } as never, 7, '1'),
    ).rejects.toThrow('Authentication is required');
    expect(revisionsService.list).not.toHaveBeenCalled();
  });

  it('serves the latest published manifest', async () => {
    const manifest: PackageManifest = {
      packageId: 7,
      name: 'Hero',
      revision: 2,
      files: [file],
      totalSize: 3,
      publishedAt: '2026-10-29T00:00:00.000Z',
    };
    revisionsService.getManifest.mockResolvedValueOnce(manifest);

    await expect(controller.getManifest(7)).resolves.toBe(manifest);
    expect(revisionsService.getManifest).toHaveBeenCalledWith(7);
  });

  it('serves a manifest of an explicit revision', async () => {
    await controller.getRevisionManifest(7, 2);
    expect(revisionsService.getManifestForRevision).toHaveBeenCalledWith(7, 2);
  });

  it('streams a published file as binary', async () => {
    const result = await controller.getRevisionFile(7, 2, [
      'scripts',
      'hero.gd',
    ]);

    expect(revisionsService.resolvePublishedFile).toHaveBeenCalledWith(
      7,
      2,
      'scripts/hero.gd',
    );
    expect(result).toBeInstanceOf(StreamableFile);
    expect(result.getHeaders()).toMatchObject({
      type: 'application/octet-stream',
      length: 3,
    });
  });

  it('returns a signed runtime manifest for a published revision and room', async () => {
    delivery.getRuntimeManifest.mockResolvedValue({
      packageId: 5,
      revision: 3,
    });

    await expect(controller.runtimeManifest(5, 3, 7)).resolves.toMatchObject({
      packageId: 5,
    });
    expect(delivery.getRuntimeManifest).toHaveBeenCalledWith(5, 3, 7);
  });

  it('rejects a runtime file with a token for another room', async () => {
    readUrls.verifyToken.mockReturnValue(false);

    await expect(
      controller.runtimeFile(5, 3, ['a.gd'], 8, 'bad', response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('rejects a runtime file without a token', async () => {
    await expect(
      controller.runtimeFile(5, 3, ['a.gd'], 7, undefined as never, response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(readUrls.verifyToken).not.toHaveBeenCalled();
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('streams a runtime file for a valid token', async () => {
    await controller.runtimeFile(5, 3, ['a.gd'], 7, 'good', response);

    expect(readUrls.verifyToken).toHaveBeenCalledWith('good', {
      roomId: 7,
      packageId: 5,
      revision: 3,
    });
    expect(delivery.resolveRuntimeFile).toHaveBeenCalledWith(5, 3, 7, 'a.gd');
    expect(response.set).toHaveBeenCalledWith({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '3',
    });
  });
});
