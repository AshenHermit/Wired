import { BadRequestException } from '@nestjs/common';
import { createValidationPipe } from 'src/common/validation';
import { CreateUserDTO } from './create-user.dto';

describe('CreateUserDTO through the global validation pipe', () => {
  const pipe = createValidationPipe();
  const transform = (payload: Record<string, unknown>) =>
    pipe.transform(payload, { type: 'body', metatype: CreateUserDTO });

  it('keeps name and picture defined by the DTO', async () => {
    const dto = await transform({
      email: 'user@example.com',
      password: 'secret1',
      name: 'Anna Lord',
      picture: 'https://site.com/picture.webp',
    });

    expect(dto).toBeInstanceOf(CreateUserDTO);
    expect(dto).toMatchObject({
      email: 'user@example.com',
      name: 'Anna Lord',
      picture: 'https://site.com/picture.webp',
    });
  });

  it('accepts a payload without an optional picture', async () => {
    await expect(
      transform({
        email: 'user@example.com',
        password: 'secret1',
        name: 'Anna Lord',
      }),
    ).resolves.toBeInstanceOf(CreateUserDTO);
  });

  it('rejects a missing name', async () => {
    await expect(
      transform({ email: 'user@example.com', password: 'secret1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a short password', async () => {
    await expect(
      transform({
        email: 'user@example.com',
        password: '123',
        name: 'Anna Lord',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown properties', async () => {
    await expect(
      transform({
        email: 'user@example.com',
        password: 'secret1',
        name: 'Anna Lord',
        id: 999,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
