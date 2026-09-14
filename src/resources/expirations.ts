/**
 * ExpirationsResource — Hudu "expirations" resource.
 *
 * The vendor exposes `GET /expirations` (paginated), `PUT /expirations/{id}` and
 * `DELETE /expirations/{id}` — there is NO `GET /expirations/{id}` and no id list
 * filter, so an id is resolved by a bounded client scan (policy §6).
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type {
  DryRunResult, Identifier, MutationOptions, Resolution, ResolutionOptions,
} from '../types/common.js';
import type { Expiration, ExpirationUpdate } from '../types/index.js';
import type { ExpirationIdentifier, ExpirationSummary } from '../types/expiration.js';
import {
  ambiguityProbeLimit, decideResolution, helperLimit, identifierError,
  refuseExpectedUpdatedAtOutsideUpdate, requirePositiveId,
} from './agent-layer-helpers.js';

export interface ExpirationsListParams extends ListParams {
  company_id?: number;
  expiration_type?: string;
  resource_id?: number;
  resource_type?: string;
  archived?: boolean;
}

/** Options accepted by `findByResource`. */
export interface FindExpirationsOptions {
  /** Row bound: default 25, hard maximum 100. */
  limit?: number;
  /** Return the full expiration records instead of the compact summaries. */
  expand?: boolean;
}

/** Compact projection of one expiration (policy §9). */
export function toExpirationSummary(record: Expiration): ExpirationSummary {
  return {
    id: record.id,
    date: record.date,
    expiration_type: record.expiration_type,
    company_id: record.company_id,
    expirationable_type: record.expirationable_type,
    expirationable_id: record.expirationable_id,
    asset_field_id: record.asset_field_id,
    asset_layout_field_id: record.asset_layout_field_id,
    sync_id: record.sync_id,
    updated_at: record.updated_at,
  };
}

export class ExpirationsResource extends BaseResource<Expiration> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'expirations', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Stream expirations across pages. */
  list(params?: ExpirationsListParams): AsyncIterable<Expiration> {
    return this.items(params ?? {});
  }
  /** Get every expirations. MCP-preferred read. */
  async listAll(params?: ExpirationsListParams): Promise<Expiration[]> {
    return this.all(params ?? {});
  }

  /** PUT /expirations/{id}. */
  async update(id: number, data: ExpirationUpdate): Promise<Expiration>;
  /** Dry-run: describe the update without issuing it. */
  async update(id: number, data: ExpirationUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Expiration>>;
  /** Live update; `{ expectedUpdatedAt }` adds the opt-in stale guard. */
  async update(id: number, data: ExpirationUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Expiration>;
  async update(id: number, data: ExpirationUpdate, opts: MutationOptions | undefined): Promise<Expiration | DryRunResult<Expiration>>;
  async update(id: number, data: ExpirationUpdate, opts?: MutationOptions): Promise<Expiration | DryRunResult<Expiration>> {
    if (opts?.dryRun !== true && opts?.expectedUpdatedAt !== undefined) {
      // The read-then-compare is done with the resource's own bounded scan: the vendor
      // has no GET /expirations/{id}, so the base guard's single-get would 405 here.
      await this.assertNotStale('expirations.update', 'expirations', id, opts.expectedUpdatedAt, async () => {
        const found = await this.expirationById(id);
        return found.value ?? undefined;
      });
      return this.updateOne<Expiration>(id, { expiration: data });
    }
    return this.updateOne<Expiration>(id, { expiration: data }, undefined, opts);
  }

  /** DELETE /expirations/{id}. */
  async delete(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  /** Live delete. A delete is bounded by an explicit id and Hudu exposes no conditional delete. */
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    // staleCheck is "unavailable" for a delete: no prior revision to compare, no
    // conditional delete in the vendor API, so `expectedUpdatedAt` is refused here.
    refuseExpectedUpdatedAtOutsideUpdate('expirations.delete', opts);
    return this.deleteOne(id, opts);
  }

  listPages(params?: ExpirationsListParams): AsyncIterable<Page<Expiration>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve an expiration from an id or from its resource.
   *
   * An id has no single-get and no vendor id filter, so it is found by a bounded client
   * scan. A `{ resource_type, resource_id }` pair uses the vendor filters and may
   * legitimately match several expirations: that is reported as RESOLUTION_AMBIGUOUS
   * with the candidate ids, never guessed.
   */
  async resolve(identifier: Identifier): Promise<ExpirationSummary | null>;
  /** `{ expand: true }` returns the full expiration record. */
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<Expiration | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<ExpirationSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ExpirationSummary | Expiration | null | Resolution<ExpirationSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<ExpirationSummary | Expiration | null | Resolution<ExpirationSummary>> {
    const resolution = await this.resolveExpiration(identifier, opts);
    if (opts?.resolutionDetails === true) {
      const value = resolution.value;
      return { ...resolution, value: value === null ? null : toExpirationSummary(value) };
    }
    const record = resolution.value;
    if (record === null) return null;
    return opts?.expand === true ? record : toExpirationSummary(record);
  }

  /**
   * List the expirations attached to one resource ("when does this record expire").
   * Uses the vendor `resource_id` + `resource_type` filters, so no scan is needed; the
   * list is bounded by `limit` (default 25, hard maximum 100).
   */
  async findByResource(resourceType: string, resourceId: number, opts?: FindExpirationsOptions): Promise<ExpirationSummary[]>;
  async findByResource(
    resourceType: string,
    resourceId: number,
    opts: FindExpirationsOptions & { expand: true },
  ): Promise<Expiration[]>;
  async findByResource(
    resourceType: string,
    resourceId: number,
    opts?: FindExpirationsOptions,
  ): Promise<ExpirationSummary[] | Expiration[]>;
  async findByResource(
    resourceType: string,
    resourceId: number,
    opts?: FindExpirationsOptions,
  ): Promise<ExpirationSummary[] | Expiration[]> {
    const method = 'expirations.findByResource';
    const limit = helperLimit(opts?.limit, method);
    if (typeof resourceType !== 'string' || resourceType.trim().length === 0 || !Number.isInteger(resourceId) || resourceId < 1) {
      throw identifierError(method, 'a non-empty resource type (e.g. "Asset") and a positive resource id');
    }
    const filter: ListParams = { resource_type: resourceType.trim(), resource_id: resourceId };
    const records = await this.collectBounded(filter, limit);
    return opts?.expand === true ? records : records.map(toExpirationSummary);
  }

  /** Collect at most `limit` rows through one bounded scan. */
  private async collectBounded(filter: ListParams, limit: number): Promise<Expiration[]> {
    const items: Expiration[] = [];
    await this.boundedScan<Expiration>(this.pageFetcher(filter), {
      match: (record) => {
        items.push(record);
        return items.length >= limit;
      },
      label: (record) => String(record.id),
      idOf: (record) => record.id,
      resolutionCost: 'server-filter',
    });
    return items.slice(0, limit);
  }

  /** One bounded scan for a single expiration id, optionally narrowed by filters. */
  private async expirationById(id: number, extra?: ListParams): Promise<Resolution<Expiration>> {
    const matches: Expiration[] = [];
    const scan = await this.boundedScan<Expiration>(this.pageFetcher(extra ?? {}), {
      // An id is unique, so the first match decides and the scan stops there.
      match: (record) => {
        if (record.id === id) matches.push(record);
        return matches.length >= 1;
      },
      label: (record) => String(record.id),
      idOf: (record) => record.id,
      resolutionCost: 'client-scan',
    });
    return decideResolution<Expiration>({
      operation: 'expirations.resolve',
      resource: 'expirations',
      identifier: id,
      matches,
      scanned: scan.scanned,
      truncated: scan.scanTruncated,
      resolutionCost: 'client-scan',
      label: (record) => String(record.id),
      idOf: (record) => record.id,
      definite: true,
    });
  }

  /** Kind dispatch for `resolve`: a numeric id, or a `{ resource_type, resource_id }` pair. */
  private async resolveExpiration(identifier: Identifier, opts?: ResolutionOptions): Promise<Resolution<Expiration>> {
    const method = 'expirations.resolve';
    const limit = helperLimit(opts?.limit, method);
    if (typeof identifier === 'number') {
      return this.expirationById(requirePositiveId(identifier, method));
    }
    if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (/^\d+$/.test(text)) return this.expirationById(requirePositiveId(Number(text), method));
      throw identifierError(method, 'a numeric id or { resource_type, resource_id }');
    }
    if (identifier !== null && typeof identifier === 'object') {
      const typed = identifier as ExpirationIdentifier;
      if (typed.id !== undefined) return this.expirationById(requirePositiveId(typed.id, method));
      const resourceType = typeof typed.resource_type === 'string' ? typed.resource_type.trim() : '';
      const resourceId = typed.resource_id;
      if (resourceType.length > 0 && typeof resourceId === 'number') {
        const filter: ListParams = { resource_type: resourceType, resource_id: resourceId };
        if (typeof typed.expiration_type === 'string' && typed.expiration_type.length > 0) {
          filter.expiration_type = typed.expiration_type;
        }
        if (typeof typed.company_id === 'number') filter.company_id = typed.company_id;
        const matches: Expiration[] = [];
        const scan = await this.boundedScan<Expiration>(this.pageFetcher(filter), {
          match: (record) => {
            if (record.expirationable_type === resourceType && record.expirationable_id === resourceId) {
              matches.push(record);
            }
            return matches.length >= ambiguityProbeLimit(limit);
          },
          label: (record) => `${record.expiration_type} ${record.date}`,
          idOf: (record) => record.id,
          resolutionCost: 'server-filter',
        });
        return decideResolution<Expiration>({
          operation: method,
          resource: 'expirations',
          identifier,
          matches,
          scanned: scan.scanned,
          truncated: scan.scanTruncated,
          resolutionCost: 'server-filter',
          label: (record) => `${record.expiration_type} ${record.date}`,
          idOf: (record) => record.id,
        });
      }
    }
    throw identifierError(method, 'a numeric id or { resource_type, resource_id }');
  }
}
