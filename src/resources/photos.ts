/**
 * PhotosResource — Hudu "photos" resource.
 *
 * Agent-execution layer (policy §6-§9):
 * - `resolve` resolves by id (direct) or by the record the photo is attached to
 *   (vendor filter + ambiguity detection).
 * - `findByPhotoable` is the bounded list path for one record's photos.
 * - `create`/`update`/`delete` carry the dry-run contract; `update`/`delete` and
 *   the create path honour the opt-in `expectedUpdatedAt` stale guard.
 * Additive only: `get`, `list`, `listAll`, `listPages`, `create`, `update` and
 * `delete` keep their existing arguments and behaviour.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import type { DryRunCheck, DryRunResult, HelperOptions, MutationOptions, Resolution } from '../types/common.js';
import type { Photo, PhotoCreate, PhotoUpdate } from '../types/photo.js';
import type { PhotoSummary } from '../types/photo.js';

export interface PhotosListParams extends ListParams {
  company_id?: number;
  photoable_type?: string;
  photoable_id?: number;
  folder_id?: number;
  archived?: boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Identifier object accepted by `photos.resolve`: either an `id`, or the record the
 * photo is attached to (`photoable_type` + `photoable_id`, optionally `folder_id`).
 */
export interface PhotoIdentifier {
  id?: number;
  photoable_type?: string;
  photoable_id?: number;
  folder_id?: number;
  [key: string]: unknown;
}

/** Helper `limit` bounds (policy §9): default 25, hard maximum 100. */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

/** Rows `limit` allows, or a deterministic `HuduConfigError` above the maximum. */
function helperLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(
      `photos helper limit must be an integer from 1 to ${MAX_HELPER_LIMIT}, got "${String(limit)}"`,
    );
  }
  return limit;
}

/** Compact projection of a photo (policy §9): drops `created_at`. */
function toPhotoSummary(photo: Photo): PhotoSummary {
  return {
    id: photo.id,
    company_id: photo.company_id,
    folder_id: photo.folder_id,
    photoable_type: photo.photoable_type,
    photoable_id: photo.photoable_id,
    caption: photo.caption,
    pinned: photo.pinned,
    archived: photo.archived,
    updated_at: photo.updated_at,
  };
}

type PhotoSelector =
  | { kind: 'id'; id: number }
  | { kind: 'photoable'; photoableType: string; photoableId: number; folderId?: number };

/** Kind name used in the validation error, so a caller learns what IS accepted. */
function unsupportedKind(identifier: unknown): string {
  if (typeof identifier === 'string') return `the string "${identifier}"`;
  if (identifier !== null && typeof identifier === 'object') {
    const keys = Object.keys(identifier as Record<string, unknown>);
    return keys.length > 0 ? `an object with { ${keys.join(', ')} }` : 'an empty identifier object';
  }
  return `a value of type ${identifier === null ? 'null' : typeof identifier}`;
}

/** Read an identifier into a selector, or a structured validation error naming the accepted kinds. */
function photoSelector(identifier: unknown): PhotoSelector {
  if (typeof identifier === 'number' && Number.isInteger(identifier) && identifier > 0) {
    return { kind: 'id', id: identifier };
  }
  if (typeof identifier === 'string' && /^\d+$/.test(identifier.trim())) {
    return { kind: 'id', id: Number(identifier.trim()) };
  }
  if (identifier !== null && typeof identifier === 'object') {
    const candidate = identifier as PhotoIdentifier;
    if (typeof candidate.id === 'number' && Number.isInteger(candidate.id) && candidate.id > 0) {
      return { kind: 'id', id: candidate.id };
    }
    if (typeof candidate.photoable_type === 'string' && candidate.photoable_type.length > 0 &&
        typeof candidate.photoable_id === 'number' && Number.isInteger(candidate.photoable_id)) {
      return {
        kind: 'photoable',
        photoableType: candidate.photoable_type,
        photoableId: candidate.photoable_id,
        folderId: candidate.folder_id,
      };
    }
  }
  throw new HuduConfigError(
    `photos.resolve accepts an id (a number, a numeric string or { id }) or the record the photo is attached to ` +
      `({ photoable_type, photoable_id } with an optional folder_id); got ${unsupportedKind(identifier)}. ` +
      'A photo has no name/slug/domain of its own, so no other identifier kind is supported.',
  );
}

export class PhotosResource extends BaseResource<Photo> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'photos', singleKey: 'photo', listKey: 'photos', createType: 'wrapped', paginated: true });
  }

  async get(id: number, opts?: { download?: boolean }): Promise<Photo | Blob> {
    if (opts?.download) {
      return this.http.download({ method: 'GET', path: `/photos/${id}`, query: { download: true }, operation: 'photos.get' });
    }
    return this.getOne<Photo>(id);
  }

  list(params?: PhotosListParams): AsyncIterable<Photo> {
    return this.items(params ?? {});
  }

  async listAll(params?: PhotosListParams): Promise<Photo[]> {
    return this.all(params ?? {});
  }

  listPages(params?: PhotosListParams): AsyncIterable<Page<Photo>> {
    return this.pageIter(params ?? {});
  }

  /** The vendor-filtered page fetcher for a photoable selector. */
  private photoableFetcher(selector: Extract<PhotoSelector, { kind: 'photoable' }>): (page: number, pageSize: number) => Promise<Page<Photo>> {
    const filter: Record<string, unknown> = {
      photoable_type: selector.photoableType,
      photoable_id: selector.photoableId,
    };
    if (selector.folderId !== undefined) filter.folder_id = selector.folderId;
    return this.pageFetcher({}, filter);
  }

  private photoableMatch(selector: Extract<PhotoSelector, { kind: 'photoable' }>): (photo: Photo) => boolean {
    return (photo) =>
      photo.photoable_type === selector.photoableType &&
      photo.photoable_id === selector.photoableId &&
      (selector.folderId === undefined || photo.folder_id === selector.folderId);
  }

  /**
   * Resolve one photo (policy §6).
   *
   * - `{ id }` is fetched directly; an id miss throws `NOT_FOUND` (never `null`).
   * - A `{ photoable_type, photoable_id }` lookup uses the vendor filter, which is
   *   NOT exact: a record can carry several photos. Exactly one match resolves;
   *   several matches throw `RESOLUTION_AMBIGUOUS` with the candidate ids in
   *   `resourceIds`; a truncated scan throws `RESOLUTION_TRUNCATED` (never `null`).
   *   `null` therefore means "a complete bounded scan found no photo for this record".
   * - `photos.findByPhotoable` is the list path when all of a record's photos are wanted.
   */
  async resolve(identifier: number | string | PhotoIdentifier): Promise<PhotoSummary | null>;
  async resolve(identifier: number | string | PhotoIdentifier, opts: { expand: true }): Promise<Photo | null>;
  async resolve(identifier: number | string | PhotoIdentifier, opts: { resolutionDetails: true }): Promise<Resolution<PhotoSummary>>;
  async resolve(
    identifier: number | string | PhotoIdentifier,
    opts?: HelperOptions,
  ): Promise<Photo | PhotoSummary | null | Resolution<PhotoSummary>> {
    const selector = photoSelector(identifier);
    if (selector.kind === 'id') {
      const photo = await this.getOne<Photo>(selector.id);
      const summary = toPhotoSummary(photo);
      if (opts?.resolutionDetails) {
        const resolution: Resolution<PhotoSummary> = {
          value: summary,
          resolutionCost: 'direct',
          scanned: 1,
          scanTruncated: false,
          candidates: [{ id: summary.id, label: `photo ${summary.id} (${summary.caption})` }],
        };
        return resolution;
      }
      return opts?.expand ? photo : summary;
    }

    const fetcher = this.photoableFetcher(selector);
    const match = this.photoableMatch(selector);
    const label = (photo: Photo): string => `photo ${photo.id} (${photo.caption})`;
    const idOf = (photo: Photo): number => photo.id;

    const first = await this.boundedScan<Photo>(fetcher, {
      match,
      label,
      idOf,
      resolutionCost: 'server-filter',
    });
    const found = PhotosResource.requireResolved<Photo>(first, {
      resource: 'photos',
      operation: 'photos.resolve',
      // The photoable is the record this lookup is scoped to: report it as the id.
      identifier: selector.photoableId,
    });
    if (found === null) {
      if (opts?.resolutionDetails) return first;
      return null;
    }

    // The vendor filter is not exact, so a second bounded pass proves the match is
    // unique. A second match is ambiguity, not a resolution.
    const rest = await this.boundedScan<Photo>(fetcher, {
      match: (photo) => match(photo) && photo.id !== found.id,
      label,
      idOf,
      resolutionCost: 'server-filter',
    });
    const other = PhotosResource.requireResolved<Photo>(rest, {
      resource: 'photos',
      operation: 'photos.resolve',
      identifier: selector.photoableId,
    });
    if (other !== null) {
      throw ResolutionError.ambiguous(
        `Several photos are attached to ${selector.photoableType} ${String(selector.photoableId)} ` +
          `(candidate ids: ${found.id}, ${other.id}). The vendor photoable filter cannot disambiguate them; ` +
          'use photos.findByPhotoable for the list, or resolve by { id }.',
        {
          operation: 'photos.resolve',
          resourceIds: [found.id, other.id],
          suggestedAction: 'Pass { id } for one photo, or list them with photos.findByPhotoable(type, id).',
        },
      );
    }

    const summary = toPhotoSummary(found);
    if (opts?.resolutionDetails) {
      const resolution: Resolution<PhotoSummary> = {
        value: summary,
        resolutionCost: 'server-filter',
        scanned: first.scanned,
        scanTruncated: false,
        candidates: [{ id: summary.id, label: label(found) }],
      };
      return resolution;
    }
    return opts?.expand ? found : summary;
  }

  /**
   * All photos attached to one record (policy §9).
   *
   * One bounded vendor-filtered request (`page_size = limit`), so `limit` is a real
   * round-trip cap, never a slice of an unbounded fetch. Default 25, hard maximum
   * 100 (a larger `limit` throws `HuduConfigError`).
   */
  async findByPhotoable(photoableType: string, photoableId: number, opts?: { limit?: number; folderId?: number }): Promise<PhotoSummary[]>;
  async findByPhotoable(photoableType: string, photoableId: number, opts: { limit?: number; folderId?: number; expand: true }): Promise<Photo[]>;
  async findByPhotoable(
    photoableType: string,
    photoableId: number,
    opts?: { limit?: number; folderId?: number; expand?: boolean },
  ): Promise<Photo[] | PhotoSummary[]> {
    if (typeof photoableType !== 'string' || photoableType.length === 0) {
      throw new HuduConfigError('photos.findByPhotoable needs a non-empty photoable_type (e.g. "Company", "Asset", "Article")');
    }
    if (!Number.isInteger(photoableId)) {
      throw new HuduConfigError(`photos.findByPhotoable needs a numeric photoable_id, got "${String(photoableId)}"`);
    }
    const limit = helperLimit(opts?.limit);
    const fetcher = this.photoableFetcher({
      kind: 'photoable',
      photoableType,
      photoableId,
      folderId: opts?.folderId,
    });
    // One request whose page_size IS the limit: the cap costs no extra round trip.
    const page = await fetcher(1, limit);
    const photos = page.items.slice(0, limit);
    return opts?.expand ? photos : photos.map(toPhotoSummary);
  }

  /** Dry-run check: a file was supplied (the spec requires one). */
  private fileCheck(data: PhotoCreate | undefined): DryRunCheck {
    const file = (data ?? ({} as PhotoCreate)).file;
    const ok = file !== undefined && file !== null;
    return { name: 'file-present', ok, detail: ok ? 'image bytes supplied' : 'no image file was supplied' };
  }

  /** Dry-run check: a caption was supplied (the spec requires one). */
  private captionCheck(data: PhotoCreate | undefined): DryRunCheck {
    const caption = (data ?? ({} as PhotoCreate)).caption;
    const ok = typeof caption === 'string' && caption.length > 0;
    return { name: 'caption-present', ok, detail: ok ? 'caption supplied' : 'caption is required by the API spec' };
  }

  /** Dry-run check: photoable_type and photoable_id are supplied together or not at all. */
  private photoablePairCheck(data: PhotoCreate | undefined): DryRunCheck {
    const photo = (data ?? ({} as PhotoCreate));
    const hasType = typeof photo.photoable_type === 'string' && photo.photoable_type.length > 0;
    const hasId = typeof photo.photoable_id === 'number';
    const ok = hasType === hasId;
    return {
      name: 'photoable-pair',
      ok,
      detail: ok
        ? hasType
          ? `photoable ${String(photo.photoable_type)}:${String(photo.photoable_id)}`
          : 'photo is not attached to a photoable record'
        : 'photoable_type and photoable_id must be supplied together',
    };
  }

  /**
   * Create a new Photo (multipart; `file` and `caption` are required by the spec).
   *
   * `{ dryRun: true }` validates the multipart inputs and returns a
   * `DryRunResult<Photo>` with `simulated: true`; it never builds the multipart body
   * and never issues a POST (policy §7.2).
   *
   * There is NO stale guard on this path: a create has no prior revision that could
   * have moved on, so the plan records `staleCheck: "unavailable"` for it and an
   * `expectedUpdatedAt` passed here has no effect (the guard lives on `update`, whose
   * row records `staleCheck: "updated_at"`).
   */
  async create(data: PhotoCreate): Promise<Photo>;
  async create(data: PhotoCreate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Photo>>;
  async create(data: PhotoCreate, opts: MutationOptions & { dryRun?: false }): Promise<Photo>;
  async create(data: PhotoCreate, opts: MutationOptions | undefined): Promise<Photo | DryRunResult<Photo>>;
  async create(data: PhotoCreate, opts?: MutationOptions): Promise<Photo | DryRunResult<Photo>> {
    const operation = 'photos.create';
    this.refuseGuardOutsideUpdate(operation, opts);
    if (opts?.dryRun) {
      return this.buildDryRunResult<Photo>({
        operation,
        method: 'POST',
        path: '/photos',
        checks: [this.fileCheck(data), this.captionCheck(data), this.photoablePairCheck(data)],
        affected: 1,
        scope: 'single',
        reversible: true,
        warnings: [
          'dry-run validates the multipart inputs without building or sending the body, so the server-computed ' +
            'photo record (id, url, created_at, updated_at) cannot be promised',
        ],
      });
    }
    const fd = new FormData();
    fd.append('file', data.file);
    fd.append('caption', data.caption);
    for (const k of ['company_id', 'photoable_type', 'photoable_id', 'folder_id', 'pinned'] as const) {
      const v = data[k];
      if (v !== undefined) fd.append(k, String(v));
    }
    const body = await this.http.request<unknown>({
      method: 'POST',
      path: '/photos',
      formData: fd,
      operation,
      ...(typeof data.photoable_id === 'number' ? { resourceIds: [data.photoable_id] } : {}),
    });
    return this.unwrapSingle<Photo>(body);
  }

  /**
   * Update a Photo. The body is wrapped in a `photo` key (spec, B7) and the response
   * is unwrapped by `singleKey`.
   *
   * `{ dryRun: true }` describes the PUT and returns a `DryRunResult<Photo>` without
   * issuing it; `{ expectedUpdatedAt }` enables the opt-in stale guard (a mismatch
   * throws `STALE_OBJECT` before the PUT).
   */
  async update(id: number, data: PhotoUpdate): Promise<Photo>;
  async update(id: number, data: PhotoUpdate, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<Photo>>;
  async update(id: number, data: PhotoUpdate, opts: MutationOptions & { dryRun?: false }): Promise<Photo>;
  async update(id: number, data: PhotoUpdate, opts: MutationOptions | undefined): Promise<Photo | DryRunResult<Photo>>;
  async update(id: number, data: PhotoUpdate, opts?: MutationOptions): Promise<Photo | DryRunResult<Photo>> {
    return this.updateOne<Photo>(id, { photo: data }, undefined, opts);
  }

  /**
   * Delete a Photo.
   *
   * `{ dryRun: true }` describes the delete and issues NO request at all.
   *
   * There is NO stale guard on this path: a delete is bounded by the explicit id and
   * the vendor exposes no conditional delete, so the plan records
   * `staleCheck: "unavailable"` for it.
   */
  async delete(id: number): Promise<void>;
  async delete(id: number, opts: MutationOptions & { dryRun: true }): Promise<DryRunResult<void>>;
  async delete(id: number, opts: MutationOptions & { dryRun?: false }): Promise<void>;
  async delete(id: number, opts: MutationOptions | undefined): Promise<void | DryRunResult<void>>;
  async delete(id: number, opts?: MutationOptions): Promise<void | DryRunResult<void>> {
    this.refuseGuardOutsideUpdate('photos.delete', opts);
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
