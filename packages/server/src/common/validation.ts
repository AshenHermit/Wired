import { ValidationPipe } from '@nestjs/common';

/**
 * Global request validation. `whitelist` + `forbidNonWhitelisted` prevent
 * mass-assignment of entity fields (id, createdAt, relations) from request
 * bodies; DTO decorators were previously inert because no pipe was installed.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}
