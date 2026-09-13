/**
 * Live-verified contract gaps around a MISSING record and a MISSING identifier.
 *
 * Live tenant (Hudu 2.45.1) behaviour: `articles`, `asset_layouts`, `asset_passwords`, `folders` and
 * `websites` answer `200` with a body of `null` for an unknown id instead of `404`. Before this fix
 * `get(id)` returned that `null` typed as the record, and `resolve` then read `.id` off it and threw a
 * RAW TypeError. These tests pin the two contracts without touching the network:
 *
 *   F2 - a single-record read that unwraps to null/undefined is NOT_FOUND, exactly as a 404 is;
 *        a real record is unaffected.
 *   F4 - an absent identifier is CONFIG_ERROR naming the accepted kinds, never a TypeError.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../src/client.js';
import { HuduConfigError, NotFoundError } from '../src/errors.js';
import { stubFetch, json, clearFetch } from './helpers.js';

afterEach(clearFetch);

function makeClient(): HuduClient {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
}

const MISSING = 99999999;

/**
 * The five resources live-verified to answer `200` + `null` on an id miss.
 * `key` is the envelope key the vendor wraps the single record in.
 */
const NULL_BODY_CASES: Array<{
  name: string;
  key: string;
  get: (c: HuduClient, id: number) => Promise<unknown>;
  resolve: (c: HuduClient, id: number) => Promise<unknown>;
}> = [
  {
    name: 'articles',
    key: 'article',
    get: (c, id) => c.articles.get(id),
    resolve: (c, id) => c.articles.resolve(id),
  },
  {
    name: 'assetLayouts',
    key: 'asset_layout',
    get: (c, id) => c.assetLayouts.get(id),
    resolve: (c, id) => c.assetLayouts.resolve(id),
  },
  {
    name: 'assetPasswords',
    key: 'asset_password',
    get: (c, id) => c.assetPasswords.get(id),
    resolve: (c, id) => c.assetPasswords.resolve(id),
  },
  {
    name: 'folders',
    key: 'folder',
    get: (c, id) => c.folders.get(id),
    resolve: (c, id) => c.folders.resolve(id),
  },
  {
    name: 'websites',
    key: 'website',
    get: (c, id) => c.websites.get(id),
    resolve: (c, id) => c.websites.resolve(id),
  },
];

describe('F2: a 200 + null body on a single-record read is NOT_FOUND, never null and never a TypeError', () => {
  for (const kase of NULL_BODY_CASES) {
    it(`${kase.name}.get(id) throws NotFoundError with code/category/resourceIds`, async () => {
      stubFetch(() => json(null));
      const client = makeClient() as unknown as Record<string, { get(id: number): Promise<unknown> }>;
      const err = await client[kase.name]!
        .get(MISSING)
        .then(() => undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      const notFound = err as NotFoundError;
      expect(notFound.code).toBe('NOT_FOUND');
      expect(notFound.category).toBe('not_found');
      expect(notFound.status).toBe(404);
      expect(notFound.resourceIds).toEqual([MISSING]);
      expect(notFound.operation).toBe(`${kase.name === 'assetLayouts' ? 'asset_layouts' : kase.name === 'assetPasswords' ? 'asset_passwords' : kase.name}.get`);
      expect(notFound).not.toBeInstanceOf(TypeError);
      expect(String(notFound.message)).toMatch(/empty body/);
    });

    it(`${kase.name}.resolve(id) throws NotFoundError instead of a raw TypeError`, async () => {
      stubFetch(() => json(null));
      const err = await kase.resolve(makeClient(), MISSING).then(() => undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).code).toBe('NOT_FOUND');
      expect((err as Error).name).not.toBe('TypeError');
    });

    it(`${kase.name}.resolve({ id }) throws NotFoundError instead of a raw TypeError`, async () => {
      stubFetch(() => json(null));
      const client = makeClient() as unknown as Record<string, { resolve(id: unknown): Promise<unknown> }>;
      const err = await client[kase.name]!
        .resolve({ id: MISSING })
        .then(() => undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).name).not.toBe('TypeError');
    });

    it(`${kase.name}: a real record is unaffected`, async () => {
      stubFetch(() => json({ [kase.key]: { id: 7, name: 'real' } }));
      const record = (await kase.get(makeClient(), 7)) as { id: number };
      expect(record.id).toBe(7);
      const resolved = (await kase.resolve(makeClient(), 7)) as { id: number };
      expect(resolved.id).toBe(7);
    });
  }

  it('a real 404 still throws NotFoundError (behaviour unchanged)', async () => {
    stubFetch(() => json({ error: 'Not found' }, 404));
    const err = await makeClient()
      .folders.get(MISSING)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    const notFound = err as NotFoundError;
    expect(notFound.code).toBe('NOT_FOUND');
    expect(notFound.resourceIds).toEqual([MISSING]);
  });

  it('a legitimately empty-looking but present record is NOT treated as missing', async () => {
    // `{}` (or any non-null body) is a real body the vendor sent: only null/undefined is a miss.
    stubFetch(() => json({ folder: {} }));
    const record = await makeClient().folders.get(7);
    expect(record).toEqual({});
  });

  it('a wrapped envelope whose key carries null is a miss too', async () => {
    // The vendor's other shape of "no such record": `{"website": null}` rather than a bare `null`.
    stubFetch(() => json({ website: null }));
    const err = await makeClient()
      .websites.get(MISSING)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).resourceIds).toEqual([MISSING]);
  });
});

describe('F4: an absent identifier is CONFIG_ERROR naming the accepted kinds, never a TypeError', () => {
  const CASES: Array<{ name: string; resolve: (c: HuduClient, id: unknown) => Promise<unknown> }> = [
    { name: 'users', resolve: (c, id) => c.users.resolve(id as number) },
    { name: 'folders', resolve: (c, id) => c.folders.resolve(id as number) },
    { name: 'websites', resolve: (c, id) => c.websites.resolve(id as number) },
    { name: 'groups', resolve: (c, id) => c.groups.resolve(id as number) },
    { name: 'labels', resolve: (c, id) => c.labels.resolve(id as number) },
    { name: 'labelTypes', resolve: (c, id) => c.labelTypes.resolve(id as number) },
    { name: 'lists', resolve: (c, id) => c.lists.resolve(id as number) },
    { name: 'passwordFolders', resolve: (c, id) => c.passwordFolders.resolve(id as number) },
    { name: 'companies', resolve: (c, id) => c.companies.resolve(id as number) },
  ];

  for (const kase of CASES) {
    it(`${kase.name}.resolve(undefined) is a HuduConfigError naming accepted kinds`, async () => {
      const spy = stubFetch(() => json(null));
      const err = await kase.resolve(makeClient(), undefined).then(() => undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HuduConfigError);
      expect((err as HuduConfigError).code).toBe('CONFIG_ERROR');
      expect((err as HuduConfigError).category).toBe('validation');
      expect((err as Error).name).not.toBe('TypeError');
      expect(String((err as Error).message)).toContain('accepts');
      // Refused before any request: an absent identifier is a caller bug, not a lookup.
      expect(spy.calls.length).toBe(0);
    });

    it(`${kase.name}.resolve(null) is a HuduConfigError, not a TypeError`, async () => {
      stubFetch(() => json(null));
      const err = await kase.resolve(makeClient(), null).then(() => undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HuduConfigError);
      expect((err as Error).name).not.toBe('TypeError');
    });
  }
});
