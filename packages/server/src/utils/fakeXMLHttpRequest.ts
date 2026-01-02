import http from 'http';
import https from 'https';
import { URL } from 'url';

class FakeXMLHttpRequest {
  public url!: string;
  public status = 200;
  public response: any;
  public responseText: string | undefined;
  private method: string = 'GET';
  private requestUrl!: URL;

  public open(method: string, url: string) {
    this.method = method.toUpperCase();
    this.url = url;
    try {
      this.requestUrl = new URL(url);
    } catch (error) {
      // Если URL относительный, попробуем добавить протокол
      this.requestUrl = new URL(
        url.startsWith('//') ? `http:${url}` : `http://${url}`,
      );
    }
  }

  public send(data?: any) {
    const isHttps = this.requestUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: this.requestUrl.hostname,
      port: this.requestUrl.port || (isHttps ? 443 : 80),
      path: this.requestUrl.pathname + this.requestUrl.search,
      method: this.method,
      headers: {} as Record<string, string>,
    };

    // Добавляем заголовки из URL, если есть
    if (this.requestUrl.username || this.requestUrl.password) {
      const auth = Buffer.from(
        `${this.requestUrl.username}:${this.requestUrl.password}`,
      ).toString('base64');
      options.headers['Authorization'] = `Basic ${auth}`;
    }

    // Если есть данные для отправки, добавляем заголовки
    if (data) {
      if (typeof data === 'string') {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        options.headers['Content-Length'] = Buffer.byteLength(data).toString();
      } else if (Buffer.isBuffer(data)) {
        options.headers['Content-Length'] = data.length.toString();
      }
    }

    const req = httpModule.request(options, (res) => {
      this.status = res.statusCode || 200;

      const chunks: Buffer[] = [];
      let totalLength = 0;
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalLength += chunk.length;

        // Вызываем onprogress если он определен
        if (this.onprogress && contentLength > 0) {
          const event = {
            loaded: totalLength,
            total: contentLength,
            lengthComputable: true,
          };
          this.onprogress(event);
        }
      });

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';

        // Определяем кодировку в зависимости от типа контента
        if (
          contentType.includes('application/json') ||
          /\.json$/i.test(this.url)
        ) {
          try {
            this.responseText = buffer.toString('utf8');
            this.response = JSON.parse(this.responseText);
          } catch (e) {
            this.responseText = buffer.toString('utf8');
            this.response = this.responseText;
          }
        } else if (contentType.startsWith('text/')) {
          this.responseText = buffer.toString('utf8');
          this.response = this.responseText;
        } else {
          // Для бинарных данных (изображения и т.д.) используем base64
          this.response = buffer.toString('base64');
          this.responseText = this.response;
        }

        const event = { target: { status: this.status } };
        this.onload(this, event);
      });
    });

    req.on('error', (err) => {
      this.status = 0;
      console.error(err);
      this.onerror(err);
    });

    // Отправляем данные, если они есть
    if (data) {
      if (typeof data === 'string') {
        req.write(data);
      } else if (Buffer.isBuffer(data)) {
        req.write(data);
      }
    }

    req.end();
  }

  public onload(xhr: any, event: any) {}
  public onerror(err: NodeJS.ErrnoException | null) {}
  public onprogress(event?: any) {}
}

export default FakeXMLHttpRequest;
