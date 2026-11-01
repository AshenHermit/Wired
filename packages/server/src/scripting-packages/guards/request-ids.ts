/** Route/query ids arrive as raw strings: guards run before ParseIntPipe. */
export function readPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
