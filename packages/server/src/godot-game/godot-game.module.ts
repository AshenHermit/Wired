import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from 'src/config/config.module';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { RoomsModule } from 'src/rooms/rooms.module';
import { PackageDeliveryModule } from 'src/scripting-packages/delivery/package-delivery.module';
import { GameExportController } from './export/game-export.controller';
import { GameRoomController } from './game-room/game-room.controller';
import { GameSocketProxyService } from './socket-proxy/game-socket-proxy.service';
import {
  GameRoomTicketRateLimiter,
  InMemoryTicketRateLimitStore,
  TICKET_RATE_LIMIT_STORE,
} from './game-room/game-room.rate-limiter';
import { GameRoomService } from './game-room/game-room.service';
import { GameTicketService } from './game-room/game-ticket.service';
import { GodotRuntimeProcessFactory } from './runtime/godot-runtime-process.factory';
import { PackageSyncService } from './package-sync/package-sync.service';
import { PACKAGE_REVISION_DISPATCHER } from 'src/common/runtime-contracts';
import { RoomRuntimeService } from './runtime/room-runtime.service';
import { RuntimeProcessFactory } from './runtime/room-runtime.types';

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
    GameSocketProxyService,
    GameRoomService,
    GameRoomTicketRateLimiter,
    {
      // Default binding for the limiter's seam. A multi-instance deploy
      // overrides it with a shared store.
      provide: TICKET_RATE_LIMIT_STORE,
      useClass: InMemoryTicketRateLimitStore,
    },
    PackageSyncService,
    {
      provide: RuntimeProcessFactory,
      useClass: GodotRuntimeProcessFactory,
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
