/**
 * ApiInfoResource tests — primitive contract + the documented degenerate `resolve`
 * (a singleton with no identifier, policy §5/§6).
 *
 * The `it(...)` titles are asserted verbatim by `capabilities:check` against the
 * `api_info` rows of capabilities.plan.json, so they are copied from the plan.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduError } from '../../src/errors.js';
import { stubFetch, json, clearFetch } from '../helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient(extra: Record<string, unknown> = {}) {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', ...extra });
}

function auditSpy() {
  const events: AuditEvent[] = [];
  return { events, onAudit: (event: AuditEvent) => { events.push(event); } };
}

async function rejection(promise: Promise<unknown>): Promise<HuduError> {
  try {
    await promise;
  } catch (err) {
    return err as HuduError;
  }
  throw new Error('expected the call to reject');
}

const apiInfo = { version: '2.45.1', date: '2024-01-01' };

describe('ApiInfoResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped api_info record', async () => {
    const spy = stubFetch(() => json(apiInfo));
    const res = await makeClient().apiInfo.get();
    expect(res).toEqual(apiInfo);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/api_info');
    expect(spy.calls[0].init.method).toBe('GET');
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ message: 'not found' }, 404));
    const err = await rejection(makeClient().apiInfo.get());
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = stubFetch(() => json(apiInfo));
    const client = makeClient({ onAudit: audit.onAudit });
    await client.apiInfo.get();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('api_info.get');
    spy.setHandler(() => json({ message: 'nope' }, 404));
    const err = await rejection(client.apiInfo.get());
    expect(err.correlationId).toMatch(UUID);
    expect(err.correlationId).not.toBe(audit.events[0]?.correlationId);
  });

  it('returns the singleton document and issues exactly one request', async () => {
    const spy = stubFetch(() => json(apiInfo));
    const client = makeClient();
    // The identifier carries no meaning for a singleton: it is ignored, never thrown on.
    const res = await client.apiInfo.resolve({ id: 1, name: 'ignored' });
    expect(res).toEqual(apiInfo);
    expect(spy.calls).toHaveLength(1);
    const detailed = await client.apiInfo.resolve(undefined, { resolutionDetails: true });
    expect(detailed).toEqual({ value: apiInfo, resolutionCost: 'direct', scanned: 1, scanTruncated: false });
    expect(spy.calls).toHaveLength(2);
    await client.apiInfo.resolve();
    expect(spy.calls).toHaveLength(3);
    for (const call of spy.calls) expect(call.url).toBe('https://hudu.example.com/api/v1/api_info');
  });
});
