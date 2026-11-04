import {
  BadRequestException,
  INestApplication,
  StreamableFile,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
} from '@wired-io/shared';
import { Response } from 'express';
import request from 'supertest';
import { APP_GUARD } from '@nestjs/core';
import { createValidationPipe } from 'src/common/validation';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { User } from 'src/database/entities/user.entity';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { WorkshopController } from './workshop/workshop.controller';
import { PackageDeliveryController } from './delivery/package-delivery.controller';
import { ArtifactBuildRateLimiter } from './delivery/artifact-build.rate-limiter';
import { PackageDeliveryService } from './delivery/package-delivery.service';
import { PackageReadUrlService } from './delivery/package-read-url.service';
import { PackageRevisionsService } from './publish/package-revisions.service';
import { PackageWorkshopService } from './workshop/package-workshop.service';
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

  let packagesService: {
    assertPackageEditing: jest.Mock;
    assertPackagePublishing: jest.Mock;
    findVisibleOne: jest.Mock;
  };
  let revisionsService: Record<string, jest.Mock>;
  let controller: ScriptingPackagesController;

  beforeEach(() => {
    packagesService = {
      assertPackageEditing: jest.fn(),
      assertPackagePublishing: jest.fn(),
      findVisibleOne: jest.fn(),
    };
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
    controller = new ScriptingPackagesController(
      packagesService as unknown as ScriptingPackagesService,
      revisionsService as unknown as PackageRevisionsService,
    );
  });

  it('requires publishing rights before creating a draft revision', async () => {
    const payload = { files: [file] };

    await expect(controller.createRevision(request, 7, payload)).resolves.toBe(
      revision,
    );

    expect(packagesService.assertPackagePublishing).toHaveBeenCalledWith(
      user,
      7,
    );
    expect(packagesService.assertPackageEditing).not.toHaveBeenCalled();
    expect(revisionsService.createDraft).toHaveBeenCalledWith(7, payload);
  });

  it('requires publishing rights before uploading a revision file', async () => {
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

    expect(packagesService.assertPackagePublishing).toHaveBeenCalledWith(
      user,
      7,
    );
    expect(packagesService.assertPackageEditing).not.toHaveBeenCalled();
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

  it('requires publishing rights before publishing', async () => {
    await controller.publishRevision(request, 7, 2);

    expect(packagesService.assertPackagePublishing).toHaveBeenCalledWith(
      user,
      7,
    );
    expect(packagesService.assertPackageEditing).not.toHaveBeenCalled();
    expect(revisionsService.publish).toHaveBeenCalledWith(7, 2);
  });

  it('lists published revisions without publishing rights', async () => {
    await expect(
      controller.listRevisions({ user: null } as never, 7, undefined),
    ).resolves.toEqual([revision]);
    expect(packagesService.assertPackagePublishing).not.toHaveBeenCalled();
    expect(revisionsService.list).toHaveBeenCalledWith(7, {
      includeDrafts: false,
    });
  });

  it('treats includeDrafts=0 as a public listing', async () => {
    await expect(
      controller.listRevisions({ user: null } as never, 7, '0'),
    ).resolves.toEqual([revision]);
    expect(packagesService.assertPackagePublishing).not.toHaveBeenCalled();
    expect(revisionsService.list).toHaveBeenCalledWith(7, {
      includeDrafts: false,
    });
  });

  it('lists drafts only for users with publishing rights', async () => {
    await expect(controller.listRevisions(request, 7, '1')).resolves.toEqual([
      revision,
    ]);

    expect(packagesService.assertPackagePublishing).toHaveBeenCalledWith(
      user,
      7,
    );
    expect(packagesService.assertPackageEditing).not.toHaveBeenCalled();
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
      slug: 'hero',
      name: 'Hero',
      revision: 2,
      files: [file],
      totalSize: 3,
      publishedAt: '2026-10-29T00:00:00.000Z',
    };
    revisionsService.getManifest.mockResolvedValueOnce(manifest);

    await expect(controller.getManifest({ user: null } as never, 7)).resolves.toBe(manifest);
    expect(revisionsService.getManifest).toHaveBeenCalledWith(7);
    expect(packagesService.findVisibleOne).toHaveBeenCalledWith(7, null);
  });

  it('serves a manifest of an explicit revision', async () => {
    await controller.getRevisionManifest({ user: null } as never, 7, 2);
    expect(revisionsService.getManifestForRevision).toHaveBeenCalledWith(7, 2);
  });

  it('streams a published file as binary', async () => {
    const result = await controller.getRevisionFile({ user: null } as never, 7, 2, [
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
});

describe('ScriptingPackagesController lifecycle routes', () => {
  const user = { id: 11 } as User;
  const request = { user } as AuthenticatedRequest;
  let packagesService: {
    assertPackageEditing: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    checkSlugAvailability: jest.Mock;
  };
  let controller: ScriptingPackagesController;

  beforeEach(() => {
    packagesService = {
      assertPackageEditing: jest.fn(),
      update: jest.fn(async () => ({ id: 7 })),
      remove: jest.fn(async () => undefined),
      checkSlugAvailability: jest.fn(async (slug: string) => ({
        slug,
        available: true,
      })),
    };
    controller = new ScriptingPackagesController(
      packagesService as unknown as ScriptingPackagesService,
      {} as never,
    );
  });

  it('delegates slug availability to the service', async () => {
    await expect(controller.slugAvailability('hero')).resolves.toEqual({
      slug: 'hero',
      available: true,
    });
    expect(packagesService.checkSlugAvailability).toHaveBeenCalledWith(
      'hero',
      undefined,
      undefined,
    );
  });

  it('passes excludeId from the query', async () => {
    await controller.slugAvailability('hero', 3, 5);
    expect(packagesService.checkSlugAvailability).toHaveBeenCalledWith(
      'hero',
      3,
      5,
    );
  });

  it('passes slug and confirmSlugRename to the service', async () => {
    await controller.update(request, 5, {
      slug: 'hero2',
      confirmSlugRename: true,
    });
    expect(packagesService.update).toHaveBeenCalledWith(5, {
      slug: 'hero2',
      confirmSlugRename: true,
    });
  });

  it('checks editing rights before toggling a package', async () => {
    await expect(
      controller.update(request, 7, { enabled: false }),
    ).resolves.toEqual({ id: 7 });
    expect(packagesService.assertPackageEditing).toHaveBeenCalledWith(user, 7);
    expect(packagesService.update).toHaveBeenCalledWith(7, { enabled: false });
  });

  it('keeps a completed deletion successful when the dispatcher fails', async () => {
    await expect(controller.remove(7, request)).resolves.toBeUndefined();
    expect(packagesService.assertPackageEditing).toHaveBeenCalledWith(user, 7);
    expect(packagesService.remove).toHaveBeenCalledWith(7);
  });
});

describe('ScriptingPackagesController slug route ordering', () => {
  let app: INestApplication;
  let findVisibleOne: jest.Mock;
  let update: jest.Mock;
  let checkSlugAvailability: jest.Mock;
  let listWorkshop: jest.Mock;
  let lookupWorkshop: jest.Mock;
  let tagsWorkshop: jest.Mock;

  beforeAll(async () => {
    findVisibleOne = jest.fn((id: number) =>
      Promise.resolve({ id, slug: 'hero' }),
    );
    update = jest.fn((id: number) => Promise.resolve({ id, slug: 'hero' }));
    checkSlugAvailability = jest.fn((slug: string) =>
      Promise.resolve({ slug, available: true }),
    );
    listWorkshop = jest.fn(() => Promise.resolve({ items: [], total: 0 }));
    lookupWorkshop = jest.fn(() => Promise.resolve({ package: null }));
    tagsWorkshop = jest.fn(() => Promise.resolve({ items: [], total: 0 }));

    const moduleRef = await Test.createTestingModule({
      // The workshop routes live in their own controller, and this module test
      // exists to prove the registration order keeps them out of `:id`.
      controllers: [
        WorkshopController,
        PackageDeliveryController,
        ScriptingPackagesController,
      ],
      providers: [
        {
          provide: ScriptingPackagesService,
          useValue: {
            assertPackageEditing: jest.fn(),
            findVisibleOne,
            update,
            checkSlugAvailability,
          },
        },
        { provide: PackageRevisionsService, useValue: {} },
        { provide: PackageDeliveryService, useValue: {} },
        {
          provide: PackageReadUrlService,
          useValue: { verifyToken: () => true },
        },
        {
          provide: PackageWorkshopService,
          useValue: {
            list: listWorkshop,
            lookup: lookupWorkshop,
            tags: tagsWorkshop,
          },
        },
        { provide: getRepositoryToken(Room), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(ScriptingPackage),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: ArtifactBuildRateLimiter,
          useValue: { assertAllowed: jest.fn() },
        },
        {
          // The app authenticates through APP_GUARD; this module test only
          // exercises handler wiring, so the guard is stubbed open.
          provide: APP_GUARD,
          useValue: { canActivate: () => true },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves slug availability instead of falling through to :id', async () => {
    await request(app.getHttpServer())
      .get('/scripting-packages/slug-availability?slug=hero')
      .expect(200);

    expect(checkSlugAvailability).toHaveBeenCalledWith(
      'hero',
      undefined,
      undefined,
    );
    expect(findVisibleOne).not.toHaveBeenCalled();
  });

  it('passes the requested room to the availability check', async () => {
    await request(app.getHttpServer())
      .get('/scripting-packages/slug-availability?slug=hero&roomId=5')
      .expect(200);

    expect(checkSlugAvailability).toHaveBeenCalledWith('hero', 5, undefined);
  });

  it('passes the excluded package to the availability check', async () => {
    await request(app.getHttpServer())
      .get(
        '/scripting-packages/slug-availability?slug=hero&roomId=5&excludeId=7',
      )
      .expect(200);

    expect(checkSlugAvailability).toHaveBeenCalledWith('hero', 5, 7);
  });

  it('no longer serves the unauthenticated package collection', async () => {
    await request(app.getHttpServer()).get('/scripting-packages').expect(404);
  });

  it('still parses numeric ids for the :id route', async () => {
    await request(app.getHttpServer()).get('/scripting-packages/7').expect(200);

    expect(findVisibleOne).toHaveBeenCalledWith(7, undefined);
  });

  it('serves the workshop listing instead of falling through to :id', async () => {
    await request(app.getHttpServer())
      .get('/scripting-packages/workshop?q=hero&limit=5&offset=10')
      .expect(200);

    expect(listWorkshop).toHaveBeenCalledWith({
      q: 'hero',
      limit: 5,
      offset: 10,
    });
    expect(findVisibleOne).not.toHaveBeenCalled();
  });

  it('serves the workshop lookup instead of falling through to :id', async () => {
    await request(app.getHttpServer())
      .get('/scripting-packages/workshop/lookup?slug=hero')
      .expect(200);

    expect(lookupWorkshop).toHaveBeenCalledWith('hero');
    expect(findVisibleOne).not.toHaveBeenCalled();
  });

  it('serves workshop tags instead of falling through to :id', async () => {
    await request(app.getHttpServer())
      .get('/scripting-packages/workshop/tags?q=hero&limit=5')
      .expect(200);

    expect(tagsWorkshop).toHaveBeenCalledWith({
      q: 'hero',
      limit: 5,
      offset: undefined,
    });
    expect(findVisibleOne).not.toHaveBeenCalled();
  });

  it('treats blank limit and offset as absent', async () => {
    await request(app.getHttpServer())
      .get('/scripting-packages/workshop?limit=&offset=%20')
      .expect(200);

    expect(listWorkshop).toHaveBeenCalledWith({
      q: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('accepts a slug field in PATCH', async () => {
    await request(app.getHttpServer())
      .patch('/scripting-packages/7')
      .send({ slug: 'other', confirmSlugRename: true, name: 'Renamed' })
      .expect(200);

    expect(update).toHaveBeenCalledWith(7, {
      slug: 'other',
      confirmSlugRename: true,
      name: 'Renamed',
    });
  });

  it('rejects a non-string slug in PATCH', async () => {
    await request(app.getHttpServer())
      .patch('/scripting-packages/7')
      .send({ slug: 5 })
      .expect(400);

    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a PATCH without slug', async () => {
    await request(app.getHttpServer())
      .patch('/scripting-packages/7')
      .send({ name: 'Renamed' })
      .expect(200);

    expect(update).toHaveBeenCalledWith(7, { name: 'Renamed' });
  });
});
