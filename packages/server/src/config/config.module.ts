// src/config/config.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './config';
import { APP_CONFIG, AppConfigService } from './config.service';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true, // makes `ConfigService` global
      load: [configuration],
    }),
  ],
  providers: [
    // `config()` runs once here; every consumer reads the same frozen result.
    { provide: APP_CONFIG, useFactory: configuration },
    AppConfigService,
  ],
  exports: [AppConfigService], // export to use in other modules
})
export class AppConfigModule {}
