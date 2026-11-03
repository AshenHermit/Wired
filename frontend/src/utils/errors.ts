/**
 * Message of an unknown thrown value, for logs and diagnostics.
 *
 * Mirrors `packages/server/src/common/errors.ts`: a rejected promise can carry
 * anything, and every call site wants the same one-line rendering of it.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
