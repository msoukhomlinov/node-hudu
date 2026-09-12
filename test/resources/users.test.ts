/**
 * UsersResource — agent-execution-layer coverage: `resolve`, `findByEmail` and
 * `search` with the compact `UserSummary`. The vendor exposes no user write, so this
 * resource is read-only. Mocked fetch only; never touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduError, HuduConfigError, NotFoundError, ResolutionError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import type { User } from '../../src/types/user.js';
import { clearFetch, json, stubFetch } from '../helpers.js';
import type { SpyCall } from '../helpers.js';

const BASE = 'https://hudu.example.com/api/v1/users';
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

function makeUser(id: number, first: string, last: string, email: string): User {
  return {
    id,
    email,
    otp_required_for_login: true,
    security_level: 'admin',
    first_name: first,
    last_name: last,
    phone_number: '555',
    slug: `${first}-${last}`.toLowerCase(),
    time_zone: 'UTC',
    accepted_invite: true,
    sign_in_count: 12,
    currently_signed_in: false,
    last_sign_in_at: '2026-01-01T00:00:00Z',
    last_sign_in_ip: '10.0.0.1',
    created_at: '2025-12-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    archived: false,
    portal_member_company_id: null,
    score_30_days: 3,
    score_all_time: 30,
    score_90_days: 9,
  };
}

const ALICE = makeUser(1, 'Alice', 'Smith', 'alice@example.com');
const BOB = makeUser(2, 'Bob', 'Jones', 'bob@example.com');

const ALICE_SUMMARY = {
  id: 1,
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Smith',
  slug: 'alice-smith',
  security_level: 'admin',
  archived: false,
  portal_member_company_id: null,
  updated_at: '2026-01-02T00:00:00Z',
};

/** Stub handler that answers the vendor filters the way the API would. */
function usersHandler(select: (params: URLSearchParams) => User[]) {
  return (url: string) => json(select(new URL(url).searchParams));
}

/** A full page of users who match nothing (drives the scan cap). */
function page(startId: number): User[] {
  return Array.from({ length: 25 }, (_, i) => makeUser(startId + i, `Filler${i}`, 'Person', `filler${i}@example.com`));
}

describe('users.resolve (helper tier)', () => {
  afterEach(() => clearFetch());

  it('fetches by id without a scan', async () => {
    const spy = stubFetch(() => json(ALICE));
    const found = await makeClient().users.resolve(1);
    expect(found).toEqual(ALICE_SUMMARY);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const spy = stubFetch(() => json({ error: 'nope' }, 404));
    const err = await rejection(makeClient().users.resolve(999));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolves by exact email', async () => {
    const spy = stubFetch(usersHandler((p) => (p.get('email') === 'alice@example.com' ? [ALICE] : [])));
    const found = await makeClient().users.resolve('alice@example.com');
    expect(found).toEqual(ALICE_SUMMARY);
    // Email is the first bare-value stage: the vendor filter fetches, the exact
    // compare decides, and a second pass proves the match is unique.
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('email')).toBe('alice@example.com');
    expect(query(spy.calls[1]!).get('search')).toBeNull();
  });

  it('matches an email case-insensitively', async () => {
    stubFetch(usersHandler((p) => (p.get('email')?.toLowerCase() === 'alice@example.com' ? [ALICE] : [])));
    await expect(makeClient().users.resolve('ALICE@Example.COM')).resolves.toEqual(ALICE_SUMMARY);
  });

  it('returns the single exact match', async () => {
    // A bare name reads all three stages: email (miss), slug (miss), exact name (hit).
    const spy = stubFetch(
      usersHandler((p) => (p.get('email') !== null ? [] : [BOB, ALICE])),
    );
    const found = await makeClient().users.resolve('Alice Smith');
    expect(found).toEqual(ALICE_SUMMARY);
    expect(spy.calls).toHaveLength(4);
    expect(query(spy.calls[0]!).get('email')).toBe('Alice Smith');
    expect(query(spy.calls[1]!).get('search')).toBe('Alice Smith');
    expect(query(spy.calls[3]!).get('search')).toBe('Alice Smith');
    expect(query(spy.calls[1]!).get('page_size')).toBe('25');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(usersHandler(() => []));
    const found = await makeClient().users.resolve('Nobody At All');
    expect(found).toBeNull();
    // Every stage completed a scan; none truncated.
    expect(spy.calls).toHaveLength(3);
  });

  it('throws RESOLUTION_AMBIGUOUS when several users match a name', async () => {
    const twin = makeUser(4, 'Alice', 'Smith', 'alice.two@example.com');
    twin.slug = 'alice-smith-two';
    const spy = stubFetch(usersHandler((p) => (p.get('email') !== null ? [] : [ALICE, twin])));
    const err = await rejection(makeClient().users.resolve('Alice Smith'));
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 4]);
    expect(err.suggestedAction).toContain('candidate ids');
    // email stage (miss) + slug stage (miss) + name stage (match + second match).
    expect(spy.calls).toHaveLength(4);
  });

  it('returns UserSummary', async () => {
    stubFetch(() => json(ALICE));
    const found = await makeClient().users.resolve(1);
    expect(found).toEqual(ALICE_SUMMARY);
    expect(found).not.toHaveProperty('otp_required_for_login');
    expect(found).not.toHaveProperty('last_sign_in_ip');
    expect(found).not.toHaveProperty('score_all_time');
    expect(found).not.toHaveProperty('created_at');
  });

  it('expand: true returns the full user', async () => {
    stubFetch(() => json(ALICE));
    const found = await makeClient().users.resolve(1, { expand: true });
    expect(found).toEqual(ALICE);
    expect(found).toHaveProperty('otp_required_for_login', true);
    expect(found).toHaveProperty('sign_in_count', 12);
  });

  it('honours an explicit { email } identifier as a single stage', async () => {
    const spy = stubFetch(usersHandler((p) => (p.get('email') === 'bob@example.com' ? [BOB] : [])));
    await expect(makeClient().users.resolve({ email: 'bob@example.com' })).resolves.toEqual({
      ...ALICE_SUMMARY,
      id: 2,
      email: 'bob@example.com',
      first_name: 'Bob',
      last_name: 'Jones',
      slug: 'bob-jones',
    });
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('search')).toBeNull();
  });

  it('resolves by an explicit slug identifier', async () => {
    const spy = stubFetch(usersHandler((p) => (p.get('search') === 'alice-smith' ? [BOB, ALICE] : [])));
    const found = await makeClient().users.resolve({ slug: 'alice-smith' });
    expect(found).toEqual(ALICE_SUMMARY);
    expect(spy.calls).toHaveLength(2);
        expect(spy.calls[0]!.url).toContain('search=alice-smith');
  });

  it('throws RESOLUTION_TRUNCATED when the scan cap stops the search', async () => {
    const spy = stubFetch(usersHandler(() => page(100)));
    const err = await rejection(makeClient().users.resolve({ name: 'Nowhere' }));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(err.category).toBe('resolution');
    expect(spy.calls).toHaveLength(4);
  });

  it('throws RESOLUTION_TRUNCATED when the uniqueness pass hits the cap', async () => {
    const spy = stubFetch((url: string) => {
      const p = Number(new URL(url).searchParams.get('page') ?? '1');
      if (p === 3) return json([ALICE, ...page(200).slice(0, 24)]);
      return json(page(300 + p * 25));
    });
    const err = await rejection(makeClient().users.resolve({ name: 'Alice Smith' }));
    expect(err.code).toBe('RESOLUTION_TRUNCATED');
    expect(spy.calls).toHaveLength(7);
  });

  it('reports the direct cost through resolutionDetails', async () => {
    stubFetch(() => json(ALICE));
    const resolution = await makeClient().users.resolve(1, { resolutionDetails: true });
    expect(resolution).toEqual({
      value: ALICE_SUMMARY,
      resolutionCost: 'direct',
      scanned: 1,
      scanTruncated: false,
    });
  });

  it('reports the scan cost and candidates through resolutionDetails', async () => {
    stubFetch(usersHandler((p) => (p.get('email') !== null ? [] : [BOB, ALICE])));
    const resolution = await makeClient().users.resolve('Alice Smith', { resolutionDetails: true });
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
    expect(resolution.value).toEqual(ALICE_SUMMARY);
    expect(resolution.candidates).toEqual([{ id: 1, label: 'user "Alice Smith"' }]);
  });

  it('refuses an identifier kind the vendor cannot support', async () => {
    const spy = stubFetch(() => json([]));
    const err = await rejection(makeClient().users.resolve({ phone_number: '555' } as never));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('users.resolve accepts');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('users.findByEmail (helper tier)', () => {
  afterEach(() => clearFetch());

  it('returns the exact email match', async () => {
    const spy = stubFetch(usersHandler((p) => (p.get('email') === 'alice@example.com' ? [BOB, ALICE] : [])));
    const found = await makeClient().users.findByEmail('alice@example.com');
    expect(found).toEqual(ALICE_SUMMARY);
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('email')).toBe('alice@example.com');
  });

  it('returns null after a complete scan', async () => {
    const spy = stubFetch(usersHandler(() => []));
    await expect(makeClient().users.findByEmail('nobody@example.com')).resolves.toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('returns UserSummary', async () => {
    stubFetch(usersHandler(() => [ALICE]));
    const found = await makeClient().users.findByEmail('alice@example.com');
    expect(found).toEqual(ALICE_SUMMARY);
    expect(found).not.toHaveProperty('score_90_days');
  });

  it('expand: true returns the full user', async () => {
    stubFetch(usersHandler(() => [ALICE]));
    await expect(makeClient().users.findByEmail('alice@example.com', { expand: true })).resolves.toEqual(ALICE);
  });

  it('reports the resolution cost through resolutionDetails', async () => {
    stubFetch(usersHandler(() => [ALICE]));
    const resolution = await makeClient().users.findByEmail('alice@example.com', { resolutionDetails: true });
    expect(resolution.value).toEqual(ALICE_SUMMARY);
    expect(resolution.resolutionCost).toBe('server-filter');
    expect(resolution.scanTruncated).toBe(false);
  });

  it('throws RESOLUTION_AMBIGUOUS when the email filter is not unique', async () => {
    const twin = makeUser(5, 'Alice', 'Smith', 'alice@example.com');
    const err = await rejection(
      (stubFetch(usersHandler(() => [ALICE, twin])), makeClient().users.findByEmail('alice@example.com')),
    );
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([1, 5]);
  });
});

describe('users.search (helper tier)', () => {
  afterEach(() => clearFetch());

  it('returns matching UserSummary records', async () => {
    const spy = stubFetch(usersHandler((p) => (p.get('search') === 'alice' ? [ALICE] : [])));
    const found = await makeClient().users.search('alice');
    expect(found).toEqual([ALICE_SUMMARY]);
    expect(spy.calls).toHaveLength(1);
    expect(query(spy.calls[0]!).get('search')).toBe('alice');
    expect(query(spy.calls[0]!).get('page_size')).toBe('25');
  });

  it('honours limit and never exceeds 100', async () => {
    const spy = stubFetch(usersHandler(() => [ALICE, BOB]));
    const client = makeClient();
    const many = await client.users.search('a', { limit: 100 });
    expect(many).toHaveLength(2);
    expect(query(spy.calls[0]!).get('page_size')).toBe('100');

    const one = await client.users.search('a', { limit: 1 });
    expect(one).toHaveLength(1);

    const err = await rejection(client.users.search('a', { limit: 101 }));
    expect(err).toBeInstanceOf(HuduConfigError);
    expect(err.message).toContain('limit must be <= 100');
    const zero = await rejection(client.users.search('a', { limit: 0 }));
    expect(zero).toBeInstanceOf(HuduConfigError);
  });

  it('narrows by archived and security_level and expands on request', async () => {
    const spy = stubFetch(usersHandler(() => [ALICE, BOB]));
    const summaries = await makeClient().users.search('a', { archived: true, security_level: 'admin' });
    expect(summaries).toHaveLength(2);
    expect(query(spy.calls[0]!).get('archived')).toBe('true');
    expect(query(spy.calls[0]!).get('security_level')).toBe('admin');

    const full = await makeClient().users.search('a', { expand: true });
    expect(full).toEqual([ALICE, BOB]);
    expect(full[0]).toHaveProperty('otp_required_for_login');
  });
});

describe('users primitives (list/get)', () => {
  afterEach(() => clearFetch());

  it('returns the unwrapped users list', async () => {
    const spy = stubFetch(() => json([ALICE, BOB]));
    await expect(makeClient().users.listAll({})).resolves.toEqual([ALICE, BOB]);
    expect(spy.calls[0]!.url).toContain(BASE);
  });

  it('sends page/page_size and stops on a short page', async () => {
    let n = 0;
    const spy = stubFetch(() => {
      n += 1;
      return n === 1 ? json(page(1)) : json([ALICE]);
    });
    const all = await makeClient().users.listAll({});
    expect(all).toHaveLength(26);
    expect(spy.calls).toHaveLength(2);
    expect(query(spy.calls[0]!).get('page')).toBe('1');
    expect(query(spy.calls[0]!).get('page_size')).toBe('25');
    expect(query(spy.calls[1]!).get('page')).toBe('2');
  });

  it('streams the list and its pages', async () => {
    stubFetch(() => json([ALICE]));
    const items: User[] = [];
    for await (const item of makeClient().users.list({})) items.push(item);
    expect(items).toEqual([ALICE]);

    const pages = [];
    for await (const item of makeClient().users.listPages({})) pages.push(item);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.items).toEqual([ALICE]);
  });

  it('returns the unwrapped users record', async () => {
    const spy = stubFetch(() => json(ALICE));
    await expect(makeClient().users.get(1)).resolves.toEqual(ALICE);
    expect(spy.calls[0]!.url).toBe(`${BASE}/1`);
  });

  it('normalises a 404 into NOT_FOUND', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    const err = await rejection(makeClient().users.get(404));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const client = makeClient({ onAudit: audit.hook });
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? json([ALICE]) : json({ error: 'nope' }, 404);
    });
    await client.users.listAll({});
    expect(audit.events[0]!.correlationId).toMatch(UUID);
    expect(audit.events[0]!.operation).toBe('users.list');
    expect(audit.events[0]!.effect).toBe('read');

    const err = await rejection(client.users.get(9));
    expect(err.correlationId).toMatch(UUID);
    expect(audit.events[1]!.correlationId).toBe(err.correlationId);
    expect(audit.events[1]!.outcome).toBe('error');
  });
});
