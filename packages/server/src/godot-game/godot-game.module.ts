import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from 'src/config/config.module';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { RoomsModule } from 'src/rooms/rooms.module';
import { PackageDeliveryModule } from 'src/scripting-packages/package-delivery.module';
import { GameExportController } from './game-export.controller';
import { GameRoomController } from './game-room.controller';
import { GameRoomTicketRateLimiter } from './game-room.rate-limiter';
import { GameRoomService } from './game-room.service';
import { GameTicketService } from './game-ticket.service';
import { NodeRuntimeProcessFactory } from './node-runtime-process.factory';
import { PackageSyncService } from './package-sync.service';
import { PACKAGE_REVISION_DISPATCHER } from './package-sync.types';
import { RoomRuntimeService } from './room-runtime.service';
import { RuntimeProcessFactory } from './room-runtime.types';

@Module({
  imports: [
    AppConfigModule,
    RoomsModule,
    PackageDeliveryModule,
    TypeOrmModule.forFeature([ScriptingPackage, ScriptingPackageRevision]),
  ],
  controllers: [GameRoomController, GameExportController],
  providers: [
    GameTicketService,
    RoomRuntimeService,
    GameRoomService,
    GameRoomTicketRateLimiter,
    PackageSyncService,
    {
      provide: RuntimeProcessFactory,
      useClass: NodeRuntimeProcessFactory,
    },
    {
      provide: PACKAGE_REVISION_DISPATCHER,
      useExisting: PackageSyncService,
    },
  ],
  exports: [
    RoomRuntimeService,
    GameTicketService,
    PackageSyncService,
    PACKAGE_REVISION_DISPATCHER,
  ],
})
export class GodotGameModule {}
