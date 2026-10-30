import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'fs';
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
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { UseAuthGuard, UseSilentAuthGuard } from 'src/auth/jwt-auth.guard';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';
import { MAX_PACKAGE_FILE_SIZE } from './package-manifest';

@ApiTags('scripting-packages')
@Controller('scripting-packages')
export class ScriptingPackagesController {
  constructor(
    private readonly packagesService: ScriptingPackagesService,
    private readonly revisionsService: PackageRevisionsService,
    private readonly delivery: PackageDeliveryService,
    private readonly readUrls: PackageReadUrlService,
  ) {}

  @ApiOkResponse({ type: [ScriptingPackage] })
  @Get()
  findAll() {
    return this.packagesService.findAll();
  }

  @ApiOkResponse({ type: ScriptingPackage })
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.packagesService.findOne(id);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Post()
  async create(
    @Body() dto: CreateScriptingPackageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    this.packagesService.assertPackageCreation(req.user, dto);
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
    await this.packagesService.assertPackageEditing(req.user, id);
    return await this.revisionsService.createDraft(id, payload);
  }

  @UseSilentAuthGuard()
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
      await this.packagesService.assertPackageEditing(req.user, id);
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
    await this.packagesService.assertPackageEditing(req.user, id);
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
    await this.packagesService.assertPackageEditing(req.user, id);
    return await this.revisionsService.publish(id, revision);
  }

  @ApiOkResponse({ description: 'Latest published manifest' })
  @Get(':id/manifest')
  getManifest(@Param('id', ParseIntPipe) id: number) {
    return this.revisionsService.getManifest(id);
  }

  @ApiOkResponse({ description: 'Manifest of an explicit revision' })
  @Get(':id/revisions/:revision/manifest')
  getRevisionManifest(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
  ) {
    return this.revisionsService.getManifestForRevision(id, revision);
  }

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

  @ApiOkResponse({ description: 'Signed runtime manifest for a room' })
  @Get(':id/revisions/:revision/runtime-manifest')
  async runtimeManifest(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Query('room', ParseIntPipe) room: number,
  ): Promise<PackageRuntimeManifest> {
    return this.delivery.getRuntimeManifest(id, revision, room);
  }

  @ApiOkResponse({
    description: 'Raw contents of a runtime artifact file',
    schema: { type: 'string', format: 'binary' },
  })
  @Get(':id/revisions/:revision/runtime-files/*path')
  async runtimeFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('path') path: string | string[],
    @Query('room', ParseIntPipe) room: number,
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

    const filepath = Array.isArray(path) ? path.join('/') : path;
    const file = await this.delivery.resolveRuntimeFile(
      id,
      revision,
      room,
      filepath,
    );

    // Stream from disk instead of buffering the file in memory. A file can
    // disappear between stat and open, so destroy the response on stream
    // error rather than leaving the client hanging on an unhandled 'error'.
    const stream = createReadStream(file.path);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
    });
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
  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.packagesService.assertPackageEditing(req.user, id);
    return await this.packagesService.remove(id);
  }
}
