/**
 * CardsResource tests — the two read primitives plus the `resolve` helper.
 *
 * `cards` is not a CRUD resource: the vendor exposes only `GET /cards/lookup` and
 * `GET /cards/jump`, so the suite proves the helper uses the lookup filters, keeps the
 * jump target in its compact shape, and never invents get/create/update/delete.
 *
 * The `it(...)` titles are asserted verbatim by `capabilities:check` against the `cards`
 * rows of capabilities.plan.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { HuduConfigError } from '../../src/errors.js';
import type { AuditEvent } from '../../src/types/common.js';
import { HuduError } from '../../src/errors.js';
import { stubFetch, json, clearFetch, type FetchSpy } from '../helpers.js';

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

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    integrator_id: 4,
    integrator_name: 'autotask',
    link: 'https://hudu.example.com/cards/11/jump',
    primary_field: 'Green Mile 24',
    data: { secretish: 'payload' },
    office_365_assigned_products: ['EXCHANGE'],
    exchange_license_assign_date: 'Oct 13, 2025',
    onedrive_license_assign_date: 'Oct 13, 2025',
    sharepoint_license_assign_date: 'Oct 13, 2025',
    skype_for_business_license_assign_date: 'Oct 13, 2025',
    sync_type: 'AutotaskCompany',
    sync_id: 29683607,
    sync_identifier: 'Green Mile 24',
    ...overrides,
  };
}

/** Serve a lookup response with the given cards. */
function lookupOnce(cards: unknown[]): FetchSpy {
  return stubFetch((raw) => {
    const url = new URL(raw);
    if (url.pathname !== '/api/v1/cards/lookup') throw new Error(`unexpected request: ${url.pathname}`);
    return json({ integrator_cards: cards });
  });
}

describe('CardsResource — agent execution layer', () => {
  afterEach(() => clearFetch());

  it('calls the cards.jump endpoint and returns the documented shape', async () => {
    const spy = stubFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://hudu.example.com/companies/acme' } }),
    );
    const url = await makeClient().cards.jump({ integration_type: 'hudu', integration_slug: 'hudu', integration_id: '7' });
    expect(url).toBe('https://hudu.example.com/companies/acme');
    expect(spy.calls[0]?.url).toContain('/api/v1/cards/jump');
    expect(spy.calls[0]?.url).toContain('integration_type=hudu');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = stubFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://hudu.example.com/companies/acme' } }),
    );
    const client = makeClient({ onAudit: audit.onAudit });
    await client.cards.jump({ integration_type: 'hudu', integration_slug: 'hudu' });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    spy.setHandler(() => json({ message: 'gone' }, 404));
    const err = await rejection(client.cards.jump({ integration_type: 'hudu', integration_slug: 'hudu' }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.correlationId).toMatch(UUID);
  });

  it('calls the cards.lookup endpoint and returns the documented shape', async () => {
    const spy = lookupOnce([card()]);
    const res = await makeClient().cards.lookup({ integration_slug: 'autotask', integration_identifier: 'Green Mile 24' });
    expect(res).toEqual([card()]);
    expect(spy.calls[0]?.url).toContain('/api/v1/cards/lookup');
    expect(spy.calls[0]?.url).toContain('integration_slug=autotask');
    expect(spy.calls[0]?.url).toContain('integration_identifier=Green+Mile+24');
  });

  it('surfaces a correlation id on the success path and the error path', async () => {
    const audit = auditSpy();
    const spy = lookupOnce([card()]);
    const client = makeClient({ onAudit: audit.onAudit });
    await client.cards.lookup({ integration_slug: 'autotask' });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.correlationId).toMatch(UUID);
    expect(audit.events[0]?.operation).toBe('cards.lookup');
    spy.setHandler(() => json({ message: 'no key' }, 401));
    const err = await rejection(client.cards.lookup({ integration_slug: 'autotask' }));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.correlationId).toMatch(UUID);
  });

  it('returns the card(s) for the integration identifier', async () => {
    const spy = lookupOnce([card()]);
    const res = await makeClient().cards.resolve({ integration_slug: 'autotask', integration_identifier: 'Green Mile 24' });
    // Compact by default: identity, integrator, sync identity and the jump target `link`.
    expect(res).toEqual({
      id: 11,
      integrator_id: 4,
      integrator_name: 'autotask',
      link: 'https://hudu.example.com/cards/11/jump',
      primary_field: 'Green Mile 24',
      sync_type: 'AutotaskCompany',
      sync_id: 29683607,
      sync_identifier: 'Green Mile 24',
    });
    expect(res).not.toHaveProperty('data');
    expect(res).not.toHaveProperty('office_365_assigned_products');
    expect(spy.calls).toHaveLength(1);
    const expanded = await makeClient().cards.resolve('autotask', { expand: true });
    expect(expanded).toEqual(card());
    const detailed = await makeClient().cards.resolve('autotask', { resolutionDetails: true });
    expect(detailed).toMatchObject({ resolutionCost: 'server-filter', scanned: 1, scanTruncated: false });
    expect(detailed.candidates).toEqual([{ id: 11, label: 'autotask' }]);
  });

  it('returns null after a complete lookup', async () => {
    const spy = lookupOnce([]);
    const res = await makeClient().cards.resolve({ integration_slug: 'autotask', integration_id: '99' });
    expect(res).toBeNull();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('integration_id=99');
  });

  it('throws RESOLUTION_AMBIGUOUS when several cards match', async () => {
    lookupOnce([card(), card({ id: 12, sync_id: 29683608, sync_identifier: 'Other' })]);
    const err = await rejection(makeClient().cards.resolve({ integration_slug: 'autotask' }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.category).toBe('resolution');
    expect(err.resourceIds).toEqual([11, 12]);
    expect(err.retryable).toBe(false);
  });

  it('honours limit and never exceeds 100', async () => {
    const cards = [card(), card({ id: 12 }), card({ id: 13 }), card({ id: 14 }), card({ id: 15 })];
    const spy = lookupOnce(cards);
    const client = makeClient();
    // limit bounds how many matches the resolver collects before it reports ambiguity.
    const err = await rejection(client.cards.resolve({ integration_slug: 'autotask' }, { limit: 3 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toEqual([11, 12, 13]);
    expect(spy.calls).toHaveLength(1);
    // 100 is the hard maximum; above it the helper refuses deterministically.
    await expect(client.cards.resolve({ integration_slug: 'autotask' }, { limit: 100 })).rejects.toBeInstanceOf(HuduError);
    await expect(client.cards.resolve({ integration_slug: 'autotask' }, { limit: 101 })).rejects.toThrow(HuduConfigError);
    await expect(client.cards.resolve({ integration_slug: 'autotask' }, { limit: 0 })).rejects.toThrow(HuduConfigError);
    // An identifier the vendor cannot filter on is refused, not guessed.
    await expect(client.cards.resolve({ integration_slug: '  ' })).rejects.toThrow(HuduConfigError);
  });
});

describe('CardsResource — resolution edge cases', () => {
  afterEach(() => clearFetch());

  it('rejects identifiers the vendor cannot filter on', async () => {
    const spy = lookupOnce([]);
    const client = makeClient();
    await expect(client.cards.resolve(null as never)).rejects.toThrow(HuduConfigError);
    await expect(client.cards.resolve('')).rejects.toThrow(HuduConfigError);
    await expect(client.cards.resolve({ integration_id: '7' })).rejects.toThrow(HuduConfigError);
    expect(spy.calls).toHaveLength(0);
    // A narrow lookup that finds nothing is a definitive null, not an error.
    await expect(client.cards.resolve({ integration_slug: 'autotask', integration_id: '7', integration_identifier: 'x' })).resolves.toBeNull();
    expect(spy.calls[0]?.url).toContain('integration_id=7');
  });
});

describe('CardsResource — bounded candidate collection', () => {
  afterEach(() => clearFetch());

  it('reports every ambiguous candidate it collected', async () => {
    const cards = Array.from({ length: 14 }, (_v, index) => card({ id: index + 1 }));
    const spy = lookupOnce(cards);
    const err = await rejection(makeClient().cards.resolve({ integration_slug: 'autotask' }, { limit: 100 }));
    expect(err.code).toBe('RESOLUTION_AMBIGUOUS');
    expect(err.resourceIds).toHaveLength(14);
    expect(err.message).toContain('...');
    expect(spy.calls).toHaveLength(1);
  });
});
