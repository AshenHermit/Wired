import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createValidationPipe } from './common/validation';
import { AppConfigService } from './config/config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const appConfig = app.get(AppConfigService);

  app.useGlobalPipes(createValidationPipe());

  // Ensures room runtime processes are stopped when the backend exits
  // (SIGINT/SIGTERM); RoomRuntimeService also terminates them gracefully.
  app.enableShutdownHooks();

  const corsOrigin = appConfig.site.corsOrigin;
  app.enableCors({
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'x-requested-with',
      'X-Requested-With',
      'X-Real-IP',
      'X-Forwarded-For',
      'X-Forwarded-Proto',
    ],
    // Browsers reject `*` together with credentials. Only send credentials
    // when the allowed origin is actually configured.
    origin: corsOrigin ?? '*',
    crossOriginIsolated: true,
    credentials: corsOrigin !== null,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    exposedHeaders: ['Content-Type', 'Content-Length'],
  });

  const config = new DocumentBuilder()
    .setTitle('Wired API')
    .setDescription('The Wired API description')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, documentFactory);

  await app.listen(appConfig.port);
}

bootstrap().catch((error: unknown) => {
  // Nest logs module-level failures itself, but a rejected bootstrap (missing
  // config, unreachable database) would otherwise exit with an unhandled
  // rejection and no non-zero status.
  console.error('Failed to start the Wired API', error);
  process.exit(1);
});
