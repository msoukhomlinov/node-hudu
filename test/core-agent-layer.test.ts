/**
 * Core agent-execution-layer plumbing (policy §6-§10): dry-run, correlation ids,
 * audit + redaction, the bounded client scan, the stale guard and the structured
 * error contract. Uses the shared mocked-fetch helper — never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HttpClient } from '../src/http.js';
import type { DryRunRequest } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import { BaseResource } from '../src/resources/base.js';
import type { DryRunOperation } from '../src/resources/base.js';
import { redact, isCredentialKey, REDACTED, REDACTED_KEYS } from '../src/logger.js';
import {
  HuduError, HuduConfigError, HuduNetworkError, BadRequestError, UnauthorizedError,
  ForbiddenError, NotFoundError, MethodNotAllowedError, NotAcceptableError, UnprocessableEntityError,
  RateLimitError, ServerError, ConflictError, StaleObjectError, ValidationFailedError,
  DuplicateFoundError, ResolutionError, PolicyDeniedError, errorFromStatus, isHuduError,
} from '../src/errors.js';
import type {
  AuditEvent, DryRunResult, Identifier, MutationOptions, Resolution,
} from '../src/types/common.js';
import type { Page } from '../src/pagination.js';
import { clearFetch, stubFetch, json, empty } from './helpers.js';

interface Probe { id: number; name: string; updated_at?: string }

interface ScanOpts<T> {
  match: (item: T) => boolean;
  maxScanRecords?: number;
  maxScanPages?: number;
  label: (item: T) => string;
  idOf?: (item: T) => number;
  resolutionCost?: 'direct' | 'server-filter' | 'client-scan';
}

function makeHttp(overrides: Record<string, unknown> = {}): HttpClient {
  return new HttpClient(
    resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'secret-key', ...overrides }),
  );
}

/** Exposes the protected BaseResource plumbing the way a real resource would. */
class ProbeResource extends BaseResource<Probe> {
  constructor(http: HttpClient, paginated = true) {
    super(http, {
      resourcePath: 'companies',
      singleKey: 'company',
      listKey: 'companies',
      createType: 'wrapped',
      paginated,
    });
  }
  get(id: number): Promise<Probe> { return this.getOne<Probe>(id); }
  create(data: unknown, opts?: MutationOptions): Promise<Probe | DryRunResult<Probe>> {
    return this.createOne<Probe>(data, undefined, opts);
  }
  update(id: number | string, data: unknown, opts?: MutationOptions): Promise<Probe | DryRunResult<Probe>> {
    return this.updateOne<Probe>(id, data, undefined, opts);
  }
  updateWithQuery(id: number | string, data: unknown, query: Record<string, unknown>): Promise<Probe | DryRunResult<Probe>> {
    return this.updateOne<Probe>(id, data, query);
  }
  remove(id: number | string, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    return this.deleteOne(id, opts);
  }
  archive(id: number | string, on: boolean, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    return this.setArchived(id, on, opts);
  }
  // Overload-contract checks: these typed signatures do not build if the TS OVERLOADS
  // on the mutating primitives regress (the existing call shape must return U; the
  // literal { dryRun: true } shape must return DryRunResult<U>).
  createTyped(data: unknown): Promise<Probe> { return this.createOne<Probe>(data); }
  createTypedWithQuery(data: unknown, query: Record<string, unknown>): Promise<Probe> { return this.createOne<Probe>(data, query); }
  createDry(data: unknown): Promise<DryRunResult<Probe>> { return this.createOne<Probe>(data, undefined, { dryRun: true }); }
  updateTyped(id: number, data: unknown): Promise<Probe> { return this.updateOne<Probe>(id, data); }
  updateTypedWithQuery(id: number, data: unknown, query: Record<string, unknown>): Promise<Probe> { return this.updateOne<Probe>(id, data, query); }
  updateStaleTyped(id: number, data: unknown, expected: string): Promise<Probe> {
    return this.updateOne<Probe>(id, data, undefined, { expectedUpdatedAt: expected });
  }
  updateDry(id: number, data: unknown): Promise<DryRunResult<Probe>> { return this.updateOne<Probe>(id, data, undefined, { dryRun: true }); }
  deleteTyped(id: number): Promise<void> { return this.deleteOne(id); }
  deleteDry(id: number): Promise<DryRunResult<void>> { return this.deleteOne(id, { dryRun: true }); }
  archiveTyped(id: number, on: boolean): Promise<void> { return this.setArchived(id, on); }
  archiveDry(id: number, on: boolean): Promise<DryRunResult<void>> { return this.setArchived(id, on, { dryRun: true }); }
  buildResult<U = Probe>(op: DryRunOperation): DryRunResult<U> { return this.buildDryRunResult<U>(op); }
  raw<U>(opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string }): Promise<U> { return this.request<U>(opts); }
  getConcurrency(): number { return this.concurrency; }
  scan<T>(fetchPage: (page: number, pageSize: number) => Promise<Page<T>>, opts: ScanOpts<T>): Promise<Resolution<T>> {
    return this.boundedScan<T>(fetchPage, opts);
  }
  stale(id: number | string, expected: string | undefined, fetchCurrent: () => Promise<{ updated_at?: string } | undefined>): Promise<void> {
    return this.assertNotStale('companies.update', 'companies', id, expected, fetchCurrent);
  }
  map<X, Y>(items: readonly X[], fn: (item: X, index: number) => Promise<Y>, concurrency?: number): Promise<Y[]> {
    return this.mapConcurrent(items, fn, concurrency);
  }
  static require<T>(resolution: Resolution<T>, opts: { resource: string; operation?: string; identifier?: Identifier }): T | null {
    return ProbeResource.requireResolved<T>(resolution, opts);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Await a promise that must reject, and return the error it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the request to reject');
}

function auditSpy(): { events: AuditEvent[]; hook: (event: AuditEvent) => void } {
  const events: AuditEvent[] = [];
  return { events, hook: (event) => { events.push(event); } };
}

/** Fetcher over a fixed record list, 25 per page (the scan page size). */
function pagesOf<T>(all: T[]) {
  return async (page: number, pageSize: number): Promise<Page<T>> => {
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);
    return { items, page, page_size: pageSize, hasMore: start + pageSize < all.length };
  };
}

/** Fetcher that always reports more pages, with unique ids. */
function endlessPage<T>(make: (n: number) => T) {
  return async (page: number, pageSize: number): Promise<Page<T>> => {
    const items: T[] = [];
    for (let i = 0; i < pageSize; i++) items.push(make((page - 1) * pageSize + i));
    return { items, page, page_size: pageSize, hasMore: true };
  };
}

describe('agent-layer client config', () => {
  it('keeps every existing default and adds the new ones', () => {
    const cfg = resolveConfig({ baseUrl: 'https://x.example.com', apiKey: ' k ' });
    expect(cfg.basePath).toBe('/api/v1');
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.rateLimit).toBeUndefined();
    expect(cfg.resolution).toEqual({ maxScanRecords: 500, maxScanPages: 4 });
    expect(cfg.concurrency).toBe(4);
    expect(cfg.onAudit).toBeUndefined();
  });

  it('accepts and resolves the new options', () => {
    const hook = () => {};
    const cfg = resolveConfig({
      baseUrl: 'https://x.example.com', apiKey: 'k',
      resolution: { maxScanRecords: 10, maxScanPages: 2 }, concurrency: 8, onAudit: hook,
    });
    expect(cfg.resolution).toEqual({ maxScanRecords: 10, maxScanPages: 2 });
    expect(cfg.concurrency).toBe(8);
    expect(cfg.onAudit).toBe(hook);
    // A partial resolution block keeps the other default.
    expect(resolveConfig({ baseUrl: 'https://x.example.com', apiKey: 'k', resolution: { maxScanPages: 3 } }).resolution)
      .toEqual({ maxScanRecords: 500, maxScanPages: 3 });
  });

  it('applies each new option default independently', () => {
    const partial = resolveConfig({
      baseUrl: 'https://x.example.com', apiKey: 'k', resolution: { maxScanRecords: 10 },
    });
    expect(partial.resolution).toEqual({ maxScanRecords: 10, maxScanPages: 4 });
  });

  it('rejects nonsense in the new options', () => {
    const base = { baseUrl: 'https://x.example.com', apiKey: 'k' };
    const bad: Record<string, unknown>[] = [
      { resolution: { maxScanRecords: 0 } },
      { resolution: { maxScanRecords: 1.5 } },
      { resolution: { maxScanRecords: 'many' } },
      { resolution: { maxScanPages: 0 } },
      { resolution: { maxScanPages: -2 } },
      { concurrency: 0 },
      { concurrency: 1.5 },
      { concurrency: 'lots' },
      { onAudit: 'not a function' },
    ];
    for (const overrides of bad) {
      expect(() => resolveConfig({ ...base, ...overrides }), JSON.stringify(overrides)).toThrow(HuduConfigError);
    }
  });

  it('a client without the new options behaves exactly as before (no audit, no dry-run)', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }));
    const http = makeHttp();
    await expect(http.request({ method: 'GET', path: '/companies/1' })).resolves.toEqual({ company: { id: 1 } });
    expect(spy.calls).toHaveLength(1);
    expect(http.concurrency).toBe(4);
    expect(http.resolution).toEqual({ maxScanRecords: 500, maxScanPages: 4 });
    clearFetch();
  });
});

describe('dry-run: no mutating request is ever issued', () => {
  afterEach(() => clearFetch());

  it('create/update/delete/archive dry-runs call fetch ZERO times and return simulated results', async () => {
    const spy = stubFetch(() => json({}));
    const http = makeHttp();
    const r = new ProbeResource(http);

    const created = (await r.create({ name: 'Acme' }, { dryRun: true })) as DryRunResult<Probe>;
    const updated = (await r.update(42, { name: 'Acme Pty' }, { dryRun: true })) as DryRunResult<Probe>;
    const deleted = (await r.remove(42, { dryRun: true })) as DryRunResult<void>;
    const archived = (await r.archive(42, true, { dryRun: true })) as DryRunResult<void>;

    // The policy's hard requirement: a spy on fetch shows no request at all.
    expect(spy.calls).toHaveLength(0);

    expect(created.simulated).toBe(true);
    expect(created.wouldApply).toBe(true);
    expect(created.operation).toBe('companies.create');
    expect(created.target).toEqual({ resource: 'companies', ids: [] });
    expect(created.request).toEqual({ method: 'POST', path: '/companies' });
    expect(created.checks).toEqual([{ name: 'payload-present', ok: true, detail: 'request body supplied' }]);
    expect(created.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
    expect(created.warnings.length).toBeGreaterThan(0);

    expect(updated.operation).toBe('companies.update');
    expect(updated.request).toEqual({ method: 'PUT', path: '/companies/42' });
    expect(updated.target.ids).toEqual([42]);
    expect(updated.checks.map((c) => c.name)).toEqual(['target-identifier', 'payload-present']);

    expect(deleted.operation).toBe('companies.delete');
    expect(deleted.request).toEqual({ method: 'DELETE', path: '/companies/42' });
    expect(deleted.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
    expect(deleted.warnings).toEqual(['dry-run does not inspect dependent records']);

    expect(archived.operation).toBe('companies.archive');
    expect(archived.request).toEqual({ method: 'PUT', path: '/companies/42/archive' });
    expect(archived.impact.reversible).toBe(true);
    expect((await r.archive(42, false, { dryRun: true }) as DryRunResult<void>).operation).toBe('companies.unarchive');
    expect(spy.calls).toHaveLength(0);
  });

  it('keeps the existing call shape typed as the record and the literal dry-run shape typed as DryRunResult', async () => {
    stubFetch(() => json({ company: { id: 9, updated_at: 'T' } }));
    const r = new ProbeResource(makeHttp());
    // Existing call shapes still return the record type U.
    await expect(r.createTyped({ name: 'x' })).resolves.toEqual({ id: 9, updated_at: 'T' });
    await expect(r.createTypedWithQuery({ name: 'x' }, { q: 1 })).resolves.toEqual({ id: 9, updated_at: 'T' });
    await expect(r.updateTyped(9, { name: 'x' })).resolves.toEqual({ id: 9, updated_at: 'T' });
    await expect(r.updateTypedWithQuery(9, { name: 'x' }, { q: 1 })).resolves.toEqual({ id: 9, updated_at: 'T' });
    await expect(r.updateStaleTyped(9, { name: 'x' }, 'T')).resolves.toEqual({ id: 9, updated_at: 'T' });
    await expect(r.deleteTyped(9)).resolves.toBeUndefined();
    await expect(r.archiveTyped(9, true)).resolves.toBeUndefined();
    // Literal { dryRun: true } shapes return a DryRunResult<void>-typed value.
    expect((await r.updateDry(9, { name: 'x' })).simulated).toBe(true);
    expect((await r.deleteDry(9)).simulated).toBe(true);
    expect((await r.archiveDry(9, true)).simulated).toBe(true);
    expect((await r.createDry({ name: 'x' })).simulated).toBe(true);
  });

  it('reports the checks that actually failed instead of inventing a pass', async () => {
    const spy = stubFetch(() => json({}));
    const r = new ProbeResource(makeHttp());
    const noPayload = (await r.create(undefined, { dryRun: true })) as DryRunResult<Probe>;
    expect(noPayload.checks[0]).toEqual({
      name: 'payload-present', ok: false, detail: 'no request body was supplied',
    });
    const noTarget = (await r.remove('', { dryRun: true })) as DryRunResult<void>;
    expect(noTarget.checks[0]).toEqual({
      name: 'target-identifier', ok: false, detail: 'no target identifier was supplied',
    });
    expect(spy.calls).toHaveLength(0);
  });

  it('buildDryRunResult carries an explicit diff, scope, warnings and affected count', () => {
    const r = new ProbeResource(makeHttp());
    const bulk = r.buildResult<void>({
      operation: 'companies.deleteAll',
      method: 'DELETE',
      path: '/companies',
      checks: [{ name: 'bounded-scope', ok: true }],
      diff: [{ field: 'archived', from: false, to: true }],
      affected: 7,
      scope: 'bulk',
      reversible: false,
      warnings: ['bulk delete cannot be undone'],
    });
    expect(bulk.diff).toEqual([{ field: 'archived', from: false, to: true }]);
    expect(bulk.impact).toEqual({ affected: 7, scope: 'bulk', reversible: false });
    expect(bulk.warnings).toEqual(['bulk delete cannot be undone']);
    expect(bulk.simulated).toBe(true);
    // Defaults when the caller gives none.
    const bare = r.buildResult<void>({ operation: 'companies.get', method: 'GET', path: '/companies/1' });
    expect(bare.diff).toBeUndefined();
    expect(bare.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
    expect('exact' in bare.impact).toBe(false);
    expect(bare.warnings).toEqual(['server-computed fields are not guaranteed by dry-run']);
  });

  it('the transport itself short-circuits a dryRun request (marker, no fetch, audit dryRun: true)', async () => {
    const spy = stubFetch(() => json({}));
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook });
    const marker = await http.request<DryRunRequest>({
      method: 'POST', path: '/companies', body: { name: 'x' }, operation: 'companies.create', dryRun: true,
    });
    expect(spy.calls).toHaveLength(0);
    expect(marker.__dryRun).toBe(true);
    expect(marker.simulated).toBe(true);
    expect(marker.method).toBe('POST');
    expect(marker.path).toBe('/companies');
    expect(marker.url).toBe('https://hudu.example.com/api/v1/companies');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.dryRun).toBe(true);
    expect(audit.events[0]!.outcome).toBe('success');
    expect(audit.events[0]!.operation).toBe('companies.create');
  });

  it('rejects mutation options passed in the query position instead of writing them as query params', async () => {
    const spy = stubFetch(() => json({ company: { id: 42 } }));
    const r = new ProbeResource(makeHttp());
    await expect(r.updateWithQuery(42, { name: 'x' }, { dryRun: true })).rejects.toThrow(HuduConfigError);
    await expect(r.updateWithQuery(42, { name: 'x' }, { expectedUpdatedAt: 't' })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('correlation id and the optional audit hook', () => {
  afterEach(() => clearFetch());

  it('audits one success event with correlationId/operation/effect/outcome/resourceIds', async () => {
    stubFetch(() => json({ company: { id: 1 } }));
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook });
    await http.request({ method: 'GET', path: '/companies/1' });
    expect(audit.events).toHaveLength(1);
    const event = audit.events[0]!;
    expect(event.correlationId).toMatch(UUID);
    expect(event.operation).toBe('companies.get');
    expect(event.effect).toBe('read');
    expect(event.outcome).toBe('success');
    expect(event.dryRun).toBe(false);
    expect(event.method).toBe('GET');
    expect(event.path).toBe('/companies/1');
    expect(event.resourceIds).toEqual([1]);
    expect(event.httpStatus).toBeUndefined();
    expect(event.query).toBeUndefined();
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('generates ONE correlation id per call and reuses it across retries', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n++;
      return n === 1 ? json({}, 500) : json({ company: { id: 1 } });
    });
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook, maxRetries: 1 });
    await http.request({ method: 'GET', path: '/companies/1' });
    expect(spy.calls).toHaveLength(2);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.outcome).toBe('success');
    expect(audit.events[0]!.correlationId).toMatch(UUID);
  });

  it('surfaces the same correlation id on the thrown error and on the error event', async () => {
    stubFetch(() => json({ error: 'nope' }, 404));
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook });
    const err = await rejection(
      http.request({ method: 'GET', path: '/companies/9', operation: 'companies.get' }),
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('companies.get');
    expect(err.resourceIds).toEqual([9]);
    expect(err.httpStatus).toBe(404);
    expect(err.status).toBe(404);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.outcome).toBe('error');
    expect(audit.events[0]!.httpStatus).toBe(404);
    expect(audit.events[0]!.correlationId).toBe(err.correlationId);
    expect(audit.events[0]!.operation).toBe('companies.get');
  });

  it('derives operation names and effects from the verb and path when no operation is given', async () => {
    stubFetch(() => json({}));
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook });
    await http.request({ method: 'GET', path: '/companies' });
    await http.request({ method: 'POST', path: '/companies' });
    await http.request({ method: 'PUT', path: '/companies/1' });
    await http.request({ method: 'PUT', path: '/companies/1/archive' });
    await http.request({ method: 'DELETE', path: '/companies/1' });
    await http.request({ method: 'GET', path: '/' });
    expect(audit.events.map((e) => e.operation)).toEqual([
      'companies.list', 'companies.create', 'companies.update', 'companies.archive', 'companies.delete', 'hudu.list',
    ]);
    expect(audit.events.map((e) => e.effect)).toEqual([
      'read', 'write', 'write', 'write', 'destructive', 'read',
    ]);
    expect(audit.events[0]!.resourceIds).toBeUndefined();
    expect(audit.events[2]!.resourceIds).toEqual([1]);
  });

  it('redacts credential-shaped query values in the audit payload but never in returned data', async () => {
    stubFetch(() => json({ company: { id: 1, api_key: 'KEEP-ME' } }));
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook });
    const data = await http.request<{ company: Record<string, unknown> }>({
      method: 'GET', path: '/companies/1', query: { api_key: 'SUPERSECRET', page: 2 },
    });
    // Returned data is NOT silently redacted.
    expect(data.company.api_key).toBe('KEEP-ME');
    // The audit payload carries no credential-shaped value.
    const event = audit.events[0]!;
    expect(event.query).toEqual({ api_key: REDACTED, page: 2 });
    const serialised = JSON.stringify(audit.events);
    expect(serialised).not.toContain('SUPERSECRET');
    expect(serialised).not.toContain('secret-key');
    expect(serialised).not.toContain('KEEP-ME');
  });

  it('does nothing when no hook is configured (no logging by default)', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }));
    const http = makeHttp();
    await expect(http.request({ method: 'GET', path: '/companies/1' })).resolves.toBeDefined();
    expect(spy.calls).toHaveLength(1);
  });
});

describe('executed-result metadata: impact on the audit event (policy §7.3)', () => {
  afterEach(() => clearFetch());

  it('a successful update reports its impact in the executed result metadata', async () => {
    stubFetch(() => json({ company: { id: 9, updated_at: 'T' } }));
    const audit = auditSpy();
    const r = new ProbeResource(makeHttp({ onAudit: audit.hook }));
    await r.update(9, { name: 'x' });
    expect(audit.events).toHaveLength(1);
    const event = audit.events[0]!;
    expect(event.effect).toBe('write');
    expect(event.outcome).toBe('success');
    expect(event.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('a successful delete reports a non-reversible impact', async () => {
    stubFetch(() => empty(204));
    const audit = auditSpy();
    const r = new ProbeResource(makeHttp({ onAudit: audit.hook }));
    await r.remove(9);
    const event = audit.events[0]!;
    expect(event.effect).toBe('destructive');
    expect(event.impact).toEqual({ affected: 1, scope: 'single', reversible: false });
  });

  it('a READ event carries no impact at all', async () => {
    stubFetch(() => json({ company: { id: 9 } }));
    const audit = auditSpy();
    const r = new ProbeResource(makeHttp({ onAudit: audit.hook }));
    await r.get(9);
    const event = audit.events[0]!;
    expect(event.effect).toBe('read');
    expect(event.impact).toBeUndefined();
    expect('impact' in event).toBe(false);
  });

  it('the error path still reports the best-effort impact', async () => {
    stubFetch(() => json({ error: 'nope' }, 500));
    const audit = auditSpy();
    const r = new ProbeResource(makeHttp({ onAudit: audit.hook, maxRetries: 0 }));
    await r.create({ name: 'x' }).catch(() => undefined);
    const event = audit.events[0]!;
    expect(event.outcome).toBe('error');
    expect(event.httpStatus).toBe(500);
    expect(event.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
  });

  it('a caller-supplied bulk impact reaches the event, including exact: false', async () => {
    stubFetch(() => empty(204));
    const audit = auditSpy();
    const http = makeHttp({ onAudit: audit.hook });
    await http.request({
      method: 'DELETE', path: '/activity_logs', operation: 'activity_logs.deleteAll',
      impact: { affected: 50, scope: 'bulk', reversible: false, exact: false },
    });
    expect(audit.events[0]!.impact).toEqual({ affected: 50, scope: 'bulk', reversible: false, exact: false });
    // A read never gains an impact even when one is passed.
    await http.request({ method: 'GET', path: '/companies', impact: { affected: 5, scope: 'bulk', reversible: false } });
    expect(audit.events[1]!.impact).toBeUndefined();
  });

  it('the dry-run impact and the executed impact are the same statement', async () => {
    stubFetch(() => empty(204));
    const audit = auditSpy();
    const r = new ProbeResource(makeHttp({ onAudit: audit.hook }));
    const dry = (await r.remove(9, { dryRun: true })) as DryRunResult<void>;
    await r.remove(9);
    expect(dry.impact).toEqual(audit.events[0]!.impact);
  });

  it('buildDryRunResult marks affected as a lower bound when exact: false is given', () => {
    const r = new ProbeResource(makeHttp());
    const bulk = r.buildResult<void>({
      operation: 'activity_logs.deleteAll',
      method: 'DELETE',
      path: '/activity_logs',
      affected: 50,
      scope: 'bulk',
      reversible: false,
      exact: false,
    });
    expect(bulk.impact).toEqual({ affected: 50, scope: 'bulk', reversible: false, exact: false });
  });
});

describe('redact() — the one SDK redactor', () => {
  it('exports the documented key list and marker', () => {
    expect(REDACTED).toBe('[REDACTED]');
    expect([...REDACTED_KEYS]).toEqual([
      'password', 'otp_secret', 'api_key', 'token', 'secret', 'authorization',
      'x-api-key', 'client_secret', 'private_key',
    ]);
  });

  it('replaces credential-shaped keys, case-insensitively and by suffix', () => {
    const input: Record<string, unknown> = {
      password: 'p', otp_secret: 'o', api_key: 'a', token: 't', secret: 's',
      authorization: 'Bearer h', 'X-Api-Key': 'x', client_secret: 'cs', private_key: 'pk',
      user_token: 'ut', my_secret: 'ms', db_password: 'dp', name: 'Acme', id: 7,
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.otp_secret).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out['X-Api-Key']).toBe(REDACTED);
    expect(out.client_secret).toBe(REDACTED);
    expect(out.private_key).toBe(REDACTED);
    expect(out.user_token).toBe(REDACTED);
    expect(out.my_secret).toBe(REDACTED);
    expect(out.db_password).toBe(REDACTED);
    expect(out.name).toBe('Acme');
    expect(out.id).toBe(7);
    // The input is untouched — returned data is never silently altered.
    expect(input.password).toBe('p');
    expect(isCredentialKey('owner')).toBe(false);
    expect(isCredentialKey('TOKEN')).toBe(true);
  });

  it('masks every spelling of a credential key, not just the snake_case one', () => {
    // Live sandbox testing found `apiKey` - the camelCase name the SDK's own config uses, and the one most
    // JSON bodies carry - was NOT masked, because the key set only held `api_key`. A credential could
    // therefore reach an audit event or a log line in clear text.
    const input = {
      apiKey: 'K', apikey: 'K', api_key: 'K', API_KEY: 'K', 'api-key': 'K', 'Api-Key': 'K',
      clientSecret: 'cs', privateKey: 'pk', otpSecret: 'os', accessToken: 'at',
    };
    const out = redact(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) expect(out[key]).toBe(REDACTED);
    for (const key of Object.keys(input)) expect(isCredentialKey(key)).toBe(true);
    // A field whose name merely CONTAINS a credential word but is not one stays readable.
    expect(isCredentialKey('keywords')).toBe(false);
  });

  it('recurses through nested records and arrays, and passes non-plain values through', () => {
    const out = redact({
      company: { id: 1, password: 'p', nested: [{ api_key: 'a', keep: true }] },
      blob: new Date(0),
    }) as Record<string, unknown>;
    expect(out.company).toEqual({ id: 1, password: REDACTED, nested: [{ api_key: REDACTED, keep: true }] });
    expect(out.blob).toBeInstanceOf(Date);
    expect(redact('plain')).toBe('plain');
    expect(redact(null)).toBeNull();
  });
});

describe('bounded client scan (policy §6)', () => {
  afterEach(() => clearFetch());

  const records = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `Company ${i + 1}` }));

  /** The RESOLUTION_TRUNCATED error for a given identifier, for its resourceIds. */
  function resolutionErrorFor(opts: { resource: string; identifier: Identifier }): ResolutionError {
    const truncated: Resolution<{ id: number }> = { value: null, resolutionCost: 'client-scan', scanned: 50, scanTruncated: true };
    try {
      ProbeResource.require(truncated, opts);
    } catch (err) {
      return err as ResolutionError;
    }
    throw new Error('expected a RESOLUTION_TRUNCATED error');
  }
  const matchId = (id: number) => (item: { id: number }) => item.id === id;

  it('stops at the FIRST exact match and reports the cost, count and candidates', async () => {
    const r = new ProbeResource(makeHttp());
    const resolution = await r.scan<{ id: number; name: string }>(
      pagesOf(records),
      { match: matchId(30), label: (item) => item.name, idOf: (item) => item.id },
    );
    expect(resolution.value).toEqual({ id: 30, name: 'Company 30' });
    expect(resolution.resolutionCost).toBe('client-scan');
    expect(resolution.scanned).toBe(30);
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.candidates).toEqual([{ id: 30, label: 'Company 30' }]);
  });

  it('stops at maxScanRecords (pages already fetched are fully examined) and signals truncation', async () => {
    const r = new ProbeResource(makeHttp());
    let calls = 0;
    const inner = endlessPage<{ id: number }>((n) => ({ id: n + 1 }));
    const fetcher = async (page: number, pageSize: number): Promise<Page<{ id: number }>> => {
      calls++;
      return inner(page, pageSize);
    };
    const resolution = await r.scan(fetcher, {
      match: () => false, label: (item) => String(item.id), maxScanRecords: 40,
    });
    // Page 1 gives 25 records (< 40), page 2 pushes the count to 50 (>= 40) with more pages left.
    expect(calls).toBe(2);
    expect(resolution.value).toBeNull();
    expect(resolution.scanned).toBe(50);
    expect(resolution.scanTruncated).toBe(true);
  });

  it('takes maxScanRecords/maxScanPages from the client config by default', async () => {
    const r = new ProbeResource(makeHttp({ resolution: { maxScanRecords: 40, maxScanPages: 2 } }));
    const truncated = await r.scan(endlessPage<{ id: number }>((n) => ({ id: n + 1 })), {
      match: () => false, label: (item) => String(item.id),
    });
    expect(truncated.scanned).toBe(50);
    expect(truncated.scanTruncated).toBe(true);
  });

  it('stops at maxScanPages while the fetcher still has pages left', async () => {
    const r = new ProbeResource(makeHttp());
    let calls = 0;
    const inner = endlessPage<{ id: number }>((n) => ({ id: n + 1 }));
    const fetcher = async (page: number, pageSize: number): Promise<Page<{ id: number }>> => {
      calls++;
      return inner(page, pageSize);
    };
    const resolution = await r.scan(fetcher, {
      match: () => false, label: (item) => String(item.id), maxScanPages: 2, maxScanRecords: 5000,
    });
    expect(resolution.value).toBeNull();
    expect(resolution.scanTruncated).toBe(true);
    expect(resolution.scanned).toBe(50);
    expect(calls).toBe(2); // two page fetches and no hidden extra call
  });

  it('returns null ONLY after a complete scan, with scanTruncated false', async () => {
    const r = new ProbeResource(makeHttp());
    const short = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
    const resolution = await r.scan(pagesOf(short), { match: matchId(9999), label: (item) => String(item.id) });
    expect(resolution.value).toBeNull();
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.scanned).toBe(60);
    expect(resolution.candidates).toBeUndefined();
  });

  it('does not re-request a NON-paginated endpoint and never calls a fetched page truncated', async () => {
    const r = new ProbeResource(makeHttp(), false);
    const all = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` }));
    let calls = 0;
    const nonPaginated = async (): Promise<Page<{ id: number; name: string }>> => {
      calls++;
      return { items: all, page: 1, page_size: all.length, hasMore: false };
    };
    const found = await r.scan(nonPaginated, {
      match: (item) => item.id === 600, label: (item) => item.name, idOf: (item) => item.id, maxScanRecords: 10,
    });
    expect(calls).toBe(1);
    expect(found.value).toEqual({ id: 600, name: 'Row 600' });
    expect(found.scanned).toBe(600);
    expect(found.scanTruncated).toBe(false);

    const missing = await r.scan(nonPaginated, {
      match: () => false, label: (item) => item.name, maxScanRecords: 10,
    });
    expect(calls).toBe(2);
    expect(missing.value).toBeNull();
    expect(missing.scanTruncated).toBe(false);
    expect(missing.scanned).toBe(600);
    // A non-paginated scan may not silently hit the page cap either.
    expect(missing.scanned).toBeGreaterThan(10);
  });

  it('requireResolved turns a truncated scan into RESOLUTION_TRUNCATED and passes null/values through', () => {
    const truncated: Resolution<{ id: number }> = { value: null, resolutionCost: 'client-scan', scanned: 50, scanTruncated: true };
    let thrown: unknown;
    try {
      ProbeResource.require(truncated, { resource: 'companies', operation: 'companies.resolve', identifier: 7 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ResolutionError);
    const err = thrown as ResolutionError;
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.category).toBe('resolution');
    expect(err.retryable).toBe(false);
    expect(err.resourceIds).toEqual([7]);
    expect(err.operation).toBe('companies.resolve');
    expect(err.suggestedAction).toBeTruthy();

    // A structured identifier contributes its id to a truncated error.
    const structured = resolutionErrorFor({ resource: 'companies', identifier: { id: 11, name: 'Acme' } });
    expect(structured.resourceIds).toEqual([11]);
    expect(resolutionErrorFor({ resource: 'companies', identifier: 'acme' }).resourceIds).toBeUndefined();

    const complete: Resolution<{ id: number }> = { value: null, resolutionCost: 'client-scan', scanned: 60, scanTruncated: false };
    expect(ProbeResource.require(complete, { resource: 'companies' })).toBeNull();
    const hit: Resolution<{ id: number }> = { value: { id: 3 }, resolutionCost: 'client-scan', scanned: 3, scanTruncated: false };
    expect(ProbeResource.require(hit, { resource: 'companies' })).toEqual({ id: 3 });
  });
});

describe('stale-object guard and the updateOne contract', () => {
  afterEach(() => clearFetch());

  it('makes NO extra request when expectedUpdatedAt is absent', async () => {
    const spy = stubFetch(() => json({ company: { id: 9 } }));
    const r = new ProbeResource(makeHttp());
    const updated = (await r.update(9, { name: 'x' })) as Probe;
    expect(updated).toEqual({ id: 9 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.init.method).toBe('PUT');
  });

  it('reads then writes when expectedUpdatedAt matches, and still unwraps PUT by singleKey', async () => {
    const spy = stubFetch((url) =>
      url.endsWith('/companies/9')
        ? json({ company: { id: 9, updated_at: '2026-01-01T00:00:00Z' } })
        : json({}),
    );
    const r = new ProbeResource(makeHttp());
    const updated = (await r.update(9, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' })) as Probe;
    expect(updated).toEqual({ id: 9, updated_at: '2026-01-01T00:00:00Z' });
    expect(spy.calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/companies/9');
    expect(spy.calls[1]!.url).toBe('https://hudu.example.com/api/v1/companies/9');
  });

  it('throws STALE_OBJECT before the PUT when the record moved on', async () => {
    const spy = stubFetch(() => json({ company: { id: 9, updated_at: '2026-02-02T00:00:00Z' } }));
    const r = new ProbeResource(makeHttp());
    const err = (await rejection(
      r.update(9, { name: 'x' }, { expectedUpdatedAt: '2026-01-01T00:00:00Z' }),
    )) as StaleObjectError;
    expect(err).toBeInstanceOf(StaleObjectError);
    expect(err.code).toBe('STALE_OBJECT');
    expect(err.category).toBe('conflict');
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(412);
    expect(err.operation).toBe('companies.update');
    expect(err.resourceIds).toEqual([9]);
    expect(err.suggestedAction).toBeTruthy();
    // Only the read happened: the mutation was never issued.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.init.method).toBe('GET');
  });

  it('assertNotStale does nothing at all when expectedUpdatedAt is undefined', async () => {
    const spy = stubFetch(() => json({ company: { id: 9 } }));
    const r = new ProbeResource(makeHttp());
    await expect(r.stale(9, undefined, () => Promise.resolve({ updated_at: 'x' }))).resolves.toBeUndefined();
    expect(spy.calls).toHaveLength(0);
  });

  it('forwards raw requests through the shared HttpClient', async () => {
    const spy = stubFetch(() => json({ company: { id: 1 } }));
    const r = new ProbeResource(makeHttp());
    await expect(r.raw({ method: 'GET', path: '/companies/1' })).resolves.toEqual({ company: { id: 1 } });
    expect(spy.calls).toHaveLength(1);
  });

  it('assertNotStale raises CONFIG_ERROR, never a bogus STALE_OBJECT, when there is no version field', async () => {
    stubFetch(() => json({ company: { id: 9 } }));
    const r = new ProbeResource(makeHttp());
    // No record body at all, then a record whose updated_at is undefined / null / empty.
    for (const current of [undefined, {}, { updated_at: null }, { updated_at: '' }]) {
      const err = (await rejection(r.stale(9, '2026-01-01T00:00:00Z', () => Promise.resolve(current)))) as HuduConfigError;
      expect(err, JSON.stringify(current)).toBeInstanceOf(HuduConfigError);
      expect(err).not.toBeInstanceOf(StaleObjectError);
      expect(err.code).toBe('CONFIG_ERROR');
      expect(err.category).toBe('validation');
      expect(err.retryable).toBe(false);
      expect(err.suggestedAction).toContain('updated_at');
      expect(err.resourceIds).toEqual([9]);
      expect(err.operation).toBe('companies.update');
      expect(err.message).toContain('no updated_at');
    }
  });

  it('rejects expectedUpdatedAt on create/delete/archive instead of silently ignoring it', async () => {
    const spy = stubFetch(() => json({ company: { id: 9, updated_at: 'T' } }));
    const r = new ProbeResource(makeHttp());
    const calls: Promise<unknown>[] = [
      r.create({ name: 'x' }, { expectedUpdatedAt: 'T' }),
      r.create({ name: 'x' }, { expectedUpdatedAt: 'T', dryRun: true }),
      r.remove(9, { expectedUpdatedAt: 'T' }),
      r.remove(9, { expectedUpdatedAt: 'T', dryRun: true }),
      r.archive(9, true, { expectedUpdatedAt: 'T' }),
      r.archive(9, false, { expectedUpdatedAt: 'T', dryRun: true }),
    ];
    const names = ['createOne', 'createOne', 'deleteOne', 'deleteOne', 'setArchived', 'setArchived'];
    for (let i = 0; i < calls.length; i++) {
      const err = (await rejection(calls[i]!)) as HuduConfigError;
      expect(err).toBeInstanceOf(HuduConfigError);
      expect(err.code).toBe('CONFIG_ERROR');
      expect(err.category).toBe('validation');
      expect(err.message).toContain(names[i]!);
      expect(err.message).toContain('guards update only (updateOne)');
    }
    // A caller believing a guard ran must not have issued anything.
    expect(spy.calls).toHaveLength(0);
    // The same options are still accepted by updateOne.
    await expect(r.update(9, { name: 'x' }, { expectedUpdatedAt: 'T' })).resolves.toBeDefined();
  });
});

describe('structured error contract (policy §8)', () => {
  it('populates category/retryable/httpStatus and keeps status as the same value', () => {
    const body = { error: 'boom' };
    const cases: { status: number; instance: unknown; category: string; retryable: boolean }[] = [
      { status: 400, instance: BadRequestError, category: 'validation', retryable: false },
      { status: 401, instance: UnauthorizedError, category: 'auth', retryable: false },
      { status: 403, instance: ForbiddenError, category: 'auth', retryable: false },
      { status: 404, instance: NotFoundError, category: 'not_found', retryable: false },
      { status: 405, instance: MethodNotAllowedError, category: 'validation', retryable: false },
      { status: 406, instance: NotAcceptableError, category: 'validation', retryable: false },
      { status: 409, instance: ConflictError, category: 'conflict', retryable: false },
      { status: 412, instance: StaleObjectError, category: 'conflict', retryable: false },
      { status: 422, instance: UnprocessableEntityError, category: 'validation', retryable: false },
      { status: 429, instance: RateLimitError, category: 'rate_limit', retryable: true },
      { status: 500, instance: ServerError, category: 'server', retryable: true },
      { status: 503, instance: ServerError, category: 'server', retryable: true },
      { status: 418, instance: HuduError, category: 'validation', retryable: false },
    ];
    for (const c of cases) {
      const err = errorFromStatus(c.status, body, 'https://x/api/v1/companies/1');
      expect(err, String(c.status)).toBeInstanceOf(c.instance);
      expect(err.httpStatus, String(c.status)).toBe(c.status);
      expect(err.status, String(c.status)).toBe(err.httpStatus);
      expect(err.category, String(c.status)).toBe(c.category);
      expect(err.retryable, String(c.status)).toBe(c.retryable);
      // Documented statuses carry a deterministic next step; an unknown 4xx has none,
      // so the SDK gives no advice rather than inventing some.
      if (c.status === 418) expect(err.suggestedAction, String(c.status)).toBeUndefined();
      else expect(err.suggestedAction, String(c.status)).toBeTruthy();
      expect(err.body).toEqual(body);
      expect(err.vendorError).toEqual(body);
      expect(err.url).toBe('https://x/api/v1/companies/1');
      expect(err.correlationId).toBeUndefined();
      expect(err.operation).toBeUndefined();
      expect(isHuduError(err)).toBe(true);
    }
  });

  it('maps the documented codes and deterministic next steps', () => {
    const unauthorized = errorFromStatus(401, null);
    expect(unauthorized.code).toBe('UNAUTHORIZED');
    expect(unauthorized.suggestedAction).toBe('Check the API key and its scopes.');
    const missing = errorFromStatus(404, null);
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.suggestedAction).toBe('Verify the id, or resolve the record by name first.');
    const limited = errorFromStatus(429, null);
    expect(limited.code).toBe('RATE_LIMIT');
    expect(limited.suggestedAction).toBe('Retry after the Retry-After delay.');
    expect(errorFromStatus(409, null).code).toBe('CONFLICT');
    expect(errorFromStatus(412, null).code).toBe('STALE_OBJECT');
    expect(errorFromStatus(418, null).code).toBe('HTTP_418');
    expect(errorFromStatus(400, null).suggestedAction).toBeTruthy();
    expect(errorFromStatus(403, null).suggestedAction).toBeTruthy();
    expect(errorFromStatus(405, null).suggestedAction).toBeTruthy();
    expect(errorFromStatus(406, null).suggestedAction).toBeTruthy();
    expect(errorFromStatus(422, null).suggestedAction).toBeTruthy();
    expect(errorFromStatus(500, null).suggestedAction).toBeTruthy();
  });

  it('the new error classes throw with their documented code and category', () => {
    const conflict = new ConflictError('conflict');
    expect([conflict.code, conflict.category, conflict.retryable, conflict.httpStatus]).toEqual(['CONFLICT', 'conflict', false, 409]);

    const stale = new StaleObjectError('stale');
    expect([stale.code, stale.category, stale.retryable, stale.httpStatus]).toEqual(['STALE_OBJECT', 'conflict', false, 412]);

    const invalid = new ValidationFailedError('bad field');
    expect([invalid.code, invalid.category, invalid.retryable, invalid.httpStatus]).toEqual(['VALIDATION_FAILED', 'validation', false, 400]);

    const duplicate = new DuplicateFoundError('already exists');
    expect([duplicate.code, duplicate.category, duplicate.retryable]).toEqual(['DUPLICATE_FOUND', 'conflict', false]);
    expect(duplicate.suggestedAction).toContain('resourceIds');

    const denied = new PolicyDeniedError('unbounded bulk delete refused');
    expect([denied.code, denied.category, denied.retryable]).toEqual(['POLICY_DENIED', 'policy', false]);
    expect(denied.suggestedAction).toBeTruthy();

    const truncated = ResolutionError.truncated('scan cap hit', { resourceIds: [1, 2] });
    expect([truncated.code, truncated.category, truncated.retryable]).toEqual(['RESOLUTION_TRUNCATED', 'resolution', false]);
    expect(truncated.resourceIds).toEqual([1, 2]);
    expect(truncated.suggestedAction).toContain('maxScanRecords');

    const ambiguous = ResolutionError.ambiguous('several matches', { resourceIds: [4, 5] });
    expect([ambiguous.code, ambiguous.category, ambiguous.retryable]).toEqual(['RESOLUTION_AMBIGUOUS', 'resolution', false]);
    expect(ambiguous.resourceIds).toEqual([4, 5]);
    expect(ambiguous.suggestedAction).toContain('candidate ids');
  });

  it('classifies transport, config and timeout errors', () => {
    const net = new HuduNetworkError('down', 'https://x');
    expect([net.code, net.category, net.retryable]).toEqual(['NETWORK_ERROR', 'network', true]);
    const timeout = new HuduNetworkError('slow', 'https://x', { category: 'timeout', retryable: true });
    expect([timeout.code, timeout.category, timeout.retryable]).toEqual(['NETWORK_ERROR', 'timeout', true]);
    // A bare code (no status) still classifies from the documented vocabulary.
    expect(new HuduError('slow', { code: 'TIMEOUT' }).category).toBe('timeout');
    expect(new HuduError('slow', { code: 'TIMEOUT' }).retryable).toBe(true);
    const cfg = new HuduConfigError('bad concurrency');
    expect([cfg.code, cfg.category, cfg.retryable]).toEqual(['CONFIG_ERROR', 'validation', false]);
    expect(cfg.suggestedAction).toBeTruthy();
  });

  it('lets callers add deterministic context without changing the code or status', () => {
    const err = new BadRequestError('identifier not accepted', undefined, undefined, {
      suggestedAction: 'Pass { id } or an exact name.',
      resourceIds: [3],
      operation: 'companies.resolve',
      correlationId: 'abc',
    });
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.status).toBe(400);
    expect(err.httpStatus).toBe(400);
    expect(err.suggestedAction).toBe('Pass { id } or an exact name.');
    expect(err.resourceIds).toEqual([3]);
    expect(err.operation).toBe('companies.resolve');
    expect(err.correlationId).toBe('abc');
    // The transport attaches these after construction.
    err.correlationId = 'later';
    err.operation = 'companies.get';
    expect(err.correlationId).toBe('later');
    expect(err.operation).toBe('companies.get');
  });
});

describe('bounded parallelism for bulk work', () => {
  it('inherits the client concurrency by default and exposes it to subclasses', async () => {
    const r = new ProbeResource(makeHttp({ concurrency: 2 }));
    expect(r.getConcurrency()).toBe(2);
    expect(await r.map([1, 2, 3], async (n: number) => n + 1)).toEqual([2, 3, 4]);
  });

  it('preserves order and never exceeds the concurrency cap', async () => {
    const r = new ProbeResource(makeHttp());
    let inFlight = 0;
    let peak = 0;
    const out = await r.map([1, 2, 3, 4, 5], async (n: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return n * 2;
    }, 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(await r.map([], async () => 1)).toEqual([]);
  });
});
