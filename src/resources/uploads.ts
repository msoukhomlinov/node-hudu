/**
 * UploadsResource — Hudu "uploads" resource.
 *
 * Agent-execution layer (policy §6-§9):
 * - `resolve` fetches the one identity an upload has: its id.
 * - `upload` carries the dry-run contract; the multipart body is built once, and
 *   on the dry-run path never built at all.
 * Additive only: `upload`, `get`, `list`, `listAll`, `listPages` and `delete` keep
 * their existing shapes and behaviour.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError } from '../errors.js';
import type { DryRunCheck, DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import type { Upload } from '../types/upload.js';
import type { UploadSummary } from '../types/upload.js';

export type UploadsListParams = ListParams;

/**
 * Identifier object accepted by `uploads.resolve`. Uploads expose no name/slug/domain
 * filter in the Hudu API, so `id` is the ONLY resolvable kind.
 */
export interface UploadIdentifier {
  id?: number;
}

/** Kind name used in the validation error, so a caller learns what IS accepted. */
function unsupportedKind(identifier: unknown): string {
  if (typeof identifier === 'string') return 'a name/slug string';
  if (identifier !== null && typeof identifier === 'object') {
    const keys = Object.keys(identifier as Record<string, unknown>);
    return keys.length > 0 ? `an object with { ${keys.join(', ')} }` : 'an empty identifier object';
  }
  return `a value of type ${identifier === null ? 'null' : typeof identifier}`;
}

/**
 * The id an upload identifier names, or a structured validation error naming the
 * accepted kinds. Never guesses and never scans: an upload has no other identity.
 */
function uploadId(identifier: unknown): number {
  if (typeof identifier === 'number' && Number.isInteger(identifier) && identifier > 0) return identifier;
  if (typeof identifier === 'string' && /^\d+$/.test(identifier.trim())) return Number(identifier.trim());
  if (identifier !== null && typeof identifier === 'object') {
    const id = (identifier as UploadIdentifier).id;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  }
  throw new HuduConfigError(
    `uploads.resolve accepts only an id (a number, a numeric string or { id }); got ${unsupportedKind(identifier)}. ` +
      'The Hudu API exposes no name, slug or domain filter for uploads, so no other identifier kind can be ' +
      'resolved without guessing. Use uploads.listAll to enumerate uploads.',
  );
}

/** Compact projection of an upload (policy §9): drops `archived_at`. */
function toUploadSummary(upload: Upload): UploadSummary {
  return {
    id: upload.id,
    name: upload.name,
    ext: upload.ext,
    mime: upload.mime,
    size: upload.size,
    url: upload.url,
    uploadable_id: upload.uploadable_id,
    uploadable_type: upload.uploadable_type,
    created_date: upload.created_date,
  };
}

export class UploadsResource extends BaseResource<Upload> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'uploads', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  list(params?: UploadsListParams): AsyncIterable<Upload> {
    return this.items(params ?? {});
  }

  async listAll(params?: UploadsListParams): Promise<Upload[]> {
    return this.all(params ?? {});
  }

  listPages(params?: UploadsListParams): AsyncIterable<Page<Upload>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve one upload by its id (policy §6).
   *
   * Default: `UploadSummary`. `{ expand: true }`: the full `Upload`.
   * `{ resolutionDetails: true }`: a `Resolution<UploadSummary>` (cost, scanned,
   * candidates). An unknown id throws `NOT_FOUND` — never `null`. A non-id kind
   * throws a structured validation error instead of scanning the whole account.
   */
  async resolve(identifier: number | string | UploadIdentifier): Promise<UploadSummary | null>;
  async resolve(identifier: number | string | UploadIdentifier, opts: { expand: true }): Promise<Upload | null>;
  async resolve(identifier: number | string | UploadIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<UploadSummary>>;
  async resolve(
    identifier: number | string | UploadIdentifier,
    opts?: HelperOptions,
  ): Promise<Upload | UploadSummary | null | Resolution<UploadSummary>> {
    const id = uploadId(identifier);
    const upload = await this.getOne<Upload>(id);
    const summary = toUploadSummary(upload);
    if (opts?.resolutionDetails) {
      const resolution: Resolution<UploadSummary> = {
        value: summary,
        resolutionCost: 'direct',
        scanned: 1,
        scanTruncated: false,
        candidates: [{ id, label: `upload ${id} (${summary.name})` }],
      };
      return resolution;
    }
    return opts?.expand ? upload : summary;
  }

  /** Dry-run check: a file was supplied. */
  private fileCheck(file: unknown): DryRunCheck {
    const ok = file !== undefined && file !== null;
    return { name: 'file-present', ok, detail: ok ? 'file bytes supplied' : 'no file was supplied' };
  }

  /** Dry-run check: the upload names the record it is attached to. */
  private uploadTargetCheck(data: unknown): DryRunCheck {
    const target = (data ?? {}) as { uploadable_id?: unknown; uploadable_type?: unknown };
    const ok =
      typeof target.uploadable_id === 'number' &&
      Number.isInteger(target.uploadable_id) &&
      typeof target.uploadable_type === 'string' &&
      target.uploadable_type.length > 0;
    return {
      name: 'upload-target',
      ok,
      detail: ok ? `uploadable ${String(target.uploadable_type)}:${String(target.uploadable_id)}` : 'uploadable_id/uploadable_type missing',
    };
  }

  /**
   * Multipart upload. A Node Buffer is converted to a Blob so binary bytes are not
   * mangled to a UTF-8 string by undici FormData (close-check F1).
   *
   * `{ dryRun: true }` describes the upload and returns a `DryRunResult<Upload>` with
   * `simulated: true` WITHOUT building or sending the multipart body (policy §7.2).
   */
  async upload(file: File | Blob | Buffer, data: { uploadable_id: number; uploadable_type: string }): Promise<Upload>;
  async upload(
    file: File | Blob | Buffer,
    data: { uploadable_id: number; uploadable_type: string },
    opts: MutationOptions & { dryRun: true },
  ): Promise<DryRunResult<Upload>>;
  async upload(
    file: File | Blob | Buffer,
    data: { uploadable_id: number; uploadable_type: string },
    opts: MutationOptions & { dryRun?: false },
  ): Promise<Upload>;
  async upload(
    file: File | Blob | Buffer,
    data: { uploadable_id: number; uploadable_type: string },
    opts: MutationOptions | undefined,
  ): Promise<Upload | DryRunResult<Upload>>;
  async upload(
    file: File | Blob | Buffer,
    data: { uploadable_id: number; uploadable_type: string },
    opts?: MutationOptions,
  ): Promise<Upload | DryRunResult<Upload>> {
    const operation = 'uploads.upload';
    this.refuseGuardOutsideUpdate(operation, opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<Upload>({
        operation,
        method: 'POST',
        path: '/uploads',
        checks: [this.fileCheck(file), this.uploadTargetCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
        warnings: [
          'dry-run describes the multipart upload without building or sending the body, so the server-computed ' +
            'upload record (id, url, size, created_date) cannot be promised',
        ],
      });
    }
    const fd = new FormData();
    const blob = Buffer.isBuffer(file) ? new Blob([file]) : (file as Blob);
    fd.append('file', blob);
    fd.append('upload[uploadable_id]', String(data.uploadable_id));
    fd.append('upload[uploadable_type]', data.uploadable_type);
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: '/uploads',
      formData: fd,
      operation,
      resourceIds: [data.uploadable_id],
    });
    return body as Upload;
  }

  async get(id: number, opts?: { download?: boolean }): Promise<Upload | Blob> {
    if (opts?.download) {
      return this.http.download({ method: 'GET', path: `/uploads/${id}`, query: { download: true }, operation: 'uploads.get' });
    }
    return this.getOne<Upload>(id);
  }

  /** Delete an upload. `{ dryRun: true }` describes it and issues NO request at all. */
  async delete(id: number): Promise<void>;
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    this.refuseGuardOutsideUpdate('uploads.delete', opts);
    return this.deleteOne(id, opts);
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
