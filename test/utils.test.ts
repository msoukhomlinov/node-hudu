/**
 * Unit tests for src/utils.ts helpers.
 */
import { describe, it, expect } from 'vitest';
import { isRecord, mergeQuery, assertString, idToString } from '../src/utils.js';

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

describe('mergeQuery', () => {
  it('spreads base when no extra', () => {
    expect(mergeQuery({ a: 1 })).toEqual({ a: 1 });
  });
  it('merges extra over base', () => {
    expect(mergeQuery({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });
  it('returns a new object (not a mutation)', () => {
    const base = { a: 1 };
    const out = mergeQuery(base, { b: 2 });
    expect(out).not.toBe(base);
  });
});

describe('assertString', () => {
  it('returns the trimmed string for a non-empty string', () => {
    expect(assertString('  hello  ', 'name')).toBe('hello');
  });
  it('throws for a non-string', () => {
    expect(() => assertString(123, 'name')).toThrow('name must be a non-empty string');
  });
  it('throws for an empty/whitespace string', () => {
    expect(() => assertString('   ', 'name')).toThrow();
  });
});

describe('idToString', () => {
  it('coerces numbers and strings', () => {
    expect(idToString(5)).toBe('5');
    expect(idToString('abc')).toBe('abc');
    expect(idToString(0)).toBe('0');
  });
});
