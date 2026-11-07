import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { RoomsService } from './rooms.service';
import { RoomsController } from './rooms.controller';
import { UsersService } from 'src/users/users.service';
import { ScriptingPackagesModule } from 'src/scripting-packages/scripting-packages.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Room, User]),
    // Cycle: ScriptingPackagesModule → GodotGameModule → RoomsModule.
    forwardRef(() => ScriptingPackagesModule),
  ],
  providers: [RoomsService, UsersService],
  controllers: [RoomsController],
  exports: [RoomsService],
})
export class RoomsModule {}
