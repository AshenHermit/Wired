import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProxyModule } from './proxy/proxy.module';
import { WebsocketModule } from './websocket/websocket.module';
import { TypesModule } from './types/types.module';
import { AppConfigModule } from './config/config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from './config/config.service';

@Module({
  imports: [ProxyModule, WebsocketModule, TypesModule, AppConfigModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
