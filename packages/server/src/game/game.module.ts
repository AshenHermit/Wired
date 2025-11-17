import { Module } from '@nestjs/common';
import { GameRoomsService } from './game-rooms.service';

@Module({
  imports: [],
  providers: [GameRoomsService],
  controllers: [],
  exports: [GameRoomsService],
})
export class GameModule {}
