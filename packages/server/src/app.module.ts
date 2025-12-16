import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProxyModule } from './proxy/proxy.module';
import { WebsocketModule } from './websocket/websocket.module';
import { TypesModule } from './types/types.module';
import { AppConfigModule } from './config/config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from './config/config.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ProxyModule,
    WebsocketModule,
    TypesModule,
    AppConfigModule,
    AuthModule,
    UsersModule,
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'postgres',
        host: config.db.host,
        port: config.db.port,
        username: 'postgres',
        password: config.db.password,
        database: 'postgres',
        entities: config.db.entities,
        synchronize: config.db.sync,
      }),
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
