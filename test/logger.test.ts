/**
 * Logger hook tests.
 */
import { describe, it, expect } from 'vitest';
import { NOOP_LOGGER } from '../src/logger.js';
import { HuduClient } from '../src/client.js';
import { stubFetch, json, text, clearFetch } from './helpers.js';

describe('NOOP_LOGGER', () => {
  it('is safe to call on all four methods', () => {
    expect(() => {
      NOOP_LOGGER.debug('d');
      NOOP_LOGGER.info('i');
      NOOP_LOGGER.warn('w');
      NOOP_LOGGER.error('e');
    }).not.toThrow();
  });
});

describe('logger wiring', () => {
  afterEach(() => clearFetch());

  it('passes a custom logger and emits debug/warn/error hooks', async () => {
    const seen: string[] = [];
    const logger = {
      debug: (msg: string) => seen.push('debug:' + msg),
      info: () => {},
      warn: (msg: string) => seen.push('warn:' + msg),
      error: () => {},
    };
    // Retry path triggers a warn; a normal request triggers debug.
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) return json({}, 500);
      return json({ ok: true });
    });
    const c = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', maxRetries: 2, logger });
    await c.companies.get(1);
    expect(seen.some((s) => s.startsWith('warn:'))).toBe(true);
    expect(seen.some((s) => s.startsWith('debug:'))).toBe(true);
  });

  it('logs a warn when retrying a 429', async () => {
    const seen: string[] = [];
    const logger = { debug: () => {}, info: () => {}, warn: (m: string) => seen.push(m), error: () => {} };
    let n = 0;
    stubFetch(() => {
      n++;
      return json({}, 429, { 'Retry-After': '0.01' });
    });
    const c = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', maxRetries: 1, logger });
    await c.companies.get(1).catch(() => {});
    expect(seen.some((m) => m.includes('429'))).toBe(true);
    expect(n).toBe(2); // retried once
  });
});
