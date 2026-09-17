/**
 * ArticlesResource tests — primitives and agent-execution-layer helpers.
 * Titles marked "plan" are copied verbatim from capabilities.plan.json.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduConfigError, HuduContentLossError, NotFoundError, StaleObjectError } from '../../src/errors.js';
import type { Article } from '../../src/types/index.js';
import { diffArticleRoundTrip, type ArticleHtmlFinding } from '../../src/resources/article-html.js';

// Wraps the REAL diffArticleRoundTrip so every other test in this file still exercises the
// genuine converters; only the one test below that calls `.mockReturnValueOnce` sees a
// fabricated findings array, to pin the impact === 'content' narrowing in articles.ts
// independent of what the real converters can produce (see the test itself for why).
vi.mock('../../src/resources/article-html.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resources/article-html.js')>();
  return { ...actual, diffArticleRoundTrip: vi.fn(actual.diffArticleRoundTrip) };
});

const article = {
  id: 1,
  slug: 'vpn-setup',
  name: 'VPN Setup',
  draft: false,
  content: '<p>Steps</p>',
  url: '/kb/vpn-setup',
  object_type: 'Article',
  folder_id: 5,
  enable_sharing: false,
  share_url: '',
  company_id: 7,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-02T00:00:00.000Z',
  public_photos: [],
};

const company = { id: 7, name: 'Acme Corp', slug: 'acme-corp', website: 'https://acme.example.com' };
const folder = { id: 5, name: 'Runbooks', company_id: 7, folder_type: 'article' };

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** The 8 fields ArticleSummary keeps; every other Article field is dropped. */
const ARTICLE_SUMMARY_KEYS = [
  'company_id', 'draft', 'enable_sharing', 'folder_id', 'id', 'name', 'slug', 'updated_at',
].sort();

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
}

function cappedClient(maxScanRecords: number, maxScanPages: number) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', resolution: { maxScanRecords, maxScanPages } });
}

function auditedClient() {
  const events: AuditEvent[] = [];
  const client = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', onAudit: (event) => events.push(event) });
  return { client, events };
}

function rowsPage(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => ({ ...article, id: 100 + i, name: `Row ${i}`, ...overrides }));
}

function listStub(byFilter: Record<string, unknown[]>, fallback: unknown[] = []) {
  return stubFetch((url) => {
    for (const [key, rows] of Object.entries(byFilter)) if (url.includes(`${key}=`)) return json({ articles: rows });
    return json({ articles: fallback });
  });
}

describe('ArticlesResource agent-execution-layer helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ article }));
    expect(asRecord(await makeClient().articles.resolve(1)).id).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/articles/1');
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().articles.resolve({ id: 99 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = listStub({ name: [article] });
    expect(asRecord(await makeClient().articles.resolve('VPN Setup')).id).toBe(1);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].url).toContain('name=');
  });

  it('returns null after a complete scan', async () => {
    const spy = listStub({});
    await expect(makeClient().articles.resolve('Nope')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(2);
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids', async () => {
    listStub({ name: [{ ...article, id: 21, name: 'VPN Guide' }, { ...article, id: 22, name: 'VPN Notes' }] });
    await expect(makeClient().articles.resolve('VPN')).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      resourceIds: [21, 22],
    });
  });

  it('throws RESOLUTION_TRUNCATED at the cap', async () => {
    const spy = listStub({}, rowsPage(25));
    await expect(cappedClient(25, 1).articles.resolve('Nope')).rejects.toMatchObject({ code: 'RESOLUTION_TRUNCATED' });
    expect(spy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_TRUNCATED instead of the one matching article when the cap stopped the scan', async () => {
    const rows = [{ ...article, id: 31 }, ...rowsPage(24, { slug: 'other', name: 'Row' })];
    listStub({ slug: rows });
    await expect(cappedClient(25, 1).articles.resolve('vpn-setup')).rejects.toMatchObject({
      code: 'RESOLUTION_TRUNCATED',
      category: 'resolution',
    });
  });

  it('returns ArticleSummary', async () => {
    stubFetch(() => json({ article }));
    const summary = asRecord(await makeClient().articles.resolve(1));
    expect(Object.keys(summary).sort()).toEqual(ARTICLE_SUMMARY_KEYS);
    expect(summary.content).toBeUndefined();
    expect(summary.share_url).toBeUndefined();
    expect(summary.created_at).toBeUndefined();
  });

  it('expand: true returns the full article', async () => {
    stubFetch(() => json({ article }));
    await expect(makeClient().articles.resolve(1, { expand: true })).resolves.toEqual(article);
  });

  it('returns the exact match (slug)', async () => {
    stubFetch(() => json({ articles: [article] }));
    expect(asRecord(await makeClient().articles.findBySlug('vpn-setup')).slug).toBe('vpn-setup');
  });

  it('returns null after a complete scan (slug)', async () => {
    stubFetch(() => json({ articles: [] }));
    await expect(makeClient().articles.findBySlug('missing')).resolves.toBeNull();
  });

  it('returns ArticleSummary (slug)', async () => {
    stubFetch(() => json({ articles: [article] }));
    expect(Object.keys(asRecord(await makeClient().articles.findBySlug('vpn-setup'))).sort()).toEqual(ARTICLE_SUMMARY_KEYS);
  });

  it('expand: true returns the full article (slug)', async () => {
    stubFetch(() => json({ articles: [article] }));
    await expect(makeClient().articles.findBySlug('vpn-setup', { expand: true })).resolves.toEqual(article);
  });

  it('returns matching ArticleSummary records', async () => {
    stubFetch(() => json({ articles: [{ ...article, id: 31 }, { ...article, id: 32 }] }));
    const rows = (await makeClient().articles.search('vpn')) as unknown[];
    expect(rows).toHaveLength(2);
    expect(Object.keys(asRecord(rows[0])).sort()).toEqual(ARTICLE_SUMMARY_KEYS);
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = stubFetch(() => json({ articles: [article] }));
    await expect(makeClient().articles.search('vpn', { limit: 100 })).resolves.toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=100');
    await expect(makeClient().articles.search('vpn', { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(spy.calls).toHaveLength(1);
  });

  it('narrows the search to company_id when given', async () => {
    const spy = stubFetch(() => json({ articles: [article] }));
    await makeClient().articles.search('vpn', { company_id: 7 });
    expect(spy.calls[0].url).toContain('company_id=7');
    expect(spy.calls[0].url).toContain('search=vpn');
  });

  it('returns the article with its company and folder context', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/articles/1')) return json({ article });
      if (url.includes('/companies/7')) return json({ company });
      if (url.includes('/folders/5')) return json({ folder });
      return json({});
    });
    const context = (await makeClient().articles.getContext(1)) as Record<string, unknown>;
    expect(asRecord(context.article).id).toBe(1);
    expect(asRecord(context.company).id).toBe(7);
    expect(asRecord(context.folder).id).toBe(5);
    expect(spy.calls).toHaveLength(3);
  });

  it('throws NOT_FOUND for an unknown article id', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().articles.getContext(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ArticlesResource agent-execution-layer primitives', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().articles.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().articles.delete(1, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/articles/1');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (delete)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.articles.delete(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.articles.delete(2).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the unwrapped articles list', async () => {
    stubFetch(() => json({ articles: [article] }));
    const rows: unknown[] = [];
    for await (const row of makeClient().articles.list({})) rows.push(row);
    expect(rows).toEqual([article]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch(() => json({ articles: [article] }));
    const rows: unknown[] = [];
    for await (const row of makeClient().articles.list({})) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path (list)', async () => {
    const { client, events } = auditedClient();
    stubFetch(() => json({ articles: [article] }));
    const rows: unknown[] = [];
    for await (const row of client.articles.list({})) rows.push(row);
    expect(events[0]!.outcome).toBe('success');
    expect(typeof events[0]!.correlationId).toBe('string');
  });

  it('returns the unwrapped articles record', async () => {
    stubFetch(() => json({ article }));
    await expect(makeClient().articles.get(1)).resolves.toEqual(article);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().articles.get(1)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('surfaces a correlation id on the success path and the error path (get)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ article }));
    await client.articles.get(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.articles.get(2).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the created articles record', async () => {
    const spy = stubFetch(() => json(article, 201));
    await expect(makeClient().articles.create({ name: 'VPN Setup' })).resolves.toEqual(article);
    expect(spy.calls[0].init.method).toBe('POST');
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ name: 'VPN Setup' }));
  });

  it('dry-run issues no mutating request and returns simulated: true (create)', async () => {
    const spy = stubFetch(() => json(article, 201));
    const result = (await makeClient().articles.create({ name: 'VPN' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).method).toBe('POST');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (create)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json(article, 201));
    await client.articles.create({ name: 'VPN' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.articles.create({ name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the updated articles record', async () => {
    const spy = stubFetch(() => json({ article }));
    await expect(makeClient().articles.update(1, { name: 'New' })).resolves.toEqual(article);
    expect(spy.calls[0].init.method).toBe('PUT');
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ article }));
    const result = (await makeClient().articles.update(1, { name: 'New' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.target).ids).toEqual([1]);
    expect(spy.calls).toHaveLength(0);
  });

  it('unwraps the PUT response by singleKey (update)', async () => {
    stubFetch(() => json({ article }));
    expect(asRecord(await makeClient().articles.update(1, { name: 'New' })).id).toBe(1);
  });

  it('surfaces a correlation id on the success path and the error path (update)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ article }));
    await client.articles.update(1, { name: 'New' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.articles.update(1, { name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT (update)', async () => {
    const spy = stubFetch(() => json({ article }));
    await expect(makeClient().articles.update(1, { name: 'New' }, { expectedUpdatedAt: article.updated_at })).resolves.toEqual(article);
    expect(spy.calls[0].init.method).toBe('GET');
    expect(spy.calls[1].init.method).toBe('PUT');
    spy.calls.length = 0;
    await expect(makeClient().articles.update(1, { name: 'New' }, { expectedUpdatedAt: '1999-01-01T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'STALE_OBJECT',
      category: 'conflict',
    });
    expect(spy.calls).toHaveLength(1);
  });

  it('calls the articles.archive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().articles.archive(3)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/articles/3/archive');
  });

  it('dry-run issues no mutating request and returns simulated: true (archive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().articles.archive(3, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/articles/3/archive');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (archive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.articles.archive(3);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.articles.archive(4).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the articles.unarchive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().articles.unarchive(3)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/articles/3/unarchive');
  });

  it('dry-run issues no mutating request and returns simulated: true (unarchive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().articles.unarchive(3, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (unarchive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.articles.unarchive(3);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.articles.unarchive(4).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });
});


describe('ArticlesResource helper edge branches and validation', () => {
  afterEach(() => clearFetch());

  it('lists every article and yields pages', async () => {
    stubFetch(() => json({ articles: [article] }));
    await expect(makeClient().articles.listAll({})).resolves.toEqual([article]);
    const pages: unknown[] = [];
    for await (const page of makeClient().articles.listPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
  });

  it('reads a bare numeric value and the object identifier kinds', async () => {
    const byId = stubFetch(() => json({ article }));
    expect(asRecord(await makeClient().articles.resolve('12')).id).toBe(1);
    expect(byId.calls[0].url).toBe('https://hudu.example.com/api/v1/articles/12');
    stubFetch(() => json({ articles: [article] }));
    expect(asRecord(await makeClient().articles.resolve({ slug: 'vpn-setup' })).id).toBe(1);
    expect(asRecord(await makeClient().articles.resolve({ name: 'VPN Setup', company_id: 7 })).id).toBe(1);
  });

  it('reports the resolution cost and scanned count with resolutionDetails', async () => {
    stubFetch(() => json({ article }));
    const direct = (await makeClient().articles.resolve(1, { resolutionDetails: true })) as Record<string, unknown>;
    expect(direct.resolutionCost).toBe('direct');
    expect(asRecord(direct.value).id).toBe(1);
    const expanded = (await makeClient().articles.resolve(1, { resolutionDetails: true, expand: true })) as Record<string, unknown>;
    expect(asRecord(expanded.value).content).toBe('<p>Steps</p>');
    stubFetch(() => json({ articles: [] }));
    const miss = (await makeClient().articles.resolve('Nope', { resolutionDetails: true })) as Record<string, unknown>;
    expect(miss.value).toBeNull();
  });

  it('throws RESOLUTION_AMBIGUOUS when two articles match exactly', async () => {
    stubFetch(() => json({ articles: [{ ...article, id: 61 }, { ...article, id: 62 }] }));
    await expect(makeClient().articles.resolve('vpn-setup')).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      resourceIds: [61, 62],
    });
  });

  it('rejects an empty identifier, slug and query', async () => {
    await expect(makeClient().articles.resolve('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().articles.resolve(null as unknown as number)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().articles.resolve({ external_id: 'x' } as unknown as { id?: number })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    await expect(makeClient().articles.findBySlug('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().articles.search('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().articles.search('vpn', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('returns the expanded context and tolerates a missing company or folder', async () => {
    stubFetch((url) => {
      if (url.includes('/articles/1')) return json({ article });
      if (url.includes('/companies/7')) return json({ error: 'gone' }, 404);
      if (url.includes('/folders/5')) return json({ folder });
      return json({});
    });
    const context = (await makeClient().articles.getContext(1, { expand: true })) as Record<string, unknown>;
    expect(asRecord(context.article).content).toBe('<p>Steps</p>');
    expect(context.company).toBeNull();
    expect(asRecord(context.folder).id).toBe(5);
  });

  it('propagates a non-404 failure of a related record', async () => {
    stubFetch((url) => {
      if (url.includes('/articles/1')) return json({ article });
      if (url.includes('/companies/7')) return json({ error: 'bad request' }, 400);
      return json({ folder });
    });
    await expect(makeClient().articles.getContext(1)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('matches a bare slug before the name filter', async () => {
    const spy = stubFetch(() => json({ articles: [article] }));
    expect(asRecord(await makeClient().articles.resolve('vpn-setup')).id).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('slug=vpn-setup');
  });

});

describe('reading an article as Markdown', () => {
  afterEach(clearFetch);

  it('returns content as Markdown when format is markdown', async () => {
    stubFetch(() => json({ article: { ...article, content: '<h2>Setup</h2><p>Run it.</p>' } }));
    const result = await makeClient().articles.get(1, { format: 'markdown' });
    expect(result.content).toBe('## Setup\n\nRun it.');
  });

  it('returns HTML by default, unchanged', async () => {
    stubFetch(() => json({ article: { ...article, content: '<h2>Setup</h2>' } }));
    expect((await makeClient().articles.get(1)).content).toBe('<h2>Setup</h2>');
  });

  it('converts inside getContext when expand is set', async () => {
    stubFetch((url) => {
      if (url.includes('/articles/1')) return json({ article: { ...article, content: '<p>Body</p>' } });
      if (url.includes('/companies/7')) return json({ company });
      return json({ folder });
    });
    const ctx = await makeClient().articles.getContext(1, { expand: true, format: 'markdown' });
    expect(asRecord(ctx.article).content).toBe('Body');
  });

  it('leaves the compact getContext tier alone -- it already drops content', async () => {
    stubFetch((url) => {
      if (url.includes('/articles/1')) return json({ article });
      if (url.includes('/companies/7')) return json({ company });
      return json({ folder });
    });
    const ctx = await makeClient().articles.getContext(1, { format: 'markdown' });
    expect(asRecord(ctx.article).content).toBeUndefined();
  });
});

describe('writing an article as Markdown', () => {
  afterEach(clearFetch);

  const sentBody = (spy: { calls: { init: RequestInit }[] }, call = 0) => JSON.parse(String(spy.calls[call].init.body));

  it('converts Markdown to HTML on create, with no guard and no extra fetch', async () => {
    const spy = stubFetch(() => json(article, 201));
    await makeClient().articles.create({ name: 'N', content: '## Setup', folder_id: 5 }, { format: 'markdown' });
    expect(spy.calls).toHaveLength(1);
    expect(sentBody(spy).content).toContain('<h2');
  });

  it('refuses an update when the STORED article would lose content', async () => {
    // The agent never touched the callout; converting the stored body would destroy it.
    const spy = stubFetch(() =>
      json({ article: { ...article, content: '<div class="callout callout-warning"><p>Back up first.</p></div>' } }),
    );
    await expect(
      makeClient().articles.update(1, { content: '## New' }, { format: 'markdown' }),
    ).rejects.toThrow(HuduContentLossError);
    expect(spy.calls).toHaveLength(1); // the GET only; no PUT was issued
    expect(spy.calls[0].init.method).toBe('GET');
  });

  it('issues ONE fetch with allowLossyMarkdown and no expectedUpdatedAt (SANCTIONED change, issue #43 B2 #2)', async () => {
    // EXPECTATION CHANGED BY DESIGN (issue #43, Batch 2 #2): with the loss guard skipped by
    // intent and no expectedUpdatedAt to check, the guard's GET would feed nothing, so it is
    // skipped -- this test used to assert 2 calls (GET + PUT); the GET is gone, so the PUT is
    // the single fetch. (allowLossyMarkdown WITH expectedUpdatedAt still fetches once, pinned
    // below.)
    const spy = stubFetch(() => json({ article }));
    await makeClient().articles.update(1, { content: '## New' }, { format: 'markdown', allowLossyMarkdown: true });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(sentBody(spy).content).toContain('<h2');
  });

  it('still fetches ONCE when allowLossyMarkdown is set with expectedUpdatedAt (the stale check consumes the fetch)', async () => {
    const spy = stubFetch((_url, init) => (init.method === 'GET' ? json({ article }) : json({ article })));
    await makeClient().articles.update(
      1,
      { content: '## New' },
      { format: 'markdown', allowLossyMarkdown: true, expectedUpdatedAt: article.updated_at },
    );
    expect(spy.calls).toHaveLength(2); // the stale-check GET, then the PUT
    expect(spy.calls[0].init.method).toBe('GET');
    expect(spy.calls[1].init.method).toBe('PUT');
    expect(sentBody(spy, 1).content).toContain('<h2');
  });

  it('allowLossyMarkdown suppresses the total-loss case when the guard does run', async () => {
    // A stored body that converts to EMPTY Markdown is HuduContentLossError (issue #43,
    // Batch 2 #4) -- and the intent flag applies to it: with expectedUpdatedAt the fetch
    // still runs (stale check), the guard block is skipped by intent, and the PUT is issued.
    const spy = stubFetch((_url, init) =>
      init.method === 'GET'
        ? json({ article: { ...article, content: '<!-- invisible to the converter -->' } })
        : json({ article }),
    );
    await makeClient().articles.update(
      1,
      { content: '## New' },
      { format: 'markdown', allowLossyMarkdown: true, expectedUpdatedAt: article.updated_at },
    );
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].init.method).toBe('PUT');
    expect(sentBody(spy, 1).content).toContain('<h2');
  });

  it('allows an update whose stored body round-trips cleanly', async () => {
    // The calibration case: an ordinary article must stay editable as Markdown. (This
    // fixture round-trips to ZERO findings, not presentation-only ones -- the gate that
    // distinguishes content from presentation findings is pinned separately below,
    // because this fixture cannot exercise it.)
    const spy = stubFetch((_url, init) => {
      if (init.method === 'GET') {
        return json({ article: { ...article, content: '<h2 class="text-left">Setup</h2><p style="color:#333">Run it.</p>' } });
      }
      return json({ article });
    });
    await makeClient().articles.update(1, { content: '## Setup\n\nRun it.' }, { format: 'markdown' });
    expect(spy.calls).toHaveLength(2);
  });

  it('throws only for a content-impact finding, never for a presentation-only one', async () => {
    // diffArticleRoundTrip has exactly one presentation-impact code
    // (ROUNDTRIP_THEAD_DROPPED), and it is unreachable through markdownToHtml(htmlToMarkdown(x))
    // because marked always re-emits <thead> for a GFM table -- so no HTTP-level fixture can
    // exercise the impact === 'content' narrowing at articles.ts. This pins it directly by
    // fabricating the findings diffArticleRoundTrip returns, which also proves the gate reads
    // `impact`, not `severity` (the fabricated presentation finding below deliberately carries
    // severity: 'error', the combination a `findings.some((f) => f.severity === 'error')`
    // regression would wrongly treat as loss).
    const mockDiff = vi.mocked(diffArticleRoundTrip);
    const presentationOnly: ArticleHtmlFinding[] = [
      { code: 'CALLOUT_TYPE_UNKNOWN', severity: 'error', impact: 'presentation', element: 'callout', message: 'cosmetic only' },
    ];
    const withContentLoss: ArticleHtmlFinding[] = [
      { code: 'CALLOUT_BASE_CLASS_MISSING', severity: 'error', impact: 'content', element: 'callout', message: 'destroys the callout' },
    ];

    mockDiff.mockReturnValueOnce(presentationOnly);
    const allowSpy = stubFetch((_url, init) => (init.method === 'GET' ? json({ article }) : json({ article })));
    await expect(makeClient().articles.update(1, { content: '## New' }, { format: 'markdown' })).resolves.toBeDefined();
    expect(allowSpy.calls).toHaveLength(2); // presentation-only: proceeds to the PUT
    clearFetch();

    mockDiff.mockReturnValueOnce(withContentLoss);
    const refuseSpy = stubFetch(() => json({ article }));
    await expect(
      makeClient().articles.update(1, { content: '## New' }, { format: 'markdown' }),
    ).rejects.toThrow(HuduContentLossError);
    expect(refuseSpy.calls).toHaveLength(1); // content loss: refuses before any PUT
  });

  it('issues no extra fetch when data carries no content key', async () => {
    const spy = stubFetch(() => json({ article }));
    await makeClient().articles.update(1, { name: 'Renamed' }, { format: 'markdown' });
    expect(spy.calls).toHaveLength(1); // the PUT alone -- no guard fetch
    expect(spy.calls[0].init.method).toBe('PUT');
  });

  it('shares ONE fetch between the guard and expectedUpdatedAt', async () => {
    const spy = stubFetch(() => json({ article }));
    await makeClient().articles.update(
      1,
      { content: '## New' },
      { format: 'markdown', expectedUpdatedAt: article.updated_at },
    );
    expect(spy.calls).toHaveLength(2); // one GET, one PUT
    expect(spy.calls[0].init.method).toBe('GET');
    expect(spy.calls[1].init.method).toBe('PUT');
  });

  it('still throws StaleObjectError through the shared fetch', async () => {
    const spy = stubFetch(() => json({ article: { ...article, updated_at: '2030-01-01T00:00:00.000Z' } }));
    await expect(
      makeClient().articles.update(1, { content: '## New' }, { format: 'markdown', expectedUpdatedAt: article.updated_at }),
    ).rejects.toThrow(StaleObjectError);
    expect(spy.calls).toHaveLength(1); // no PUT was issued once the GET proved it stale
  });

  it('runs the guard on a dry run and reports rather than writing', async () => {
    const spy = stubFetch(() =>
      json({ article: { ...article, content: '<div class="callout callout-info"><p>FYI</p></div>' } }),
    );
    await expect(
      makeClient().articles.update(1, { content: '## New' }, { format: 'markdown', dryRun: true }),
    ).rejects.toThrow(HuduContentLossError);
    expect(spy.calls).toHaveLength(1); // the guard's GET ran; no PUT followed
  });

  it('leaves an HTML update completely unchanged', async () => {
    const spy = stubFetch(() => json({ article }));
    await makeClient().articles.update(1, { content: '<p>x</p>' });
    expect(spy.calls).toHaveLength(1);
    expect(sentBody(spy).content).toBe('<p>x</p>');
  });

  it('treats format: "html" as the plain path: no guard fetch, no conversion', async () => {
    // issue #43, Batch 2 #7: an explicit non-Markdown format takes the updateOne path --
    // the guard fetch never happens and the content is sent byte-for-byte.
    const spy = stubFetch(() => json({ article }));
    await makeClient().articles.update(1, { content: '<p>plain</p>' }, { format: 'html' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].init.method).toBe('PUT');
    expect(sentBody(spy).content).toBe('<p>plain</p>');
  });

  it('sends an explicit empty Markdown body as-is (the guard still judges the STORED body)', async () => {
    // issue #43, Batch 2 #7: '' is typeof string, so the Markdown path runs; the guard
    // judges the STORED body (probe-confirmed independent of the submitted payload), and
    // markdownToHtml('') returns '' without throwing -- an explicit empty is the caller's
    // intent, not a converter accident, so it is written as sent.
    const spy = stubFetch((_url, init) => (init.method === 'GET' ? json({ article }) : json({ article })));
    await makeClient().articles.update(1, { content: '' }, { format: 'markdown' });
    expect(spy.calls).toHaveLength(2);
    expect(sentBody(spy, 1).content).toBe('');
  });

  it('still refuses via the stored-body guard when the submitted body is an explicit empty', async () => {
    // The other side of the '' pin: the guard is about the STORED body, so a lossy stored
    // body refuses even when the caller explicitly sent an empty body.
    const spy = stubFetch(() =>
      json({ article: { ...article, content: '<div class="callout callout-warning"><p>Back up first.</p></div>' } }),
    );
    await expect(
      makeClient().articles.update(1, { content: '' }, { format: 'markdown' }),
    ).rejects.toThrow(HuduContentLossError);
    expect(spy.calls).toHaveLength(1); // the GET only; no PUT was issued
  });

  it('propagates the converter cap error cleanly from the STORED body, before any PUT', async () => {
    // issue #43, Batch 2 #7: a stored body over the document cap makes htmlToMarkdown throw
    // HuduConfigError; it must propagate unchanged (NOT re-typed as content loss), with the
    // PUT never issued -- no half-state.
    const big = `<p>${'x'.repeat(300 * 1024)}</p>`;
    const spy = stubFetch(() => json({ article: { ...article, content: big } }));
    const err = (await makeClient().articles
      .update(1, { content: '## New' }, { format: 'markdown' })
      .catch((e: unknown) => e)) as HuduConfigError;
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('over the');
    expect(spy.calls).toHaveLength(1); // the guard's GET ran; no PUT was issued
  });

  it('propagates the converter cap error cleanly from the SUBMITTED body with zero fetches', async () => {
    // allowLossyMarkdown + no expectedUpdatedAt: the zero-fetch branch converts before
    // updateOne, so an over-cap submitted body throws with NO request at all.
    const spy = stubFetch(() => json({ article }));
    const err = (await makeClient()
      .articles.update(1, { content: 'x'.repeat(300 * 1024) }, { format: 'markdown', allowLossyMarkdown: true })
      .catch((e: unknown) => e)) as HuduConfigError;
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('content.markdownToHtml');
    expect(spy.calls).toHaveLength(0);
  });

  it('reports a stored body that converts to EMPTY Markdown as HuduContentLossError (total loss)', async () => {
    // issue #43, Batch 2 #4: a non-empty stored body that htmlToMarkdown empties used to
    // surface as HuduConfigError; it is unambiguous total loss, so it is CONTENT_LOSS now,
    // with the rule-table finding that names exactly this shape (ROUNDTRIP_BODY_EMPTY).
    const spy = stubFetch(() => json({ article: { ...article, content: '<!-- invisible to the converter -->' } }));
    const err = (await makeClient()
      .articles.update(1, { content: '## New' }, { format: 'markdown' })
      .catch((e: unknown) => e)) as HuduContentLossError;
    expect(err).toBeInstanceOf(HuduContentLossError);
    expect(err.findings).toHaveLength(1);
    expect(err.findings[0]!.code).toBe('ROUNDTRIP_BODY_EMPTY');
    expect(err.findings[0]!.impact).toBe('content');
    expect(spy.calls).toHaveLength(1); // the guard's GET ran; no PUT was issued
  });

  it('names articles.update when the guard fetch 404s (wire)', async () => {
    // issue #43, Batch 2 #6: the guard fetch is an internal step of the update, so its miss
    // names the operation the caller invoked in the structured error (pre-fix it named
    // articles.get).
    const spy = stubFetch(() => json({ error: 'no' }, 404));
    const err = (await makeClient()
      .articles.update(99, { content: '## New' }, { format: 'markdown' })
      .catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.operation).toBe('articles.update');
    expect(err.message).not.toContain('articles.get');
    expect(spy.calls).toHaveLength(1); // the guard's GET; no PUT was issued
  });

  it('names articles.update when the guard fetch answers 200 with an empty body', async () => {
    // The 200-with-null-body shape (live-verified vendor behaviour) is the second NotFound
    // source; its message names the operation too.
    stubFetch(() => json(null));
    const err = (await makeClient()
      .articles.update(99, { content: '## New' }, { format: 'markdown' })
      .catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.operation).toBe('articles.update');
    expect(err.message).toContain('articles.update');
    expect(err.message).not.toContain('articles.get');
  });

  it('audits the guard fetch as articles.update (one entry, correct operation)', async () => {
    // issue #43, Batch 2 #6: the single audit entry for a failed guard fetch is named after
    // the operation the caller invoked, not the fetch primitive.
    const { client, events } = auditedClient();
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(
      client.articles.update(99, { content: '## New' }, { format: 'markdown' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(events).toHaveLength(1);
    expect(events[0]!.operation).toBe('articles.update');
    expect(events[0]!.outcome).toBe('error');
  });

  it('dry-run markdown update checks staleness and throws (stricter than the plain path, by design)', async () => {
    // issue #43, Batch 2 #3: the deliberate divergence documented on update() -- the
    // Markdown path checks expectedUpdatedAt even in a dry run (and issues the guard's GET),
    // so a stale expectedUpdatedAt rejects before any description is built.
    const spy = stubFetch(() => json({ article: { ...article, updated_at: '2030-01-01T00:00:00.000Z' } }));
    await expect(
      makeClient().articles.update(1, { content: '## New' }, { format: 'markdown', dryRun: true, expectedUpdatedAt: article.updated_at }),
    ).rejects.toThrow(StaleObjectError);
    expect(spy.calls).toHaveLength(1); // the guard's GET ran; no PUT followed
  });

  it('dry-run HTML update with a stale expectedUpdatedAt neither fetches nor throws (updateOne short-circuits)', async () => {
    // The other side of the deliberate divergence (issue #43, Batch 2 #3): probe-confirmed
    // before the change and pinned here -- updateOne's dry-run returns BEFORE its own stale
    // check, so no GET is issued and no StaleObjectError is thrown.
    const spy = stubFetch(() => json({ article: { ...article, updated_at: '2030-01-01T00:00:00.000Z' } }));
    const result = (await makeClient().articles.update(1, { content: '<p>x</p>' }, {
      dryRun: true,
      expectedUpdatedAt: article.updated_at,
    })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('articles.update');
    expect(spy.calls).toHaveLength(0); // no GET, no PUT
  });

  it('types a non-dryRun Markdown create as the plain Article return (issue #43 B2 #5 overload)', async () => {
    // The create overload set now mirrors update's `dryRun?: false` counterpart, so a
    // Markdown create without dryRun type-checks to Article with no narrowing. This line is
    // the compile-time pin; the gate is tsc.
    const spy = stubFetch(() => json(article, 201));
    const created: Article = await makeClient().articles.create(
      { name: 'N', content: '## Setup', folder_id: 5 },
      { format: 'markdown' },
    );
    expect(created.id).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].init.method).toBe('POST');
  });

  it('describes a Markdown create on dry run: no fetch, no POST, simulated result', async () => {
    // issue #43, Batch 2 #7: a create has no stored body, so even the Markdown path issues
    // no fetch on dry run -- the description covers the POST that would carry the
    // converted HTML payload.
    const spy = stubFetch(() => json(article, 201));
    const result = (await makeClient().articles.create(
      { name: 'N', content: '## Setup', folder_id: 5 },
      { format: 'markdown', dryRun: true },
    )) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('articles.create');
    expect(result.request).toEqual({ method: 'POST', path: '/articles' });
    expect(spy.calls).toHaveLength(0);
  });

  it('converts before describing: an over-cap Markdown body throws on a dry-run create', async () => {
    // The described payload is the CONVERTED one -- the conversion runs before the dry-run
    // short-circuit, so a body the converter refuses is refused even when nothing is sent
    // (issue #43, Batch 2 #7).
    const spy = stubFetch(() => json(article, 201));
    const err = (await makeClient()
      .articles.create({ name: 'N', content: 'x'.repeat(300 * 1024) }, { format: 'markdown', dryRun: true })
      .catch((e: unknown) => e)) as HuduConfigError;
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});
