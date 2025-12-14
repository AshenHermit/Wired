import '@geckos.io/phaser-on-nodejs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

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
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
