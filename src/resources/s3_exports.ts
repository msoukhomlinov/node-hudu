/**
 * S3ExportsResource — Hudu "s3_exports" resource.
 *
 * Write-only by design: POST /s3_exports returns an empty 200 body and the vendor
 * exposes no list, get or delete endpoint, so there are no records to resolve and the
 * plan declares NO helper rows for this resource (SCOPING decision 14). The one
 * primitive still carries the full classification, dry-run and error contract.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import { HuduConfigError } from '../errors.js';
import type { DryRunResult, MutationOptions } from '../types/common.js';
import type { S3ExportCreate } from '../types/s3_export.js';

export class S3ExportsResource extends BaseResource<unknown> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 's3_exports', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: false });
  }

  /**
   * POST /s3_exports — initiate an s3 export. Returns 200 with an empty (null) body,
   * so this resolves `void`.
   *
   * `{ dryRun: true }` validates the request and returns a `DryRunResult<void>` with
   * `simulated: true` and no POST. Because the endpoint returns no record, the result
   * WARNS that there is no server-computed result to promise.
   */
  async create(data?: S3ExportCreate): Promise<void>;
  async create(data: S3ExportCreate | undefined, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async create(data: S3ExportCreate | undefined, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async create(data: S3ExportCreate | undefined, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async create(data?: S3ExportCreate, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    const operation = 's3_exports.create';
    this.refuseGuardOutsideUpdate(operation, opts);
    const payload = data ?? {};
    if (opts?.dryRun) {
      return this.buildDryRunResult<void>({
        operation,
        method: 'POST',
        path: '/s3_exports',
        checks: [this.payloadCheck(payload)],
        affected: 1,
        scope: 'single',
        // No compensating undo exists: /s3_exports has POST only (no DELETE, no cancel).
        reversible: false,
        warnings: [
          'POST /s3_exports returns an empty 200 body, so there is no server-computed result to promise: the export ' +
            'runs asynchronously and dry-run cannot describe its outcome',
          'an export runs asynchronously and the API exposes no cancel or delete path for it, so this cannot be undone',
        ],
      });
    }
    await this.http.request<unknown>({ method: 'POST', path: '/s3_exports', body: payload, operation });
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
