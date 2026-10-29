import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from './config/config.service';
import { UsersModule } from './users/users.module';
import { RoomsModule } from './rooms/rooms.module';
import { ScriptingPackagesModule } from './scripting-packages/scripting-packages.module';
import { GodotGameModule } from './godot-game/godot-game.module';
import { GodotEditorProviderModule } from './godot-editor-provider/godot-editor-provider.module';

@Module({
  imports: [
    GodotEditorProviderModule,
    GodotGameModule,
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
        username: config.db.username,
        password: config.db.password,
        database: config.db.database,
        entities: config.db.entities,
        synchronize: config.db.sync,
      }),
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
