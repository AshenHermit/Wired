import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createValidationPipe } from './common/validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(createValidationPipe());

  // Ensures room runtime processes are stopped when the backend exits
  // (SIGINT/SIGTERM); RoomRuntimeService also terminates them gracefully.
  app.enableShutdownHooks();

  const siteHost = process.env.SITE_HOST;
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
    origin: siteHost ?? '*',
    crossOriginIsolated: true,
    credentials: Boolean(siteHost),
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

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
