/**
 * FlagTypesResource — primitive contract + agent-execution-layer helper rows (group B).
 *
 * Every test title here is asserted verbatim by `npm run capabilities:check` against the
 * `flag_types.*` rows of capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, NotFoundError, ResolutionError, StaleObjectError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/flag_types';

const FLAG_TYPE_FULL = {
  id: 7,
  name: 'Critical',
  slug: 'critical',
  color: 'Red' as const,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

const FLAG_TYPE_SUMMARY = { id: 7, name: 'Critical', slug: 'critical', color: 'Red' };

/** 25 rows for a vendor filter that did not actually filter: a FULL page, so the scan keeps paging. */
const FULL_NON_MATCHING_PAGE = Array.from({ length: 25 }, (_, index) => ({
  ...FLAG_TYPE_FULL,
  id: 1000 + index,
  name: `Other ${index}`,
  slug: `other-${index}`,
}));

function makeClient(onAudit?: (event: AuditEvent) => void): HuduClient {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    ...(onAudit === undefined ? {} : { onAudit }),
  });
}

describe('flag_types', () => {
  afterEach(() => clearFetch());

  describe('primitives', () => {
    it('returns the unwrapped flag_types record', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const record = await makeClient().flagTypes.get(7);
      expect(record).toEqual(FLAG_TYPE_FULL);
      expect(spy.calls[0]?.url).toBe(`${BASE}/7`);
    });

    it('normalises a 404 into NOT_FOUND', async () => {
      stubFetch(() => json({ error: 'not found' }, 404));
      await expect(makeClient().flagTypes.get(7)).rejects.toMatchObject({
        name: 'NotFoundError',
        code: 'NOT_FOUND',
        httpStatus: 404,
      });
    });

    it('returns the unwrapped flag_types list', async () => {
      const spy = stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL] }));
      const items = await makeClient().flagTypes.listAll();
      expect(items).toEqual([FLAG_TYPE_FULL]);
      expect(spy.calls[0]?.url).toContain(BASE);
    });

    it('sends page/page_size and stops on a short page', async () => {
      const spy = stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL] }));
      await makeClient().flagTypes.listAll();
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toContain('page=1');
      expect(spy.calls[0]?.url).toContain('page_size=25');
    });

    it('returns the created flag_types record', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }, 201));
      const created = await makeClient().flagTypes.create({ name: 'Critical', slug: 'critical' });
      expect(created).toEqual(FLAG_TYPE_FULL);
      expect(spy.calls[0]?.init.method).toBe('POST');
      expect(spy.calls[0]?.init.body).toBe(JSON.stringify({ flag_type: { name: 'Critical', slug: 'critical' } }));
    });

    it('returns the updated flag_types record', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const updated = await makeClient().flagTypes.update(7, { name: 'Severe' });
      expect(updated).toEqual(FLAG_TYPE_FULL);
      expect(spy.calls[0]?.init.method).toBe('PUT');
      expect(spy.calls[0]?.url).toBe(`${BASE}/7`);
    });

    it('unwraps the PUT response by singleKey', async () => {
      stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const updated = await makeClient().flagTypes.update(7, { name: 'Severe' });
      expect(updated).toEqual(FLAG_TYPE_FULL);
      expect(updated).not.toHaveProperty('flag_type');
    });

    it('resolves void after a successful delete', async () => {
      const spy = stubFetch(() => empty(204));
      await expect(makeClient().flagTypes.delete(7)).resolves.toBeUndefined();
      expect(spy.calls[0]?.init.method).toBe('DELETE');
      expect(spy.calls[0]?.url).toBe(`${BASE}/7`);
    });

    it('dry-run issues no mutating request and returns simulated: true', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }, 201));
      const result = await makeClient().flagTypes.create({ name: 'Critical' }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.operation).toBe('flag_types.create');
      expect(result.request).toEqual({ method: 'POST', path: '/flag_types' });
      expect(spy.calls).toHaveLength(0);
    });

    it('dry-run issues no PUT request and returns simulated: true', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const result = await makeClient().flagTypes.update(7, { name: 'Severe' }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'PUT', path: '/flag_types/7' });
      expect(result.target).toEqual({ resource: 'flag_types', ids: [7] });
      expect(spy.calls).toHaveLength(0);
    });

    it('refuses expectedUpdatedAt on the create and delete paths, which carry no stale guard', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const client = makeClient();
      for (const attempt of [
        client.flagTypes.create({ name: 'Critical' }, { expectedUpdatedAt: 'v1' }),
        client.flagTypes.delete(7, { expectedUpdatedAt: 'v1' }),
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
      const result = await makeClient().flagTypes.delete(7, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'DELETE', path: '/flag_types/7' });
      expect(result.impact.reversible).toBe(false);
      expect(spy.calls).toHaveLength(0);
    });

    it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
      const mismatchSpy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const failure = await makeClient()
        .flagTypes.update(7, { name: 'Severe' }, { expectedUpdatedAt: '2020-01-01T00:00:00Z' })
        .then(
          () => undefined,
          (err: unknown) => err as StaleObjectError,
        );
      expect(failure).toBeInstanceOf(StaleObjectError);
      expect(failure?.code).toBe('STALE_OBJECT');
      expect(failure?.category).toBe('conflict');
      expect(failure?.retryable).toBe(false);
      expect(failure?.operation).toBe('flag_types.update');
      expect(mismatchSpy.calls).toHaveLength(1);
      expect(mismatchSpy.calls[0]?.init.method).toBe('GET');

      const matchSpy = stubFetch((url, init) =>
        init.method === 'PUT' ? json({ flag_type: { ...FLAG_TYPE_FULL, name: 'Severe' } }) : json({ flag_type: FLAG_TYPE_FULL }),
      );
      const updated = await makeClient().flagTypes.update(
        7,
        { name: 'Severe' },
        { expectedUpdatedAt: FLAG_TYPE_FULL.updated_at },
      );
      expect(updated).toMatchObject({ id: 7, name: 'Severe' });
      expect(matchSpy.calls.map((call) => call.init.method)).toEqual(['GET', 'PUT']);
    });

    it('surfaces a correlation id on the success path and the error path', async () => {
      const events: AuditEvent[] = [];
      const client = makeClient((event) => events.push(event));
      stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      await client.flagTypes.get(7);
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events[0]?.outcome).toBe('success');

      stubFetch(() => json({ error: 'nope' }, 400));
      const failure = await client.flagTypes.get(7).then(
        () => undefined,
        (err: unknown) => err as { correlationId?: string; code?: string },
      );
      expect(failure?.code).toBe('BAD_REQUEST');
      expect(events[1]?.outcome).toBe('error');
      expect(events[1]?.correlationId).toBe(failure?.correlationId);
    });
  });

  describe('resolve', () => {
    it('fetches by id without a scan', async () => {
      const spy = stubFetch(() => json({ flag_type: FLAG_TYPE_FULL }));
      const found = await makeClient().flagTypes.resolve(7);
      expect(found).toEqual(FLAG_TYPE_SUMMARY);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toBe(`${BASE}/7`);
      expect(spy.calls[0]?.url).not.toContain('slug=');
      expect(spy.calls[0]?.url).not.toContain('name=');
    });

    it('throws NOT_FOUND for an unknown id', async () => {
      stubFetch(() => json({ error: 'not found' }, 404));
      const failure = await makeClient()
        .flagTypes.resolve('999')
        .then(
          () => undefined,
          (err: unknown) => err as NotFoundError,
        );
      expect(failure).toBeInstanceOf(NotFoundError);
      expect(failure?.code).toBe('NOT_FOUND');
      expect(failure?.operation).toBe('flag_types.resolve');
      expect(failure?.resourceIds).toEqual([999]);

      // A non-404 failure is propagated unchanged, never re-labelled as a miss.
      stubFetch(() => json({ error: 'bad request' }, 400));
      await expect(makeClient().flagTypes.resolve(7)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns the single exact match', async () => {
      const spy = stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL] }));
      const found = await makeClient().flagTypes.resolve('critical');
      expect(found).toEqual(FLAG_TYPE_SUMMARY);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toContain('slug=critical');
    });

    it('falls through from slug to exact name for a bare value', async () => {
      const spy = stubFetch((url) =>
        url.includes('slug=') ? json({ flag_types: [] }) : json({ flag_types: [FLAG_TYPE_FULL] }),
      );
      const found = await makeClient().flagTypes.resolve('Critical');
      expect(found).toEqual(FLAG_TYPE_SUMMARY);
      expect(spy.calls).toHaveLength(2);
      expect(spy.calls[0]?.url).toContain('slug=Critical');
      expect(spy.calls[1]?.url).toContain('name=Critical');
    });

    it('returns null after a complete scan', async () => {
      const spy = stubFetch(() => json({ flag_types: [] }));
      await expect(makeClient().flagTypes.resolve('nope')).resolves.toBeNull();
      // The documented kind order: slug first, then exact name, each searched completely.
      expect(spy.calls).toHaveLength(2);
      expect(spy.calls[0]?.url).toContain('slug=nope');
      expect(spy.calls[1]?.url).toContain('name=nope');
    });

    it('returns FlagTypeSummary', async () => {
      stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL] }));
      const found = await makeClient().flagTypes.resolve({ slug: 'critical' });
      expect(found).toEqual(FLAG_TYPE_SUMMARY);
      expect(found).not.toHaveProperty('created_at');
      expect(found).not.toHaveProperty('updated_at');
      expect(Object.keys(found ?? {}).sort()).toEqual(Object.keys(FLAG_TYPE_SUMMARY).sort());
    });

    it('expand: true returns the full flag type', async () => {
      stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL] }));
      const found = await makeClient().flagTypes.resolve({ name: 'Critical' }, { expand: true });
      expect(found).toEqual(FLAG_TYPE_FULL);
      expect(found).toHaveProperty('created_at', '2026-01-01T00:00:00Z');
    });

    it('throws RESOLUTION_AMBIGUOUS with the candidate ids when the filter is not unique', async () => {
      const duplicate = { ...FLAG_TYPE_FULL, id: 8, slug: 'critical-2' };
      stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL, duplicate] }));
      const failure = await makeClient()
        .flagTypes.resolve({ name: 'Critical' })
        .then(
          () => undefined,
          (err: unknown) => err as ResolutionError,
        );
      expect(failure).toBeInstanceOf(ResolutionError);
      expect(failure?.code).toBe('RESOLUTION_AMBIGUOUS');
      expect(failure?.category).toBe('resolution');
      expect(failure?.resourceIds).toEqual([7, 8]);
    });

    it('resolutionDetails: true reports a complete miss as value null, never as truncated', async () => {
      stubFetch(() => json({ flag_types: [] }));
      await expect(makeClient().flagTypes.resolve('nope', { resolutionDetails: true })).resolves.toEqual({
        value: null,
        resolutionCost: 'server-filter',
        scanned: 0,
        scanTruncated: false,
      });
    });

    it('throws RESOLUTION_TRUNCATED when the filtered scan hits the cap', async () => {
      const spy = stubFetch(() => json({ flag_types: FULL_NON_MATCHING_PAGE }));
      const failure = await makeClient()
        .flagTypes.resolve({ slug: 'missing' })
        .then(
          () => undefined,
          (err: unknown) => err as ResolutionError,
        );
      expect(failure).toBeInstanceOf(ResolutionError);
      expect(failure?.code).toBe('RESOLUTION_TRUNCATED');
      expect(failure?.retryable).toBe(false);
      // Bounded by the client page cap (4), never unbounded.
      expect(spy.calls).toHaveLength(4);
    });

    it('an unsupported identifier kind is refused with the accepted kinds named', async () => {
      const spy = stubFetch(() => json({ flag_types: [] }));
      const failure = await makeClient()
        .flagTypes.resolve({ domain: 'example.com' })
        .then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
      expect(failure).toBeInstanceOf(HuduConfigError);
      expect(failure?.category).toBe('validation');
      expect(failure?.message).toContain('slug');
      expect(failure?.message).toContain('name');
      expect(spy.calls).toHaveLength(0);
    });

    it('resolutionDetails: true reports the server-filter cost', async () => {
      stubFetch(() => json({ flag_types: [FLAG_TYPE_FULL] }));
      await expect(makeClient().flagTypes.resolve({ slug: 'critical' }, { resolutionDetails: true })).resolves.toEqual({
        value: FLAG_TYPE_SUMMARY,
        resolutionCost: 'server-filter',
        scanned: 1,
        scanTruncated: false,
        candidates: [{ id: 7, label: '#7 Critical (critical)' }],
      });
    });
  });
});
