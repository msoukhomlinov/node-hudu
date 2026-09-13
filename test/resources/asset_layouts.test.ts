/**
 * AssetLayoutsResource tests — primitives and agent-execution-layer helpers.
 * Titles marked "plan" are copied verbatim from capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';
import type { AuditEvent } from '../../src/types/common.js';

const layout = {
  id: 1,
  slug: 'server',
  name: 'Server',
  icon: 'server',
  color: '#ffffff',
  icon_color: '#000000',
  sidebar_folder_id: null,
  active: true,
  include_passwords: false,
  include_photos: false,
  include_comments: false,
  include_files: false,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-02T00:00:00.000Z',
  fields: [],
};

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** The 6 fields AssetLayoutSummary keeps; every other AssetLayout field is dropped. */
const LAYOUT_SUMMARY_KEYS = ['active', 'color', 'icon', 'id', 'name', 'slug'].sort();

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
}

function auditedClient() {
  const events: AuditEvent[] = [];
  const client = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', onAudit: (event) => events.push(event) });
  return { client, events };
}

describe('AssetLayoutsResource agent-execution-layer helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ asset_layout: layout }));
    expect(asRecord(await makeClient().assetLayouts.resolve(1)).id).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/asset_layouts/1');
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assetLayouts.resolve({ id: 99 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = stubFetch(() => json({ asset_layouts: [layout] }));
    expect(asRecord(await makeClient().assetLayouts.resolve('server')).slug).toBe('server');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('slug=server');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json({ asset_layouts: [] }));
    await expect(makeClient().assetLayouts.resolve('Missing Layout')).resolves.toBeNull();
    // slug filter, then name filter: two bounded reads, no client scan.
    expect(spy.calls).toHaveLength(2);
  });

  it('returns AssetLayoutSummary', async () => {
    stubFetch(() => json({ asset_layout: layout }));
    const summary = asRecord(await makeClient().assetLayouts.resolve(1));
    expect(Object.keys(summary).sort()).toEqual(LAYOUT_SUMMARY_KEYS);
    expect(summary.fields).toBeUndefined();
    expect(summary.include_passwords).toBeUndefined();
    expect(summary.updated_at).toBeUndefined();
  });

  it('expand: true returns the full layout', async () => {
    stubFetch(() => json({ asset_layout: layout }));
    await expect(makeClient().assetLayouts.resolve(1, { expand: true })).resolves.toEqual(layout);
  });

  it('returns the unwrapped asset_layouts list', async () => {
    // The server paginates at its own size: a full page is followed by an empty one.
    stubFetch((url) => (url.includes('page=1') ? json({ asset_layouts: [layout, { ...layout, id: 2, slug: 'switch' }] }) : json({ asset_layouts: [] })));
    const rows: unknown[] = [];
    for await (const row of makeClient().assetLayouts.list({})) rows.push(row);
    expect(rows).toEqual([layout, { ...layout, id: 2, slug: 'switch' }]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    // GET /asset_layouts accepts `page` but NOT `page_size` (the server paginates at
    // its own size), so the SDK sends page only and stops on a short page.
    const spy = stubFetch((url) => (url.includes('page=1') ? json({ asset_layouts: [layout, { ...layout, id: 2 }] }) : json({ asset_layouts: [] })));
    const rows: unknown[] = [];
    for await (const row of makeClient().assetLayouts.list({})) rows.push(row);
    expect(rows).toHaveLength(2);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[1].url).toContain('page=2');
    expect(spy.calls[0].url).not.toContain('page_size');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch((url) => (url.includes('page=1') ? json({ asset_layouts: [layout, { ...layout, id: 2 }] }) : json({ asset_layouts: [] })));
    const rows: unknown[] = [];
    for await (const row of client.assetLayouts.list({})) rows.push(row);
    expect(rows).toHaveLength(2);
    expect(events[0]!.outcome).toBe('success');
    expect(typeof events[0]!.correlationId).toBe('string');
    spy.setHandler(() => json({ error: 'boom' }, 500));
    const err = (await (async () => {
      for await (const _row of client.assetLayouts.list({})) void _row;
    })().catch((e: unknown) => e)) as { correlationId?: string };
    expect(typeof err.correlationId).toBe('string');
    expect(events[events.length - 1]!.outcome).toBe('error');
    expect(events[events.length - 1]!.correlationId).toBe(err.correlationId);
  });
});

describe('AssetLayoutsResource agent-execution-layer primitives', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped asset_layouts record', async () => {
    stubFetch(() => json({ asset_layout: layout }));
    await expect(makeClient().assetLayouts.get(1)).resolves.toEqual(layout);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assetLayouts.get(9)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('surfaces a correlation id on the success path and the error path (get)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset_layout: layout }));
    await client.assetLayouts.get(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assetLayouts.get(9).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the created asset_layouts record', async () => {
    const spy = stubFetch(() => json({ asset_layout: layout }, 201));
    await expect(makeClient().assetLayouts.create({ name: 'Server' })).resolves.toEqual(layout);
    expect(spy.calls[0].init.method).toBe('POST');
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ asset_layout: layout }, 201));
    const result = (await makeClient().assetLayouts.create({ name: 'Server' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('POST');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (create)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset_layout: layout }, 201));
    await client.assetLayouts.create({ name: 'Server' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.assetLayouts.create({ name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the updated asset_layouts record', async () => {
    const spy = stubFetch(() => json({ asset_layout: layout }));
    await expect(makeClient().assetLayouts.update(1, { name: 'New' })).resolves.toEqual(layout);
    expect(spy.calls[0].init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ asset_layout: layout }));
    const result = (await makeClient().assetLayouts.update(1, { name: 'New' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.target).ids).toEqual([1]);
    expect(spy.calls).toHaveLength(0);
  });

  it('unwraps the PUT response by singleKey (update)', async () => {
    stubFetch(() => json({ asset_layout: layout }));
    expect(asRecord(await makeClient().assetLayouts.update(1, { name: 'New' })).id).toBe(1);
  });

  it('surfaces a correlation id on the success path and the error path (update)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset_layout: layout }));
    await client.assetLayouts.update(1, { name: 'New' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.assetLayouts.update(1, { name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT (update)', async () => {
    const spy = stubFetch(() => json({ asset_layout: layout }));
    await expect(makeClient().assetLayouts.update(1, { name: 'New' }, { expectedUpdatedAt: layout.updated_at })).resolves.toEqual(layout);
    expect(spy.calls[0].init.method).toBe('GET');
    expect(spy.calls[1].init.method).toBe('PUT');
    spy.calls.length = 0;
    await expect(makeClient().assetLayouts.update(1, { name: 'New' }, { expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'STALE_OBJECT', category: 'conflict', retryable: false });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].init.method).toBe('GET');
  });
});


describe('AssetLayoutsResource helper edge branches and validation', () => {
  afterEach(() => clearFetch());

  it('lists every layout and yields pages', async () => {
    stubFetch((url) => (url.includes('page=1') ? json({ asset_layouts: [layout] }) : json({ asset_layouts: [] })));
    await expect(makeClient().assetLayouts.listAll({})).resolves.toEqual([layout]);
    const pages: unknown[] = [];
    for await (const page of makeClient().assetLayouts.listPages({})) pages.push(page);
    // The server paginates at its own size, so a one-row page is followed by an empty one.
    expect(pages).toHaveLength(2);
    expect(asRecord(pages[0]).items).toHaveLength(1);
  });

  it('reads a bare numeric value and the object identifier kinds', async () => {
    const byId = stubFetch(() => json({ asset_layout: layout }));
    expect(asRecord(await makeClient().assetLayouts.resolve('12')).id).toBe(1);
    expect(byId.calls[0].url).toBe('https://hudu.example.com/api/v1/asset_layouts/12');
    stubFetch(() => json({ asset_layouts: [layout] }));
    expect(asRecord(await makeClient().assetLayouts.resolve({ slug: 'server' })).id).toBe(1);
    expect(asRecord(await makeClient().assetLayouts.resolve({ name: 'Server' })).id).toBe(1);
    expect(asRecord(await makeClient().assetLayouts.resolve('Server')).id).toBe(1);
  });

  it('throws RESOLUTION_AMBIGUOUS for several exact matches and for an inexact filter', async () => {
    stubFetch(() => json({ asset_layouts: [{ ...layout, id: 71 }, { ...layout, id: 72 }] }));
    await expect(makeClient().assetLayouts.resolve('server')).rejects.toMatchObject({ code: 'RESOLUTION_AMBIGUOUS', resourceIds: [71, 72] });
    stubFetch(() => json({ asset_layouts: [{ ...layout, id: 81, slug: 'a' }, { ...layout, id: 82, slug: 'b' }] }));
    await expect(makeClient().assetLayouts.resolve('Missing Layout')).rejects.toMatchObject({ code: 'RESOLUTION_AMBIGUOUS', resourceIds: [81, 82] });
  });

  it('reports the resolution cost with resolutionDetails', async () => {
    stubFetch(() => json({ asset_layout: layout }));
    const direct = (await makeClient().assetLayouts.resolve(1, { resolutionDetails: true })) as Record<string, unknown>;
    expect(direct.resolutionCost).toBe('direct');
    expect(asRecord(direct.value).id).toBe(1);
    stubFetch(() => json({ asset_layouts: [] }));
    const miss = (await makeClient().assetLayouts.resolve('Missing', { resolutionDetails: true })) as Record<string, unknown>;
    expect(miss.value).toBeNull();
  });

  it('rejects an empty or unsupported identifier and an unsupported limit or page', async () => {
    await expect(makeClient().assetLayouts.resolve('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetLayouts.resolve(null as unknown as number)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetLayouts.resolve({ icon: 'x' } as unknown as { id?: number })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    // `limit` is not accepted at all: /asset_layouts has no page_size, so the resolver
    // cannot bound its page size and refuses the knob instead of ignoring it.
    await expect(makeClient().assetLayouts.resolve('server', { limit: 25 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetLayouts.resolve('server', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetLayouts.resolve('server', { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    const invalidPage = (async () => {
      for await (const _page of makeClient().assetLayouts.list({ page: 0 })) void _page;
    })();
    await expect(invalidPage).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('refuses a list endpoint that ignores page and repeats the same full page', async () => {
    const spy = stubFetch(() => json({ asset_layouts: [layout, { ...layout, id: 2 }] }));
    const run = (async () => {
      for await (const _row of makeClient().assetLayouts.list({})) void _row;
    })();
    await expect(run).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(spy.calls).toHaveLength(2);
  });

  it('matches a layout by exact name when the slug filter misses', async () => {
    const spy = stubFetch((url) => (url.includes('slug=') ? json({ asset_layouts: [] }) : json({ asset_layouts: [layout] })));
    expect(asRecord(await makeClient().assetLayouts.resolve('Server')).id).toBe(1);
    // The slug pass is empty (one read), the name pass finds it (one read).
    expect(spy.calls).toHaveLength(2);
  });

});

describe('AssetLayoutsResource paged resolution scan (QA finding 2)', () => {
  afterEach(() => clearFetch());

  /** 25 non-matching layouts — a full page at the SDK's assumed page size. */
  const fullNonMatchingPage = () =>
    Array.from({ length: 25 }, (_, i) => ({ ...layout, id: 500 + i, slug: `other-${i}`, name: `Other ${i}` }));

  it('finds a layout that sits on page 2 instead of reporting it missing', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('page=1')) return json({ asset_layouts: fullNonMatchingPage() });
      return json({ asset_layouts: [{ ...layout, id: 7, slug: 'second-page', name: 'Second Page' }] });
    });
    const found = asRecord(await makeClient().assetLayouts.resolve('second-page'));
    expect(found.id).toBe(7);
    expect(spy.calls.map((call) => call.url)).toEqual([
      expect.stringContaining('page=1'),
      expect.stringContaining('page=2'),
    ]);
    // `page_size` is not in the api-docs parameter list, so the scan never sends it.
    expect(spy.calls.every((call) => !call.url.includes('page_size'))).toBe(true);
  });

  it('throws RESOLUTION_TRUNCATED when the client cap stops the walk (never null)', async () => {
    const spy = stubFetch(() => json({ asset_layouts: fullNonMatchingPage() }));
    await expect(makeClient().assetLayouts.resolve('never-matches')).rejects.toMatchObject({
      code: 'RESOLUTION_TRUNCATED',
    });
    // Bounded by the client caps: 4 pages of 25, never an unbounded walk.
    expect(spy.calls).toHaveLength(4);
  });

  it('throws RESOLUTION_TRUNCATED instead of the one matching layout when the cap stopped the walk', async () => {
    const others = Array.from({ length: 26 }, (_, i) => ({ ...layout, id: 700 + i, slug: `other-${i}`, name: `Other ${i}` }));
    stubFetch((url) => json({ asset_layouts: url.includes('page=1') ? [layout, ...others.slice(1)] : others }));
    await expect(makeClient().assetLayouts.resolve('server')).rejects.toMatchObject({
      code: 'RESOLUTION_TRUNCATED',
      category: 'resolution',
    });
  });

  it('reports the found layout on page 2 with resolutionDetails', async () => {
    stubFetch((url) => (url.includes('page=1')
      ? json({ asset_layouts: fullNonMatchingPage() })
      : json({ asset_layouts: [{ ...layout, id: 8, slug: 'paged' }] })));
    const resolution = await makeClient().assetLayouts.resolve({ slug: 'paged' }, { resolutionDetails: true });
    expect(asRecord(resolution.value).id).toBe(8);
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.scanned).toBe(26);
  });
});

describe('AssetLayoutsResource page-size learning', () => {
  afterEach(() => clearFetch());

  it('keeps walking when the server returns a page longer than the SDK default', async () => {
    // 40 > the assumed 25: the server's real page size is learned from the response,
    // so the walk continues instead of stopping after one page.
    const longPage = Array.from({ length: 40 }, (_, i) => ({ ...layout, id: 600 + i, slug: `other-${i}`, name: `Other ${i}` }));
    const spy = stubFetch((url) => (url.includes('page=1')
      ? json({ asset_layouts: longPage })
      : json({ asset_layouts: [{ ...layout, id: 61, slug: 'tail', name: 'Tail' }] })));
    const found = asRecord(await makeClient().assetLayouts.resolve({ slug: 'tail' }));
    expect(found.id).toBe(61);
    expect(spy.calls.map((call) => call.url)).toEqual([
      expect.stringContaining('page=1'),
      expect.stringContaining('page=2'),
    ]);
    expect(spy.calls.every((call) => !call.url.includes('page_size'))).toBe(true);
  });
});
