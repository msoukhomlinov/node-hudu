/**
 * S3ExportsResource tests: the write-only resource (no helper rows — SCOPING
 * decision 14), its void return, the dry-run contract and correlation ids.
 * Uses the shared mocked-fetch helper — never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError, HuduError } from '../../src/errors.js';
import type { AuditEvent, DryRunResult } from '../../src/types/common.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';

function makeClient(onAudit?: (event: AuditEvent) => void) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...(onAudit ? { onAudit } : {}) });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('S3ExportsResource — plan rows', () => {
  afterEach(() => clearFetch());

  it('returns the created s3_exports record', async () => {
    const spy = stubFetch(() => empty(200));
    // POST /s3_exports answers with an empty body: there is no record to return.
    await expect(makeClient().s3Exports.create({ bucket: 'b' })).resolves.toBeUndefined();
    expect(spy.calls[0]!.url).toBe('https://hudu.example.com/api/v1/s3_exports');
    expect(spy.calls[0]!.init.method).toBe('POST');
    expect(spy.calls[0]!.init.body).toBe(JSON.stringify({ bucket: 'b' }));
  });

  it('dry-run issues no mutating request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(200));
    const result = (await makeClient().s3Exports.create(undefined, { dryRun: true })) as DryRunResult<void>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.wouldApply).toBe(true);
    expect(result.operation).toBe('s3_exports.create');
    expect(result.request).toEqual({ method: 'POST', path: '/s3_exports' });
    expect(result.impact).toEqual({ affected: 1, scope: 'single', reversible: true });
    expect(result.checks).toEqual([{ name: 'payload-present', ok: true, detail: 'request body supplied' }]);
    // The plan's contract: the warning states there is no server-computed result to promise.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('empty 200 body');
    expect(result.warnings[0]).toContain('no server-computed result to promise');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const events: AuditEvent[] = [];
    const client = makeClient((event) => events.push(event));
    const spy = stubFetch(() => empty(200));
    await client.s3Exports.create({ bucket: 'b' });
    expect(events).toHaveLength(1);
    expect(events[0]!.correlationId).toMatch(UUID);
    expect(events[0]!.operation).toBe('s3_exports.create');
    expect(events[0]!.effect).toBe('write');
    expect(events[0]!.outcome).toBe('success');

    // 400 is not retried, so the error path costs one request.
    spy.setHandler(() => json({ error: 'bad payload' }, 400));
    const err = (await client.s3Exports.create({}).catch((e: unknown) => e)) as HuduError;
    expect(err.correlationId).toMatch(UUID);
    expect(err.operation).toBe('s3_exports.create');
    const errorEvent = events[events.length - 1]!;
    expect(errorEvent.outcome).toBe('error');
    expect(errorEvent.correlationId).toBe(err.correlationId);
    expect(errorEvent.httpStatus).toBe(400);
  });
});

describe('S3ExportsResource — the stale option outside update', () => {
  afterEach(() => clearFetch());

  it('refuses expectedUpdatedAt on create instead of ignoring it', async () => {
    const spy = stubFetch(() => empty(200));
    const err = (await makeClient()
      .s3Exports.create({ bucket: 'b' }, { expectedUpdatedAt: 't' })
      .catch((e: unknown) => e)) as HuduError;
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.category).toBe('validation');
    expect(err.message).toContain('s3_exports.create');
    expect(err.message).toContain('update (PUT) only');
    expect(spy.calls).toHaveLength(0);
  });
});
