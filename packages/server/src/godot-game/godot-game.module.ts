import { Module } from '@nestjs/common';
import { AppConfigModule } from 'src/config/config.module';
import { RoomsModule } from 'src/rooms/rooms.module';
import { GameExportController } from './game-export.controller';
import { GameRoomController } from './game-room.controller';
import { GameRoomTicketRateLimiter } from './game-room.rate-limiter';
import { GameRoomService } from './game-room.service';
import { GameTicketService } from './game-ticket.service';
import { NodeRuntimeProcessFactory } from './node-runtime-process.factory';
import { RoomRuntimeService } from './room-runtime.service';
import { RuntimeProcessFactory } from './room-runtime.types';

@Module({
  imports: [AppConfigModule, RoomsModule],
  controllers: [GameRoomController, GameExportController],
  providers: [
    GameTicketService,
    RoomRuntimeService,
    GameRoomService,
    GameRoomTicketRateLimiter,
    {
      provide: RuntimeProcessFactory,
      useClass: NodeRuntimeProcessFactory,
    },
  ],
  exports: [RoomRuntimeService, GameTicketService],
})
export class GodotGameModule {}
