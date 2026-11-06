import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { packageError } from '../package-errors';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'fs';
import { once } from 'events';
import { Response } from 'express';
import { PackageRuntimeManifest } from '@wired-io/shared';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';
import { RoomMembershipGuard } from '../guards/room-membership.guard';
import { RuntimeAuthGuard } from '../guards/runtime-auth.guard';
import { RoomTokenAuth } from 'src/auth/auth-policy';

/**
 * What the native Godot runtime and game clients read: one manifest per
 * (package, revision, room) plus the artifact files it names.
 *
 * Separate from the authoring controller because this half is readable by any
 * room member (a user JWT or the room's own service token) and never mutates
 * anything, while authoring is authenticated per package.
 */
@ApiTags('scripting-packages')
@Controller('scripting-packages')
export class PackageDeliveryController {
  constructor(
    private readonly delivery: PackageDeliveryService,
    private readonly readUrls: PackageReadUrlService,
    // Registered by ScriptingPackagesModule; a missing provider must fail at
    // boot rather than silently fall back to a second, unconfigured limiter.
    private readonly buildLimiter: ArtifactBuildRateLimiter,
  ) {}

  @RoomTokenAuth()
  @ApiOkResponse({ description: 'Signed runtime manifest for a room' })
  // `no-transform` keeps the Next.js dev proxy (and production proxies) from
  // gzipping this JSON. Godot's Web HTTPRequest receives an already-decoded
  // body but still sees `Content-Encoding: gzip` and fails to decompress it.
  @Header('Cache-Control', 'no-store, no-transform')
  // The membership guard is listed above the auth guard on purpose: decorators
  // apply bottom-up, so RuntimeAuthGuard is registered (and therefore runs)
  // first and `req.user` is populated before the membership lookup. The runtime
  // authenticates with a room-scoped service token, users with their JWT.
  @UseGuards(RoomMembershipGuard)
  @UseGuards(RuntimeAuthGuard)
  @ApiBearerAuth()
  @Get(':id/revisions/:revision/runtime-manifest')
  async runtimeManifest(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Query('room', ParseIntPipe) room: number,
  ): Promise<PackageRuntimeManifest> {
    // A manifest miss builds a whole artifact on disk, so throttle it per
    // (package, revision, room) before the service is allowed to build.
    this.buildLimiter.assertAllowed(id, revision, room);
    return this.delivery.getRuntimeManifest(id, revision, room);
  }

  @RoomTokenAuth()
  @ApiOkResponse({
    description: 'Raw contents of a runtime artifact file',
    schema: { type: 'string', format: 'binary' },
  })
  @UseGuards(RoomMembershipGuard)
  @UseGuards(RuntimeAuthGuard)
  @ApiBearerAuth()
  @Get(':id/revisions/:revision/runtime-files/*path')
  async runtimeFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('path') path: string | string[],
    @Query('room', ParseIntPipe) room: number,
    @Query('key') artifactKey: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    if (
      !token ||
      !this.readUrls.verifyToken(token, {
        roomId: room,
        packageId: id,
        revision,
      })
    ) {
      throw packageError(
        'package_read_token_invalid',
        'Package read token is invalid',
      );
    }
    if (!artifactKey) {
      throw packageError(
        'package_artifact_key_missing',
        'The artifact key is missing from the resolved closure',
      );
    }

    const filepath = Array.isArray(path) ? path.join('/') : path;
    const file = await this.delivery.resolveRuntimeFile({
      packageId: id,
      revision,
      roomId: room,
      artifactKey,
      filepath,
    });

    // `resolveRuntimeFile` stats the file, but pruning can delete it before the
    // stream opens. Wait for 'open' so that race is a controlled 404 instead of
    // an unhandled 'error' on a response that was never sent.
    const stream = createReadStream(file.path);
    try {
      await once(stream, 'open');
    } catch {
      stream.destroy();
      throw packageError(
        'package_artifact_file_missing',
        'The runtime artifact does not contain this file',
      );
    }

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
      'Cache-Control': 'no-store',
    });
    // The file can still disappear mid-stream; destroying the response is the
    // only correct answer once headers are on the wire.
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
