/**
 * FlagsResource — primitive contract + agent-execution-layer helper rows (group B).
 *
 * Every test title here is asserted verbatim by `npm run capabilities:check` against the
 * `flags.*` rows of capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, NotFoundError, StaleObjectError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/flags';

const FLAG_FULL = {
  id: 31,
  flag_type_id: 4,
  description: 'needs review',
  flagable_type: 'Asset',
  flagable_id: 42,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

const FLAG_SUMMARY = {
  id: 31,
  flag_type_id: 4,
  description: 'needs review',
  flagable_type: 'Asset',
  flagable_id: 42,
  updated_at: '2026-02-01T00:00:00Z',
};

function makeClient(onAudit?: (event: AuditEvent) => void): HuduClient {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    ...(onAudit === undefined ? {} : { onAudit }),
  });
}

describe('flags', () => {
  afterEach(() => clearFetch());

  describe('primitives', () => {
    it('returns the unwrapped flags record', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }));
      const record = await makeClient().flags.get(31);
      expect(record).toEqual(FLAG_FULL);
      expect(spy.calls[0]?.url).toBe(`${BASE}/31`);
    });

    it('normalises a 404 into NOT_FOUND', async () => {
      stubFetch(() => json({ error: 'not found' }, 404));
      await expect(makeClient().flags.get(31)).rejects.toMatchObject({
        name: 'NotFoundError',
        code: 'NOT_FOUND',
        httpStatus: 404,
      });
    });

    it('returns the unwrapped flags list', async () => {
      const spy = stubFetch(() => json({ flags: [FLAG_FULL] }));
      const items = await makeClient().flags.listAll();
      expect(items).toEqual([FLAG_FULL]);
      expect(spy.calls[0]?.url).toContain(BASE);
    });

    it('sends page/page_size and stops on a short page', async () => {
      const spy = stubFetch(() => json({ flags: [FLAG_FULL] }));
      await makeClient().flags.listAll();
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toContain('page=1');
      expect(spy.calls[0]?.url).toContain('page_size=25');
    });

    it('returns the created flags record', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }, 201));
      const created = await makeClient().flags.create({ flag_type_id: 4, flagable_type: 'Asset', flagable_id: 42 });
      expect(created).toEqual(FLAG_FULL);
      expect(spy.calls[0]?.init.method).toBe('POST');
      expect(spy.calls[0]?.init.body).toBe(
        JSON.stringify({ flag: { flag_type_id: 4, flagable_type: 'Asset', flagable_id: 42 } }),
      );
    });

    it('returns the updated flags record', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }));
      const updated = await makeClient().flags.update(31, { description: 'reviewed' });
      expect(updated).toEqual(FLAG_FULL);
      expect(spy.calls[0]?.init.method).toBe('PUT');
      expect(spy.calls[0]?.url).toBe(`${BASE}/31`);
    });

    it('unwraps the PUT response by singleKey', async () => {
      stubFetch(() => json({ flag: FLAG_FULL }));
      const updated = await makeClient().flags.update(31, { description: 'reviewed' });
      expect(updated).toEqual(FLAG_FULL);
      expect(updated).not.toHaveProperty('flag');
    });

    it('resolves void after a successful delete', async () => {
      const spy = stubFetch(() => empty(204));
      await expect(makeClient().flags.delete(31)).resolves.toBeUndefined();
      expect(spy.calls[0]?.init.method).toBe('DELETE');
      expect(spy.calls[0]?.url).toBe(`${BASE}/31`);
    });

    it('dry-run issues no mutating request and returns simulated: true', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }, 201));
      const result = await makeClient().flags.create({ flagable_type: 'Asset' }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.operation).toBe('flags.create');
      expect(result.request).toEqual({ method: 'POST', path: '/flags' });
      expect(result.checks.some((check) => check.name === 'payload-present' && check.ok)).toBe(true);
      expect(spy.calls).toHaveLength(0);
    });

    it('dry-run issues no PUT request and returns simulated: true', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }));
      const result = await makeClient().flags.update(31, { description: 'reviewed' }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'PUT', path: '/flags/31' });
      expect(result.target).toEqual({ resource: 'flags', ids: [31] });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(spy.calls).toHaveLength(0);
    });

    it('refuses expectedUpdatedAt on the create and delete paths, which carry no stale guard', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }));
      const client = makeClient();
      for (const attempt of [
        client.flags.create({ flagable_type: 'Asset' }, { expectedUpdatedAt: 'v1' }),
        client.flags.delete(31, { expectedUpdatedAt: 'v1' }),
      ]) {
        const failure = await attempt.then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
        expect(failure).toBeInstanceOf(HuduConfigError);
        expect(failure?.code).toBe('CONFIG_ERROR');
        expect(failure?.category).toBe('validation');
        expect(spy.calls).toHaveLength(0);
      }
      expect(spy.calls).toHaveLength(0);
    });

    it('dry-run issues no DELETE request and returns simulated: true', async () => {
      const spy = stubFetch(() => empty(204));
      const result = await makeClient().flags.delete(31, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'DELETE', path: '/flags/31' });
      expect(result.impact.reversible).toBe(false);
      expect(spy.calls).toHaveLength(0);
    });

    it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
      // Update: the guard reads the current record first, and a mismatch stops the PUT.
      const mismatchSpy = stubFetch(() => json({ flag: FLAG_FULL }));
      const failure = await makeClient()
        .flags.update(31, { description: 'reviewed' }, { expectedUpdatedAt: '2020-01-01T00:00:00Z' })
        .then(
          () => undefined,
          (err: unknown) => err as StaleObjectError,
        );
      expect(failure).toBeInstanceOf(StaleObjectError);
      expect(failure?.code).toBe('STALE_OBJECT');
      expect(failure?.category).toBe('conflict');
      expect(failure?.retryable).toBe(false);
      expect(failure?.httpStatus).toBe(412);
      expect(failure?.operation).toBe('flags.update');
      expect(mismatchSpy.calls).toHaveLength(1);
      expect(mismatchSpy.calls[0]?.init.method).toBe('GET');

      // Update: a matching revision lets the PUT through.
      const matchSpy = stubFetch((url, init) =>
        init.method === 'PUT' ? json({ flag: { ...FLAG_FULL, description: 'reviewed' } }) : json({ flag: FLAG_FULL }),
      );
      const updated = await makeClient().flags.update(
        31,
        { description: 'reviewed' },
        { expectedUpdatedAt: FLAG_FULL.updated_at },
      );
      expect(updated).toMatchObject({ id: 31, description: 'reviewed' });
      expect(matchSpy.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
    });

    it('surfaces a correlation id on the success path and the error path', async () => {
      const events: AuditEvent[] = [];
      const client = makeClient((event) => events.push(event));
      stubFetch(() => json({ flag: FLAG_FULL }));
      await client.flags.get(31);
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events[0]?.operation).toBe('flags.get');
      expect(events[0]?.outcome).toBe('success');

      stubFetch(() => json({ error: 'nope' }, 400));
      const failure = await client.flags.get(31).then(
        () => undefined,
        (err: unknown) => err as { correlationId?: string; code?: string; operation?: string },
      );
      expect(failure?.code).toBe('BAD_REQUEST');
      expect(failure?.operation).toBe('flags.get');
      expect(events[1]?.outcome).toBe('error');
      expect(events[1]?.correlationId).toBe(failure?.correlationId);
    });
  });

  describe('resolve', () => {
    it('fetches by id without a scan', async () => {
      const spy = stubFetch(() => json({ flag: FLAG_FULL }));
      const found = await makeClient().flags.resolve(31);
      expect(found).toEqual(FLAG_SUMMARY);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toBe(`${BASE}/31`);
      expect(spy.calls[0]?.url).not.toContain('page');
    });

    it('throws NOT_FOUND for an unknown id', async () => {
      stubFetch(() => json({ error: 'not found' }, 404));
      const failure = await makeClient()
        .flags.resolve(999)
        .then(
          () => undefined,
          (err: unknown) => err as NotFoundError,
        );
      expect(failure).toBeInstanceOf(NotFoundError);
      expect(failure?.code).toBe('NOT_FOUND');
      expect(failure?.operation).toBe('flags.resolve');
      expect(failure?.resourceIds).toEqual([999]);

      // A non-404 failure is propagated unchanged, never re-labelled as a miss.
      stubFetch(() => json({ error: 'bad request' }, 400));
      await expect(makeClient().flags.resolve(31)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('throws a validation error naming the accepted identifier kind', async () => {
      const spy = stubFetch(() => json({ flags: [FLAG_FULL] }));
      const failure = await makeClient()
        .flags.resolve({ name: 'needs review' })
        .then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
      expect(failure).toBeInstanceOf(HuduConfigError);
      expect(failure?.category).toBe('validation');
      expect(failure?.message).toContain('numeric id');
      expect(failure?.message).toContain('findByFlagable');
      await expect(makeClient().flags.resolve('needs review')).rejects.toBeInstanceOf(HuduConfigError);
      expect(spy.calls).toHaveLength(0);
    });

    it('returns FlagSummary', async () => {
      stubFetch(() => json({ flag: FLAG_FULL }));
      const found = await makeClient().flags.resolve('31');
      expect(found).toEqual(FLAG_SUMMARY);
      expect(found).not.toHaveProperty('created_at');
      expect(Object.keys(found ?? {}).sort()).toEqual(Object.keys(FLAG_SUMMARY).sort());
    });

    it('expand: true returns the full flag', async () => {
      stubFetch(() => json({ flag: FLAG_FULL }));
      const found = await makeClient().flags.resolve(31, { expand: true });
      expect(found).toEqual(FLAG_FULL);
      expect(found).toHaveProperty('created_at', '2026-01-01T00:00:00Z');
    });

    it('resolutionDetails: true reports a direct fetch', async () => {
      stubFetch(() => json({ flag: FLAG_FULL }));
      await expect(makeClient().flags.resolve(31, { resolutionDetails: true })).resolves.toEqual({
        value: FLAG_SUMMARY,
        resolutionCost: 'direct',
        scanned: 1,
        scanTruncated: false,
      });
    });
  });

  describe('findByFlagable', () => {
    it('returns the flags attached to the record', async () => {
      const spy = stubFetch(() => json({ flags: [FLAG_FULL] }));
      const found = await makeClient().flags.findByFlagable('Asset', 42);
      expect(found).toEqual([FLAG_SUMMARY]);
      expect(found[0]).not.toHaveProperty('created_at');
      expect(spy.calls).toHaveLength(1);
      const url = spy.calls[0]?.url ?? '';
      expect(url).toContain('flagable_type=Asset');
      expect(url).toContain('flagable_id=42');
      expect(url).toContain('page_size=25');
    });

    it('returns an empty array for an unflagged record', async () => {
      const spy = stubFetch(() => json({ flags: [] }));
      await expect(makeClient().flags.findByFlagable('Asset', 42)).resolves.toEqual([]);
      expect(spy.calls).toHaveLength(1);
    });

    it('honours limit and never exceeds 100', async () => {
      const spy = stubFetch(() => json({ flags: [FLAG_FULL] }));
      const client = makeClient();
      await client.flags.findByFlagable('Asset', 42, { limit: 3 });
      expect(spy.calls[0]?.url).toContain('page_size=3');
      await client.flags.findByFlagable('Asset', 42, { limit: 100, expand: true });
      expect(spy.calls[1]?.url).toContain('page_size=100');
      await expect(client.flags.findByFlagable('Asset', 42, { limit: 101 })).rejects.toBeInstanceOf(HuduConfigError);
      await expect(client.flags.findByFlagable('Asset', 42, { limit: -1 })).rejects.toBeInstanceOf(HuduConfigError);
      await expect(client.flags.findByFlagable('Asset', 42, { limit: 2.5 })).rejects.toBeInstanceOf(HuduConfigError);
      expect(spy.calls).toHaveLength(2);
    });

    it('rejects a flagable reference the vendor filter cannot express', async () => {
      const spy = stubFetch(() => json({ flags: [] }));
      await expect(makeClient().flags.findByFlagable('', 42)).rejects.toBeInstanceOf(HuduConfigError);
      await expect(makeClient().flags.findByFlagable('Asset', 0)).rejects.toBeInstanceOf(HuduConfigError);
      expect(spy.calls).toHaveLength(0);
    });
  });
});
