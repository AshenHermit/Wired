import { BadRequestException } from '@nestjs/common';
import type { PublicUser } from '@wired-io/shared';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

describe('UsersController search', () => {
  let usersService: { search: jest.Mock };
  let controller: UsersController;

  const results: PublicUser[] = [{ id: 1, name: 'Anna', picture: 'p' }];

  beforeEach(() => {
    usersService = { search: jest.fn(() => Promise.resolve(results)) };
    controller = new UsersController(usersService as unknown as UsersService);
  });

  it('delegates the trimmed query with the default limit', async () => {
    await expect(controller.search('  anna  ', undefined)).resolves.toEqual(
      results,
    );
    expect(usersService.search).toHaveBeenCalledWith('anna', 20);
  });

  it('uses the requested limit when it is within bounds', async () => {
    await controller.search('anna', '7');
    expect(usersService.search).toHaveBeenCalledWith('anna', 7);
  });

  it('caps an oversized limit at 50', async () => {
    await controller.search('anna', '999');
    expect(usersService.search).toHaveBeenCalledWith('anna', 50);
  });

  it('treats a blank limit as the default', async () => {
    await controller.search('anna', '   ');
    expect(usersService.search).toHaveBeenCalledWith('anna', 20);
  });

  it('rejects an empty or whitespace-only query', () => {
    expect(() => controller.search('   ', undefined)).toThrow(
      BadRequestException,
    );
    expect(usersService.search).not.toHaveBeenCalled();
  });

  it('rejects a missing query', () => {
    expect(() => controller.search(undefined, undefined)).toThrow(
      BadRequestException,
    );
    expect(usersService.search).not.toHaveBeenCalled();
  });
});
