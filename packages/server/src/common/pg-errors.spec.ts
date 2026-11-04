import { isUniqueViolation } from './pg-errors';

describe('isUniqueViolation', () => {
  it('recognises the SQLSTATE Postgres reports for a unique index', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('recognises an Error carrying the driver code', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      code: '23505',
    });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('ignores every other SQLSTATE', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation({ code: '42P01' })).toBe(false);
  });

  it('answers false for a value that is not a driver error', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(new Error('no code'))).toBe(false);
  });
});
