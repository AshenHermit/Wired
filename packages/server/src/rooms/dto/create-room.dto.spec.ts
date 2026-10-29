import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from 'src/common/validation';
import { CreateRoomDto } from './create-room.dto';

async function typeErrors(type: string) {
  const dto = plainToInstance(CreateRoomDto, {
    name: 'Room',
    authorId: 1,
    type,
  });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'type');
}

describe('CreateRoomDto', () => {
  it('accepts godot', async () => {
    expect(await typeErrors('godot')).toHaveLength(0);
  });

  it('rejects legacy ts-game', async () => {
    expect(await typeErrors('ts-game')).toHaveLength(1);
  });
});

describe('global validation pipe', () => {
  const pipe = createValidationPipe();
  const transform = (payload: Record<string, unknown>) =>
    pipe.transform(payload, { type: 'body', metatype: CreateRoomDto });

  it('accepts a valid payload', async () => {
    await expect(
      transform({ name: 'Room', authorId: 1, type: 'godot' }),
    ).resolves.toBeInstanceOf(CreateRoomDto);
  });

  it('rejects unknown properties (mass assignment)', async () => {
    await expect(
      transform({ name: 'Room', authorId: 1, type: 'godot', id: 999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects legacy ts-game through the pipe', async () => {
    await expect(
      transform({ name: 'Room', authorId: 1, type: 'ts-game' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
