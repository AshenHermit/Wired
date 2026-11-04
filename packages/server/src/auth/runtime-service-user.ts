/**
 * Synthetic principal for the native Godot runtime.
 *
 * `RuntimeAuthGuard` puts it on the request when a valid room-scoped service
 * token was presented. It has no database row, so membership checks must treat
 * it as "the room's own runtime" rather than as a user.
 */
export const RUNTIME_SERVICE_USER_ID = 0;

export type RuntimeServiceUser = {
  id: number;
  runtimeService: true;
};

export function createRuntimeServiceUser(): RuntimeServiceUser {
  return { id: RUNTIME_SERVICE_USER_ID, runtimeService: true };
}

export function isRuntimeServiceUser(
  user: unknown,
): user is RuntimeServiceUser {
  return (
    !!user &&
    typeof user === 'object' &&
    (user as { runtimeService?: unknown }).runtimeService === true
  );
}
