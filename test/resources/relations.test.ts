/**
 * RelationsResource — primitive contract + agent-execution-layer helper rows (group B).
 *
 * Every test title here is asserted verbatim by `npm run capabilities:check` against the
 * `relations.*` rows of capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, NotFoundError, ResolutionError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/relations';

const REL_FULL = {
  id: 21,
  description: 'serves',
  is_inverse: false,
  name: 'Asset to Company',
  fromable_id: 42,
  fromable_type: 'Asset',
  fromable_url: 'https://hudu.example.com/assets/42',
  toable_id: 7,
  toable_type: 'Company',
  toable_url: 'https://hudu.example.com/companies/7',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

const REL_SUMMARY = {
  id: 21,
  name: 'Asset to Company',
  description: 'serves',
  is_inverse: false,
  fromable_id: 42,
  fromable_type: 'Asset',
  fromable_url: 'https://hudu.example.com/assets/42',
  toable_id: 7,
  toable_type: 'Company',
  toable_url: 'https://hudu.example.com/companies/7',
};

/** 25 non-matching relations — a FULL page, so the scan keeps paging until the page cap. */
const FULL_NON_MATCHING_PAGE = Array.from({ length: 25 }, (_, index) => ({
  ...REL_FULL,
  id: 1000 + index,
}));

function makeClient(onAudit?: (event: AuditEvent) => void): HuduClient {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    ...(onAudit === undefined ? {} : { onAudit }),
  });
}

describe('relations', () => {
  afterEach(() => clearFetch());

  describe('primitives', () => {
    it('returns the unwrapped relations list', async () => {
      const spy = stubFetch(() => json({ relations: [REL_FULL] }));
      const items = await makeClient().relations.listAll();
      expect(items).toEqual([REL_FULL]);
      expect(spy.calls[0]?.url).toContain(BASE);
    });

    it('sends page/page_size and stops on a short page', async () => {
      const spy = stubFetch(() => json({ relations: [REL_FULL] }));
      const items = await makeClient().relations.listAll();
      expect(items).toEqual([REL_FULL]);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toContain('page=1');
      expect(spy.calls[0]?.url).toContain('page_size=25');
    });

    it('returns the created relations record', async () => {
      const spy = stubFetch(() => json({ relation: REL_FULL }, 201));
      const created = await makeClient().relations.create({ fromable_type: 'Asset', fromable_id: 42 });
      expect(created).toEqual(REL_FULL);
      expect(spy.calls[0]?.init.method).toBe('POST');
      expect(spy.calls[0]?.init.body).toBe(
        JSON.stringify({ relation: { fromable_type: 'Asset', fromable_id: 42 } }),
      );
    });

    it('dry-run issues no mutating request and returns simulated: true', async () => {
      const spy = stubFetch(() => json({ relation: REL_FULL }, 201));
      const result = await makeClient().relations.create({ fromable_type: 'Asset' }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.operation).toBe('relations.create');
      expect(result.request).toEqual({ method: 'POST', path: '/relations' });
      expect(spy.calls).toHaveLength(0);
    });

    it('refuses expectedUpdatedAt on create and delete, which carry no stale guard', async () => {
      const spy = stubFetch(() => json({ relation: REL_FULL }));
      const client = makeClient();
      for (const attempt of [
        client.relations.create({ fromable_type: 'Asset' }, { expectedUpdatedAt: 'v1' }),
        client.relations.delete(21, { expectedUpdatedAt: 'v1' }),
      ]) {
        const failure = await attempt.then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
        expect(failure).toBeInstanceOf(HuduConfigError);
        expect(failure?.code).toBe('CONFIG_ERROR');
        expect(failure?.message).toContain('staleCheck');
      }
      expect(spy.calls).toHaveLength(0);
    });

    it('resolves void after a successful delete', async () => {
      const spy = stubFetch(() => empty(204));
      await expect(makeClient().relations.delete(21)).resolves.toBeUndefined();
      expect(spy.calls[0]?.init.method).toBe('DELETE');
      expect(spy.calls[0]?.url).toBe(`${BASE}/21`);
    });

    it('dry-run issues no DELETE request and returns simulated: true', async () => {
      const spy = stubFetch(() => empty(204));
      const result = await makeClient().relations.delete(21, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'DELETE', path: '/relations/21' });
      expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
      expect(spy.calls).toHaveLength(0);
    });

    it('surfaces a correlation id on the success path and the error path', async () => {
      const events: AuditEvent[] = [];
      const client = makeClient((event) => events.push(event));
      stubFetch(() => json({ relations: [REL_FULL] }));
      await client.relations.listAll();
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events[0]?.outcome).toBe('success');

      stubFetch(() => json({ error: 'nope' }, 400));
      const failure = await client.relations.listAll().then(
        () => undefined,
        (err: unknown) => err as { correlationId?: string; code?: string },
      );
      expect(failure?.code).toBe('BAD_REQUEST');
      expect(failure?.correlationId).toBeTruthy();
      expect(events[1]?.outcome).toBe('error');
      expect(events[1]?.correlationId).toBe(failure?.correlationId);
    });
  });

  describe('resolve (bounded client scan — the vendor exposes no GET /relations/{id})', () => {
    it('finds the relation by a bounded client scan', async () => {
      const spy = stubFetch(() => json({ relations: [REL_FULL] }));
      const found = await makeClient().relations.resolve(21);
      expect(found).toEqual(REL_SUMMARY);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toContain('page=1');
      expect(spy.calls[0]?.url).toContain('page_size=25');
    });

    it('throws NOT_FOUND when the complete scan has no match', async () => {
      const spy = stubFetch(() => json({ relations: [] }));
      const failure = await makeClient()
        .relations.resolve(999)
        .then(
          () => undefined,
          (err: unknown) => err as NotFoundError,
        );
      expect(failure).toBeInstanceOf(NotFoundError);
      expect(failure?.code).toBe('NOT_FOUND');
      expect(failure?.operation).toBe('relations.resolve');
      expect(failure?.resourceIds).toEqual([999]);
      // One page, empty: the scan is complete, so the id really does not exist.
      expect(spy.calls).toHaveLength(1);
    });

    it('throws RESOLUTION_TRUNCATED instead of null when the scan hits the cap', async () => {
      const spy = stubFetch(() => json({ relations: FULL_NON_MATCHING_PAGE }));
      const failure = await makeClient()
        .relations.resolve(21)
        .then(
          () => undefined,
          (err: unknown) => err as ResolutionError,
        );
      expect(failure).toBeInstanceOf(ResolutionError);
      expect(failure?.code).toBe('RESOLUTION_TRUNCATED');
      expect(failure?.category).toBe('resolution');
      expect(failure?.retryable).toBe(false);
      // The scan stopped at the configured page cap (4 pages), not at the record cap.
      expect(spy.calls).toHaveLength(4);
    });

    it('returns RelationSummary', async () => {
      stubFetch(() => json({ relations: [REL_FULL] }));
      const found = await makeClient().relations.resolve(21);
      expect(found).toEqual(REL_SUMMARY);
      expect(found).not.toHaveProperty('created_at');
      expect(found).not.toHaveProperty('updated_at');
    });

    it('expand: true returns the full record', async () => {
      stubFetch(() => json({ relations: [REL_FULL] }));
      const found = await makeClient().relations.resolve(21, { expand: true });
      expect(found).toEqual(REL_FULL);
      expect(found).toHaveProperty('created_at', '2026-01-01T00:00:00Z');
    });

    it('resolutionDetails: true reports the scan cost', async () => {
      stubFetch(() => json({ relations: [REL_FULL] }));
      const resolution = await makeClient().relations.resolve(21, { resolutionDetails: true });
      expect(resolution).toEqual({
        value: REL_SUMMARY,
        resolutionCost: 'client-scan',
        scanned: 1,
        scanTruncated: false,
        candidates: [{ id: 21, label: 'Asset to Company (#21: Asset 42 -> Company 7)' }],
      });
    });

    it('resolutionDetails: true reports an undecided miss as a complete scan, never as truncated', async () => {
      stubFetch(() => json({ relations: [] }));
      await expect(makeClient().relations.resolve(999, { resolutionDetails: true })).resolves.toEqual({
        value: null,
        resolutionCost: 'client-scan',
        scanned: 0,
        scanTruncated: false,
      });
    });

    it('an unsupported identifier kind is refused with the accepted kind named', async () => {
      const spy = stubFetch(() => json({ relations: [] }));
      const failure = await makeClient()
        .relations.resolve({ description: 'serves' })
        .then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
      expect(failure).toBeInstanceOf(HuduConfigError);
      expect(failure?.category).toBe('validation');
      expect(failure?.message).toContain('numeric id');
      await expect(makeClient().relations.resolve('Asset to Company')).rejects.toBeInstanceOf(HuduConfigError);
      expect(spy.calls).toHaveLength(0);
    });

    it('allowClientScan: false refuses the only lookup path with RESOLUTION_TRUNCATED', async () => {
      const spy = stubFetch(() => json({ relations: [REL_FULL] }));
      const failure = await makeClient()
        .relations.resolve(21, { allowClientScan: false })
        .then(
          () => undefined,
          (err: unknown) => err as ResolutionError,
        );
      expect(failure?.code).toBe('RESOLUTION_TRUNCATED');
      expect(spy.calls).toHaveLength(0);
    });
  });

  describe('findByEndpoints (vendor fromable_/toable_ filters, no scan)', () => {
    it('returns the relations between the two endpoints', async () => {
      const spy = stubFetch(() => json({ relations: [REL_FULL] }));
      const found = await makeClient().relations.findByEndpoints(
        { type: 'Asset', id: 42 },
        { type: 'Company', id: 7 },
      );
      expect(found).toEqual([REL_SUMMARY]);
      expect(spy.calls).toHaveLength(1);
      const url = spy.calls[0]?.url ?? '';
      expect(url).toContain('fromable_type=Asset');
      expect(url).toContain('fromable_id=42');
      expect(url).toContain('toable_type=Company');
      expect(url).toContain('toable_id=7');
      expect(url).toContain('page_size=25');
    });

    it('respects fromable/toable direction and is_inverse', async () => {
      const forward = stubFetch(() => json({ relations: [REL_FULL] }));
      const asForward = await makeClient().relations.findByEndpoints(
        { type: 'Asset', id: 42 },
        { type: 'Company', id: 7 },
        { isInverse: false },
      );
      expect(asForward).toEqual([REL_SUMMARY]);
      const forwardUrl = forward.calls[0]?.url ?? '';
      expect(forwardUrl).toContain('fromable_type=Asset');
      expect(forwardUrl).toContain('toable_type=Company');
      expect(forwardUrl).toContain('is_inverse=false');

      // The same pair asked in the other direction sends the endpoints swapped and reports the
      // inverse record the vendor keeps — the helper never re-interprets direction client-side.
      const inverseRecord = { ...REL_FULL, id: 22, is_inverse: true, fromable_id: 7, fromable_type: 'Company', toable_id: 42, toable_type: 'Asset' };
      const backward = stubFetch(() => json({ relations: [inverseRecord] }));
      const asBackward = await makeClient().relations.findByEndpoints(
        { type: 'Company', id: 7 },
        { type: 'Asset', id: 42 },
        { isInverse: true, expand: true },
      );
      const backwardUrl = backward.calls[0]?.url ?? '';
      expect(backwardUrl).toContain('fromable_type=Company');
      expect(backwardUrl).toContain('toable_type=Asset');
      expect(backwardUrl).toContain('is_inverse=true');
      expect(asBackward).toEqual([inverseRecord]);
      expect((asBackward[0] as { is_inverse: boolean }).is_inverse).toBe(true);
    });

    it('returns an empty array when the records are not related', async () => {
      stubFetch(() => json({ relations: [] }));
      await expect(
        makeClient().relations.findByEndpoints({ type: 'Asset', id: 42 }, { type: 'Company', id: 8 }),
      ).resolves.toEqual([]);
    });

    it('honours limit and never exceeds 100', async () => {
      const spy = stubFetch(() => json({ relations: [REL_FULL] }));
      const client = makeClient();
      await client.relations.findByEndpoints({ type: 'Asset', id: 42 }, { type: 'Company', id: 7 }, { limit: 5 });
      expect(spy.calls[0]?.url).toContain('page_size=5');

      await expect(
        client.relations.findByEndpoints({ type: 'Asset', id: 42 }, { type: 'Company', id: 7 }, { limit: 101 }),
      ).rejects.toBeInstanceOf(HuduConfigError);
      await expect(
        client.relations.findByEndpoints({ type: 'Asset', id: 42 }, { type: 'Company', id: 7 }, { limit: 0 }),
      ).rejects.toBeInstanceOf(HuduConfigError);
      await expect(
        client.relations.findByEndpoints({ type: 'Asset', id: 42 }, { type: 'Company', id: 7 }, { limit: 2.5 }),
      ).rejects.toBeInstanceOf(HuduConfigError);
      // The refused calls never reached the network.
      expect(spy.calls).toHaveLength(1);
    });

    it('rejects a malformed endpoint reference before any request', async () => {
      const spy = stubFetch(() => json({ relations: [] }));
      await expect(
        makeClient().relations.findByEndpoints({ type: '', id: 42 }, { type: 'Company', id: 7 }),
      ).rejects.toBeInstanceOf(HuduConfigError);
      expect(spy.calls).toHaveLength(0);
    });
  });
});
