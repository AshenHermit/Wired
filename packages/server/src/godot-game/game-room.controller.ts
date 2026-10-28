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
import { UseAuthQuard } from 'src/auth/jwt-auth.guard';
import { GameRoomService } from './game-room.service';

@ApiTags('game')
@UseAuthQuard()
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
}
