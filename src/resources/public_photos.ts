/**
 * PublicPhotosResource — Hudu "public_photos" resource.
 *
 * Agent-execution layer (policy §6-§9): `resolve` by id (direct) or by the record a
 * public photo belongs to (bounded client scan — the endpoint declares no filters),
 * plus the dry-run contract on `create`/`update`. Additive only: `get`, `list`,
 * `listAll`, `listPages`, `create` and `update` keep their existing shapes.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError } from '../errors.js';
import type { DryRunCheck, DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import type { PublicPhoto, PublicPhotoCreate, PublicPhotoUpdate } from '../types/public_photo.js';

export type PublicPhotosListParams = ListParams;

/**
 * Identifier object accepted by `public_photos.resolve`: the photo's id (its slug or
 * numeric id) or the record it belongs to (`record_type` + `record_id`).
 */
export interface PublicPhotoIdentifier {
  id?: string | number;
  record_type?: string;
  record_id?: number;
  [key: string]: unknown;
}

/** The one page a `resolve` scan may read (plan: `maxScanPages: 1`). */
const RESOLVE_SCAN_PAGES = 1;

/** Kind name used in the validation error, so a caller learns what IS accepted. */
function unsupportedKind(identifier: unknown): string {
  if (typeof identifier === 'string') return `the string "${identifier}"`;
  if (identifier !== null && typeof identifier === 'object') {
    const keys = Object.keys(identifier as Record<string, unknown>);
    return keys.length > 0 ? `an object with { ${keys.join(', ')} }` : 'an empty identifier object';
  }
  return `a value of type ${identifier === null ? 'null' : typeof identifier}`;
}

type PublicPhotoSelector =
  | { kind: 'id'; id: string | number }
  | { kind: 'record'; recordType: string; recordId: number };

/** Read an identifier into a selector, or a structured validation error naming the accepted kinds. */
function publicPhotoSelector(identifier: unknown): PublicPhotoSelector {
  if (typeof identifier === 'number' && Number.isInteger(identifier) && identifier > 0) {
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string' && identifier.trim().length > 0) {
    // The vendor path accepts either the numeric id or the slug id (PublicPhoto.id).
    return { kind: 'id', id: identifier.trim() };
  }
  if (identifier !== null && typeof identifier === 'object') {
    const candidate = identifier as PublicPhotoIdentifier;
    if (typeof candidate.id === 'string' && candidate.id.length > 0) return { kind: 'id', id: candidate.id };
    if (typeof candidate.id === 'number' && Number.isInteger(candidate.id) && candidate.id > 0) {
      return { kind: 'id', id: candidate.id };
    }
    if (
      typeof candidate.record_type === 'string' &&
      candidate.record_type.length > 0 &&
      typeof candidate.record_id === 'number' &&
      Number.isInteger(candidate.record_id)
    ) {
      return { kind: 'record', recordType: candidate.record_type, recordId: candidate.record_id };
    }
  }
  throw new HuduConfigError(
    'public_photos.resolve accepts an id (its slug or numeric id, or { id }) or the record the public photo ' +
      'belongs to ({ record_type, record_id }); got ' + unsupportedKind(identifier) + '. ' +
      'The Hudu API declares no filters on GET /public_photos, so no other kind can be resolved.',
  );
}

export class PublicPhotosResource extends BaseResource<PublicPhoto> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'public_photos', singleKey: 'public_photo', listKey: 'public_photos', createType: 'raw', paginated: true });
  }

  async get(id: number | string, opts?: { download?: boolean }): Promise<PublicPhoto | Blob> {
    if (opts?.download) {
      return this.http.download({
        method: 'GET',
        path: `/public_photos/${id}`,
        query: { download: true },
        operation: 'public_photos.get',
      });
    }
    return this.getOne<PublicPhoto>(id);
  }

  list(params?: PublicPhotosListParams): AsyncIterable<PublicPhoto> {
    return this.items(params ?? {});
  }

  async listAll(params?: PublicPhotosListParams): Promise<PublicPhoto[]> {
    return this.all(params ?? {});
  }

  listPages(params?: PublicPhotosListParams): AsyncIterable<Page<PublicPhoto>> {
    return this.pageIter(params ?? {});
  }

  /**
   * Resolve one public photo (policy §6).
   *
   * - An id (slug or numeric) is fetched directly; a miss throws `NOT_FOUND`.
   * - `{ record_type, record_id }` is a BOUNDED client scan: the endpoint declares no
   *   filters, so one page (25 records, `maxScanPages: 1`) is read and the first
   *   record-pair match wins. A page that ends with `hasMore` and no match means the
   *   scan was cut short — that throws `RESOLUTION_TRUNCATED`, never `null`. `null`
   *   means a complete scan found no public photo for that record.
   * - The record is returned in full: a `PublicPhoto` has 7 scalar fields, so the plan
   *   declares no compact shape for it.
   */
  async resolve(identifier: number | string | PublicPhotoIdentifier): Promise<PublicPhoto | null>;
  async resolve(identifier: number | string | PublicPhotoIdentifier, opts: { expand: true }): Promise<PublicPhoto | null>;
  async resolve(identifier: number | string | PublicPhotoIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<PublicPhoto>>;
  async resolve(
    identifier: number | string | PublicPhotoIdentifier,
    opts?: HelperOptions,
  ): Promise<PublicPhoto | null | Resolution<PublicPhoto>> {
    const selector = publicPhotoSelector(identifier);
    if (selector.kind === 'id') {
      const photo = await this.getOne<PublicPhoto>(selector.id);
      if (opts?.resolutionDetails) {
        const resolution: Resolution<PublicPhoto> = {
          value: photo,
          resolutionCost: 'direct',
          scanned: 1,
          scanTruncated: false,
          candidates: [{ id: Number(photo.numeric_id ?? 0), label: `public_photo ${String(photo.id)}` }],
        };
        return resolution;
      }
      return photo;
    }

    const fetcher = this.pageFetcher({});
    const resolution = await this.boundedScan<PublicPhoto>(fetcher, {
      match: (photo) => photo.record_type === selector.recordType && photo.record_id === selector.recordId,
      maxScanPages: RESOLVE_SCAN_PAGES,
      label: (photo) => `public_photo ${String(photo.id)} (${photo.file_name})`,
      idOf: (photo) => Number(photo.numeric_id ?? 0),
      resolutionCost: 'client-scan',
    });
    const found = PublicPhotosResource.requireResolved<PublicPhoto>(resolution, {
      resource: 'public_photos',
      operation: 'public_photos.resolve',
      // The record the lookup is scoped to is the id a truncated scan must report.
      identifier: selector.recordId,
    });
    if (opts?.resolutionDetails) return resolution;
    return found;
  }

  /** Dry-run check: the multipart body carries the image (spec: required). */
  private photoCheck(data: PublicPhotoCreate | undefined): DryRunCheck {
    const photo = (data ?? ({} as PublicPhotoCreate)).photo;
    const ok = photo !== undefined && photo !== null;
    return { name: 'photo-present', ok, detail: ok ? 'image bytes supplied' : 'no image file was supplied' };
  }

  /** Dry-run check: the public photo names the record it exposes (spec: both required). */
  private recordCheck(data: PublicPhotoUpdate | PublicPhotoCreate | undefined): DryRunCheck {
    const record = (data ?? ({} as PublicPhotoUpdate));
    const ok =
      typeof record.record_type === 'string' &&
      record.record_type.length > 0 &&
      typeof record.record_id === 'number' &&
      Number.isInteger(record.record_id);
    return {
      name: 'record-named',
      ok,
      detail: ok ? `record ${String(record.record_type)}:${String(record.record_id)}` : 'record_type/record_id missing (both are required)',
    };
  }

  /**
   * Multipart create: photo + required record_type + record_id.
   *
   * `{ dryRun: true }` validates the multipart inputs and returns a
   * `DryRunResult<PublicPhoto>` with `simulated: true`; it never builds the multipart
   * body and never issues a POST.
   */
  async create(data: PublicPhotoCreate): Promise<PublicPhoto>;
  async create(data: PublicPhotoCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<PublicPhoto>>;
  async create(data: PublicPhotoCreate, opts: MutationOptions & { dryRun?: false }): Promise<PublicPhoto>;
  async create(data: PublicPhotoCreate, opts: MutationOptions | undefined): Promise<PublicPhoto | DryRunResult<PublicPhoto>>;
  async create(data: PublicPhotoCreate, opts?: MutationOptions): Promise<PublicPhoto | DryRunResult<PublicPhoto>> {
    const operation = 'public_photos.create';
    this.refuseGuardOutsideUpdate(operation, opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<PublicPhoto>({
        operation,
        method: 'POST',
        path: '/public_photos',
        checks: [this.photoCheck(data), this.recordCheck(data)],
        affected: 1,
        scope: 'single',
        // No compensating undo exists: /public_photos has GET and POST, and /public_photos/{id} has GET and PUT
        // only — the API exposes no DELETE, so a created public photo cannot be removed.
        reversible: false,
        warnings: [
          'dry-run validates the multipart inputs without building or sending the body, so the server-computed ' +
            'public photo (id, url, file_size) cannot be promised',
          'the API exposes no delete path for a public photo, so this create cannot be undone (it can only be ' +
            're-associated with public_photos.update)',
        ],
      });
    }
    const fd = new FormData();
    fd.append('photo', data.photo as Blob);
    fd.append('record_type', data.record_type);
    fd.append('record_id', String(data.record_id));
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: '/public_photos',
      formData: fd,
      operation,
      resourceIds: [data.record_id],
    });
    return body as PublicPhoto;
  }

  /**
   * PUT /public_photos/{id} consumes multipart/form-data and returns a
   * `{ public_photo }` envelope, which is unwrapped by `singleKey`.
   *
   * `{ dryRun: true }` describes the PUT without building the body or issuing it.
   */
  async update(id: number, data: PublicPhotoUpdate): Promise<PublicPhoto>;
  async update(id: number, data: PublicPhotoUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<PublicPhoto>>;
  async update(id: number, data: PublicPhotoUpdate, opts: MutationOptions & { dryRun?: false }): Promise<PublicPhoto>;
  async update(id: number, data: PublicPhotoUpdate, opts: MutationOptions | undefined): Promise<PublicPhoto | DryRunResult<PublicPhoto>>;
  async update(id: number, data: PublicPhotoUpdate, opts?: MutationOptions): Promise<PublicPhoto | DryRunResult<PublicPhoto>> {
    const operation = 'public_photos.update';
    this.refuseGuardOutsideUpdate(operation, opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<PublicPhoto>({
        operation,
        method: 'PUT',
        path: `/public_photos/${id}`,
        ids: [id],
        checks: [this.targetCheck(id), this.recordCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
        warnings: [
          'dry-run describes the multipart PUT without building the body or issuing it, so the server-computed ' +
            'public photo fields cannot be promised',
        ],
      });
    }
    const fd = new FormData();
    fd.append('record_type', data.record_type);
    fd.append('record_id', String(data.record_id));
    const body = await this.http.request<unknown>({
      method: 'PUT',
      path: `/public_photos/${id}`,
      formData: fd,
      operation,
      resourceIds: [id],
    });
    return this.unwrapSingle<PublicPhoto>(body);
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
