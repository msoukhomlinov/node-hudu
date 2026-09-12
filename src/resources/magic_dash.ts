/**
 * MagicDashResource — Hudu "magic_dash" resource.
 *
 * The vendor exposes `GET /magic_dash` (paginated, no single-get), `POST /magic_dash`,
 * `DELETE /magic_dash` (form-urlencoded, by title), `DELETE /magic_dash/{id}` and
 * `PUT /magic_dash/update_positions`. The two bulk shapes refuse to run without a bound
 * (`POLICY_DENIED`) and report `impact.scope: "bulk"`.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import { PolicyDeniedError } from '../errors.js';
import type { ListParams, Page } from '../pagination.js';
import type {
  DryRunResult, Identifier, MutationOptions, OperationImpact, Resolution, ResolutionOptions,
} from '../types/common.js';
import type { MagicDash, MagicDashCreate } from '../types/index.js';
import type { MagicDashIdentifier, MagicDashSummary } from '../types/magic_dash.js';
import {
  MAX_HELPER_LIMIT, decideResolution, helperLimit, identifierError, numericIds,
  refuseExpectedUpdatedAtOutsideUpdate, requirePositiveId,
} from './agent-layer-helpers.js';

export interface MagicDashListParams extends ListParams {
  title?: string;
  company_id?: number;
}

/** Options accepted by `findByCompany`. */
export interface FindMagicDashOptions {
  /** Row bound: default 25, hard maximum 100. */
  limit?: number;
  /** Return the full items instead of the compact summaries. */
  expand?: boolean;
}

/** Compact projection of one Magic Dash item (policy §9). */
export function toMagicDashSummary(record: MagicDash): MagicDashSummary {
  return {
    id: record.id,
    title: record.title,
    message: record.message,
    shade: record.shade,
    icon: record.icon,
    image_url: record.image_url,
    company_id: record.company_id,
    company_name: record.company_name,
    position: record.position,
  };
}

export class MagicDashResource extends BaseResource<MagicDash> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'magic_dash', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  list(params?: MagicDashListParams): AsyncIterable<MagicDash> {
    return this.items(params ?? {});
  }
  async listAll(params?: MagicDashListParams): Promise<MagicDash[]> {
    return this.all(params ?? {});
  }
  listPages(params?: MagicDashListParams): AsyncIterable<Page<MagicDash>> {
    return this.pageIter(params ?? {});
  }

  /** POST /magic_dash — may create or update. */
  async create(data: MagicDashCreate): Promise<MagicDash>;
  /** Dry-run: describe the create without issuing it. */
  async create(data: MagicDashCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<MagicDash>>;
  async create(data: MagicDashCreate, opts: MutationOptions & { dryRun?: false }): Promise<MagicDash>;
  async create(data: MagicDashCreate, opts: MutationOptions | undefined): Promise<MagicDash | DryRunResult<MagicDash>>;
  async create(data: MagicDashCreate, opts?: MutationOptions): Promise<MagicDash | DryRunResult<MagicDash>> {
    // staleCheck is "unavailable" for a create: `expectedUpdatedAt` is refused, not ignored.
    refuseExpectedUpdatedAtOutsideUpdate('magic_dash.create', opts);
    return this.createOne<MagicDash>(data, undefined, opts);
  }

  /**
   * DELETE /magic_dash (delete item without id) — title and company_name are required,
   * application/x-www-form-urlencoded (spec consumes).
   *
   * The affected set is every item with that title in that company, so an empty title or
   * company refuses to run (`POLICY_DENIED`) instead of deleting an unbounded set.
   */
  async delete(data: { title: string; company_name: string }): Promise<void>;
  /** Dry-run: describe the bulk delete without issuing it. */
  async delete(
    data: { title: string; company_name: string },
    opts: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<void>>;
  async delete(
    data: { title: string; company_name: string },
    opts: MutationOptions | undefined,
  ): Promise<void | DryRunResult<void>>;
  async delete(
    data: { title: string; company_name: string },
    opts?: MutationOptions,
  ): Promise<void | DryRunResult<void>> {
    const operation = 'magic_dash.delete';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const title = typeof data?.title === 'string' ? data.title.trim() : '';
    const company = typeof data?.company_name === 'string' ? data.company_name.trim() : '';
    if (title.length === 0 || company.length === 0) {
      throw new PolicyDeniedError(
        `${operation} refuses to run without a bound: it deletes every Magic Dash item with the given title ` +
          'in the given company, so both title and company_name must be non-empty.',
        {
          operation,
          suggestedAction: 'Pass the exact title and company_name, or call with { dryRun: true } to inspect the impact first.',
        },
      );
    }
    // ONE impact statement in both channels (policy §7.3): the dry-run result and the audit
    // event of the EXECUTED delete must not disagree about the blast radius. The affected set is
    // server-computed, so both paths take the same bounded pre-read floor (one GET, page_size 100).
    const impact = await this.deleteImpact(title, company);
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'DELETE',
        path: '/magic_dash',
        checks: [{ name: 'bulk-bound', ok: true, detail: `title "${title}" in company "${company}"` }],
        ...impact,
        warnings: [
          `bulk delete by a server-side bound: every Magic Dash item titled "${title}" in "${company}"`,
          `affected ${impact.affected} is a FLOOR from ONE bounded page (page_size ${MAX_HELPER_LIMIT}) filtered by ` +
            'title; the server decides the final target set',
        ],
      });
    }
    await this.http.request<unknown>({
      method: 'DELETE',
      path: '/magic_dash',
      formUrlEncoded: data,
      operation,
      impact,
    });
  }

  /**
   * The impact of the by-title bulk delete, for BOTH channels: `affected` is a floor measured by
   * one bounded page read (page_size 100) whose items must match BOTH bounds; the server computes
   * the real set, so `exact` is false. No undo exists for a deleted item.
   */
  private async deleteImpact(title: string, company: string): Promise<OperationImpact> {
    const floor = await this.countTitleFloor(title, company);
    return { affected: floor, scope: 'bulk', reversible: false, exact: false };
  }

  /** DELETE /magic_dash/{id} — bounded to the one item named by its id. */
  async deleteById(id: number): Promise<void>;
  /** Dry-run: describe the delete without issuing it. */
  async deleteById(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async deleteById(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async deleteById(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    const operation = 'magic_dash.deleteById';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const itemId = requirePositiveId(id, operation);
    // ONE impact statement in both channels; a single-record delete has no undo.
    const impact: OperationImpact = { affected: 1, scope: 'single', reversible: false };
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'DELETE',
        path: `/magic_dash/${itemId}`,
        ids: [itemId],
        checks: [this.targetCheck(itemId)],
        ...impact,
      });
    }
    await this.http.request<unknown>({
      method: 'DELETE',
      path: `/magic_dash/${itemId}`,
      operation,
      resourceIds: [itemId],
      impact,
    });
  }

  /**
   * PUT /magic_dash/update_positions — one call reorders MANY items, so it refuses to
   * run without targets (`POLICY_DENIED`) and reports `impact.scope: "bulk"` with the
   * number of positions the caller supplied.
   */
  async updatePositions(data: { company_id: number; positions: Array<{ id: number; position: number }> }): Promise<{ success: boolean }>;
  /** Dry-run: describe the fan-out without issuing it. */
  async updatePositions(
    data: { company_id: number; positions: Array<{ id: number; position: number }> },
    opts: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<{ success: boolean }>>;
  async updatePositions(
    data: { company_id: number; positions: Array<{ id: number; position: number }> },
    opts: MutationOptions | undefined,
  ): Promise<{ success: boolean } | DryRunResult<{ success: boolean }>>;
  async updatePositions(
    data: { company_id: number; positions: Array<{ id: number; position: number }> },
    opts?: MutationOptions,
  ): Promise<{ success: boolean } | DryRunResult<{ success: boolean }>> {
    const operation = 'magic_dash.updatePositions';
    refuseExpectedUpdatedAtOutsideUpdate(operation, opts);
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    if (positions.length === 0) {
      throw new PolicyDeniedError(
        `${operation} refuses to run without targets: it is a multi-record fan-out and every affected item must ` +
          'be named by an explicit { id, position }.',
        {
          operation,
          resourceIds: numericIds(data?.company_id),
          suggestedAction: 'Pass the positions to apply, or call with { dryRun: true } to inspect the impact first.',
        },
      );
    }
    const ids = positions.map((entry) => entry.id);
    // ONE impact statement in both channels. The caller supplied the bound, so the count IS the
    // affected set (`exact: true`), and the undo path is the same call with the previous positions.
    const impact: OperationImpact = { affected: positions.length, scope: 'bulk', reversible: true, exact: true };
    if (opts?.dryRun === true) {
      return this.buildDryRunResult<{ success: boolean }>({
        operation,
        method: 'PUT',
        path: '/magic_dash/update_positions',
        ids,
        checks: [
          { name: 'explicit-targets', ok: true, detail: `${positions.length} position(s) named` },
          this.payloadCheck(data),
        ],
        ...impact,
        warnings: [
          `multi-record fan-out: ${positions.length} Magic Dash item(s) are repositioned in one call`,
          'the affected count is the number of positions supplied',
          'undo: call magic_dash.updatePositions again with the previous positions',
        ],
      });
    }
    return this.http.request<{ success: boolean }>({
      method: 'PUT',
      path: '/magic_dash/update_positions',
      body: { company_id: data.company_id, positions: data.positions },
      operation,
      resourceIds: ids,
      impact,
    });
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §5/§6/§9).
  // ---------------------------------------------------------------------------

  /**
   * Resolve a Magic Dash item from an id or a title.
   *
   * A title uses the vendor `title` filter with an exact compare (optionally narrowed
   * with `company_id`). An id has no `GET /magic_dash/{id}` read endpoint, so it is found
   * by a bounded client scan (500 records / 4 pages by default) that throws
   * RESOLUTION_TRUNCATED rather than returning `null` when the cap stops it.
   */
  async resolve(identifier: Identifier): Promise<MagicDashSummary | null>;
  /** `{ expand: true }` returns the full item. */
  async resolve(identifier: Identifier, opts: { expand: true }): Promise<MagicDash | null>;
  /** `{ resolutionDetails: true }` returns the resolution cost/scan/candidates. */
  async resolve(identifier: Identifier, opts: { resolutionDetails: true }): Promise<Resolution<MagicDashSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<MagicDashSummary | MagicDash | null | Resolution<MagicDashSummary>>;
  async resolve(
    identifier: Identifier,
    opts?: ResolutionOptions,
  ): Promise<MagicDashSummary | MagicDash | null | Resolution<MagicDashSummary>> {
    const resolution = await this.resolveItem(identifier, opts);
    if (opts?.resolutionDetails === true) {
      const value = resolution.value;
      return { ...resolution, value: value === null ? null : toMagicDashSummary(value) };
    }
    const record = resolution.value;
    if (record === null) return null;
    return opts?.expand === true ? record : toMagicDashSummary(record);
  }

  /**
   * List the Magic Dash items of one company. Uses the vendor `company_id` filter, so no
   * scan is needed; the list is bounded by `limit` (default 25, hard maximum 100).
   */
  async findByCompany(companyId: number, opts?: FindMagicDashOptions): Promise<MagicDashSummary[]>;
  async findByCompany(companyId: number, opts: FindMagicDashOptions & { expand: true }): Promise<MagicDash[]>;
  async findByCompany(companyId: number, opts?: FindMagicDashOptions): Promise<MagicDashSummary[] | MagicDash[]>;
  async findByCompany(companyId: number, opts?: FindMagicDashOptions): Promise<MagicDashSummary[] | MagicDash[]> {
    const method = 'magic_dash.findByCompany';
    const limit = helperLimit(opts?.limit, method);
    const id = requirePositiveId(companyId, method);
    const items = await this.collectBounded({ company_id: id }, limit);
    return opts?.expand === true ? items : items.map(toMagicDashSummary);
  }

  /** One bounded page read (page_size 100) used as an `affected` FLOOR for a bulk dry-run. */
  private async countTitleFloor(title: string, company: string): Promise<number> {
    const page = await this.pageFetcher({ title })(1, MAX_HELPER_LIMIT);
    return page.items.filter((item) => item.title === title && item.company_name === company).length;
  }

  /** Collect at most `limit` rows through one bounded scan. */
  private async collectBounded(filter: ListParams, limit: number): Promise<MagicDash[]> {
    const items: MagicDash[] = [];
    await this.boundedScan<MagicDash>(this.pageFetcher(filter), {
      match: (record) => {
        items.push(record);
        return items.length >= limit;
      },
      label: (record) => record.title,
      idOf: (record) => record.id,
      resolutionCost: 'server-filter',
    });
    return items.slice(0, limit);
  }

  /** Kind dispatch for `resolve`: a numeric id (bounded scan), then an exact title. */
  private async resolveItem(identifier: Identifier, opts?: ResolutionOptions): Promise<Resolution<MagicDash>> {
    const method = 'magic_dash.resolve';
    const limit = helperLimit(opts?.limit, method);
    let id: number | undefined;
    let title: string | undefined;
    let companyId: number | undefined;
    if (typeof identifier === 'number') {
      id = identifier;
    } else if (typeof identifier === 'string') {
      const text = identifier.trim();
      if (text.length === 0) throw identifierError(method, 'a numeric id or a non-empty title (with an optional company_id)');
      if (/^\d+$/.test(text)) id = Number(text);
      else title = text;
    } else if (identifier !== null && typeof identifier === 'object') {
      const typed = identifier as MagicDashIdentifier;
      if (typed.id !== undefined) id = typed.id;
      if (typeof typed.title === 'string' && typed.title.trim().length > 0) title = typed.title.trim();
      if (typeof typed.company_id === 'number') companyId = typed.company_id;
    }
    if (id !== undefined) {
      const itemId = requirePositiveId(id, method);
      const filter: ListParams = {};
      if (companyId !== undefined) filter.company_id = companyId;
      const matches: MagicDash[] = [];
      const scan = await this.boundedScan<MagicDash>(this.pageFetcher(filter), {
        // An id is unique, so the first match decides and the scan stops there.
        match: (record) => {
          if (record.id === itemId) matches.push(record);
          return matches.length >= 1;
        },
        label: (record) => record.title,
        idOf: (record) => record.id,
        resolutionCost: 'client-scan',
      });
      return decideResolution<MagicDash>({
        operation: method,
        resource: 'magic_dash',
        identifier,
        matches,
        scanned: scan.scanned,
        truncated: scan.scanTruncated,
        resolutionCost: 'client-scan',
        label: (record) => record.title,
        idOf: (record) => record.id,
        definite: true,
      });
    }
    if (title !== undefined) {
      const filter: ListParams = { title };
      if (companyId !== undefined) filter.company_id = companyId;
      const matches: MagicDash[] = [];
      const scan = await this.boundedScan<MagicDash>(this.pageFetcher(filter), {
        match: (record) => {
          if (record.title === title) matches.push(record);
          return matches.length >= limit;
        },
        label: (record) => record.title,
        idOf: (record) => record.id,
        resolutionCost: 'server-filter',
      });
      return decideResolution<MagicDash>({
        operation: method,
        resource: 'magic_dash',
        identifier,
        matches,
        scanned: scan.scanned,
        truncated: scan.scanTruncated,
        resolutionCost: 'server-filter',
        label: (record) => record.title,
        idOf: (record) => record.id,
      });
    }
    throw identifierError(method, 'a numeric id or a title (with an optional company_id)');
  }
}
