/**
 * ExportsResource — Hudu "exports" resource.
 *
 * Agent-execution layer (policy §6-§9): `resolve` by id (direct) or by exact file
 * name (one bounded fetch — /exports is NON-PAGINATED and declares no filters), plus
 * the dry-run contract on `create`. Additive only: `list`, `listAll`, `listPages`,
 * `get` and `create` keep their existing shapes.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError } from '../errors.js';
import type { DryRunCheck, DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import type { Export, ExportCreate, ExportSummary } from '../types/export.js';

export type ExportsListParams = ListParams;

/** Identifier object accepted by `exports.resolve`: an `id` or the export's `file_name`. */
export interface ExportIdentifier {
  id?: number;
  file_name?: string;
  [key: string]: unknown;
}

/** Kind name used in the validation error, so a caller learns what IS accepted. */
function unsupportedKind(identifier: unknown): string {
  if (identifier !== null && typeof identifier === 'object') {
    const keys = Object.keys(identifier as Record<string, unknown>);
    return keys.length > 0 ? `an object with { ${keys.join(', ')} }` : 'an empty identifier object';
  }
  return `a value of type ${identifier === null ? 'null' : typeof identifier}`;
}

type ExportSelector = { kind: 'id'; id: number } | { kind: 'file_name'; fileName: string };

/** Read an identifier into a selector, or a structured validation error naming the accepted kinds. */
function exportSelector(identifier: unknown): ExportSelector {
  if (typeof identifier === 'number' && Number.isInteger(identifier) && identifier > 0) {
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string' && identifier.trim().length > 0) {
    const text = identifier.trim();
    return /^\d+$/.test(text) ? { kind: 'id', id: Number(text) } : { kind: 'file_name', fileName: text };
  }
  if (identifier !== null && typeof identifier === 'object') {
    const candidate = identifier as ExportIdentifier;
    if (typeof candidate.id === 'number' && Number.isInteger(candidate.id) && candidate.id > 0) {
      return { kind: 'id', id: candidate.id };
    }
    if (typeof candidate.file_name === 'string' && candidate.file_name.length > 0) {
      return { kind: 'file_name', fileName: candidate.file_name };
    }
  }
  throw new HuduConfigError(
    'exports.resolve accepts an id (a number, a numeric string or { id }) or an exact file name ' +
      '(a string or { file_name }); got ' + unsupportedKind(identifier) + '. ' +
      'The Hudu API declares no filters on GET /exports, so no other identifier kind is supported.',
  );
}

export class ExportsResource extends BaseResource<Export> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'exports', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  list(params?: ExportsListParams): AsyncIterable<Export> {
    return this.items(params ?? {});
  }

  async listAll(params?: ExportsListParams): Promise<Export[]> {
    return this.all(params ?? {});
  }

  listPages(params?: ExportsListParams): AsyncIterable<Page<Export>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve one export (policy §6).
   *
   * - `{ id }` is fetched directly; an id miss throws `NOT_FOUND` (never `null`).
   * - A file name is resolved with ONE bounded fetch of the non-paginated list and an
   *   exact `file_name` compare (the vendor declares no filters). The first exact
   *   match wins.
   * - `Export` is already a compact record (9 scalar fields), so the summary shape IS
   *   the record: the plan declares no compact shape and nothing is dropped.
   * - A non-paginated single fetch always reports `hasMore: false`, so a file-name
   *   lookup is a COMPLETE scan: it returns `null` when nothing matches, and
   *   `RESOLUTION_TRUNCATED` is structurally unreachable on this path (documented,
   *   not silently swallowed — the cap cannot stop a one-request complete read).
   */
  async resolve(identifier: number | string | ExportIdentifier): Promise<ExportSummary | null>;
  async resolve(identifier: number | string | ExportIdentifier, opts: { expand: true }): Promise<Export | null>;
  async resolve(identifier: number | string | ExportIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<ExportSummary>>;
  async resolve(
    identifier: number | string | ExportIdentifier,
    opts?: HelperOptions,
  ): Promise<Export | ExportSummary | null | Resolution<ExportSummary>> {
    const selector = exportSelector(identifier);
    if (selector.kind === 'id') {
      const record = await this.getOne<Export>(selector.id);
      if (opts?.resolutionDetails) {
        const resolution: Resolution<ExportSummary> = {
          value: record,
          resolutionCost: 'direct',
          scanned: 1,
          scanTruncated: false,
          candidates: [{ id: selector.id, label: `export ${selector.id} (${record.file_name ?? 'unnamed'})` }],
        };
        return resolution;
      }
      return record;
    }

    const fetcher = this.pageFetcher({});
    const resolution = await this.boundedScan<Export>(fetcher, {
      match: (record) => record.file_name === selector.fileName,
      label: (record) => `export ${String(record.id ?? '?')} (${record.file_name ?? 'unnamed'})`,
      idOf: (record) => Number(record.id ?? 0),
      resolutionCost: 'client-scan',
    });
    const found = ExportsResource.requireResolved<Export>(resolution, {
      resource: 'exports',
      operation: 'exports.resolve',
      identifier,
    });
    if (opts?.resolutionDetails) return resolution;
    return found;
  }

  /** Dry-run check: the export names its format and company (both required by the spec). */
  private exportRequestCheck(data: ExportCreate | undefined): DryRunCheck {
    const request = (data ?? ({} as ExportCreate));
    const ok =
      (request.format === 'pdf' || request.format === 'csv') &&
      typeof request.company_id === 'number' &&
      Number.isInteger(request.company_id);
    return {
      name: 'export-request',
      ok,
      detail: ok
        ? `format ${request.format} for company ${String(request.company_id)}`
        : 'format ("pdf"|"csv") and company_id are required by the API spec',
    };
  }

  /**
   * POST /exports — initiate an export. Body is wrapped in `export` (spec). The server
   * answers 200 with an EMPTY body, so this resolves `void`.
   *
   * `{ dryRun: true }` validates the request and returns a `DryRunResult<void>` with
   * `simulated: true` and no POST. Because the endpoint returns no record, the result
   * WARNS that the server-computed export (id, status, download_url) cannot be
   * promised — there is no partial result to describe.
   */
  async create(data: ExportCreate): Promise<void>;
  async create(data: ExportCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async create(data: ExportCreate, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async create(data: ExportCreate, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async create(data: ExportCreate, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    const operation = 'exports.create';
    this.refuseGuardOutsideUpdate(operation, opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'POST',
        path: '/exports',
        checks: [this.payloadCheck(data), this.exportRequestCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
        warnings: [
          'POST /exports returns an empty 200 body, so there is no server-computed result to promise: the export ' +
            'record (id, status, download_url) is created asynchronously and cannot be described by dry-run',
        ],
      });
    }
    await this.http.request<unknown>({ method: 'POST', path: '/exports', body: { export: data }, operation });
  }

  /** Get export metadata or, when download=true, the file blob. */
  async get(id: number, opts?: { download?: boolean }): Promise<Export | Blob> {
    if (opts?.download) {
      return this.http.download({ method: 'GET', path: `/exports/${id}`, query: { download: true }, operation: 'exports.get' });
    }
    return this.getOne<Export>(id);
  }
  /**
   * The `expectedUpdatedAt` guard reads the CURRENT record and compares its `updated_at`,
   * so it belongs to the update path only (the plan records `staleCheck: "unavailable"`
   * for create and delete). Silently ignoring the option would claim a guard that never
   * ran, so it is refused instead.
   */
  private refuseGuardOutsideUpdate(operation: string, opts: MutationOptions | undefined): void {
    if (opts?.expectedUpdatedAt !== undefined) {
      throw new HuduConfigError(
        `${operation}: expectedUpdatedAt compares an existing revision, so it applies to update (PUT) only`,
      );
    }
  }
}
