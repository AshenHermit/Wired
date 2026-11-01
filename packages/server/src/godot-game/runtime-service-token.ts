import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Room-scoped credential for the native Godot runtime.
 *
 * Package manifests and artifacts are served to the runtime over HTTP, but the
 * runtime has no user account. Instead of leaving those routes public, the
 * backend injects a token derived from the game ticket secret and bound to the
 * room: a leaked token cannot read another room's packages.
 *
 * The token is static for the lifetime of a room runtime and never reaches the
 * browser.
 */
const TOKEN_PREFIX = 'runtime-api:v1';

export function createRuntimeServiceToken(
  secret: string,
  roomId: string | number,
): string {
  return createHmac('sha256', secret)
    .update(`${TOKEN_PREFIX}:${roomId}`)
    .digest('hex');
}

/** Accepts a raw token or an `Authorization: Bearer <token>` header value. */
export function verifyRuntimeServiceToken(
  secret: string,
  roomId: string | number,
  authorization: string | undefined,
): boolean {
  if (!secret || !authorization) {
    return false;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) {
    return false;
  }
  const expected = Buffer.from(createRuntimeServiceToken(secret, roomId));
  const actual = Buffer.from(match[1]);
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}
