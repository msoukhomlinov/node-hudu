/**
 * MatchersResource — Hudu "matchers" resource.
 *
 * `GET /matchers` requires `integration_id`, and there is no `GET /matchers/{id}`, so
 * every `resolve` kind is answered inside ONE integration: a `sync_id` or an
 * `identifier` through the vendor filters, an id by a bounded client scan.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type {
  DryRunResult, Identifier, MutationOptions, Resolution, ResolutionOptions,
} from '../types/common.js';
import type { Matcher, MatcherUpdate } from '../types/index.js';
import type { MatcherIdentifier } from '../types/matcher.js';
import {
  decideResolution, helperLimit, identifierError,
  refuseExpectedUpdatedAtOutsideUpdate, requirePositiveId,
} from './agent-layer-helpers.js';

export interface MatchersListParams extends ListParams {
  /** Required by the spec — the ID of the integration. */
  integration_id: number;
  matched?: boolean;
  sync_id?: number;
  identifier?: string;
  company_id?: number;
}

/** Options accepted by `findBySyncId`. */
export interface FindMatchersOptions {
  /** Row bound: default 25, hard maximum 100. */
  limit?: number;
}

export class MatchersResource extends BaseResource<Matcher> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'matchers', singleKey: undefined, listKey: 'matchers', createType: 'raw', paginated: true });
  }

  /**
   * `GET /matchers` requires `integration_id`, and the vendor answers **500** (not 400) when it is
   * absent — live-verified on Hudu 2.45.1. The helper tier already refused a missing integration, but
   * the primitives forwarded whatever they were given, so a JS or agent caller that omitted it got an
   * opaque server error. Refusing before any IO makes the precondition explicit here too.
   */
  private requireIntegrationId(params: MatchersListParams | undefined, method: string): MatchersListParams {
    const integrationId = params?.integration_id;
    if (typeof integrationId !== 'number' || !Number.isInteger(integrationId) || integrationId < 1) {
      throw identifierError(method, `a positive integer integration_id (GET /matchers answers 500 without it), got "${String(integrationId)}"`);
    }
    return params as MatchersListParams;
  }

  /** Stream matchers across pages. integration_id is required (spec). */
  list(params: MatchersListParams): AsyncIterable<Matcher> {
    return this.items(this.requireIntegrationId(params, 'matchers.list'));
  }
  /** Get every matchers. MCP-preferred read. integration_id is required (spec). */
  async listAll(params: MatchersListParams): Promise<Matcher[]> {
    return this.all(this.requireIntegrationId(params, 'matchers.listAll'));
  }

  /** PUT /matchers/{id}. */
  async update(id: number, data: MatcherUpdate): Promise<Matcher>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: MatcherUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Matcher>>;
  /** Live update. Hudu declares no updated_at revision for a matcher, so no stale guard exists. */
  async update(id: number, data: MatcherUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Matcher>;
  async update(id: number, data: MatcherUpdate, opts: MutationOptions | undefined): Promise<Matcher | DryRunResult<Matcher>>;
  async update(id: number, data: MatcherUpdate, opts?: MutationOptions): Promise<Matcher | DryRunResult<Matcher>> {
    // `matchers` declares staleCheck "unavailable" (a matcher carries no updated_at), so the
    // guard is refused rather than a read the vendor has no endpoint for.
    refuseExpectedUpdatedAtOutsideUpdate('matchers.update', opts);
    return this.updateOne<Matcher>(id, data, undefined, opts);
  }

  /** DELETE /matchers/{id}. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  /** Live delete. A matcher carries no updated_at revision, so staleCheck is "unavailable". */
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    refuseExpectedUpdatedAtOutsideUpdate('matchers.delete', opts);
    return this.deleteOne(id, opts);
  }

  /** Iterate matcher pages. integration_id is required (spec). */
  listPages(params: MatchersListParams): AsyncIterable<Page<Matcher>> {
    return this.pageIter(this.requireIntegrationId(params, 'matchers.listPages'));
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve a matcher (the record that correlates a Hudu object with an external
   * system). Accepted kinds: a `sync_id`, an `identifier`, or an id — each resolved
   * inside the `integration_id` the vendor requires. There is no compact shape: a
   * matcher is nine small fields, so the full record is returned.
   */
  async resolve(identifier: Identifier): Promise<Matcher | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<Matcher>>;
  async resolve(identifier: Identifier, opts?: ResolutionOptions): Promise<Matcher | null | Resolution<Matcher>>;
  async resolve(identifier: Identifier, opts?: ResolutionOptions): Promise<Matcher | null | Resolution<Matcher>> {
    const resolution = await this.resolveMatcher(identifier, opts);
    if (opts?.resolutionDetails === true) return resolution;
    return resolution.value;
  }

  /**
   * Find the matcher(s) for an external sync id. Uses the vendor `sync_id` filter
   * (plus the required `integration_id`), so no scan is needed; the list is bounded by
   * `limit` (default 25, hard maximum 100) because one sync id can legitimately match
   * several Hudu records.
   */
  async findBySyncId(syncId: number, integrationId: number, opts?: FindMatchersOptions): Promise<Matcher[]> {
    const method = 'matchers.findBySyncId';
    const limit = helperLimit(opts?.limit, method);
    if (!Number.isInteger(syncId)) throw identifierError(method, 'a numeric sync_id and the integration_id the vendor requires');
    if (!Number.isInteger(integrationId) || integrationId < 1) {
      throw identifierError(method, 'a numeric sync_id and the integration_id the vendor requires');
    }
    const matches: Matcher[] = [];
    const filter: ListParams = { integration_id: integrationId, sync_id: syncId };
    await this.boundedScan<Matcher>(this.pageFetcher(filter), {
      match: (record) => {
        if (record.sync_id === syncId) matches.push(record);
        return matches.length >= limit;
      },
      label: (record) => record.name,
      idOf: (record) => record.id,
      resolutionCost: 'server-filter',
    });
    return matches.slice(0, limit);
  }

  /** Kind dispatch for `resolve` (policy §6): sync_id, identifier, then a bounded id scan. */
  private async resolveMatcher(identifier: Identifier, opts?: ResolutionOptions): Promise<Resolution<Matcher>> {
    const method = 'matchers.resolve';
    const limit = helperLimit(opts?.limit, method);
    const accepted = 'a sync_id, an identifier or an id, each with the integration_id the vendor requires';
    let integrationId: number | undefined;
    let id: number | undefined;
    let syncId: number | undefined;
    let externalIdentifier: string | undefined;
    if (typeof identifier === 'number' || typeof identifier === 'string') {
      // A bare value can only be an id, and the vendor needs the integration for its list.
      if (typeof identifier === 'string' && !/^\d+$/.test(identifier.trim())) throw identifierError(method, accepted);
      throw identifierError(method, `${accepted} — pass an object because a bare value carries no integration_id`);
    }
    if (identifier !== null && typeof identifier === 'object') {
      const typed = identifier as MatcherIdentifier;
      if (typed.integration_id !== undefined) integrationId = typed.integration_id;
      if (typed.id !== undefined) id = typed.id;
      if (typed.sync_id !== undefined) syncId = typed.sync_id;
      if (typeof typed.identifier === 'string' && typed.identifier.trim().length > 0) {
        externalIdentifier = typed.identifier.trim();
      }
    }
    if (integrationId === undefined || !Number.isInteger(integrationId) || integrationId < 1) {
      throw identifierError(method, `${accepted} — integration_id is required by GET /matchers`);
    }
    const filter: ListParams = { integration_id: integrationId };
    let decide: (record: Matcher) => boolean;
    let cost: 'server-filter' | 'client-scan' = 'server-filter';
    if (syncId !== undefined) {
      filter.sync_id = syncId;
      decide = (record) => record.sync_id === syncId;
    } else if (externalIdentifier !== undefined) {
      filter.identifier = externalIdentifier;
      decide = (record) => record.identifier === externalIdentifier;
    } else if (id !== undefined) {
      decide = (record) => record.id === requirePositiveId(id, method);
      // There is no GET /matchers/{id}: the id is found by a bounded client scan.
      cost = 'client-scan';
    } else {
      throw identifierError(method, accepted);
    }
    const matches: Matcher[] = [];
    // An id is unique, so that kind stops at its first match; sync_id/identifier can
    // legitimately match several, so they collect up to `limit` before deciding.
    const stopAfter = id !== undefined ? 1 : limit;
    const scan = await this.boundedScan<Matcher>(this.pageFetcher(filter), {
      match: (record) => {
        if (decide(record)) matches.push(record);
        return matches.length >= stopAfter;
      },
      label: (record) => record.name,
      idOf: (record) => record.id,
      resolutionCost: cost,
    });
    return decideResolution<Matcher>({
      operation: method,
      resource: 'matchers',
      identifier,
      matches,
      scanned: scan.scanned,
      truncated: scan.scanTruncated,
      resolutionCost: cost,
      label: (record) => record.name,
      idOf: (record) => record.id,
      definite: id !== undefined,
    });
  }
}
