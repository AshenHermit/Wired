import { Profile } from 'passport-google-oauth20';
import { GoogleStrategy } from './auth-google.strategy';

function profile(verified: boolean): Profile {
  return {
    id: 'google-id',
    displayName: 'Anna Lord',
    name: { givenName: 'Anna', familyName: 'Lord' },
    emails: [{ value: 'anna@example.com', verified }],
    photos: [{ value: 'https://example.com/anna.png' }],
    provider: 'google',
    _raw: '',
    _json: {},
  } as Profile;
}

describe('GoogleStrategy', () => {
  it('accepts a verified email', async () => {
    const strategy = new GoogleStrategy();
    const done = jest.fn();

    await strategy.validate('access', 'refresh', profile(true), done);

    expect(done).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ email: 'anna@example.com' }),
    );
  });

  it('rejects an unverified email', async () => {
    const strategy = new GoogleStrategy();
    const done = jest.fn();

    await strategy.validate('access', 'refresh', profile(false), done);

    expect(done).toHaveBeenCalledWith(null, false);
  });
});
