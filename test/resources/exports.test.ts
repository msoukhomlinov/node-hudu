/**
 * ExportsResource agent-execution-layer tests: resolve (id + file name over the
 * NON-PAGINATED list), dry-run on the void create and correlation ids.
 * Uses the shared mocked-fetch helper — never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError } from '../../src/errors.js';
import type { AuditEvent, DryRunResult, Resolution } from '../../src/types/common.js';
import type { Export, ExportSummary } from '../../src/types/export.js';
import type { Page } from '../../src/pagination.js';
import { stubFetch, json, text, empty, clearFetch } from '../helpers.js';

function makeClient(onAudit?: (event: AuditEvent) => void) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...(onAudit ? { onAudit } : {}) });
}

const record: Export = {
  id: 7,
  account_id: 1,
  status: 'completed',
  is_pdf: true,
  file_name: 'acme-2026.pdf',
  file_size: 2048,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:05:00Z',
  download_url: 'https://hudu.example.com/exports/7/download',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('ExportsResource — resolve', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(record));
    const res = await makeClient().exports.resolve(7);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/exports/7');
    expect(res?.id).toBe(7);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    await expect(makeClient().exports.resolve(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('finds the export by file name in one bounded fetch', async () => {
    const spy = stubFetch(() => json([record]));
    const res = await makeClient().exports.resolve('acme-2026.pdf');
    expect(res?.id).toBe(7);
    expect(res?.file_name).toBe('acme-2026.pdf');
    // One fetch, and /exports is non-paginated: no page/page_size may be sent.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/exports');
  });

  it('returns null after a complete scan', async () => {
    stubFetch(() => json([record]));
    await expect(makeClient().exports.resolve('missing.pdf')).resolves.toBeNull();
  });

  it('returns ExportSummary', async () => {
    stubFetch(() => json([record]));
    const summary = (await makeClient().exports.resolve({ file_name: 'acme-2026.pdf' })) as ExportSummary;
    // The Export record is already compact, so the summary IS the record: no field is dropped.
    expect(Object.keys(summary).sort()).toEqual(
      ['account_id', 'created_at', 'download_url', 'file_name', 'file_size', 'id', 'is_pdf', 'status', 'updated_at'],
    );
  });

  it('expand: true returns the full export record', async () => {
    stubFetch(() => json([record]));
    await expect(makeClient().exports.resolve('acme-2026.pdf', { expand: true })).resolves.toEqual(record);
  });

  it('resolutionDetails: true reports the cost of each path', async () => {
    stubFetch(() => json(record));
    const direct = (await makeClient().exports.resolve(7, { resolutionDetails: true })) as Resolution<ExportSummary>;
    expect(direct.resolutionCost).toBe('direct');
    expect(direct.candidates).toEqual([{ id: 7, label: 'export 7 (acme-2026.pdf)' }]);

    stubFetch(() => json([record]));
    const scanned = (await makeClient().exports.resolve('acme-2026.pdf', { resolutionDetails: true })) as Resolution<ExportSummary>;
    expect(scanned.resolutionCost).toBe('client-scan');
    expect(scanned.scanned).toBe(1);
    expect(scanned.scanTruncated).toBe(false);
  });

  it('rejects an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json([record]));
    await expect(makeClient().exports.resolve({ status: 'completed' })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('ExportsResource — plan rows', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped exports list', async () => {
    stubFetch(() => json([record]));
    const out: Export[] = [];
    for await (const e of makeClient().exports.list({})) out.push(e);
    expect(out).toEqual([record]);
  });

  it('never sends page/page_size to the non-paginated endpoint', async () => {
    const spy = stubFetch(() => json([record]));
    await makeClient().exports.listAll({ page: 3, page_size: 5 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/exports');
    expect(spy.calls[0]!.url).not.toContain('page');
  });

  it('returns the unwrapped exports record', async () => {
    stubFetch(() => json(record));
    await expect(makeClient().exports.get(7)).resolves.toEqual(record);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    await expect(makeClient().exports.get(404)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the created exports record', async () => {
    const spy = stubFetch(() => empty(200));
    const request = { format: 'pdf' as const, company_id: 1, include_passwords: false, include_websites: true };
    // POST /exports answers with an empty body: there is no record to return.
    await expect(makeClient().exports.create(request)).resolves.toBeUndefined();
    expect(spy.calls[0]!.init.method).toBe('POST');
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ export: request }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(200));
    const result = (await makeClient().exports.create(
      { format: 'csv', company_id: 1, include_passwords: true, include_websites: true },
      { dryRun: true },
    )) as DryRunResult<void>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('exports.create');
    expect(result.request).toEqual({ method: 'POST', path: '/exports' });
    expect(result.checks.map((c) => c.name)).toEqual(['payload-present', 'export-request']);
    // The plan's contract: the warning states there is no server-computed result to promise.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('empty 200 body');
    expect(result.warnings[0]).toContain('no server-computed result to promise');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const events: AuditEvent[] = [];
    const client = makeClient((event) => events.push(event));
    const spy = stubFetch(() => empty(200));
    await client.exports.create({ format: 'pdf', company_id: 1, include_passwords: false, include_websites: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.correlationId).toMatch(UUID);
    expect(events[0]!.operation).toBe('exports.create');
    expect(events[0]!.effect).toBe('write');

    spy.setHandler(() => json({ error: 'nope' }, 404));
    const err = (await client.exports.get(404).catch((e: unknown) => e)) as HuduError;
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('exports.get');
    const errorEvent = events[events.length - 1]!;
    expect(errorEvent.outcome).toBe('error');
    expect(errorEvent.correlationId).toBe(err.correlationId);
    expect(errorEvent.httpStatus).toBe(404);
  });
});


describe('ExportsResource — remaining branches', () => {
  afterEach(() => clearFetch());

  it('accepts a numeric string id and an { id } object', async () => {
    const spy = stubFetch(() => json(record));
    await expect(makeClient().exports.resolve('7')).resolves.toEqual(record);
    await expect(makeClient().exports.resolve({ id: 7 })).resolves.toEqual(record);
    expect(spy.calls.map((c) => c.url)).toEqual([
      'https://hudu.example.com/api/v1/exports/7',
      'https://hudu.example.com/api/v1/exports/7',
    ]);
  });

  it('rejects a null identifier without issuing a request', async () => {
    const spy = stubFetch(() => json([record]));
    await expect(makeClient().exports.resolve(null as unknown as number)).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });

  it('get with download: true returns the file blob', async () => {
    const spy = stubFetch(() => text('pdf-bytes'));
    const res = await makeClient().exports.get(7, { download: true });
    expect(res).toBeInstanceOf(Blob);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/exports/7?download=true');
  });

  it('listPages yields pages with their pagination metadata', async () => {
    stubFetch(() => json([record]));
    const pages: Page<Export>[] = [];
    for await (const p of makeClient().exports.listPages()) pages.push(p);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.items).toEqual([record]);
  });

  it('dry-run reports an unusable export request instead of inventing a pass', async () => {
    const spy = stubFetch(() => empty(200));
    const result = (await makeClient().exports.create(
      { format: 'docx' as unknown as 'pdf', company_id: 1, include_passwords: false, include_websites: false },
      { dryRun: true },
    )) as DryRunResult<void>;
    expect(spy.calls).toHaveLength(0);
    expect(result.checks[1]!.ok).toBe(false);
    expect(result.checks[1]!.detail).toContain('required by the API spec');
  });
});

describe('ExportsResource — the stale option outside update', () => {
  afterEach(() => clearFetch());

  it('refuses expectedUpdatedAt on create instead of ignoring it', async () => {
    const spy = stubFetch(() => empty(200));
    const err = (await makeClient()
      .exports.create(
        { format: 'pdf', company_id: 1, include_passwords: false, include_websites: true },
        { expectedUpdatedAt: 't' },
      )
      .catch((e: unknown) => e)) as HuduError;
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(err.message).toContain('exports.create');
    expect(err.message).toContain('update (PUT) only');
    expect(spy.calls).toHaveLength(0);
  });
});
