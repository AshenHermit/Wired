import { Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { GameModule } from 'src/ts-game/game.module';

@Module({
  imports: [GameModule],
  providers: [EventsGateway],
})
export class WebsocketModule {}
