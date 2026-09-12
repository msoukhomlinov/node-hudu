/**
 * RackStorageItemsResource — primitive contract + agent-execution-layer helper rows (group B).
 *
 * Every test title here is asserted verbatim by `npm run capabilities:check` against the
 * `rack_storage_items.*` rows of capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, NotFoundError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/rack_storage_items';

const FULL = {
  id: 11,
  rack_storage_role_id: 3,
  asset_id: 42,
  start_unit: 5,
  end_unit: 8,
  status: 1,
  side: 0,
  max_wattage: 400,
  power_draw: 120,
  rack_storage_role_name: 'Server',
  reserved_message: 'held for maintenance',
  rack_storage_role_description: 'A rack role',
  rack_storage_role_hex_color: '#ffffff',
  asset_name: 'srv-1',
  asset_url: 'https://hudu.example.com/assets/42',
  url: 'https://hudu.example.com/rack_storage_items/11',
  company_id: 7,
};

const SUMMARY = {
  id: 11,
  asset_id: 42,
  asset_name: 'srv-1',
  asset_url: 'https://hudu.example.com/assets/42',
  rack_storage_role_id: 3,
  rack_storage_role_name: 'Server',
  start_unit: 5,
  end_unit: 8,
  side: 0,
  status: 1,
  company_id: 7,
  url: 'https://hudu.example.com/rack_storage_items/11',
};

function makeClient(onAudit?: (event: AuditEvent) => void): HuduClient {
  return new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    ...(onAudit === undefined ? {} : { onAudit }),
  });
}

describe('rack_storage_items', () => {
  afterEach(() => clearFetch());

  describe('primitives', () => {
    it('returns the unwrapped rack_storage_items record', async () => {
      const spy = stubFetch(() => json(FULL));
      const record = await makeClient().rackStorageItems.get(11);
      expect(record).toEqual(FULL);
      expect(spy.calls[0]?.url).toBe(`${BASE}/11`);
      expect(spy.calls[0]?.init.method).toBe('GET');
    });

    it('normalises a 404 into NOT_FOUND', async () => {
      stubFetch(() => json({ error: 'not found' }, 404));
      await expect(makeClient().rackStorageItems.get(11)).rejects.toMatchObject({
        name: 'NotFoundError',
        code: 'NOT_FOUND',
        httpStatus: 404,
        category: 'not_found',
      });
    });

    it('returns the unwrapped rack_storage_items list', async () => {
      const spy = stubFetch(() => json([FULL]));
      const items = await makeClient().rackStorageItems.listAll();
      expect(items).toEqual([FULL]);
      expect(spy.calls[0]?.url).toContain(BASE);
    });

    it('never sends page/page_size to the non-paginated endpoint', async () => {
      const spy = stubFetch(() => json([FULL]));
      const items = await makeClient().rackStorageItems.listAll({ page: 3, page_size: 2 });
      expect(items).toEqual([FULL]);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toBe(BASE);
      expect(spy.calls[0]?.url).not.toContain('page');
    });

    it('returns the created rack_storage_items record', async () => {
      const spy = stubFetch(() => json(FULL, 201));
      const created = await makeClient().rackStorageItems.create({ asset_id: 42, start_unit: 5 });
      expect(created).toEqual(FULL);
      expect(spy.calls[0]?.init.method).toBe('POST');
      expect(spy.calls[0]?.init.body).toBe(JSON.stringify({ rack_storage_item: { asset_id: 42, start_unit: 5 } }));
    });

    it('returns the updated rack_storage_items record', async () => {
      const spy = stubFetch(() => json(FULL));
      const updated = await makeClient().rackStorageItems.update(11, { start_unit: 6 });
      expect(updated).toEqual(FULL);
      expect(spy.calls[0]?.init.method).toBe('PUT');
      expect(spy.calls[0]?.url).toBe(`${BASE}/11`);
    });

    it('unwraps the PUT response by singleKey', async () => {
      // rack_storage_items declares no singleKey, so the documented normalisation is a pass-through:
      // the PUT body is returned unchanged and is never re-read as an envelope.
      stubFetch(() => json(FULL));
      await expect(makeClient().rackStorageItems.update(11, { start_unit: 6 })).resolves.toEqual(FULL);
    });

    it('resolves void after a successful delete', async () => {
      const spy = stubFetch(() => empty(204));
      await expect(makeClient().rackStorageItems.delete(11)).resolves.toBeUndefined();
      expect(spy.calls[0]?.init.method).toBe('DELETE');
      expect(spy.calls[0]?.url).toBe(`${BASE}/11`);
    });

    it('dry-run issues no mutating request and returns simulated: true', async () => {
      const spy = stubFetch(() => json(FULL, 201));
      const result = await makeClient().rackStorageItems.create({ asset_id: 42 }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.operation).toBe('rack_storage_items.create');
      expect(result.request).toEqual({ method: 'POST', path: '/rack_storage_items' });
      expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
      expect(spy.calls).toHaveLength(0);
    });

    it('dry-run issues no PUT request and returns simulated: true', async () => {
      const spy = stubFetch(() => json(FULL));
      const result = await makeClient().rackStorageItems.update(11, { start_unit: 6 }, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'PUT', path: '/rack_storage_items/11' });
      expect(result.target).toEqual({ resource: 'rack_storage_items', ids: [11] });
      expect(spy.calls).toHaveLength(0);
    });

    it('refuses expectedUpdatedAt on every mutation, because no revision field exists', async () => {
      const spy = stubFetch(() => json(FULL));
      const client = makeClient();
      for (const attempt of [
        client.rackStorageItems.create({ asset_id: 42 }, { expectedUpdatedAt: 'v1' }),
        client.rackStorageItems.update(11, { start_unit: 6 }, { expectedUpdatedAt: 'v1' }),
        client.rackStorageItems.delete(11, { expectedUpdatedAt: 'v1' }),
      ]) {
        const failure = await attempt.then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
        expect(failure).toBeInstanceOf(HuduConfigError);
        expect(failure?.code).toBe('CONFIG_ERROR');
        expect(failure?.category).toBe('validation');
        expect(failure?.message).toContain('staleCheck');
      }
      expect(spy.calls).toHaveLength(0);
    });

    it('dry-run issues no DELETE request and returns simulated: true', async () => {
      const spy = stubFetch(() => empty(204));
      const result = await makeClient().rackStorageItems.delete(11, { dryRun: true });
      expect(result.simulated).toBe(true);
      expect(result.request).toEqual({ method: 'DELETE', path: '/rack_storage_items/11' });
      expect(result.impact.scope).toBe('single');
      expect(result.impact.reversible).toBe(false);
      expect(spy.calls).toHaveLength(0);
    });

    it('surfaces a correlation id on the success path and the error path', async () => {
      const events: AuditEvent[] = [];
      const client = makeClient((event) => events.push(event));
      stubFetch(() => json(FULL));
      await client.rackStorageItems.get(11);
      expect(events).toHaveLength(1);
      expect(events[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events[0]?.outcome).toBe('success');

      stubFetch(() => json({ error: 'nope' }, 400));
      const failure = await client.rackStorageItems.get(11).then(
        () => undefined,
        (err: unknown) => err as { correlationId?: string; code?: string },
      );
      expect(failure?.code).toBe('BAD_REQUEST');
      expect(failure?.correlationId).toBeTruthy();
      expect(events).toHaveLength(2);
      expect(events[1]?.outcome).toBe('error');
      expect(events[1]?.correlationId).toBe(failure?.correlationId);
    });
  });

  describe('resolve', () => {
    it('fetches by id without a scan', async () => {
      const spy = stubFetch(() => json(FULL));
      const found = await makeClient().rackStorageItems.resolve(11);
      expect(found).toEqual(SUMMARY);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toBe(`${BASE}/11`);
      expect(spy.calls[0]?.url).not.toContain('page_size');
    });

    it('throws NOT_FOUND for an unknown id', async () => {
      const spy = stubFetch(() => json({ error: 'not found' }, 404));
      await expect(makeClient().rackStorageItems.resolve(999)).rejects.toBeInstanceOf(NotFoundError);
      const failure = await makeClient()
        .rackStorageItems.resolve(999)
        .then(
          () => undefined,
          (err: unknown) => err as NotFoundError,
        );
      expect(failure?.code).toBe('NOT_FOUND');
      expect(failure?.operation).toBe('rack_storage_items.resolve');
      expect(failure?.resourceIds).toEqual([999]);
      expect(spy.calls).toHaveLength(2);
    });

    it('throws a validation error naming the accepted identifier kind instead of scanning', async () => {
      const spy = stubFetch(() => json([FULL]));
      const failure = await makeClient()
        .rackStorageItems.resolve({ name: 'srv-1' })
        .then(
          () => undefined,
          (err: unknown) => err as HuduConfigError,
        );
      expect(failure).toBeInstanceOf(HuduConfigError);
      expect(failure?.code).toBe('CONFIG_ERROR');
      expect(failure?.category).toBe('validation');
      expect(failure?.message).toContain('numeric id');
      expect(failure?.message).toContain('listAll');
      // No scan ran, and no HTTP request was issued.
      expect(spy.calls).toHaveLength(0);
    });

    it('refuses every non-id kind — including a fractional id and a circular object — without a request', async () => {
      const spy = stubFetch(() => json([FULL]));
      const circular: Record<string, unknown> = { name: 'srv-1' };
      circular.self = circular;
      const client = makeClient();
      for (const rejected of ['srv-1', 0, 1.5, circular, { id: 0 }] as const) {
        await expect(client.rackStorageItems.resolve(rejected as never)).rejects.toBeInstanceOf(HuduConfigError);
      }
      expect(spy.calls).toHaveLength(0);
    });

    it('propagates a non-404 failure unchanged', async () => {
      stubFetch(() => json({ error: 'bad request' }, 400));
      await expect(makeClient().rackStorageItems.resolve(11)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        category: 'validation',
      });
    });

    it('returns RackStorageItemSummary', async () => {
      stubFetch(() => json(FULL));
      const found = await makeClient().rackStorageItems.resolve({ id: 11 });
      expect(found).toEqual(SUMMARY);
      expect(Object.keys(found ?? {}).sort()).toEqual(Object.keys(SUMMARY).sort());
      for (const dropped of [
        'max_wattage',
        'power_draw',
        'reserved_message',
        'rack_storage_role_description',
        'rack_storage_role_hex_color',
      ]) {
        expect(found).not.toHaveProperty(dropped);
      }
    });

    it('expand: true returns the full item', async () => {
      stubFetch(() => json(FULL));
      const found = await makeClient().rackStorageItems.resolve('11', { expand: true });
      expect(found).toEqual(FULL);
      expect(found).toHaveProperty('max_wattage', 400);
    });

    it('resolutionDetails: true reports a direct fetch', async () => {
      stubFetch(() => json(FULL));
      const resolution = await makeClient().rackStorageItems.resolve(11, { resolutionDetails: true });
      expect(resolution).toEqual({
        value: SUMMARY,
        resolutionCost: 'direct',
        scanned: 1,
        scanTruncated: false,
      });
    });
  });
});
