import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { PackageWorkshopService } from './package-workshop.service';
import { WorkshopForkDto, WorkshopPublishDto } from './workshop.dto';
import { CopyToRoomDto } from './copy-to-room.dto';
import { Public, UseAuthGuard } from 'src/auth/auth-policy';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';

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
 * The public workshop: browsing published packages, and the copies that move
 * a published revision between a room and the workshop.
 *
 * Every copy runs server-side on the published revision; the source package is
 * never modified. Served under the same `scripting-packages` prefix as the
 * authoring routes, which is why this controller is registered before
 * `ScriptingPackagesController` — otherwise `workshop` would be parsed as an
 * `:id`.
 */
@ApiTags('scripting-packages')
@Controller('scripting-packages')
export class WorkshopController {
  constructor(private readonly workshopService: PackageWorkshopService) {}

  @Public()
  @ApiOkResponse({ description: 'Workshop packages' })
  @Get('workshop')
  list(
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
  lookup(@Query('slug') slug: string) {
    return this.workshopService.lookup(slug);
  }

  @Public()
  @ApiOkResponse({ description: 'Workshop tag usage' })
  @Get('workshop/tags')
  tags(
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
    @Body() dto: CopyToRoomDto,
  ) {
    return this.workshopService.copyToRoom(id, dto.roomId, req.user);
  }
}
