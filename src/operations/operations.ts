/**
 * Operations — the cross-resource helpers `searchAcrossResources` and `resolveAny`
 * (agent-execution-layer policy §4.1, §5, §6, §9, §10).
 *
 * These are the SDK's only two helpers that span resources. They exist because an agent that does
 * not know WHICH resource holds a record otherwise has to search one resource at a time, guess the
 * resource type, and reason about paging; and because the obvious caller-side implementation is an
 * unbounded `Promise.all` over eight resources, which the concurrency rule forbids.
 *
 * Both helpers delegate every real unit of work to the resource instances: each resource's own
 * `search` / `resolve` owns the vendor filter, the bounded scan (`BaseResource.boundedScan`), the
 * helper limit rule (25 default / 100 maximum) and the envelope handling. Nothing in this module
 * re-implements transport, scanning or limits; it composes, bounds the fan-out, and reports what
 * actually happened. Neither helper can issue a write: the only resource methods they call are
 * `search` and `resolve`, both reads.
 *
 * ```ts
 * import { HuduClient } from 'node-hudu';
 * import { Operations } from 'node-hudu/operations';
 *
 * const hudu = new HuduClient({ baseUrl, apiKey });
 * const ops = new Operations(hudu);
 *
 * const hits = await ops.searchAcrossResources('acme');          // compact summaries
 * const { hits: candidates, truncated } = await ops.resolveAny('acme.com');
 * ```
 */
import type { HuduClient } from '../client.js';
import { HuduConfigError, NotFoundError, ResolutionError } from '../errors.js';
import { helperLimit } from '../resources/agent-layer-helpers.js';
import type { CompanySummary } from '../types/company.js';
import type { ArticleSummary } from '../types/article.js';
import type { AssetSummary } from '../types/asset.js';
import type { AssetPasswordSummary } from '../types/asset_password.js';
import type { PasswordFolderSummary } from '../types/password_folder.js';
import type { GroupSummary } from '../types/group.js';
import type { UserSummary } from '../types/user.js';
import type { WebsiteSummary } from '../types/website.js';
import type { HelperOptions, Identifier, IdentifierObject, Resolution } from '../types/common.js';
import type { Page } from '../pagination.js';
import type { KnowledgeSearchOptions, KnowledgeSearchResult } from '../types/search_knowledge.js';
import { KnowledgeSearchEngine, type EngineConfig } from '../search/engine.js';
import type {
  ResolveAnyOptions,
  ResolveAnyResult,
  ResolutionCandidateHit,
  SearchAcrossResourcesOptions,
  SearchHit,
  SearchHitExpanded,
  SearchHitExpandedUnion,
  SearchHitUnion,
  SearchableRecord,
  SearchableResource,
  SearchableRow,
  SearchableSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// The eight resources, and the helper of each that this module composes.
// ---------------------------------------------------------------------------

/** One resource's helper-tier `search`, normalised to the shape the caller asked for (§9). */
interface SearchHelper {
  /** Compact rows — the resource's own `search` default. */
  compact(client: HuduClient, query: string, limit: number): Promise<SearchableSummary[]>;
  /** The full typed records (`expand: true`). */
  expanded(client: HuduClient, query: string, limit: number): Promise<SearchableRecord[]>;
}

/**
 * The compact `search(query, { limit })` signature of `websites`, `groups` and `password_folders`.
 *
 * Those three declare that form as their IMPLEMENTATION signature (`search(query, opts?: HelperOptions)`
 * with a body) instead of as an overload, so their callable overload set accepts only
 * `{ expand: true, ... }` as a second argument: `websites.search(q, { limit })` does not typecheck
 * even though the runtime path (`opts?.expand ? rows : rows.map(toSummary)`) is exactly the
 * documented compact one, and their own tests call it that way. The cast below restores the call the
 * method already supports — it changes no behaviour, no request and no returned shape. The missing
 * overload belongs to those resource files, which this module does not own; it is reported to the
 * coordinator.
 */
type CompactSearch = (query: string, opts: HelperOptions) => Promise<unknown>;

/**
 * `search` of every searchable resource. This table is the whole fan-out surface: a resource that
 * is not a key here cannot be named, and no `listAll`/`list` primitive appears anywhere in it
 * (policy §5: the helper tier is the read path, an unbounded list walk is not).
 *
 * The insertion order is the documented fan-out order of both helpers.
 */
const SEARCH_HELPERS: { [K in SearchableResource]: SearchHelper } = {
  companies: {
    compact: (client, query, limit) => rowsOf<CompanySummary>(client.companies.search(query, { limit })),
    expanded: (client, query, limit) => client.companies.search(query, { limit, expand: true }),
  },
  articles: {
    compact: (client, query, limit) => rowsOf<ArticleSummary>(client.articles.search(query, { limit })),
    expanded: (client, query, limit) => client.articles.search(query, { limit, expand: true }),
  },
  assets: {
    compact: (client, query, limit) => rowsOf<AssetSummary>(client.assets.search(query, { limit })),
    expanded: (client, query, limit) => client.assets.search(query, { limit, expand: true }),
  },
  websites: {
    compact: (client, query, limit) => rowsOf<WebsiteSummary>((client.websites.search as CompactSearch)(query, { limit })),
    expanded: (client, query, limit) => client.websites.search(query, { limit, expand: true }),
  },
  asset_passwords: {
    compact: (client, query, limit) => rowsOf<AssetPasswordSummary>(client.assetPasswords.search(query, { limit })),
    expanded: (client, query, limit) => client.assetPasswords.search(query, { limit, expand: true }),
  },
  password_folders: {
    compact: (client, query, limit) => rowsOf<PasswordFolderSummary>((client.passwordFolders.search as CompactSearch)(query, { limit })),
    expanded: (client, query, limit) => client.passwordFolders.search(query, { limit, expand: true }),
  },
  groups: {
    compact: (client, query, limit) => rowsOf<GroupSummary>((client.groups.search as CompactSearch)(query, { limit })),
    expanded: (client, query, limit) => client.groups.search(query, { limit, expand: true }),
  },
  users: {
    compact: (client, query, limit) => rowsOf<UserSummary>(client.users.search(query, { limit })),
    expanded: (client, query, limit) => client.users.search(query, { limit, expand: true }),
  },
};

/** Every resource a cross-resource helper accepts: the keys of the fan-out table, by construction. */
const SUPPORTED_RESOURCES: SearchableResource[] = Object.keys(SEARCH_HELPERS) as SearchableResource[];

/** The supported set as it is named in a `CONFIG_ERROR` message. */
const SUPPORTED_LIST = SUPPORTED_RESOURCES.map((name) => `"${name}"`).join(', ');

/** One resource's `resolve`, called with `{ resolutionDetails: true }` so the caller sees candidates. */
type ResolveHelper = (
  client: HuduClient,
  identifier: Identifier,
  opts: HelperOptions,
) => Promise<Resolution<SearchableSummary>>;

/** `resolve` of every searchable resource: the whole surface `resolveAny` can reach (policy §6). */
const RESOLVE_HELPERS: { [K in SearchableResource]: ResolveHelper } = {
  companies: (client, identifier, opts) => resolutionOf<CompanySummary>('operations.resolveAny', client.companies.resolve(identifier, opts)),
  articles: (client, identifier, opts) => resolutionOf<ArticleSummary>('operations.resolveAny', client.articles.resolve(identifier, opts)),
  assets: (client, identifier, opts) => resolutionOf<AssetSummary>('operations.resolveAny', client.assets.resolve(identifier, opts)),
  websites: (client, identifier, opts) => resolutionOf<WebsiteSummary>('operations.resolveAny', client.websites.resolve(identifier, opts)),
  asset_passwords: (client, identifier, opts) => resolutionOf<AssetPasswordSummary>('operations.resolveAny', client.assetPasswords.resolve(identifier, opts)),
  password_folders: (client, identifier, opts) => resolutionOf<PasswordFolderSummary>('operations.resolveAny', client.passwordFolders.resolve(identifier, opts)),
  groups: (client, identifier, opts) => resolutionOf<GroupSummary>('operations.resolveAny', client.groups.resolve(identifier, opts)),
  users: (client, identifier, opts) => resolutionOf<UserSummary>('operations.resolveAny', client.users.resolve(identifier, opts)),
};

// ---------------------------------------------------------------------------
// Shared plumbing (composition only — no transport, no scanning, no limits).
// ---------------------------------------------------------------------------

/**
 * Keep the rows of a helper whose overload set returns a union: the shape was chosen explicitly by
 * this module (`compact` vs `expanded`), so the narrowing is the caller's own contract, not a guess.
 */
async function rowsOf<T>(rows: Promise<unknown>): Promise<T[]> {
  return (await rows) as T[];
}

/** True for the `Resolution<T>` wrapper `resolve(identifier, { resolutionDetails: true })` returns. */
function isResolution(value: unknown): value is Resolution<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'resolutionCost' in value &&
    'scanned' in value &&
    'scanTruncated' in value
  );
}

/**
 * Extract the `Resolution<T>` a resource's `resolve` returned.
 *
 * The loose `HelperOptions` overload is the one a variable-typed option bag matches, so the call
 * returns a union and this wrapper narrows it at runtime. A resource that ignored
 * `{ resolutionDetails: true }` would silently turn a real match into "no candidate", which is the
 * one failure a cross-resource resolver must never make — so it is an error, not a quiet miss.
 */
async function resolutionOf<T>(operation: string, call: Promise<unknown>): Promise<Resolution<T>> {
  const value = await call;
  if (!isResolution(value)) {
    throw new HuduConfigError(
      `${operation}: the resource did not return a resolution for { resolutionDetails: true }, so ` +
        'cross-resource candidates cannot be reported honestly.',
    );
  }
  return value as Resolution<T>;
}

/**
 * Human-readable label for one matched row: the record's `name`, else a user's `email`, else its id.
 * Every compact shape keeps `id`; only the label is derived, and nothing is invented.
 */
function labelOf(item: SearchableRow): string {
  const row: { id: number; name?: unknown; email?: unknown } = item;
  if (typeof row.name === 'string' && row.name.length > 0) return row.name;
  if (typeof row.email === 'string' && row.email.length > 0) return row.email;
  return `#${row.id}`;
}

/**
 * Bounded-parallelism fan-out over the requested resources (policy §10): at most `concurrency`
 * helper calls in flight (default 4, from the client configuration), order preserved, never an
 * unbounded `Promise.all` over the resource list.
 *
 * This is the only parallel primitive the module owns. It mirrors `BaseResource.mapConcurrent`,
 * which is `protected` and therefore unreachable from a cross-resource module; the *work* it
 * schedules stays entirely inside each resource's own plumbing.
 */
async function boundedMap<X, Y>(
  items: readonly X[],
  concurrency: number,
  fn: (item: X) => Promise<Y>,
): Promise<Y[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<Y>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as X);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/**
 * Validate the requested resource set and return it in fan-out order, without duplicates.
 *
 * An unknown name is rejected with `CONFIG_ERROR` naming the supported set: skipping it would turn
 * "you asked for a resource the SDK cannot search" into "that resource has no match", which is the
 * silent lie policy §6 forbids for resolution.
 */
function requireResources(requested: SearchableResource[] | undefined, operation: string): SearchableResource[] {
  if (requested === undefined) return [...SUPPORTED_RESOURCES];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new HuduConfigError(
      `${operation}: resources must be a non-empty array of resource names; supported: ${SUPPORTED_LIST}`,
    );
  }
  const unsupported = requested.filter((name) => !SUPPORTED_RESOURCES.includes(name));
  if (unsupported.length > 0) {
    throw new HuduConfigError(
      `${operation}: unsupported resource name(s) ${unsupported.map((name) => JSON.stringify(name)).join(', ')}; ` +
        `supported: ${SUPPORTED_LIST}`,
    );
  }
  return [...new Set(requested)];
}

/** The numeric id a definite identifier names, or undefined when the identifier is a name/domain. */
function definiteId(identifier: Identifier): number | undefined {
  if (typeof identifier === 'number') {
    return Number.isInteger(identifier) && identifier > 0 ? identifier : undefined;
  }
  if (typeof identifier === 'string') {
    const text = identifier.trim();
    return /^\d+$/.test(text) ? Number(text) : undefined;
  }
  if (typeof identifier === 'object' && identifier !== null) {
    const id = (identifier as IdentifierObject).id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

/** What one resource contributed to `resolveAny`. */
interface ResolveOutcome {
  resource: SearchableResource;
  hits: ResolutionCandidateHit[];
  /** True when a cap stopped this resource's scan before its data ran out. */
  truncated: boolean;
  /** Records the resource reported examining; a definite id it does not hold counts as 1. */
  scanned: number;
}

/**
 * Resolve the identifier against one resource and report honestly what happened.
 *
 * - a decided match becomes one candidate;
 * - several matches inside the resource (`RESOLUTION_AMBIGUOUS`) become one candidate per reported
 *   id — the resource could not choose, so the choice goes back to the caller instead of failing
 *   the whole cross-resource call;
 * - a scan stopped by the cap (`RESOLUTION_TRUNCATED`) is reported as truncated, never as "not found";
 * - a complete scan that found nothing contributes nothing;
 * - a `NOT_FOUND` for a definite id is that resource missing the id, not a failed call.
 *
 * Every other error (transport, rate limit, bad request) propagates: it is not a resolution answer.
 */
async function resolveOutcome(
  resource: SearchableResource,
  client: HuduClient,
  identifier: Identifier,
  opts: HelperOptions,
  definite: boolean,
): Promise<ResolveOutcome> {
  try {
    const resolution = await RESOLVE_HELPERS[resource](client, identifier, opts);
    const candidates: ResolutionCandidateHit[] = [];
    const value = resolution.value;
    if (resolution.scanTruncated) {
      return { resource, hits: candidates, truncated: true, scanned: resolution.scanned };
    }
    if (value !== null) {
      const reported = resolution.candidates?.[0]?.label;
      candidates.push({ resource, id: value.id, label: reported ?? labelOf(value), item: value });
      return { resource, hits: candidates, truncated: false, scanned: resolution.scanned };
    }
    for (const candidate of resolution.candidates ?? []) {
      candidates.push({ resource, id: candidate.id, label: candidate.label, item: null });
    }
    return { resource, hits: candidates, truncated: false, scanned: resolution.scanned };
  } catch (error) {
    if (error instanceof ResolutionError && error.code === 'RESOLUTION_TRUNCATED') {
      // A cap stopped the scan before the data ran out: undecided, and never reported as not-found.
      return { resource, hits: [], truncated: true, scanned: 0 };
    }
    if (error instanceof ResolutionError) {
      // The resource matched several records and could not choose. Those ids ARE the matches, so
      // they become candidates instead of failing the whole cross-resource call.
      const ids = error.resourceIds ?? [];
      return {
        resource,
        hits: ids.map((id) => ({ resource, id, label: `#${id}`, item: null })),
        truncated: false,
        scanned: 0,
      };
    }
    if (error instanceof NotFoundError) {
      return { resource, hits: [], truncated: false, scanned: definite ? 1 : 0 };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The cross-resource helpers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The knowledge search engine (fuzzy, relevance-ranked, body-aware).
// ---------------------------------------------------------------------------

/**
 * One engine per client, held in memory for the client's lifetime (the design forbids an on-disk
 * cache: KB content is customer data). Keyed by the client object, so two clients on two tenants
 * never share an index.
 */
const KNOWLEDGE_ENGINES = new WeakMap<HuduClient, KnowledgeSearchEngine>();

/** Build the engine for a client from the client's own `config.search` bounds. */
function knowledgeEngine(client: HuduClient): KnowledgeSearchEngine {
  const existing = KNOWLEDGE_ENGINES.get(client);
  if (existing !== undefined) return existing;
  const cfg = client.config.search;
  const engineConfig: Partial<EngineConfig> = {
    bounds: { maxDocBytes: cfg.maxDocBytes, maxIndexTextBytes: cfg.maxIndexTextBytes, maxDocs: cfg.maxDocs },
    ttlMs: cfg.indexTtlMs,
    fullRefreshEvery: cfg.fullRefreshEvery,
    pageSize: cfg.indexPageSize,
    maxIndexPages: cfg.maxIndexPages,
    maxDocsScored: cfg.maxDocsScored,
    maxResponseBytes: cfg.maxResponseBytes,
    fuzzyBody: cfg.fuzzyBody,
  };
  const engine = new KnowledgeSearchEngine(
    {
      listArticlePages: (params) =>
        client.articles.listPages(params) as AsyncIterable<Page<Record<string, unknown>>>,
      listAssetPages: (params) =>
        client.assets.listAcrossCompaniesPages(params) as AsyncIterable<Page<Record<string, unknown>>>,
      vendorSearch: async (resource, query, limit) => {
        const rows = await SEARCH_HELPERS[resource as SearchableResource].compact(client, query, limit);
        return rows.map((item) => ({
          id: item.id,
          label: labelOf(item),
          item: item as unknown as Record<string, unknown>,
        }));
      },
    },
    engineConfig,
  );
  KNOWLEDGE_ENGINES.set(client, engine);
  return engine;
}

/**
 * Cross-resource read helpers. Construct one per client: `new Operations(hudu)`.
 *
 * Both methods are reads. Neither can issue a write, and neither walks an unbounded list.
 */
export class Operations {
  private readonly client: HuduClient;

  constructor(client: HuduClient) {
    this.client = client;
  }

  /** The client's bounded-parallelism setting (`concurrency`, default 4). */
  private get concurrency(): number {
    return this.client.config.concurrency;
  }

  /** Search every requested resource: the discriminated union, so `hit.resource` narrows `hit.item`. */
  async searchAcrossResources(query: string): Promise<SearchHitUnion[]>;
  /** `expand: true` returns the full typed records instead of the compact summaries. */
  async searchAcrossResources(
    query: string,
    opts: SearchAcrossResourcesOptions & { expand: true },
  ): Promise<SearchHitExpandedUnion[]>;
  /** The option bag held in a variable: the caller narrows the result. */
  async searchAcrossResources(
    query: string,
    opts: SearchAcrossResourcesOptions & { expand?: false },
  ): Promise<SearchHitUnion[]>;
  async searchAcrossResources(
    query: string,
    opts?: SearchAcrossResourcesOptions,
  ): Promise<SearchHit[] | SearchHitExpanded[]>;
  /**
   * Search several Hudu resources for one query in a single bounded call (policy §5/§9).
   *
   * Each requested resource runs its OWN helper-tier `search` (the vendor `search` filter, one
   * bounded page per resource); this method never calls `listAll` or a list primitive, and never
   * hand-rolls a request. The fan-out runs at most `concurrency` resources at a time (default 4,
   * from the client configuration).
   *
   * `resources` defaults to all eight searchable resources — `companies`, `articles`, `assets`,
   * `websites`, `asset_passwords`, `password_folders`, `groups`, `users` — in that order; an
   * unknown name throws `HuduConfigError` (`CONFIG_ERROR`) naming the supported set. `limit` is
   * per resource: default 25, maximum 100, and a larger value throws rather than silently clamping.
   * Results are compact summaries in resource order; `expand: true` returns the full records.
   *
   * `preferredWhen`: use this instead of calling several resources' `search` yourself whenever you
   * do not know which resource holds the record.
   */
  async searchAcrossResources(
    query: string,
    opts?: SearchAcrossResourcesOptions,
  ): Promise<SearchHit[] | SearchHitExpanded[]> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HuduConfigError('operations.searchAcrossResources requires a non-empty query');
    }
    const limit = helperLimit(opts?.limit, 'operations.searchAcrossResources');
    const resources = requireResources(opts?.resources, 'operations.searchAcrossResources');
    if (opts?.expand === true) {
      const rows = await boundedMap(resources, this.concurrency, async (resource) => ({
        resource,
        items: await SEARCH_HELPERS[resource].expanded(this.client, query, limit),
      }));
      return rows.flatMap(({ resource, items }) =>
        items.map((item): SearchHitExpanded => ({ resource, id: item.id, label: labelOf(item), item })),
      );
    }
    const rows = await boundedMap(resources, this.concurrency, async (resource) => ({
      resource,
      items: await SEARCH_HELPERS[resource].compact(this.client, query, limit),
    }));
    return rows.flatMap(({ resource, items }) =>
      items.map((item): SearchHit => ({ resource, id: item.id, label: labelOf(item), item })),
    );
  }

  /**
   * Search the knowledge base for a free-text query, ranked, with verbatim snippets.
   *
   * Content-first: KB articles are ranked ahead of assets by resource prior, but a precise asset
   * hit (a serial or a custom-field value) still outranks a weak article body hit. Matching is
   * token-based, order-free, accent-folded and typo-tolerant — the three things Hudu's own
   * `search` demonstrably lacks (it is a case-insensitive CONTIGUOUS SUBSTRING over article TITLES
   * only, and it never reaches article body content).
   *
   * Tiers: with a warm index the answer is the body index UNIONed with Hudu's search (so a record
   * written a second ago still surfaces); with a cold client it is Hudu's search re-ranked locally,
   * and the response says so through `meta.degraded` — article body terms were NOT searched, which
   * is why an empty result from a body-blind search carries `degraded: { reason: 'body-not-indexed' }`
   * rather than a bare empty list.
   *
   * Every bound that bites is named in `meta.reasons[]` and sets `meta.complete: false`; one
   * resource failing becomes an entry in `meta.errors[]` instead of losing the whole call; and
   * `meta.scoreScope` says whether the scores may be compared across resources.
   *
   * Returns snippets plus a `fetch` call per hit: the full record is one `articles.get` (or
   * `assets.get`) away, because a snippet is a lossy view and full bodies would cost ~11x the bytes.
   *
   * `limit` defaults to 8 and is hard-capped at 25 (a larger value throws CONFIG_ERROR, it is never
   * silently clamped). Scope defaults to articles and assets.
   */
  async searchKnowledge(query: string, opts?: KnowledgeSearchOptions): Promise<KnowledgeSearchResult> {
    return knowledgeEngine(this.client).search(query, opts ?? {});
  }

  /**
   * Resolve an identifier against several resources and return the candidates that match.
   *
   * Each requested resource runs its OWN `resolve(identifier, { resolutionDetails: true })` with
   * the same identifier, so the vendor filter, the bounded client scan and the identifier order
   * stay the resource's own contract. The fan-out is bounded by the client's `concurrency`.
   *
   * Unlike a single-resource `resolve`, this never throws `RESOLUTION_AMBIGUOUS` across the set:
   * several matches (in one resource or across resources) are exactly what it returns, as one
   * candidate per match, so the caller decides. A duplicate candidate inside a resource keeps the
   * resource's own label; an ambiguous resource reports its candidate ids with a `#<id>` label and
   * `item: null`.
   *
   * Honest boundaries: a resource whose bounded scan stopped at the resolution cap is named in
   * `truncated` and is never reported as "not found"; a resource that finished a complete scan with
   * no match contributes nothing; a resource missing a definite id contributes nothing. When every
   * scan is complete and nothing matched, `hits` is empty — except for a definite id (a number, a
   * numeric string or `{ id }`), which names exactly one record, so a miss everywhere throws
   * `NOT_FOUND` (code `NOT_FOUND`) instead of returning a misleading empty list. When every scan
   * was truncated and nothing matched, the answer is undecided and `RESOLUTION_TRUNCATED` is thrown
   * (code `RESOLUTION_TRUNCATED`) rather than reporting an empty result.
   *
   * `limit` is per resource and follows the same rule as `searchAcrossResources` (default 25,
   * maximum 100). Transport failures (network, rate limit, bad request) still propagate: they are
   * not resolution answers.
   *
   * `preferredWhen`: use this when you have an identifier but not the resource type; use the
   * resource's own `resolve` when the type is known.
   */
  async resolveAny(identifier: Identifier): Promise<ResolveAnyResult>;
  async resolveAny(identifier: Identifier, opts: ResolveAnyOptions): Promise<ResolveAnyResult>;
  async resolveAny(identifier: Identifier, opts?: ResolveAnyOptions): Promise<ResolveAnyResult>;
  async resolveAny(identifier: Identifier, opts?: ResolveAnyOptions): Promise<ResolveAnyResult> {
    const limit = helperLimit(opts?.limit, 'operations.resolveAny');
    const resources = requireResources(opts?.resources, 'operations.resolveAny');
    const id = definiteId(identifier);
    const resolutionOpts: HelperOptions = { resolutionDetails: true, limit };
    const outcomes = await boundedMap(resources, this.concurrency, (resource) =>
      resolveOutcome(resource, this.client, identifier, resolutionOpts, id !== undefined),
    );
    const hits = outcomes.flatMap((outcome) => outcome.hits);
    const truncated = outcomes.filter((outcome) => outcome.truncated).map((outcome) => outcome.resource);
    const scanned = outcomes.reduce((total, outcome) => total + outcome.scanned, 0);
    if (hits.length === 0 && truncated.length > 0) {
      throw ResolutionError.truncated(
        `operations.resolveAny: ${truncated.length} of ${resources.length} resource scan(s) stopped at the ` +
          `resolution cap (${truncated.join(', ')}) before the data ran out, so no candidate set can be decided.`,
        {
          operation: 'operations.resolveAny',
          suggestedAction:
            'Raise resolution.maxScanRecords/maxScanPages, narrow the requested resources, or resolve by { id }.',
        },
      );
    }
    if (hits.length === 0 && id !== undefined) {
      throw new NotFoundError(
        `operations.resolveAny: no record with id ${id} exists in the requested resources (${resources.join(', ')}).`,
        undefined,
        undefined,
        { operation: 'operations.resolveAny', resourceIds: [id] },
      );
    }
    return { hits, truncated, scanned };
  }
}
