import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

export const AUTH_POLICY_KEY = 'wired:auth-policy';

/**
 * How the default guard treats a route.
 *
 * `required` is the fallback, so a handler that declares nothing is protected:
 * a new endpoint cannot become public just because its author forgot a
 * decorator. The two other values are the deliberate opt-outs, which makes the
 * public surface greppable instead of implicit.
 */
export type AuthPolicy = 'public' | 'silent' | 'required' | 'room-token';

/**
 * No credentials at all: login, the workshop catalogue, static game assets.
 *
 * Only use this for data that is the same for every caller.
 */
export function Public() {
  return SetMetadata(AUTH_POLICY_KEY, 'public' satisfies AuthPolicy);
}

/**
 * Credentials are optional; `req.user` is the user or null.
 *
 * For reads whose answer depends on who is asking — a private room you are a
 * member of, your own draft revisions — where rejecting anonymous callers
 * would break the page for visitors.
 */
export function SilentAuth() {
  return applyDecorators(
    SetMetadata(AUTH_POLICY_KEY, 'silent' satisfies AuthPolicy),
    ApiBearerAuth(),
  );
}

/**
 * The route checks its own room-scoped credential instead of a session: either
 * a user JWT or the room's own service token, verified by the handler's guards.
 *
 * The default guard steps aside the same way it does for `public`, but the route
 * is not anonymous — a request without a valid credential is rejected — so it
 * must not be documented as unauthenticated.
 */
export function RoomTokenAuth() {
  return applyDecorators(
    SetMetadata(AUTH_POLICY_KEY, 'room-token' satisfies AuthPolicy),
    ApiBearerAuth(),
  );
}

/**
 * A signed-in user is required. This is the default, so the decorator exists
 * for documentation: it marks the route as protected in the controller source
 * and in Swagger.
 */
export function UseAuthGuard() {
  return applyDecorators(
    SetMetadata(AUTH_POLICY_KEY, 'required' satisfies AuthPolicy),
    ApiBearerAuth(),
  );
}
