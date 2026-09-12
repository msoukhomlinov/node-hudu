/**
 * UsersResource — Hudu "users" resource.
 *
 * Agent-execution-layer tier (policy §5-§9): `resolve`, `findByEmail` and `search`,
 * all returning the compact `UserSummary` unless `expand: true` is passed. The vendor
 * exposes no user create/update/delete, so this resource is read-only.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import { HuduConfigError, ResolutionError } from '../errors.js';
import type { Resolution } from '../types/common.js';
import type { User } from '../types/index.js';
import type { UserIdentifier, UserSummary } from '../types/user.js';

export interface UsersListParams extends ListParams {
  first_name?: string;
  last_name?: string;
  search?: string;
  portal_member_company_id?: number;
  archived?: boolean;
  email?: string;
  security_level?: string;
}

/**
 * Options for the single-record users helpers (`resolve`, `findByEmail`): the
 * compact/full switch and the `Resolution` wrapper. There is deliberately no `limit`:
 * both return ONE record, and the scan's page size comes from the client's bounded-scan
 * config.
 */
export interface UsersLookupOptions {
  expand?: boolean;
  resolutionDetails?: boolean;
}

/**
 * Options for `search` (policy §9): a bounded row cap plus the vendor narrowing filters.
 * `search` returns an ARRAY, so no `Resolution` wrapper is offered — a `Resolution<T>`
 * around a list has no single value to report.
 */
export interface UsersSearchOptions {
  limit?: number;
  archived?: boolean;
  security_level?: string;
  expand?: boolean;
}

/** Helper-tier row cap: default 25, hard maximum 100 (policy §9). */
const DEFAULT_HELPER_LIMIT = 25;
const MAX_HELPER_LIMIT = 100;

function helperLimit(requested: number | undefined): number {
  const limit = requested ?? DEFAULT_HELPER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HuduConfigError(`limit must be a positive integer, got "${String(requested)}"`);
  }
  if (limit > MAX_HELPER_LIMIT) {
    throw new HuduConfigError(`limit must be <= ${MAX_HELPER_LIMIT} for the helper tier, got ${limit}`);
  }
  return limit;
}

/**
 * Read the id/email/slug/name a caller supplied, without guessing a kind the vendor
 * cannot support. A bare non-numeric string is `bare`, which resolve reads as
 * email, then slug, then the exact name.
 */
interface UserRef {
  id?: number;
  email?: string;
  slug?: string;
  name?: string;
  bare?: string;
}

function readUserIdentifier(identifier: number | string | UserIdentifier): UserRef {
  if (typeof identifier === 'number') return { id: identifier };
  if (typeof identifier === 'string') {
    return /^\d+$/.test(identifier.trim()) ? { id: Number(identifier.trim()) } : { bare: identifier };
  }
  return { id: identifier.id, email: identifier.email, slug: identifier.slug, name: identifier.name };
}

/** Email compare: exact, but case-insensitive (the vendor stores and returns lower case). */
function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The display name a user resolves by: "First Last". */
function fullName(user: User): string {
  return `${user.first_name} ${user.last_name}`.trim();
}

/** Compact projection: keeps what an agent needs, drops the rest of the record. */
function toUserSummary(user: User): UserSummary {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    slug: user.slug,
    security_level: user.security_level,
    archived: user.archived,
    portal_member_company_id: user.portal_member_company_id,
    updated_at: user.updated_at,
  };
}

/** Map a resolution's value through a projection, keeping cost/scanned/candidates. */
function projectResolution<T, S>(resolution: Resolution<T>, project: (item: T) => S): Resolution<S> {
  return { ...resolution, value: resolution.value === null ? null : project(resolution.value) };
}

export class UsersResource extends BaseResource<User> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'users', singleKey: undefined, listKey: undefined, createType: 'raw', paginated: true });
  }

  /** Get a users by id. */
  async get(id: number): Promise<User> {
    return this.getOne<User>(id);
  }
  /** Stream users across pages. */
  list(params?: UsersListParams): AsyncIterable<User> {
    return this.items(params ?? {});
  }
  /** Get every users. MCP-preferred read. */
  async listAll(params?: UsersListParams): Promise<User[]> {
    return this.all(params ?? {});
  }

  listPages(params?: UsersListParams): AsyncIterable<Page<User>> {
    return this.pageIter(params ?? {});
  }

  // ---------------------------------------------------------------------------
  // Helper tier (policy §6, §9). Compact shape: UserSummary.
  // ---------------------------------------------------------------------------

  /**
   * Resolve a user from an id, their exact email, their slug or their exact name.
   *
   * Bare values are read in the documented order: numeric id, exact email, slug,
   * exact name. `{ id }` resolves directly and a miss throws NOT_FOUND — never null.
   * `null` means every stage completed a scan and found nothing; a stage the cap
   * stopped throws RESOLUTION_TRUNCATED. Several exact matches throw
   * RESOLUTION_AMBIGUOUS with the candidate ids.
   */
  async resolve(identifier: number | string | UserIdentifier): Promise<UserSummary | null>;
  async resolve(identifier: number | string | UserIdentifier, opts: { expand: true }): Promise<User | null>;
  async resolve(
    identifier: number | string | UserIdentifier,
    opts: { resolutionDetails: true },
  ): Promise<Resolution<UserSummary>>;
  async resolve(
    identifier: number | string | UserIdentifier,
    opts?: UsersLookupOptions,
  ): Promise<User | UserSummary | null | Resolution<UserSummary>>;
  async resolve(
    identifier: number | string | UserIdentifier,
    opts: UsersLookupOptions = {},
  ): Promise<User | UserSummary | null | Resolution<UserSummary>> {
    const operation = 'users.resolve';
    const ref = readUserIdentifier(identifier);
    if (ref.id !== undefined) {
      const record = await this.get(ref.id);
      const delivered = opts.expand ? record : toUserSummary(record);
      if (opts.resolutionDetails) {
        return { value: delivered, resolutionCost: 'direct', scanned: 1, scanTruncated: false };
      }
      return delivered;
    }
    const stages: Array<['email' | 'slug' | 'name', string]> = [];
    if (typeof ref.bare === 'string') {
      stages.push(['email', ref.bare], ['slug', ref.bare], ['name', ref.bare]);
    } else if (typeof ref.email === 'string') {
      stages.push(['email', ref.email]);
    } else if (typeof ref.slug === 'string') {
      stages.push(['slug', ref.slug]);
    } else if (typeof ref.name === 'string') {
      stages.push(['name', ref.name]);
    }
    if (stages.length === 0) {
      throw new HuduConfigError(
        'users.resolve accepts a numeric id, an email, a slug, an exact name, { id }, { email }, { slug } or { name }; ' +
          `${JSON.stringify(identifier)} matches none`,
      );
    }
    let resolution: Resolution<User> | undefined;
    let scanned = 0;
    for (const [kind, value] of stages) {
      const attempt = await this.scanBy(kind, value, operation);
      scanned += attempt.scanned;
      // A truncated attempt is undecided — never treat it as a miss for the next stage.
      if (attempt.value !== null || attempt.scanTruncated) {
        resolution = attempt;
        break;
      }
    }
    const found: Resolution<User> =
      resolution ?? { value: null, resolutionCost: 'server-filter', scanned, scanTruncated: false };
    if (opts.resolutionDetails) {
      return opts.expand ? found : projectResolution(found, toUserSummary);
    }
    const value = BaseResource.requireResolved<User>(found, {
      resource: this.resourcePath,
      operation,
      identifier: ref.id ?? ref.email ?? ref.slug ?? ref.name,
    });
    return value === null ? null : opts.expand ? value : toUserSummary(value);
  }

  /**
   * Find one user by their exact email address (vendor `email` filter + exact compare).
   * `null` only after a complete scan; RESOLUTION_AMBIGUOUS when the filter is not unique.
   */
  async findByEmail(email: string, opts?: { expand?: false }): Promise<UserSummary | null>;
  async findByEmail(email: string, opts: { expand: true }): Promise<User | null>;
  async findByEmail(email: string, opts: { resolutionDetails: true }): Promise<Resolution<UserSummary>>;
  async findByEmail(
    email: string,
    opts?: UsersLookupOptions,
  ): Promise<User | UserSummary | null | Resolution<UserSummary>>;
  async findByEmail(
    email: string,
    opts: UsersLookupOptions = {},
  ): Promise<User | UserSummary | null | Resolution<UserSummary>> {
    const operation = 'users.findByEmail';
    const found = await this.scanUnique<User>(
      this.pageFetcher({ email }),
      (item) => sameEmail(item.email, email),
      (item) => `user "${item.email}"`,
      operation,
      `several users share the email "${email}"`,
    );
    if (opts.resolutionDetails) {
      return opts.expand ? found : projectResolution(found, toUserSummary);
    }
    const value = BaseResource.requireResolved<User>(found, {
      resource: this.resourcePath,
      operation,
      identifier: email,
    });
    return value === null ? null : opts.expand ? value : toUserSummary(value);
  }

  /**
   * Search users by a free-text query (vendor `search`, optionally narrowed by
   * `archived` / `security_level`). Returns UserSummary records; limit defaults to 25
   * and is capped at 100.
   */
  async search(query: string, opts?: UsersSearchOptions & { expand?: false }): Promise<UserSummary[]>;
  async search(query: string, opts: UsersSearchOptions & { expand: true }): Promise<User[]>;
  async search(query: string, opts: UsersSearchOptions | undefined): Promise<User[] | UserSummary[]>;
  async search(query: string, opts: UsersSearchOptions = {}): Promise<User[] | UserSummary[]> {
    const limit = helperLimit(opts.limit);
    const filters: Record<string, unknown> = { search: query };
    if (opts.archived !== undefined) filters.archived = opts.archived;
    if (opts.security_level !== undefined) filters.security_level = opts.security_level;
    // One page of exactly `limit` rows: the helper never pulls more than the caller asked for.
    const page = await this.pageFetcher({ ...filters, page_size: limit })(1, limit);
    const items = page.items.slice(0, limit);
    return opts.expand ? items : items.map(toUserSummary);
  }

  /** One bounded, vendor-filtered stage of the resolve lookup. */
  private async scanBy(kind: 'email' | 'slug' | 'name', value: string, operation: string): Promise<Resolution<User>> {
    const filter = kind === 'email' ? { email: value } : { search: value };
    return this.scanUnique<User>(
      this.pageFetcher(filter),
      (item) =>
        kind === 'email' ? sameEmail(item.email, value) : kind === 'slug' ? item.slug === value : fullName(item) === value,
      (item) => (kind === 'email' ? `user "${item.email}"` : `user "${fullName(item)}"`),
      operation,
      `several users match ${kind} "${value}"`,
    );
  }

  /**
   * One bounded, vendor-filtered exact-match scan plus a bounded uniqueness pass.
   *
   * `boundedScan` returns the FIRST match, so a second pass over the same filter is
   * what proves the match is unique; a second match is RESOLUTION_AMBIGUOUS with both
   * candidate ids. Both passes are bounded (500 records / 4 pages by default).
   */
  private async scanUnique<U extends { id: number }>(
    fetchPage: (page: number, pageSize: number) => Promise<Page<U>>,
    match: (item: U) => boolean,
    label: (item: U) => string,
    operation: string,
    ambiguity: string,
  ): Promise<Resolution<U>> {
    const idOf = (item: U): number => item.id;
    const first = await this.boundedScan<U>(fetchPage, {
      match,
      label,
      idOf,
      resolutionCost: 'server-filter',
    });
    if (first.value === null) return first;
    const firstId = idOf(first.value);
    const rest = await this.boundedScan<U>(fetchPage, {
      match: (item) => idOf(item) !== firstId && match(item),
      label,
      idOf,
      resolutionCost: 'server-filter',
    });
    if (rest.value !== null) {
      throw ResolutionError.ambiguous(`${operation}: ${ambiguity} (ids ${firstId}, ${idOf(rest.value)}).`, {
        operation,
        resourceIds: [firstId, idOf(rest.value)],
      });
    }
    if (rest.scanTruncated) {
      // The uniqueness pass hit its cap: "no second match" is undecided, never a null.
      return {
        value: null,
        resolutionCost: 'server-filter',
        scanned: first.scanned + rest.scanned,
        scanTruncated: true,
      };
    }
    return { ...first, scanned: first.scanned + rest.scanned };
  }
}
