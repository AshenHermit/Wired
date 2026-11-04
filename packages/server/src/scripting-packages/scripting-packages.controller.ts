import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'fs';
import {
  CreatePackageRevisionPayload,
  PackageRevision,
} from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { PackageRevisionsService } from './publish/package-revisions.service';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { UseAuthGuard, SilentAuth } from 'src/auth/auth-policy';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';
import { User } from 'src/database/entities/user.entity';
import { MAX_PACKAGE_FILE_SIZE } from './storage/package-manifest';

/**
 * Package authoring: the record itself, its draft and published revisions, and
 * the published files anyone can read.
 *
 * The other two capabilities that live under this prefix have their own
 * controllers — `WorkshopController` for browsing and copying, and
 * `PackageDeliveryController` for the signed runtime artifacts.
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

  @SilentAuth()
  @ApiOkResponse({ description: 'Latest published manifest' })
  @Get(':id/manifest')
  async getManifest(
    @Req() req: SilentAuthRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.assertVisible(id, req.user);
    return this.revisionsService.getManifest(id);
  }

  @SilentAuth()
  @ApiOkResponse({ description: 'Manifest of an explicit revision' })
  @Get(':id/revisions/:revision/manifest')
  async getRevisionManifest(
    @Req() req: SilentAuthRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
  ) {
    await this.assertVisible(id, req.user);
    return this.revisionsService.getManifestForRevision(id, revision);
  }

  @SilentAuth()
  @ApiOkResponse({
    description: 'Raw contents of a published revision file',
    schema: { type: 'string', format: 'binary' },
  })
  @Get(':id/revisions/:revision/files/*path')
  async getRevisionFile(
    @Req() req: SilentAuthRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('path') path: string | string[],
  ): Promise<StreamableFile> {
    await this.assertVisible(id, req.user);
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

  /**
   * Refuses a package the caller may not see.
   *
   * Published files used to be served to anyone holding the id, so a private
   * room's package was readable while its metadata 404'd. Both now answer to
   * the same rule: a workshop package is open, a room package follows the
   * room's visibility.
   */
  private async assertVisible(
    packageId: number,
    user: User | null,
  ): Promise<void> {
    await this.packagesService.findVisibleOne(packageId, user);
  }
}
