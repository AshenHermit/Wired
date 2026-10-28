import { Module } from '@nestjs/common';
import { AppConfigModule } from 'src/config/config.module';
import { GameTicketService } from './game-ticket.service';
import { NodeRuntimeProcessFactory } from './node-runtime-process.factory';
import { RoomRuntimeService } from './room-runtime.service';
import { RuntimeProcessFactory } from './room-runtime.types';

@Module({
  imports: [AppConfigModule],
  controllers: [],
  providers: [
    GameTicketService,
    RoomRuntimeService,
    {
      provide: RuntimeProcessFactory,
      useClass: NodeRuntimeProcessFactory,
    },
  ],
  exports: [RoomRuntimeService, GameTicketService],
})
export class GodotGameModule {}
