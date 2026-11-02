import {
  BadRequestException,
  HttpException,
  HttpStatus,
  INestApplication,
  NotFoundException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
} from '@wired-io/shared';
import { PassThrough } from 'stream';
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { RuntimeAuthGuard } from './guards/runtime-auth.guard';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { createValidationPipe } from 'src/common/validation';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { User } from 'src/database/entities/user.entity';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';
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
  let buildLimiter: { assertAllowed: jest.Mock };
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
    buildLimiter = { assertAllowed: jest.fn() };
    response = Object.assign(new PassThrough(), {
      set: jest.fn(),
    }) as unknown as Response & { set: jest.Mock };
    controller = new ScriptingPackagesController(
      packagesService as unknown as ScriptingPackagesService,
      revisionsService as unknown as PackageRevisionsService,
      delivery as unknown as PackageDeliveryService,
      readUrls as unknown as PackageReadUrlService,
      buildLimiter as unknown as ArtifactBuildRateLimiter,
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
      slug: 'hero',
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
      controller.runtimeFile(
        5,
        3,
        ['a.gd'],
        8,
        'k'.repeat(64),
        'bad',
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('rejects a runtime file without a token', async () => {
    await expect(
      controller.runtimeFile(
        5,
        3,
        ['a.gd'],
        7,
        'k'.repeat(64),
        undefined as never,
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(readUrls.verifyToken).not.toHaveBeenCalled();
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('rejects a runtime file without an artifact key', async () => {
    await expect(
      controller.runtimeFile(5, 3, ['a.gd'], 7, '', 'good', response),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('streams a runtime file for a valid token', async () => {
    await controller.runtimeFile(
      5,
      3,
      ['a.gd'],
      7,
      'k'.repeat(64),
      'good',
      response,
    );

    expect(readUrls.verifyToken).toHaveBeenCalledWith('good', {
      roomId: 7,
      packageId: 5,
      revision: 3,
    });
    expect(delivery.resolveRuntimeFile).toHaveBeenCalledWith(
      5,
      3,
      7,
      'k'.repeat(64),
      'a.gd',
    );
    expect(response.set).toHaveBeenCalledWith({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '3',
      'Cache-Control': 'no-store',
    });
  });

  it('rate-limits artifact builds before touching the delivery service', async () => {
    buildLimiter.assertAllowed.mockImplementation(() => {
      throw new HttpException(
        'artifact_build_rate_limited',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });

    await expect(controller.runtimeManifest(5, 3, 7)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(buildLimiter.assertAllowed).toHaveBeenCalledWith(5, 3, 7);
    expect(delivery.getRuntimeManifest).not.toHaveBeenCalled();
  });

  it('passes the artifact identity to the rate limiter', async () => {
    delivery.getRuntimeManifest.mockResolvedValue({ packageId: 5 });

    await controller.runtimeManifest(5, 3, 7);

    expect(buildLimiter.assertAllowed).toHaveBeenCalledWith(5, 3, 7);
    expect(delivery.getRuntimeManifest).toHaveBeenCalledWith(5, 3, 7);
  });

  it('returns a controlled 404 when the runtime file vanished before streaming', async () => {
    delivery.resolveRuntimeFile.mockResolvedValueOnce({
      path: path.join(tmpdir(), `wired-missing-${randomUUID()}.bin`),
      size: 3,
    });

    await expect(
      controller.runtimeFile(
        5,
        3,
        ['a.gd'],
        7,
        'k'.repeat(64),
        'good',
        response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ScriptingPackagesController runtime endpoint authorization', () => {
  const roomId = 7;
  const packageId = 5;
  const revision = 3;
  const artifactKey = 'k'.repeat(64);

  let app: INestApplication;
  let authenticatedUser: { id: number } | null;
  let delivery: {
    getRuntimeManifest: jest.Mock;
    resolveRuntimeFile: jest.Mock;
  };
  let rooms: { findOne: jest.Mock };
  let packages: { findOne: jest.Mock };

  beforeAll(async () => {
    delivery = {
      getRuntimeManifest: jest.fn(() =>
        Promise.resolve({
          packageId,
          revision,
          roomId,
        }),
      ),
      resolveRuntimeFile: jest.fn(() =>
        Promise.resolve({
          path: __filename,
          size: 3,
        }),
      ),
    };
    rooms = {
      findOne: jest.fn((options: { where: { id: number } }) =>
        Promise.resolve(
          options.where.id === roomId
            ? { id: roomId, author: { id: 42 }, contributors: [] }
            : null,
        ),
      ),
    };
    packages = {
      findOne: jest.fn((options: { where: { id: number } }) =>
        Promise.resolve(
          options.where.id === packageId
            ? { id: packageId, room: { id: roomId } }
            : null,
        ),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ScriptingPackagesController],
      providers: [
        {
          provide: ScriptingPackagesService,
          useValue: { assertPackageEditing: jest.fn() },
        },
        {
          provide: PackageRevisionsService,
          useValue: {
            getManifest: jest.fn(),
            getManifestForRevision: jest.fn(),
          },
        },
        { provide: PackageDeliveryService, useValue: delivery },
        {
          provide: PackageReadUrlService,
          useValue: { verifyToken: () => true },
        },
        { provide: getRepositoryToken(Room), useValue: rooms },
        { provide: getRepositoryToken(ScriptingPackage), useValue: packages },
      ],
    })
      .overrideGuard(RuntimeAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => { user?: unknown };
          };
        }) => {
          if (!authenticatedUser) {
            throw new UnauthorizedException();
          }
          context.switchToHttp().getRequest().user = authenticatedUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authenticatedUser = { id: 42 };
  });

  const manifestUrl = `/scripting-packages/${packageId}/revisions/${revision}/runtime-manifest?room=${roomId}`;
  const fileUrl = `/scripting-packages/${packageId}/revisions/${revision}/runtime-files/a.gd?room=${roomId}&key=${artifactKey}&token=good`;

  it('rejects an anonymous runtime manifest with 401', async () => {
    authenticatedUser = null;

    await request(app.getHttpServer()).get(manifestUrl).expect(401);
    expect(delivery.getRuntimeManifest).not.toHaveBeenCalled();
  });

  it('rejects an anonymous runtime file with 401', async () => {
    authenticatedUser = null;

    await request(app.getHttpServer()).get(fileUrl).expect(401);
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('rejects a non-member runtime manifest with 403', async () => {
    authenticatedUser = { id: 99 };

    await request(app.getHttpServer()).get(manifestUrl).expect(403);
    expect(delivery.getRuntimeManifest).not.toHaveBeenCalled();
  });

  it('rejects a non-member runtime file with 403', async () => {
    authenticatedUser = { id: 99 };

    await request(app.getHttpServer()).get(fileUrl).expect(403);
    expect(delivery.resolveRuntimeFile).not.toHaveBeenCalled();
  });

  it('rejects a package that is not attached to the requested room', async () => {
    packages.findOne.mockResolvedValueOnce({
      id: packageId,
      room: { id: roomId + 1 },
    });

    await request(app.getHttpServer()).get(manifestUrl).expect(403);
    expect(delivery.getRuntimeManifest).not.toHaveBeenCalled();
  });

  it('serves the runtime manifest to a room member', async () => {
    await request(app.getHttpServer()).get(manifestUrl).expect(200);

    expect(delivery.getRuntimeManifest).toHaveBeenCalledWith(
      packageId,
      revision,
      roomId,
    );
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
      {} as never,
      {} as never,
    );
  });

  it('delegates slug availability to the service', async () => {
    await expect(controller.slugAvailability('hero')).resolves.toEqual({
      slug: 'hero',
      available: true,
    });
    expect(packagesService.checkSlugAvailability).toHaveBeenCalledWith('hero');
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
  let findOne: jest.Mock;
  let update: jest.Mock;
  let checkSlugAvailability: jest.Mock;

  beforeAll(async () => {
    findOne = jest.fn((id: number) => Promise.resolve({ id, slug: 'hero' }));
    update = jest.fn((id: number) => Promise.resolve({ id, slug: 'hero' }));
    checkSlugAvailability = jest.fn((slug: string) =>
      Promise.resolve({ slug, available: true }),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [ScriptingPackagesController],
      providers: [
        {
          provide: ScriptingPackagesService,
          useValue: {
            assertPackageEditing: jest.fn(),
            findOne,
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
        { provide: getRepositoryToken(Room), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(ScriptingPackage),
          useValue: { findOne: jest.fn() },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

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

    expect(checkSlugAvailability).toHaveBeenCalledWith('hero');
    expect(findOne).not.toHaveBeenCalled();
  });

  it('still parses numeric ids for the :id route', async () => {
    await request(app.getHttpServer()).get('/scripting-packages/7').expect(200);

    expect(findOne).toHaveBeenCalledWith(7);
  });

  it('rejects a slug field in PATCH through the global validation pipe', async () => {
    await request(app.getHttpServer())
      .patch('/scripting-packages/7')
      .send({ slug: 'other', name: 'Renamed' })
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
