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
import { RoomsModule } from './rooms/rooms.module';
import { ScriptingPackagesModule } from './scripting-packages/scripting-packages.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { GameModule } from './ts-game/game.module';
import { GodotGameModule } from './godot-game/godot-game.module';
import { GodotEditorProviderModule } from './godot-editor-provider/godot-editor-provider.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ProxyModule,
    GodotEditorProviderModule,
    GodotGameModule,
    GameModule,
    WebsocketModule,
    TypesModule,
    AppConfigModule,
    AuthModule,
    UsersModule,
    RoomsModule,
    ScriptingPackagesModule,
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
