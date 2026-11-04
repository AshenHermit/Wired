/**
 * Whether a write failed the unique index on the row it tried to insert.
 *
 * Postgres reports every constraint violation as SQLSTATE `23505`, and TypeORM
 * rethrows the driver error with that code on it. The three package services
 * that write slugs all need this answer, so it lives in one place instead of
 * being restated per service with its own narrowing.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}
