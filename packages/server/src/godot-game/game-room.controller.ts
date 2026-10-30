import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';
import { UseAuthGuard } from 'src/auth/jwt-auth.guard';
import { GameRoomService } from './game-room.service';

@ApiTags('game')
@UseAuthGuard()
@Controller('rooms/:roomId/game')
export class GameRoomController {
  constructor(private readonly gameRooms: GameRoomService) {}

  /**
   * Starts or reuses the room runtime and returns one-time connection material.
   * The client must request a fresh ticket for every connection attempt.
   */
  @Post('connection')
  connect(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gameRooms.connect(req.user, roomId);
  }

  /** Runtime and confirmed-player status; never starts the Godot process. */
  @Get('status')
  status(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gameRooms.getStatus(req.user, roomId);
  }

  /**
   * Latest published revision per package with separate runtime/client states.
   * Editors poll this to catch up on revisions they missed; it never starts
   * the runtime.
   */
  @Get('packages')
  packages(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gameRooms.getPackages(req.user, roomId);
  }
}
