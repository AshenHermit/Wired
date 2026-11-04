import { User } from 'src/database/entities/user.entity';
import { toPublicUser, withPublicUsers } from './public-user';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    email: 'ann@wired.io',
    name: 'Ann',
    service: 'google',
    picture: 'ann.png',
    ...overrides,
  } as User;
}

describe('toPublicUser', () => {
  it('keeps only the fields every reader may see', () => {
    expect(toPublicUser(user())).toEqual({
      id: 7,
      name: 'Ann',
      picture: 'ann.png',
    });
  });

  it('never carries the email or the auth provider', () => {
    const projected = toPublicUser(user());

    expect(projected).not.toHaveProperty('email');
    expect(projected).not.toHaveProperty('service');
  });
});

describe('withPublicUsers', () => {
  it('projects the author and every contributor', () => {
    const row = {
      id: 1,
      name: 'hero',
      author: user({ id: 7 }),
      contributors: [user({ id: 8, email: 'bob@wired.io' })],
    };

    expect(withPublicUsers(row)).toEqual({
      id: 1,
      name: 'hero',
      author: { id: 7, name: 'Ann', picture: 'ann.png' },
      contributors: [{ id: 8, name: 'Ann', picture: 'ann.png' }],
    });
  });

  it('leaves an absent author or contributor list alone', () => {
    const row = { id: 2, name: 'orphan', author: undefined };

    expect(withPublicUsers(row)).toEqual(row);
  });

  it('preserves a null relation rather than inventing a user', () => {
    const row = { id: 3, author: null, contributors: [] };

    expect(withPublicUsers(row)).toEqual({
      id: 3,
      author: null,
      contributors: [],
    });
  });

  it('does not mutate the row it was given', () => {
    const original = user();
    const row = { id: 4, author: original };

    withPublicUsers(row);

    expect(row.author).toBe(original);
    expect(original.email).toBe('ann@wired.io');
  });
});
