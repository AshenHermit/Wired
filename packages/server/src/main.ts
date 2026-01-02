const originalXMLHttpRequest = global.XMLHttpRequest;
import '@geckos.io/phaser-on-nodejs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import FakeXMLHttpRequest from './utils/fakeXMLHttpRequest';
// import { XMLHttpRequest } from 'xmlhttprequest';

global.XMLHttpRequest = FakeXMLHttpRequest as any;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Настройка WebSocket adapter для Socket.IO
  app.useWebSocketAdapter(new IoAdapter(app));

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
    origin: process.env.SITE_HOST ?? '*',
    credentials: true,
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
