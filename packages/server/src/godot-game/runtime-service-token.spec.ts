import {
  createRuntimeServiceToken,
  verifyRuntimeServiceToken,
} from './runtime-service-token';

describe('runtime service token', () => {
  const secret = 'ticket-secret';

  it('is deterministic for the same secret and room', () => {
    expect(createRuntimeServiceToken(secret, '42')).toBe(
      createRuntimeServiceToken(secret, '42'),
    );
  });

  it('is bound to the room', () => {
    const token = createRuntimeServiceToken(secret, '42');

    expect(verifyRuntimeServiceToken(secret, '42', `Bearer ${token}`)).toBe(
      true,
    );
    expect(verifyRuntimeServiceToken(secret, '43', `Bearer ${token}`)).toBe(
      false,
    );
  });

  it('rejects a token signed with another secret', () => {
    const token = createRuntimeServiceToken('other-secret', '42');

    expect(verifyRuntimeServiceToken(secret, '42', `Bearer ${token}`)).toBe(
      false,
    );
  });

  it('rejects missing, malformed and non-bearer headers', () => {
    const token = createRuntimeServiceToken(secret, '42');

    expect(verifyRuntimeServiceToken(secret, '42', undefined)).toBe(false);
    expect(verifyRuntimeServiceToken(secret, '42', '')).toBe(false);
    expect(verifyRuntimeServiceToken(secret, '42', token)).toBe(false);
    expect(verifyRuntimeServiceToken(secret, '42', `Basic ${token}`)).toBe(
      false,
    );
    expect(verifyRuntimeServiceToken('', '42', `Bearer ${token}`)).toBe(false);
  });

  it('accepts a case-insensitive bearer scheme', () => {
    const token = createRuntimeServiceToken(secret, '42');

    expect(verifyRuntimeServiceToken(secret, '42', `bearer ${token}`)).toBe(
      true,
    );
  });
});
