import {
  Controller,
  Get,
  Query,
  Res,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

@Controller('proxy')
export class ProxyController {
  @Get()
  async proxy(@Query('url') url: string, @Res() res: Response) {
    if (!url) {
      throw new HttpException(
        'URL parameter is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // Валидация URL для безопасности
      let targetUrl: URL;
      try {
        targetUrl = new URL(url);
      } catch {
        throw new HttpException('Invalid URL format', HttpStatus.BAD_REQUEST);
      }

      // Запрещаем локальные адреса и внутренние сети
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        throw new HttpException(
          'Only HTTP and HTTPS protocols are allowed',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (
        targetUrl.hostname === 'localhost' ||
        targetUrl.hostname === '127.0.0.1' ||
        targetUrl.hostname.startsWith('192.168.') ||
        targetUrl.hostname.startsWith('10.') ||
        targetUrl.hostname.startsWith('172.')
      ) {
        throw new HttpException(
          'Local and private network addresses are not allowed',
          HttpStatus.FORBIDDEN,
        );
      }

      const response = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ProxyServer/1.0)',
        },
      });

      if (!response.ok) {
        throw new HttpException(
          `Proxy request failed: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      // Получаем тип контента
      const contentType =
        response.headers.get('content-type') || 'application/octet-stream';

      // Получаем данные
      const buffer = await response.arrayBuffer();
      const data = Buffer.from(buffer);

      // Устанавливаем заголовки ответа
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', data.length.toString());

      // Копируем другие важные заголовки
      const headersToForward = [
        'cache-control',
        'expires',
        'last-modified',
        'etag',
      ];
      headersToForward.forEach((header) => {
        const value = response.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      });

      // Устанавливаем статус код
      res.status(response.status);

      // Отправляем данные
      return res.send(data);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Proxy error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
