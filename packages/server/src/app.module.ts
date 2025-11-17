import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProxyModule } from './proxy/proxy.module';
import { WebsocketModule } from './websocket/websocket.module';
import { TypesModule } from './types/types.module';

@Module({
  imports: [ProxyModule, WebsocketModule, TypesModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
