/**
 * CardsResource — Hudu integrator cards (lookup/jump).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { Page } from '../pagination.js';
import type { Resolution, ResolutionOptions } from '../types/common.js';
import type { IntegratorCard } from '../types/index.js';
import type { IntegratorCardIdentifier, IntegratorCardSummary } from '../types/integrator_card.js';
import { ambiguityProbeLimit, decideResolution, helperLimit, identifierError } from './agent-layer-helpers.js';

/** The vendor lookup filters (`GET /cards/lookup`). */
interface CardLookupParams {
  integration_slug: string;
  integration_id?: string;
  integration_identifier?: string;
}

/** Compact projection of one integrator card (policy §9). */
export function toIntegratorCardSummary(record: IntegratorCard): IntegratorCardSummary {
  return {
    id: record.id,
    integrator_id: record.integrator_id,
    integrator_name: record.integrator_name,
    link: record.link,
    primary_field: record.primary_field,
    sync_type: record.sync_type,
    sync_id: record.sync_id,
    sync_identifier: record.sync_identifier,
  };
}

export class CardsResource extends BaseResource<unknown> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'cards', singleKey: undefined, listKey: 'integrator_cards', createType: 'raw', paginated: false });
  }
  /** GET /cards/lookup — returns { integrator_cards: [...] }. */
  async lookup(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<IntegratorCard[]> {
    const body = await this.http.request<unknown>({
      method: 'GET',
      path: '/cards/lookup',
      query: params,
      operation: 'cards.lookup',
    });
    return this.unwrapList<IntegratorCard>(body);
  }
  /** GET /cards/jump — follows the redirect and returns the final URL. */
  async jump(params: { integration_type: string; integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string> {
    return this.followRedirect('/cards/jump', params as unknown as Record<string, unknown>);
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve an integrator card from an integration identifier.
   *
   * `cards` is not a CRUD resource: the vendor exposes only `GET /cards/lookup` and
   * `GET /cards/jump`, so this helper uses the LOOKUP filters and returns the single
   * matching card (with `link`, the jump target, kept in the compact shape). It never
   * invents get/create/update/delete methods. Several matches are ambiguous, not
   * guessed; the caller narrows with `integration_id`/`integration_identifier` or asks
   * for `cards.lookup` directly.
   */
  async resolve(identifier: string | IntegratorCardIdentifier): Promise<IntegratorCardSummary | null>;
  /** `{ expand: true }` returns the full card. */
  async resolve(identifier: string | IntegratorCardIdentifier, opts: { expand: true }): Promise<IntegratorCard | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(
    identifier: string | IntegratorCardIdentifier,
    opts: { resolutionDetails: true },
  ): Promise<Resolution<IntegratorCardSummary>>;
  async resolve(
    identifier: string | IntegratorCardIdentifier,
    opts?: ResolutionOptions,
  ): Promise<IntegratorCardSummary | IntegratorCard | null | Resolution<IntegratorCardSummary>>;
  async resolve(
    identifier: string | IntegratorCardIdentifier,
    opts?: ResolutionOptions,
  ): Promise<IntegratorCardSummary | IntegratorCard | null | Resolution<IntegratorCardSummary>> {
    const method = 'cards.resolve';
    const limit = helperLimit(opts?.limit, method);
    const filters = cardFilters(identifier, method);
    const matches: IntegratorCard[] = [];
    // ONE non-paginated lookup: the vendor filter is the narrowing, so every returned
    // card is a match and the scan is complete by construction.
    const scan = await this.boundedScan<IntegratorCard>(
      async (): Promise<Page<IntegratorCard>> => {
        const items = await this.lookup(filters);
        return { items, page: 1, page_size: items.length, hasMore: false };
      },
      {
        match: (card) => {
          matches.push(card);
          return matches.length >= ambiguityProbeLimit(limit);
        },
        label: (card) => card.integrator_name,
        idOf: (card) => card.id,
        resolutionCost: 'server-filter',
      },
    );
    const resolution = decideResolution<IntegratorCard>({
      operation: method,
      resource: 'cards',
      identifier: filters.integration_slug,
      matches,
      scanned: scan.scanned,
      truncated: scan.scanTruncated,
      resolutionCost: 'server-filter',
      label: (card) => card.integrator_name,
      idOf: (card) => card.id,
    });
    if (opts?.resolutionDetails === true) {
      const value = resolution.value;
      return { ...resolution, value: value === null ? null : toIntegratorCardSummary(value) };
    }
    const card = resolution.value;
    if (card === null) return null;
    return opts?.expand === true ? card : toIntegratorCardSummary(card);
  }
}

/** Validate and normalise the lookup filters (policy §6: never guess an identifier kind). */
function cardFilters(identifier: string | IntegratorCardIdentifier, method: string): CardLookupParams {
  const accepted = 'an integration_slug (as a bare string) or { integration_slug, integration_id?, integration_identifier? }';
  const object = typeof identifier === 'string' ? { integration_slug: identifier } : identifier;
  if (object === null || typeof object !== 'object') throw identifierError(method, accepted);
  const slug = typeof object.integration_slug === 'string' ? object.integration_slug.trim() : '';
  if (slug.length === 0) throw identifierError(method, accepted);
  const filters: CardLookupParams = { integration_slug: slug };
  if (typeof object.integration_id === 'string' && object.integration_id.length > 0) {
    filters.integration_id = object.integration_id;
  }
  if (typeof object.integration_identifier === 'string' && object.integration_identifier.length > 0) {
    filters.integration_identifier = object.integration_identifier;
  }
  return filters;
}
