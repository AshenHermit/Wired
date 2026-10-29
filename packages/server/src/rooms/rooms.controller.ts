import {
  Body,
  Controller,
  Delete,
  Get,
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
import { UseAuthGuard, UseSilentAuthGuard } from 'src/auth/jwt-auth.guard';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @UseSilentAuthGuard()
  @ApiOkResponse({ type: [Room] })
  @Get()
  findAll(@Req() req: SilentAuthRequest) {
    return this.roomsService.findAll(req.user);
  }

  @UseSilentAuthGuard()
  @ApiOkResponse({ type: Room })
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: SilentAuthRequest,
  ) {
    return this.roomsService.findVisibleOne(id, req.user);
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
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoomDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.roomsService.assertRoomEditing(req.user, id);
    return await this.roomsService.update(id, dto);
  }

  @UseAuthGuard()
  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.roomsService.assertRoomEditing(req.user, id);
    return await this.roomsService.remove(id);
  }
}
