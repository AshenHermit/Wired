import {
  BadRequestException,
  HttpException,
  HttpStatus,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PassThrough } from 'stream';
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { RuntimeAuthGuard } from '../guards/runtime-auth.guard';
import { ArtifactBuildRateLimiter } from '../publish/artifact-build.rate-limiter';
import { PackageDeliveryController } from './package-delivery.controller';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';

describe('PackageDeliveryController runtime artifacts', () => {
  let delivery: Record<string, jest.Mock>;
  let readUrls: { verifyToken: jest.Mock };
  let buildLimiter: { assertAllowed: jest.Mock };
  let response: Response & { set: jest.Mock };
  let controller: PackageDeliveryController;

  beforeEach(() => {
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
    controller = new PackageDeliveryController(
      delivery as unknown as PackageDeliveryService,
      readUrls as unknown as PackageReadUrlService,
      buildLimiter as unknown as ArtifactBuildRateLimiter,
    );
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

describe('PackageDeliveryController runtime endpoint authorization', () => {
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
      controllers: [PackageDeliveryController],
      providers: [
        { provide: PackageDeliveryService, useValue: delivery },
        {
          provide: PackageReadUrlService,
          useValue: { verifyToken: () => true },
        },
        { provide: getRepositoryToken(Room), useValue: rooms },
        { provide: getRepositoryToken(ScriptingPackage), useValue: packages },
        {
          provide: ArtifactBuildRateLimiter,
          useValue: { assertAllowed: jest.fn() },
        },
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
