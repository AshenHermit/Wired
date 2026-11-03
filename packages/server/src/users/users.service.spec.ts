import { ForbiddenException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from 'src/database/entities/user.entity';
import { UsersService } from './users.service';

interface FakeRepository {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
}

function repository(): FakeRepository {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((values: Partial<User>) => values),
    save: jest.fn(async (values: Partial<User>) => values),
    update: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
}

const serviceWith = (repo: FakeRepository): UsersService =>
  new UsersService(repo as unknown as Repository<User>);

const user = (overrides: Partial<User> = {}): User =>
  ({ id: 7, email: 'player@wired.io', ...overrides }) as User;

const HASHED = /^\$2[aby]\$/;

describe('assertUserEditing', () => {
  it('lets a user edit their own profile', async () => {
    await expect(
      serviceWith(repository()).assertUserEditing(user(), 7),
    ).resolves.toBeUndefined();
  });

  it('refuses to edit someone else', async () => {
    await expect(
      serviceWith(repository()).assertUserEditing(user(), 8),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('lookups', () => {
  it('finds a user by email', async () => {
    const repo = repository();
    repo.findOne.mockResolvedValue(user());

    await expect(
      serviceWith(repo).findOneByEmail('player@wired.io'),
    ).resolves.toMatchObject({ id: 7 });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { email: 'player@wired.io' },
    });
  });

  it('finds a user by id', async () => {
    const repo = repository();
    repo.findOne.mockResolvedValue(user());

    await expect(serviceWith(repo).findById(7)).resolves.toMatchObject({
      id: 7,
    });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});

describe('create', () => {
  it('stores the password hashed, never in clear', async () => {
    const repo = repository();

    await serviceWith(repo).create({
      email: 'new@wired.io',
      password: 'hunter22',
      name: 'New Player',
    });

    const [stored] = repo.save.mock.calls[0] as [Partial<User>];
    expect(stored.password).not.toBe('hunter22');
    expect(stored.password).toMatch(HASHED);
    await expect(
      bcrypt.compare('hunter22', String(stored.password)),
    ).resolves.toBe(true);
  });
});

describe('update', () => {
  it('writes only the fields it was given', async () => {
    const repo = repository();
    repo.findOne.mockResolvedValue(user({ name: 'Renamed' }));

    const updated = await serviceWith(repo).update(7, { name: 'Renamed' });

    expect(repo.update).toHaveBeenCalledWith(7, { name: 'Renamed' });
    expect(updated).toMatchObject({ id: 7, name: 'Renamed' });
  });

  it('rehashes a new password before storing it', async () => {
    const repo = repository();
    repo.findOne.mockResolvedValue(user());

    await serviceWith(repo).update(7, { password: 'hunter22' });

    const [, patch] = repo.update.mock.calls[0] as [number, Partial<User>];
    expect(patch.password).not.toBe('hunter22');
    await expect(
      bcrypt.compare('hunter22', String(patch.password)),
    ).resolves.toBe(true);
  });

  it('reports a row that disappeared while the update ran', async () => {
    const repo = repository();
    repo.findOne.mockResolvedValue(null);

    await expect(
      serviceWith(repo).update(7, { name: 'Gone' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('remove', () => {
  it('deletes by id', async () => {
    const repo = repository();

    await serviceWith(repo).remove(7);

    expect(repo.delete).toHaveBeenCalledWith(7);
  });
});
