import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'fs';
import { once } from 'events';
import { Response } from 'express';
import {
  CreatePackageRevisionPayload,
  PackageRevision,
  PackageRuntimeManifest,
} from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { PackageRevisionsService } from './package-revisions.service';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageWorkshopService } from './package-workshop.service';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import {
  WorkshopForkDto,
  WorkshopPublishDto,
} from './dto/workshop.dto';
import { RoomCopyDto } from './dto/room-copy.dto';
import { UseAuthGuard, SilentAuth, Public } from 'src/auth/auth-policy';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';
import { MAX_PACKAGE_FILE_SIZE } from './package-manifest';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';
import { RoomMembershipGuard } from './guards/room-membership.guard';
import { RuntimeAuthGuard } from './guards/runtime-auth.guard';

/**
 * `?limit=` (blank) reaches the handler as an empty string and `Number('')` is
 * `0`, which would silently become page size 1 instead of the documented
 * default. A repeated parameter (`?limit=1&limit=2`) arrives as an array; both
 * are treated as "not given".
 */
function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return Number(value.trim());
}

/**
 * Package authoring, revisions, workshop copies and runtime delivery.
 *
 * Path parameters: `:id` is always the package, `:roomId` would be a room path
 * segment (none here). Room scope arrives as `?room=` on the runtime routes and
 * as `roomId` in request bodies; `?room` is a frozen wire contract read by the
 * Godot runtime, so it keeps the short name.
 */
@ApiTags('scripting-packages')
@Controller('scripting-packages')
export class ScriptingPackagesController {
  constructor(
    private readonly packagesService: ScriptingPackagesService,
    private readonly revisionsService: PackageRevisionsService,
    private readonly delivery: PackageDeliveryService,
    private readonly readUrls: PackageReadUrlService,
    private readonly workshopService: PackageWorkshopService,
    // Registered by ScriptingPackagesModule; a missing provider must fail at
    // boot rather than silently fall back to a second, unconfigured limiter.
    private readonly buildLimiter: ArtifactBuildRateLimiter,
  ) {}

  // Declared before `:id` so `slug-availability` is not parsed as an id.
  @UseAuthGuard()
  @ApiOkResponse({ description: 'Package slug availability' })
  @Get('slug-availability')
  slugAvailability(
    @Query('slug') slug: string,
    @Query('roomId', new ParseIntPipe({ optional: true })) roomId?: number,
    @Query('excludeId', new ParseIntPipe({ optional: true }))
    excludeId?: number,
  ) {
    return this.packagesService.checkSlugAvailability(slug, roomId, excludeId);
  }

  @Public()
  @ApiOkResponse({ description: 'Workshop packages' })
  @Get('workshop')
  workshop(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.workshopService.list({
      q,
      limit: parseOptionalNumber(limit),
      offset: parseOptionalNumber(offset),
    });
  }

  @Public()
  @ApiOkResponse({ description: 'Workshop package by slug' })
  @Get('workshop/lookup')
  workshopLookup(@Query('slug') slug: string) {
    return this.workshopService.lookup(slug);
  }

  @Public()
  @ApiOkResponse({ description: 'Workshop tag usage' })
  @Get('workshop/tags')
  workshopTags(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.workshopService.tags({
      q,
      limit: parseOptionalNumber(limit),
      offset: parseOptionalNumber(offset),
    });
  }

  // --- Workshop copies -----------------------------------------------------
  // All three copy a published revision server-side; the source package is
  // never modified.

  @UseAuthGuard()
  @ApiOkResponse({ description: 'Published or updated workshop record' })
  @Post(':id/workshop')
  publishToWorkshop(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WorkshopPublishDto,
  ) {
    return this.workshopService.publishToWorkshop(id, req.user, dto);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Post(':id/workshop-fork')
  forkToWorkshop(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WorkshopForkDto,
  ) {
    return this.workshopService.forkToWorkshop(id, req.user, dto.slug);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Post(':id/room-copy')
  copyToRoom(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RoomCopyDto,
  ) {
    return this.workshopService.addToRoom(id, dto.roomId, req.user);
  }

  @SilentAuth()
  @ApiOkResponse({ type: ScriptingPackage })
  @Get(':id')
  findOne(
    @Req() req: SilentAuthRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.packagesService.findVisibleOne(id, req.user);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Post()
  async create(
    @Body() dto: CreateScriptingPackageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // The author is always the authenticated user; creating a package for
    // someone else is not expressible.
    return await this.packagesService.create(dto, req.user);
  }

  // --- Package revisions ---------------------------------------------------
  // Draft revisions are written file by file, published revision files are
  // immutable and readable by the Godot server and game clients over HTTP.

  @UseAuthGuard()
  @ApiOkResponse({ description: 'Draft revision' })
  @Post(':id/revisions')
  async createRevision(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: CreatePackageRevisionPayload,
  ): Promise<PackageRevision> {
    await this.packagesService.assertPackagePublishing(req.user, id);
    return await this.revisionsService.createDraft(id, payload);
  }

  @SilentAuth()
  @ApiOkResponse({ description: 'Package revisions' })
  @Get(':id/revisions')
  async listRevisions(
    @Req() req: SilentAuthRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query('includeDrafts') includeDraftsParam?: string,
  ) {
    const includeDrafts =
      includeDraftsParam === '1' || includeDraftsParam === 'true';
    if (includeDrafts) {
      if (!req.user) {
        throw new UnauthorizedException(
          'Authentication is required to list draft revisions',
        );
      }
      await this.packagesService.assertPackagePublishing(req.user, id);
    }
    return this.revisionsService.list(id, { includeDrafts });
  }

  @UseAuthGuard()
  @ApiOkResponse({ description: 'Updated draft revision' })
  @Post(':id/revisions/:revision/files/*path')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PACKAGE_FILE_SIZE } }),
  )
  async uploadRevisionFile(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('path') path: string | string[],
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.packagesService.assertPackagePublishing(req.user, id);
    if (!file || !file.buffer) {
      throw new BadRequestException('Package file body is required');
    }
    return await this.revisionsService.uploadFile(
      id,
      revision,
      Array.isArray(path) ? path.join('/') : path,
      file.buffer,
    );
  }

  @UseAuthGuard()
  @ApiOkResponse({ description: 'Published revision' })
  @Post(':id/revisions/:revision/publish')
  async publishRevision(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
  ): Promise<PackageRevision> {
    await this.packagesService.assertPackagePublishing(req.user, id);
    return await this.revisionsService.publish(id, revision);
  }

  @Public()
  @ApiOkResponse({ description: 'Latest published manifest' })
  @Get(':id/manifest')
  getManifest(@Param('id', ParseIntPipe) id: number) {
    return this.revisionsService.getManifest(id);
  }

  @Public()
  @ApiOkResponse({ description: 'Manifest of an explicit revision' })
  @Get(':id/revisions/:revision/manifest')
  getRevisionManifest(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
  ) {
    return this.revisionsService.getManifestForRevision(id, revision);
  }

  @Public()
  @ApiOkResponse({
    description: 'Raw contents of a published revision file',
    schema: { type: 'string', format: 'binary' },
  })
  @Get(':id/revisions/:revision/files/*path')
  async getRevisionFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('path') path: string | string[],
  ): Promise<StreamableFile> {
    const file = await this.revisionsService.resolvePublishedFile(
      id,
      revision,
      Array.isArray(path) ? path.join('/') : path,
    );
    // Stream from disk instead of buffering the (up to 64 MB) file in memory.
    const stream = createReadStream(file.path);
    // The file can disappear between stat and open; without a listener that
    // ENOENT becomes an unhandled 'error' event and takes down the process.
    stream.on('error', () => stream.destroy());
    return new StreamableFile(stream, {
      type: 'application/octet-stream',
      length: file.size,
    });
  }

  @Public()
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

  @Public()
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
      throw new UnauthorizedException('package_read_token_invalid');
    }
    if (!artifactKey) {
      throw new BadRequestException('package_artifact_key_missing');
    }

    const filepath = Array.isArray(path) ? path.join('/') : path;
    const file = await this.delivery.resolveRuntimeFile(
      id,
      revision,
      room,
      artifactKey,
      filepath,
    );

    // `resolveRuntimeFile` stats the file, but pruning can delete it before the
    // stream opens. Wait for 'open' so that race is a controlled 404 instead of
    // an unhandled 'error' on a response that was never sent.
    const stream = createReadStream(file.path);
    try {
      await once(stream, 'open');
    } catch {
      stream.destroy();
      throw new NotFoundException('package_artifact_file_missing');
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

  @UseAuthGuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateScriptingPackageDto,
  ) {
    await this.packagesService.assertPackageEditing(req.user, id);
    return await this.packagesService.update(id, dto);
  }

  @UseAuthGuard()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.packagesService.assertPackageEditing(req.user, id);
    await this.packagesService.remove(id);
  }
}
