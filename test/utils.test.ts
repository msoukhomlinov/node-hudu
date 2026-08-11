/**
 * Unit tests for src/utils.ts helpers.
 */
import { describe, it, expect } from 'vitest';
import { isRecord } from '../src/utils.js';

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it('returns false for non-objects, arrays, and null', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(123)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(() => {})).toBe(false);
  });
});
