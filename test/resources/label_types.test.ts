/**
 * LabelTypesResource — agent-execution-layer coverage: the helper tier (`resolve`)
 * with its compact `LabelTypeSummary`, dry-run, correlation ids and the opt-in stale
 * guard. Mocked fetch only; never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduError, HuduConfigError, NotFoundError, ResolutionError, StaleObjectError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { LabelType } from '../../src/types/label_type.js';
import type { LabelTypesResolveOptions } from '../../src/resources/label_types.js';
import { clearFetch, empty, json, stubFetch } from '../helpers.js';
import type { SpyCall } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/label_types';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient(overrides: Record<string, unknown> = {}): HuduClient {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...overrides });
}

function auditSpy(): { events: AuditEvent[]; hook: (event: AuditEvent) => void } {
  const events: AuditEvent[] = [];
  return { events, hook: (event) => { events.push(event); } };
}

async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the promise to reject');
}

function query(call: SpyCall): URLSearchParams {
  return new URL(call.url).searchParams;
}

function makeLabelType(id: number, name: string): LabelType {
  return {
    id,
    name,
    color: '#0000ff',
    slug: name.toLowerCase().replace(/ /g, '-'),
    applicable_record_types: ['Asset', 'Article'],
    access_level: 'all_companies',
    allowed_company_ids: [],
    created_at: '2025-12-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const CRITICAL = makeLabelType(1, 'Critical');
const OTHER = makeLabelType(2, 'Other');

/** Stub handler that answers the vendor filters the way the API would. */
function handlerFor(select: (params: URLSearchParams) => LabelType[], items = select) {
  return (url: string) => json({ label_types: items(new URL(url).searchParams) });
}

/** A full page of records none of which matches (drives the scan cap). */
function page(startId: number, prefix: string): LabelType[] {
  return Array.from({ length: 25 }, (_, i) => makeLabelType(startId + i, `${prefix} ${i}`));
}

describe('label_types.resolve (helper tier)', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    const found = await makeClient().labelTypes.resolve(1);
    expect(found).toEqual({
      id: 1,
      name: 'Critical',
      slug: 'critical',
      color: '#0000ff',
      applicable_record_types: ['Asset', 'Article'],
      access_level: 'all_companies',
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(makeClient().labelTypes.resolve(999));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(spy.calls).toHaveLength(1);
  });

  it('returns the single exact match', async () => {
    // A bare string reads slug first (documented order), then the exact name.
    const spy = stubFetch(
      handlerFor((params) => {
        if (params.get('slug') !== null) return [];
        return params.get('name') === 'Critical' ? [OTHER, CRITICAL] : [];
      }),
    );
    const found = await makeClient().labelTypes.resolve('Critical');
    expect(found).toEqual({
      id: 1,
      name: 'Critical',
      slug: 'critical',
      color: '#0000ff',
      applicable_record_types: ['Asset', 'Article'],
      access_level: 'all_companies',
    });
    // slug stage (1 complete miss) + name stage (match + uniqueness pass).
    expect(spy.calls).toHaveLength(3);
    expect(spy.calls[0]!.url).toContain('slug=Critical');
    expect(spy.calls[1]!.url).toContain('name=Critical');
    expect(spy.calls[2]!.url).toContain('name=Critical');
    expect(query(spy.calls[1]!).get('page_size')).toBe('25');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(handlerFor(() => []));
    const found = await makeClient().labelTypes.resolve('Missing');
    expect(found).toBeNull();
    // Both bare-string stages completed a scan; neither truncated.
    expect(spy.calls).toHaveLength(2);
  });

  it('resolutionDetails reports the direct cost without a scan', async () => {
    stubFetch(() => json({ label_type: CRITICAL }));
    const resolution = await makeClient().labelTypes.resolve(1, { resolutionDetails: true });
    expect(resolution).toEqual({
      value: {
        id: 1,
        name: 'Critical',
        slug: 'critical',
        color: '#0000ff',
        applicable_record_types: ['Asset', 'Article'],
        access_level: 'all_companies',
      },
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
    });
  });

  it('returns LabelTypeSummary', async () => {
    stubFetch(() => json({ label_types: [CRITICAL] }));
    const found = await makeClient().labelTypes.resolve({ slug: 'critical' });
    expect(found).not.toHaveProperty('allowed_company_ids');
    expect(found).not.toHaveProperty('created_at');
    expect(found).not.toHaveProperty('updated_at');
    expect(found).toHaveProperty('access_level', 'all_companies');
  });

  it('expand: true returns the full record', async () => {
    stubFetch(() => json({ label_types: [CRITICAL] }));
    const found = await makeClient().labelTypes.resolve({ slug: 'critical' }, { expand: true });
    expect(found).toEqual(CRITICAL);
    expect(found).toHaveProperty('allowed_company_ids');
    expect(found).toHaveProperty('created_at', '2025-12-01T00:00:00Z');
  });

  it('throws RESOLUTION_AMBIGUOUS when several label types share a name', async () => {
    const duplicate = makeLabelType(9, 'Critical');
    duplicate.slug = 'critical-two';
    duplicate.id = 9;
    const spy = stubFetch(handlerFor(() => [CRITICAL, duplicate]));
    const err = await rejection(makeClient().labelTypes.resolve({ name: 'Critical' }));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 9]);
    expect(spy.calls).toHaveLength(2);
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    // Four full, non-matching pages: the bounded scan (4 pages) runs out undecided.
    const spy = stubFetch(handlerFor(() => page(100, 'Filler')));
    const err = await rejection(makeClient().labelTypes.resolve({ name: 'Nowhere' }));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.category).toBe('resolution');
    expect(err.retryable).toBe(false);
    expect(spy.calls).toHaveLength(4);
  });

  it('throws RESOLUTION_TRUNCATED when the uniqueness pass hits the cap', async () => {
    // The single match sits on page 3; the uniqueness pass then reads four full
    // non-matching pages and cannot prove the match is unique.
    const spy = stubFetch((url: string) => {
      const p = Number(new URL(url).searchParams.get('page') ?? '1');
      if (p === 3) return json({ label_types: [CRITICAL, ...page(200, 'Filler').slice(0, 24)] });
      return json({ label_types: page(300 + p * 25, 'Filler') });
    });
    const err = await rejection(makeClient().labelTypes.resolve({ name: 'Critical' }));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    // 3 pages to find the match, 4 pages to fail to disprove a second match.
    expect(spy.calls).toHaveLength(7);
  });

  it('reports cost and candidates through resolutionDetails', async () => {
    stubFetch(() => json({ label_types: [CRITICAL] }));
    const resolution = await makeClient().labelTypes.resolve('critical', { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.candidates).toEqual([{ id: 1, label: 'label type "Critical" (slug critical)' }]);
    expect(resolution.value).not.toHaveProperty('allowed_company_ids');
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json({ label_types: [] }));
    const err = await rejection(makeClient().labelTypes.resolve({ color: '#fff' } as never));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('label_types.resolve accepts');
    expect(spy.calls).toHaveLength(0);
  });
});


describe('helper options are exactly the options the helpers honour', () => {
  it('label_types.resolve offers expand and resolutionDetails only', () => {
    // Exact-key compile-time guard: this literal stops compiling if an option is added
    // (an accepted-but-ignored `limit`/`expand`/`resolutionDetails`) or removed.
    const keys: Record<keyof LabelTypesResolveOptions, true> = { expand: true, resolutionDetails: true };
    expect(Object.keys(keys).sort()).toEqual(['expand', 'resolutionDetails']);
  });
});

describe('label_types primitives (list/get)', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped label_types list', async () => {
    const spy = stubFetch(() => json({ label_types: [CRITICAL] }));
    await expect(makeClient().labelTypes.listAll({})).resolves.toEqual([CRITICAL]);
    expect(spy.calls[0]!.url).toContain(BASE);
  });

  it('sends page/page_size and stops on a short page', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n += 1;
      return n === 1 ? json({ label_types: page(1, 'Type') }) : json({ label_types: [CRITICAL] });
    });
    const all = await makeClient().labelTypes.listAll({});
    expect(all).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('page')).toBe('1');
    expect(query(spy.calls[0]!).get('page_size')).toBe('25');
    expect(query(spy.calls[1]!).get('page')).toBe('2');
  });

  it('streams the list and its pages', async () => {
    stubFetch(() => json({ label_types: [CRITICAL] }));
    const items: LabelType[] = [];
    for await (const item of makeClient().labelTypes.list({})) items.push(item);
    expect(items).toEqual([CRITICAL]);

    const pages = [];
    for await (const item of makeClient().labelTypes.listPages({})) pages.push(item);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.items).toEqual([CRITICAL]);
  });

  it('returns the unwrapped label_types record', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    await expect(makeClient().labelTypes.get(1)).resolves.toEqual(CRITICAL);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().labelTypes.get(404));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    const spy = stubFetch(() => {
      n += 1;
      return n === 1 ? json({ label_types: [] }) : json({ error: 'nope' }, 404);
    });
    await client.labelTypes.listAll({});
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('label_types.list');

    const err = await rejection(client.labelTypes.get(9));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
    expect(spy.calls).toHaveLength(2);
  });
});

describe('label_types mutations (dry-run, stale guard, correlation)', () => {
  afterEach(() => clearFetch());

  it('returns the created label_types record', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }, 201));
    await expect(makeClient().labelTypes.create({ name: 'Critical' })).resolves.toEqual(CRITICAL);
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ label_type: { name: 'Critical' } }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    const result = await makeClient().labelTypes.create({ name: 'Critical' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'POST', path: '/label_types' });
    expect(result.warnings).toEqual(['server-computed fields are not guaranteed by dry-run']);
  });

  it('refuses expectedUpdatedAt on a create with CONFIG_ERROR', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    const err = await rejection(
      makeClient().labelTypes.create({ name: 'Critical' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(spy.calls).toHaveLength(0);
  });

  it('returns the updated label_types record', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    await expect(makeClient().labelTypes.update(1, { color: '#ff0000' })).resolves.toEqual(CRITICAL);
    expect(spy.calls[0]!.init.method).toBe('PUT');
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ label_type: { color: '#ff0000' } }));
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    const result = await makeClient().labelTypes.update(1, { color: '#ff0000' }, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.request).toEqual({ method: 'PUT', path: '/label_types/1' });
  });

  it('unwraps the PUT response by singleKey', async () => {
    stubFetch(() => json({ label_type: CRITICAL }));
    const updated = await makeClient().labelTypes.update(1, { color: '#ff0000' });
    expect(updated).toEqual(CRITICAL);
    expect(updated).not.toHaveProperty('label_type');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? json({ label_type: CRITICAL }) : json({ error: 'nope' }, 422);
    });
    await client.labelTypes.update(1, { color: '#ff0000' });
    expect(audit.events[0]!.operation).toBe('label_types.update');
    const err = await rejection(client.labelTypes.update(1, { color: '#ff0000' }));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT', async () => {
    const stale = { ...CRITICAL, updated_at: '2026-02-02T00:00:00Z' };
    const spy = stubFetch(() => json({ label_type: stale }));
    const err = await rejection(
      makeClient().labelTypes.update(1, { color: '#ff0000' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(err.code).toBe('STALE_OBJECT');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.init.method).toBe('GET');
  });

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().labelTypes.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0]!.init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = await makeClient().labelTypes.delete(1, { dryRun: true });
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.impact.reversible).toBe(false);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? empty(204) : json({ error: 'nope' }, 404);
    });
    await client.labelTypes.delete(1);
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    const err = await rejection(client.labelTypes.delete(404));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
  });

  it('refuses expectedUpdatedAt on a delete with CONFIG_ERROR', async () => {
    const spy = stubFetch(() => json({ label_type: CRITICAL }));
    const err = await rejection(
      makeClient().labelTypes.delete(1, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(spy.calls).toHaveLength(0);
  });
});
