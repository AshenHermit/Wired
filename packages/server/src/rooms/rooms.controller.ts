import {
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
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ForbiddenException } from '@nestjs/common';
import { Room } from 'src/database/entities/room.entity';
import { RoomsService } from './rooms.service';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from 'src/config/config';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomAccessDto } from './dto/update-room-access.dto';
import { UseAuthGuard, SilentAuth } from 'src/auth/auth-policy';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @SilentAuth()
  @ApiOkResponse({ type: [Room] })
  @Get()
  findAll(@Req() req: SilentAuthRequest) {
    return this.roomsService.findAll(req.user);
  }

  @SilentAuth()
  @ApiOkResponse({ type: Room })
  @Get(':roomId')
  findOne(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Req() req: SilentAuthRequest,
  ) {
    return this.roomsService.findVisibleOne(roomId, req.user);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: Room })
  @Post()
  async create(@Body() dto: CreateRoomDto, @Req() req: AuthenticatedRequest) {
    await this.roomsService.assertRoomCreation(req.user, dto);
    return await this.roomsService.create(dto, req.user);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: Room })
  @Patch(':roomId')
  async update(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Body() dto: UpdateRoomDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.roomsService.assertRoomEditing(req.user, roomId);
    return await this.roomsService.update(roomId, dto);
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: Room })
  @Patch(':roomId/access')
  async updateAccess(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Body() dto: UpdateRoomAccessDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.roomsService.assertRoomAccessEditing(req.user, roomId);
    return await this.roomsService.updateAccess(roomId, dto, req.user);
  }

  @UseAuthGuard()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':roomId')
  async remove(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.roomsService.assertRoomEditing(req.user, roomId);
    await this.roomsService.remove(roomId);
  }

  @UseAuthGuard()
  @Post(':roomId/state/cleanup')
  async cleanupState(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Body() body: { scope: 'self' | 'all-players' | 'dynamic' },
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const room = await this.roomsService.findOne(roomId);
    const isOwner = room.author?.id === req.user.id;
    const scope = body?.scope;
    if (scope !== 'self' && !isOwner) {
      throw new ForbiddenException('Only room author can clear all data');
    }
    const stateDir = config().godotRuntime.stateDir;
    const file = join(stateDir, String(roomId), 'state.json');
    if (!existsSync(file)) return;
    let data: any = {};
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (scope === 'self') {
      if (Array.isArray(data.players)) {
        data.players = data.players.filter((p: any) => p.account_id !== req.user.id);
      }
    } else if (scope === 'all-players') {
      data.players = [];
    } else if (scope === 'dynamic') {
      data.dynamic_world = [];
    }
    mkdirSync(join(stateDir, String(roomId)), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  }
}
