/**
 * F2 regression: the uniqueness decision must not depend on how many records the
 * caller asked to see. A resolving collector stops after at least two matches
 * (`ambiguityProbeLimit`), so `resolve(..., { limit: 1 })` over DUPLICATE records
 * throws RESOLUTION_AMBIGUOUS instead of returning the first duplicate as unique.
 * Also covers: a unique record still resolves with `limit: 1`, the default limit is
 * unchanged, a truncated scan still throws RESOLUTION_TRUNCATED, and a list helper
 * still applies `limit` to what it RETURNS (after collection).
 * Uses the shared mocked-fetch helper — never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../src/client.js';
import { HuduError } from '../src/errors.js';
import { ambiguityProbeLimit } from '../src/resources/agent-layer-helpers.js';
import { stubFetch, json, clearFetch } from './helpers.js';

const BASE = 'https://hudu.example.com';

function client() {
  return new HuduClient({ baseUrl: BASE, apiKey: 'k' });
}

async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the call to reject');
}

/** Paginated endpoint: `items` in a bare or enveloped body, 25 per page. */
function paged(items: unknown[], key?: string): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    const size = Number(url.searchParams.get('page_size') ?? '25');
    const slice = items.slice((page - 1) * size, page * size);
    return json(key === undefined ? slice : { [key]: slice });
  };
}

/** Non-paginated endpoint: the whole collection in one fetch. */
function oneShot(items: unknown[], key?: string): (url: URL) => Response {
  return () => json(key === undefined ? items : { [key]: items });
}

describe('ambiguityProbeLimit — the probe floor', () => {
  it('never returns fewer than 2 matches, and never more than the requested limit', () => {
    expect(ambiguityProbeLimit(1)).toBe(2);
    expect(ambiguityProbeLimit(2)).toBe(2);
    expect(ambiguityProbeLimit(25)).toBe(25);
    expect(ambiguityProbeLimit(100)).toBe(100);
  });
});

describe('procedures.resolve — limit: 1 keeps the ambiguity probe (F2)', () => {
  afterEach(() => clearFetch());

  const procedure = (id: number, slug: string) => ({
    id,
    name: `Process ${id}`,
    slug,
    company_id: 1,
    company_name: 'Acme',
    status: 'active',
    total: 2,
    completed: 1,
    completion_percentage: 50,
    process_type: 'normal',
    url: `${BASE}/processes/${id}`,
    updated_at: '2024-05-01T00:00:00Z',
  });

  it('throws RESOLUTION_AMBIGUOUS for a duplicate slug with limit: 1 (both ids present)', async () => {
    const spy = stubFetch((raw) => paged([procedure(11, 'quarterly'), procedure(12, 'quarterly')], 'procedures')(new URL(raw)));
    const err = await rejection(client().procedures.resolve({ slug: 'quarterly' }, { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12]);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolves a unique record with limit: 1', async () => {
    stubFetch((raw) => paged([procedure(11, 'quarterly')], 'procedures')(new URL(raw)));
    await expect(client().procedures.resolve({ slug: 'quarterly' }, { limit: 1 })).resolves.toMatchObject({ id: 11 });
  });

  it('is unchanged for the default limit (a duplicate still throws with both ids)', async () => {
    stubFetch((raw) => paged([procedure(11, 'quarterly'), procedure(12, 'quarterly')], 'procedures')(new URL(raw)));
    const err = await rejection(client().procedures.resolve({ slug: 'quarterly' }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12]);
  });

  it('throws RESOLUTION_TRUNCATED for a truncated scan, limit: 1 included', async () => {
    // No record matches the requested name: the scan runs to the page cap (default 4).
    const endless = stubFetch((raw) => {
      const url = new URL(raw);
      const size = Number(url.searchParams.get('page_size') ?? '25');
      return json({ procedures: Array.from({ length: size }, (_v, i) => procedure(100 + i, `other-${i}`)) });
    });
    const err = await rejection(client().procedures.resolve({ name: 'API TEST' }, { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(endless.calls).toHaveLength(4);
  });
});

describe('procedure_tasks.resolve — limit: 1 keeps the ambiguity probe (F2)', () => {
  afterEach(() => clearFetch());

  const task = (id: number, name: string) => ({
    id,
    name,
    procedure_id: 5,
    user_id: null,
    user_name: null,
    position: 1,
    priority: 'normal',
    completed: false,
    due_date: null,
    formatted_due_date: null,
    optional: false,
    description: '',
  });

  it('throws RESOLUTION_AMBIGUOUS for a duplicate name with limit: 1', async () => {
    const spy = stubFetch((raw) => oneShot([task(21, 'Backup'), task(22, 'Backup')], 'procedure_tasks')(new URL(raw)));
    const err = await rejection(client().procedureTasks.resolve({ name: 'Backup' }, { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([21, 22]);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolves a unique name with limit: 1', async () => {
    stubFetch((raw) => oneShot([task(21, 'Backup')], 'procedure_tasks')(new URL(raw)));
    await expect(client().procedureTasks.resolve({ name: 'Backup' }, { limit: 1 })).resolves.toMatchObject({ id: 21 });
  });

  it('is unchanged for the default limit (a duplicate still throws)', async () => {
    stubFetch((raw) => oneShot([task(21, 'Backup'), task(22, 'Backup')], 'procedure_tasks')(new URL(raw)));
    const err = await rejection(client().procedureTasks.resolve({ name: 'Backup' }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([21, 22]);
  });
});

describe('cards.resolve — limit: 1 keeps the ambiguity probe (F2)', () => {
  afterEach(() => clearFetch());

  const card = (id: number, slug: string) => ({
    id,
    integrator_name: `Card ${id}`,
    integration_slug: slug,
    link: `${BASE}/integrations/${id}`,
  });

  it('throws RESOLUTION_AMBIGUOUS for a duplicate integration_slug with limit: 1', async () => {
    const spy = stubFetch(oneShot([card(31, 'dup'), card(32, 'dup')], 'integrator_cards'));
    const err = await rejection(client().cards.resolve('dup', { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([31, 32]);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolves a unique card with limit: 1', async () => {
    stubFetch(oneShot([card(31, 'only')], 'integrator_cards'));
    await expect(client().cards.resolve('only', { limit: 1 })).resolves.toMatchObject({ id: 31 });
  });

  it('is unchanged for the default limit (a duplicate still throws)', async () => {
    stubFetch(oneShot([card(31, 'dup'), card(32, 'dup')], 'integrator_cards'));
    const err = await rejection(client().cards.resolve('dup'));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([31, 32]);
  });
});

describe('expirations.resolve — limit: 1 keeps the ambiguity probe (F2)', () => {
  afterEach(() => clearFetch());

  const expiration = (id: number, type: string, rid: number) => ({
    id,
    expirationable_type: type,
    expirationable_id: rid,
    expiration_type: 'one_time',
    date: '2024-06-01',
  });

  it('throws RESOLUTION_AMBIGUOUS for a duplicate { resource_type, resource_id } with limit: 1', async () => {
    const spy = stubFetch((raw) => paged([expiration(41, 'procedure', 11), expiration(42, 'procedure', 11)])(new URL(raw)));
    const err = await rejection(client().expirations.resolve({ resource_type: 'procedure', resource_id: 11 }, { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([41, 42]);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolves a unique expiration with limit: 1', async () => {
    stubFetch((raw) => paged([expiration(41, 'procedure', 11)])(new URL(raw)));
    await expect(client().expirations.resolve({ resource_type: 'procedure', resource_id: 11 }, { limit: 1 })).resolves.toMatchObject({ id: 41 });
  });

  it('is unchanged for the default limit (a duplicate still throws)', async () => {
    stubFetch((raw) => paged([expiration(41, 'procedure', 11), expiration(42, 'procedure', 11)])(new URL(raw)));
    const err = await rejection(client().expirations.resolve({ resource_type: 'procedure', resource_id: 11 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([41, 42]);
  });
});

describe('magicDash.resolve — limit: 1 keeps the ambiguity probe (F2)', () => {
  afterEach(() => clearFetch());

  const magicDash = (id: number, title: string) => ({ id, title, company_id: 1, message: 'msg' });

  it('throws RESOLUTION_AMBIGUOUS for a duplicate title with limit: 1', async () => {
    const spy = stubFetch((raw) => paged([magicDash(61, 'Renewal'), magicDash(62, 'Renewal')])(new URL(raw)));
    const err = await rejection(client().magicDash.resolve({ title: 'Renewal' }, { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([61, 62]);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolves a unique title with limit: 1', async () => {
    stubFetch((raw) => paged([magicDash(61, 'Renewal')])(new URL(raw)));
    await expect(client().magicDash.resolve({ title: 'Renewal' }, { limit: 1 })).resolves.toMatchObject({ id: 61 });
  });

  it('is unchanged for the default limit (a duplicate still throws)', async () => {
    stubFetch((raw) => paged([magicDash(61, 'Renewal'), magicDash(62, 'Renewal')])(new URL(raw)));
    const err = await rejection(client().magicDash.resolve({ title: 'Renewal' }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([61, 62]);
  });
});

describe('matchers — limit: 1 keeps the ambiguity probe (F2)', () => {
  afterEach(() => clearFetch());

  const matcher = (id: number, syncId: number) => ({
    id,
    name: `Matcher ${id}`,
    sync_id: syncId,
    identifier: `ext-${syncId}`,
    integration_id: 3,
    matched: true,
    object_type: 'procedure',
  });

  it('resolve throws RESOLUTION_AMBIGUOUS for a duplicate sync_id with limit: 1', async () => {
    const spy = stubFetch((raw) => paged([matcher(51, 7), matcher(52, 7)], 'matchers')(new URL(raw)));
    const err = await rejection(client().matchers.resolve({ sync_id: 7, integration_id: 3 }, { limit: 1 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([51, 52]);
    expect(spy.calls).toHaveLength(1);
  });

  it('findBySyncId applies limit to the returned slice AFTER collection (limit: 1 returns one)', async () => {
    stubFetch((raw) => paged([matcher(51, 7), matcher(52, 7)], 'matchers')(new URL(raw)));
    const list = await client().matchers.findBySyncId(7, 3, { limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 51 });
  });

  it('findBySyncId is unchanged for the default limit', async () => {
    stubFetch((raw) => paged([matcher(51, 7), matcher(52, 7)], 'matchers')(new URL(raw)));
    const list = await client().matchers.findBySyncId(7, 3);
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id)).toEqual([51, 52]);
  });
});
