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
import { Room } from 'src/database/entities/room.entity';
import { RoomsService } from './rooms.service';
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
}
