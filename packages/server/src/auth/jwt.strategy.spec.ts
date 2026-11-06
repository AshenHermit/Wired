import { UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { User } from 'src/database/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { JwtSilentStrategy, JwtStrategy } from './jwt.strategy';

const config = {
  site: { authSecret: 'test-secret' },
} as unknown as AppConfigService;

const user = { id: 7, email: 'player@wired.io' } as User;

function usersService(found: User | null) {
  const findOneByEmail = jest.fn(async () => found);
  return {
    service: { findOneByEmail } as unknown as UsersService,
    findOneByEmail,
  };
}

describe('JwtStrategy', () => {
  it('answers with the user that owns the token subject', async () => {
    const { service, findOneByEmail } = usersService(user);
    const strategy = new JwtStrategy(service, config);

    await expect(strategy.validate({ email: user.email })).resolves.toBe(user);
    expect(findOneByEmail).toHaveBeenCalledWith(user.email);
  });

  it('rejects a token whose user no longer exists', async () => {
    // A deleted account must not keep working just because its token is still
    // inside its expiry window.
    const { service } = usersService(null);
    const strategy = new JwtStrategy(service, config);

    await expect(
      strategy.validate({ email: 'gone@wired.io' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('JwtSilentStrategy', () => {
  it('answers with the user that owns the token subject', async () => {
    const { service } = usersService(user);
    const strategy = new JwtSilentStrategy(service, config);

    await expect(strategy.validate({ email: user.email })).resolves.toBe(user);
  });

  it('answers null instead of rejecting, so a page can load signed out', async () => {
    const { service } = usersService(null);
    const strategy = new JwtSilentStrategy(service, config);

    await expect(
      strategy.validate({ email: 'gone@wired.io' }),
    ).resolves.toBeNull();
  });
});
