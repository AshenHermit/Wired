import { Module } from '@nestjs/common';
import { GameRoomsService } from './game-rooms.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Room, User, ScriptingPackage])],
  providers: [GameRoomsService],
  controllers: [],
  exports: [GameRoomsService],
})
export class GameModule {}
