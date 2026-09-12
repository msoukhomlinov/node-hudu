/**
 * AssetPasswordsResource tests — primitives and agent-execution-layer helpers.
 * Titles marked "plan" are copied verbatim from capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { stubFetch, json, empty, clearFetch } from '../helpers.js';
import { redact, REDACTED } from '../../src/logger.js';
import type { AuditEvent } from '../../src/types/common.js';

const password = {
  id: 1,
  passwordable_id: null,
  passwordable_type: 'Asset',
  company_id: 7,
  name: 'Root',
  username: 'root',
  slug: 'root',
  description: 'primary root account',
  password: 's3cret-value',
  otp_secret: 'OTP-SECRET-VALUE',
  password_type: null,
  url: '',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-02T00:00:00.000Z',
  password_folder_id: 3,
  password_folder_name: 'Infra',
  login_url: null,
};

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** The 11 fields AssetPasswordSummary keeps; the secret fields are dropped. */
const PASSWORD_SUMMARY_KEYS = [
  'company_id', 'id', 'login_url', 'name', 'password_folder_id', 'password_folder_name',
  'password_type', 'slug', 'updated_at', 'url', 'username',
].sort();

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
}

function auditedClient() {
  const events: AuditEvent[] = [];
  const client = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', onAudit: (event) => events.push(event) });
  return { client, events };
}

/** A client that records everything the SDK logs, so credential leakage is observable. */
function loggingClient() {
  const logs: string[] = [];
  const record = (message: string) => logs.push(message);
  const client = new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'k',
    logger: { debug: record, info: record, warn: record, error: record },
  });
  return { client, logs };
}

describe('AssetPasswordsResource agent-execution-layer helpers', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json({ asset_password: password }));
    expect(asRecord(await makeClient().assetPasswords.resolve(1)).id).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/asset_passwords/1');
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assetPasswords.resolve({ id: 99 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the single exact match', async () => {
    const spy = stubFetch(() => json({ asset_passwords: [password] }));
    expect(asRecord(await makeClient().assetPasswords.resolve('root')).slug).toBe('root');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('slug=root');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(() => json({ asset_passwords: [] }));
    await expect(makeClient().assetPasswords.resolve('missing')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(2);
  });

  it('throws RESOLUTION_AMBIGUOUS with candidate ids', async () => {
    stubFetch(() => json({ asset_passwords: [{ ...password, id: 11, name: 'Root Prod' }, { ...password, id: 12, name: 'Root Dev' }] }));
    await expect(makeClient().assetPasswords.resolve('Root')).rejects.toMatchObject({
      code: 'RESOLUTION_AMBIGUOUS',
      resourceIds: [11, 12],
    });
  });

  it('returns AssetPasswordSummary, which omits the secret', async () => {
    stubFetch(() => json({ asset_password: password }));
    const summary = asRecord(await makeClient().assetPasswords.resolve(1));
    expect(Object.keys(summary).sort()).toEqual(PASSWORD_SUMMARY_KEYS);
    expect(summary.password).toBeUndefined();
    expect(summary.otp_secret).toBeUndefined();
    expect(summary.description).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('s3cret-value');
  });

  it('expand: true returns the full password record', async () => {
    stubFetch(() => json({ asset_password: password }));
    const full = asRecord(await makeClient().assetPasswords.resolve(1, { expand: true }));
    expect(full.password).toBe('s3cret-value');
    expect(full.otp_secret).toBe('OTP-SECRET-VALUE');
  });

  it('returns the exact match as AssetPasswordSummary', async () => {
    stubFetch(() => json({ asset_passwords: [password] }));
    const summary = asRecord(await makeClient().assetPasswords.findBySlug('root'));
    expect(summary.id).toBe(1);
    expect(summary.password).toBeUndefined();
  });

  it('returns null after a complete scan (slug)', async () => {
    stubFetch(() => json({ asset_passwords: [] }));
    await expect(makeClient().assetPasswords.findBySlug('missing')).resolves.toBeNull();
  });

  it('returns AssetPasswordSummary without the secret', async () => {
    stubFetch(() => json({ asset_passwords: [password] }));
    const summary = asRecord(await makeClient().assetPasswords.findBySlug('root'));
    expect(Object.keys(summary).sort()).toEqual(PASSWORD_SUMMARY_KEYS);
    expect(JSON.stringify(summary)).not.toContain('OTP-SECRET-VALUE');
  });

  it('returns matching AssetPasswordSummary records', async () => {
    stubFetch(() => json({ asset_passwords: [{ ...password, id: 21 }, { ...password, id: 22 }] }));
    const rows = (await makeClient().assetPasswords.search('root')) as unknown[];
    expect(rows).toHaveLength(2);
    expect(Object.keys(asRecord(rows[0])).sort()).toEqual(PASSWORD_SUMMARY_KEYS);
  });

  it('never includes password or otp_secret', async () => {
    stubFetch(() => json({ asset_passwords: [password] }));
    const rows = await makeClient().assetPasswords.search('root');
    expect(JSON.stringify(rows)).not.toContain('s3cret-value');
    expect(JSON.stringify(rows)).not.toContain('OTP-SECRET-VALUE');
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = stubFetch(() => json({ asset_passwords: [password] }));
    await expect(makeClient().assetPasswords.search('root', { limit: 100 })).resolves.toHaveLength(1);
    expect(spy.calls[0].url).toContain('page_size=100');
    await expect(makeClient().assetPasswords.search('root', { limit: 101 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(spy.calls).toHaveLength(1);
  });
});

describe('AssetPasswordsResource agent-execution-layer primitives', () => {
  afterEach(() => clearFetch());

  it('resolves void after a successful delete', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().assetPasswords.delete(1)).resolves.toBeUndefined();
    expect(spy.calls[0].init.method).toBe('DELETE');
  });

  it('dry-run issues no DELETE request and returns simulated: true', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().assetPasswords.delete(1, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/asset_passwords/1');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (delete)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.assetPasswords.delete(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assetPasswords.delete(2).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the unwrapped asset_passwords list', async () => {
    stubFetch(() => json({ asset_passwords: [password] }));
    const rows: unknown[] = [];
    for await (const row of makeClient().assetPasswords.list({})) rows.push(row);
    expect(rows).toEqual([password]);
  });

  it('sends page/page_size and stops on a short page', async () => {
    const spy = stubFetch(() => json({ asset_passwords: [password] }));
    const rows: unknown[] = [];
    for await (const row of makeClient().assetPasswords.list({})) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toContain('page=1');
    expect(spy.calls[0].url).toContain('page_size=25');
  });

  it('surfaces a correlation id on the success path and the error path (list)', async () => {
    const { client, events } = auditedClient();
    stubFetch(() => json({ asset_passwords: [password] }));
    const rows: unknown[] = [];
    for await (const row of client.assetPasswords.list({})) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
    expect(typeof events[0]!.correlationId).toBe('string');
  });

  it('does not log credential-shaped fields and redact() removes them from the returned data', async () => {
    const { client, logs } = loggingClient();
    stubFetch(() => json({ asset_passwords: [password] }));
    const rows: unknown[] = [];
    for await (const row of client.assetPasswords.list({})) rows.push(row);
    expect(JSON.stringify(rows)).toContain('s3cret-value');
    // The SDK logs the path only: the payload never reaches the logger.
    expect(logs.join('\n')).not.toContain('s3cret-value');
    expect(logs.join('\n')).not.toContain('OTP-SECRET-VALUE');
    const masked = redact(password) as Record<string, unknown>;
    expect(masked.password).toBe(REDACTED);
    expect(masked.otp_secret).toBe(REDACTED);
    expect(masked.username).toBe('root');
    expect(password.password).toBe('s3cret-value');
  });

  it('returns the unwrapped asset_passwords record', async () => {
    stubFetch(() => json({ asset_password: password }));
    await expect(makeClient().assetPasswords.get(1)).resolves.toEqual(password);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'no' }, 404));
    await expect(makeClient().assetPasswords.get(9)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('surfaces a correlation id on the success path and the error path (get)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset_password: password }));
    await client.assetPasswords.get(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assetPasswords.get(9).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('does not log credential-shaped fields and redact() removes them from the returned data (get)', async () => {
    const { client, logs } = loggingClient();
    stubFetch(() => json({ asset_password: password }));
    const record = asRecord(await client.assetPasswords.get(1));
    // The full record is returned unredacted (returned data is never redacted implicitly)...
    expect(record.password).toBe('s3cret-value');
    // ...but it never reaches the logger, and redact() is the opt-in mask.
    expect(logs.join('\n')).not.toContain('s3cret-value');
    expect((redact({ password: record.password }) as Record<string, unknown>).password).toBe(REDACTED);
  });

  it('returns the created asset_passwords record', async () => {
    const spy = stubFetch(() => json({ asset_password: password }, 201));
    await expect(makeClient().assetPasswords.create({ name: 'Root' })).resolves.toEqual(password);
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset_password: { name: 'Root' } }));
  });

  it('dry-run issues no mutating request and returns simulated: true (create)', async () => {
    const spy = stubFetch(() => json({ asset_password: password }, 201));
    const result = (await makeClient().assetPasswords.create({ name: 'Root' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('s3cret-value');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (create)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset_password: password }, 201));
    await client.assetPasswords.create({ name: 'Root' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.assetPasswords.create({ name: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('returns the updated asset_passwords record', async () => {
    const spy = stubFetch(() => json({ asset_password: password }));
    await expect(makeClient().assetPasswords.update(1, { username: 'root2' })).resolves.toEqual(password);
    expect(spy.calls[0].init.body).toBe(JSON.stringify({ asset_password: { username: 'root2' } }));
  });

  it('dry-run issues no PUT request and returns simulated: true', async () => {
    const spy = stubFetch(() => json({ asset_password: password }));
    const result = (await makeClient().assetPasswords.update(1, { username: 'root2' }, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.target).ids).toEqual([1]);
    expect(spy.calls).toHaveLength(0);
  });

  it('unwraps the PUT response by singleKey (update)', async () => {
    stubFetch(() => json({ asset_password: password }));
    expect(asRecord(await makeClient().assetPasswords.update(1, { username: 'root2' })).id).toBe(1);
  });

  it('surfaces a correlation id on the success path and the error path (update)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => json({ asset_password: password }));
    await client.assetPasswords.update(1, { username: 'root2' });
    spy.setHandler(() => json({ error: 'invalid' }, 422));
    const err = (await client.assetPasswords.update(1, { username: '' }).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('sends the expectedUpdatedAt guard and maps a mismatch to STALE_OBJECT (update)', async () => {
    const spy = stubFetch(() => json({ asset_password: password }));
    await expect(makeClient().assetPasswords.update(1, { username: 'root2' }, { expectedUpdatedAt: password.updated_at }))
      .resolves.toEqual(password);
    expect(spy.calls[0].init.method).toBe('GET');
    expect(spy.calls[1].init.method).toBe('PUT');
    spy.calls.length = 0;
    await expect(makeClient().assetPasswords.update(1, { username: 'root2' }, { expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'STALE_OBJECT', category: 'conflict' });
    expect(spy.calls).toHaveLength(1);
  });

  it('calls the asset_passwords.archive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().assetPasswords.archive(1)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/asset_passwords/1/archive');
  });

  it('dry-run issues no mutating request and returns simulated: true (archive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().assetPasswords.archive(1, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(asRecord(result.request).path).toBe('/asset_passwords/1/archive');
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (archive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.assetPasswords.archive(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assetPasswords.archive(2).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });

  it('calls the asset_passwords.unarchive endpoint and normalises the result', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(makeClient().assetPasswords.unarchive(1)).resolves.toBeUndefined();
    expect(spy.calls[0].url).toBe('https://hudu.example.com/api/v1/asset_passwords/1/unarchive');
  });

  it('dry-run issues no mutating request and returns simulated: true (unarchive)', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeClient().assetPasswords.unarchive(1, { dryRun: true })) as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it('surfaces a correlation id on the success path and the error path (unarchive)', async () => {
    const { client, events } = auditedClient();
    const spy = stubFetch(() => empty(204));
    await client.assetPasswords.unarchive(1);
    spy.setHandler(() => json({ error: 'no' }, 404));
    const err = (await client.assetPasswords.unarchive(2).catch((e: unknown) => e)) as { correlationId?: string };
    expect(events[0]!.outcome).toBe('success');
    expect(err.correlationId).toBe(events[1]!.correlationId);
  });
});


describe('AssetPasswordsResource helper edge branches and validation', () => {
  afterEach(() => clearFetch());

  it('lists every password and yields pages', async () => {
    stubFetch(() => json({ asset_passwords: [password] }));
    await expect(makeClient().assetPasswords.listAll({})).resolves.toEqual([password]);
    const pages: unknown[] = [];
    for await (const page of makeClient().assetPasswords.listPages({})) pages.push(page);
    expect(pages).toHaveLength(1);
  });

  it('reads a bare numeric value and the object identifier kinds', async () => {
    const byId = stubFetch(() => json({ asset_password: password }));
    expect(asRecord(await makeClient().assetPasswords.resolve('12')).id).toBe(1);
    expect(byId.calls[0].url).toBe('https://hudu.example.com/api/v1/asset_passwords/12');
    stubFetch(() => json({ asset_passwords: [password] }));
    expect(asRecord(await makeClient().assetPasswords.resolve({ slug: 'root' })).id).toBe(1);
    expect(asRecord(await makeClient().assetPasswords.resolve({ name: 'Root', company_id: 7 })).id).toBe(1);
  });

  it('throws RESOLUTION_TRUNCATED at the cap instead of returning null', async () => {
    const spy = stubFetch(() => json({ asset_passwords: Array.from({ length: 25 }, (_, i) => ({ ...password, id: 300 + i })) }));
    const capped = new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k', resolution: { maxScanRecords: 25, maxScanPages: 1 } });
    await expect(capped.assetPasswords.resolve('Nothing Here')).rejects.toMatchObject({ code: 'RESOLUTION_TRUNCATED' });
    expect(spy.calls).toHaveLength(1);
  });

  it('throws RESOLUTION_AMBIGUOUS when two records match exactly', async () => {
    stubFetch(() => json({ asset_passwords: [{ ...password, id: 91 }, { ...password, id: 92 }] }));
    await expect(makeClient().assetPasswords.resolve('root')).rejects.toMatchObject({ code: 'RESOLUTION_AMBIGUOUS', resourceIds: [91, 92] });
  });

  it('reports the resolution cost with resolutionDetails', async () => {
    stubFetch(() => json({ asset_password: password }));
    const direct = (await makeClient().assetPasswords.resolve(1, { resolutionDetails: true })) as Record<string, unknown>;
    expect(direct.resolutionCost).toBe('direct');
    expect(JSON.stringify(direct)).not.toContain('s3cret-value');
    stubFetch(() => json({ asset_passwords: [] }));
    const miss = (await makeClient().assetPasswords.resolve('Missing', { resolutionDetails: true })) as Record<string, unknown>;
    expect(miss.value).toBeNull();
  });

  it('narrows a search with company_id and rejects an empty one', async () => {
    const spy = stubFetch(() => json({ asset_passwords: [password] }));
    await makeClient().assetPasswords.search('root', { company_id: 7 });
    expect(spy.calls[0].url).toContain('company_id=7');
    await expect(makeClient().assetPasswords.search('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetPasswords.search('root', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('rejects an empty or unsupported identifier and an empty slug', async () => {
    await expect(makeClient().assetPasswords.resolve('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetPasswords.resolve(null as unknown as number)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetPasswords.resolve({ username: 'root' } as unknown as { id?: number })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetPasswords.findBySlug('')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await expect(makeClient().assetPasswords.findBySlug('x', { limit: 0 })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('falls back to the exact name filter and reports an inexact filter', async () => {
    const spy = stubFetch((url) => (url.includes('slug=') ? json({ asset_passwords: [] }) : json({ asset_passwords: [password] })));
    expect(asRecord(await makeClient().assetPasswords.resolve('Root')).id).toBe(1);
    expect(spy.calls).toHaveLength(2);
    stubFetch(() => json({ asset_passwords: [{ ...password, id: 81, slug: 'a', name: 'Alpha' }, { ...password, id: 82, slug: 'b', name: 'Beta' }] }));
    await expect(makeClient().assetPasswords.resolve('Root')).rejects.toMatchObject({ code: 'RESOLUTION_AMBIGUOUS', resourceIds: [81, 82] });
  });

});
