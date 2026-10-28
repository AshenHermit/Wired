import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
