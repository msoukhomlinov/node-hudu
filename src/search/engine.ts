/**
 * The knowledge search engine behind `operations.searchKnowledge`.
 *
 * Design of record: `engine-design.md` (tiers S1.4, matching S2, scoring S3, output S4) and
 * `PROPOSAL.md` S2-S4, S14.2 — search design docs, kept outside this repo. INTERNAL module: the
 * SDK's public surface gains one operation (`searchKnowledge`), nothing here is exported from the
 * root barrel.
 *
 * Tiers, exactly as designed:
 *   T0 vendor-only      - the vendor fan-out, no local re-rank (reachable when a query has no
 *                         scoreable term after stopword handling).
 *   T1 vendor + re-rank - the vendor fan-out, re-ranked locally on the labels it returned. Body
 *                         terms are NOT searched and the response SAYS SO.
 *   T2 index UNION vendor - the in-memory body index, unioned with the vendor fan-out so a record
 *                         written seconds ago still surfaces. The default once the index is warm.
 *
 * Every bound that bites is named in `meta.reasons[]`, and a body-blind empty result carries
 * `degraded: { reason: 'body-not-indexed' }` rather than a bare empty list: Hudu's own `search`
 * never matches article body content, so a silent empty answer would be a lie by omission.
 */
import { HuduConfigError, HuduError, isHuduError } from '../errors.js';
import type { Page } from '../pagination.js';
import type {
  KnowledgeIndexDocStat,
  KnowledgeIndexMeta,
  KnowledgeMatchField,
  KnowledgeResource,
  KnowledgeScoreScope,
  KnowledgeSearchDegraded,
  KnowledgeSearchError,
  KnowledgeSearchHit,
  KnowledgeSearchMeta,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeSearchSnippet,
  KnowledgeSearchTruncation,
  KnowledgeSnippetReason,
} from '../types/search_knowledge.js';
import { extractHtml } from './html.js';
import {
  DEFAULT_INDEX_BOUNDS,
  FIELD_WEIGHTS,
  INDEX_FIELDS,
  KnowledgeIndex,
  utf8Bytes,
  type IndexBounds,
  type IndexField,
  type SearchDoc,
} from './index-store.js';
import { buildSnippet } from './snippet.js';
import { compactOfQuery, editDistanceAtMost, pluralVariants, splitQueryTerms, tokenizeText } from './tokenize.js';

const K1 = 1.2;
const B = 0.75;

/**
 * How many times `warm` re-checks for a build that satisfies a `full` request before proceeding:
 * awaiting an in-flight incremental build must never be reported as a completed full re-walk, but
 * a continuous stream of concurrent callers must not spin there forever either.
 */
const MAX_WARM_ATTEMPTS = 5;

/** Resource prior: articles first, assets second, everything else behind them. */
const RESOURCE_PRIOR: Record<string, number> = { articles: 1.0, assets: 0.9 };
const DEFAULT_PRIOR = 0.8;

/** Default and maximum hits, and the maximum snippet window. */
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 25;
export const DEFAULT_SEARCH_SNIPPET_CHARS = 200;
export const MAX_SEARCH_SNIPPET_CHARS = 400;

/** Default scope: KB content first, assets second. */
export const DEFAULT_SCOPE: readonly KnowledgeResource[] = ['articles', 'assets'];

/** Every resource the engine accepts, in the documented order. */
export const KNOWLEDGE_RESOURCES: readonly KnowledgeResource[] = [
  'articles', 'assets', 'companies', 'users', 'groups', 'websites', 'asset_passwords', 'password_folders',
];

/** Prefix expansion is capped per field and term (prefix matches are a scoring aid, not a scan). */
export const MAX_PREFIX_EXPANSIONS = 64;

/** Rows as the vendor tier sees them (a compact summary plus its label). */
export interface VendorRow {
  id: number;
  label: string;
  item: Record<string, unknown>;
}

/** What the engine needs from the client: two index sources and one vendor search per resource. */
export interface EngineDeps {
  /** Article pages (the list payload already carries the full HTML `content`). */
  listArticlePages: (params: { page_size: number; updated_at?: string }) => AsyncIterable<Page<Record<string, unknown>>>;
  /** Account-wide asset pages. */
  listAssetPages: (params: { page_size: number; updated_at?: string }) => AsyncIterable<Page<Record<string, unknown>>>;
  /**
   * One resource's vendor text search. The engine calls this PER RESOURCE and isolates the
   * failure: a resource that throws contributes an entry to `meta.errors` and the rest answer.
   */
  vendorSearch: (resource: KnowledgeResource, query: string, limit: number) => Promise<VendorRow[]>;
  /** Clock seam for tests. */
  now?: () => number;
}

/** The engine's tunables; every one of them is a bound that is reported when it bites. */
export interface EngineConfig {
  bounds: IndexBounds;
  /** Index age after which an answer is marked `stale` (still answered, and said so). */
  ttlMs: number;
  /** A full re-walk every N TTLs, because deletes are NOT observable through `updated_at`. */
  fullRefreshEvery: number;
  pageSize: number;
  maxIndexPages: number;
  maxDocsScored: number;
  maxResponseBytes: number;
  maxVendorRequests: number;
  /** Fuzzy matching in article bodies (a large tenant can turn it off). */
  fuzzyBody: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  bounds: DEFAULT_INDEX_BOUNDS,
  ttlMs: 10 * 60 * 1000,
  fullRefreshEvery: 6,
  pageSize: 100,
  maxIndexPages: 100,
  maxDocsScored: 2000,
  maxResponseBytes: 8192,
  maxVendorRequests: 8,
  fuzzyBody: true,
};

/** The index state, for `meta.index` and for tests. */
export interface EngineStatus {
  state: KnowledgeIndexMeta['state'];
  builtAt: string | null;
  ageMs: number | null;
  staleness: KnowledgeIndexMeta['staleness'];
  docs: Record<string, KnowledgeIndexDocStat>;
  watermarks: Record<string, string | null>;
  requestsLastBuild: number;
  /**
   * The last BACKGROUND build failure, or null. The automatic path cannot throw at its caller, so
   * the failure is reported here (and in `meta.errors`) instead of being swallowed; the next
   * successful build clears it.
   */
  lastBuildError: { code: string; message: string } | null;
}

/**
 * The document generation a search scored against, plus the facts that describe IT.
 *
 * A build can complete during the vendor await, so the live index may describe different data than the
 * hits came from. Every value here is captured at score time and reported by the answer, so a response
 * cannot say "no bodies are indexed" beside a snippet taken from one.
 */
interface ScoredGeneration {
  docs: readonly SearchDoc[];
  stats: Record<string, KnowledgeIndexDocStat>;
  bodiesIndexed: number;
  bodiesEvicted: number;
  truncatedDocs: number;
  builtAt: number | null;
  /** Which build produced this generation: a COUNTER, so a same-millisecond rebuild is still visible. */
  buildSeq: number;
  partial: boolean;
  buildTruncated: boolean;
}

interface ScoredRow {
  docIndex: number;
  score: number;
  terms: string[];
  fields: Set<IndexField>;
  fuzzy: boolean;
}

interface VendorScored {
  resource: KnowledgeResource;
  id: number;
  label: string;
  item: Record<string, unknown>;
  score: number;
  coverage: number;
  terms: string[];
  fuzzy: boolean;
}

/** Read a string field off an untyped vendor row. */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** Read a numeric field off an untyped vendor row. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** The resource's own map for a matched index field. */
function matchField(field: IndexField): KnowledgeMatchField {
  if (field === 'cfield' || field === 'cflabel') return 'custom_field';
  if (field === 'ident') return 'ident';
  if (field === 'slug') return 'slug';
  if (field === 'body') return 'body';
  return 'title';
}

/** Resolve the requested limit (default 8, hard maximum 25, never a silent clamp). */
export function resolveSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HuduConfigError(`searchKnowledge limit must be a positive integer, got ${JSON.stringify(limit)}`);
  }
  if (limit > MAX_SEARCH_LIMIT) {
    throw new HuduConfigError(
      `searchKnowledge limit must be at most ${MAX_SEARCH_LIMIT}, got ${limit} (the bound is refused, never silently clamped)`,
    );
  }
  return limit;
}

/** Resolve the requested scope, rejecting an unknown or empty resource list. */
export function resolveScope(scope: readonly KnowledgeResource[] | undefined): KnowledgeResource[] {
  if (scope === undefined) return [...DEFAULT_SCOPE];
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new HuduConfigError('searchKnowledge scope must be a non-empty array of resource names');
  }
  for (const resource of scope) {
    if (!KNOWLEDGE_RESOURCES.includes(resource)) {
      throw new HuduConfigError(
        `searchKnowledge scope: "${String(resource)}" is not a searchable resource (supported: ${KNOWLEDGE_RESOURCES.join(', ')})`,
      );
    }
  }
  return [...scope];
}

/** The call that returns the full record behind a hit. */
function fetchCallFor(resource: KnowledgeResource, id: number, companyId: number | null): { operation: string; args: Record<string, unknown> } {
  if (resource === 'assets' && companyId !== null) return { operation: 'assets.get', args: { companyId, id } };
  return { operation: `${resource}.get`, args: { id } };
}

/** The engine: one per client + tenant, held in memory, never on disk. */
export class KnowledgeSearchEngine {
  private readonly index: KnowledgeIndex;
  private readonly config: EngineConfig;
  private readonly now: () => number;
  private builtAt: number | null = null;
  /** Completed builds, monotonically: identifies a generation without relying on clock resolution. */
  private buildSeq = 0;
  private lastFullAt: number | null = null;
  private building: Promise<void> | null = null;
  /** Whether the in-flight build (if any) re-walks everything — a `full` caller must not dedup onto an incremental. */
  private buildingFull = false;
  /** The last background-build failure, surfaced instead of swallowed. Cleared by the next success. */
  private buildError: { code: string; message: string } | null = null;
  private partial = false;
  /** True when the MOST RECENT build truncated: reported for that answer, while `partial` is the index's own state. */
  private lastBuildTruncated = false;
  private truncatedDocs = 0;
  private readonly watermarks: Record<string, string | null> = { articles: null, assets: null };
  private readonly totalKnown: Record<string, number | null> = { articles: null, assets: null };
  private requestsLastBuild = 0;

  constructor(private readonly deps: EngineDeps, config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config, bounds: { ...DEFAULT_ENGINE_CONFIG.bounds, ...(config.bounds ?? {}) } };
    this.index = new KnowledgeIndex(this.config.bounds);
    this.now = deps.now ?? (() => Date.now());
  }

  /** The index's current state. */
  status(): EngineStatus {
    const ageMs = this.builtAt === null ? null : Math.max(0, this.now() - this.builtAt);
    const state: KnowledgeIndexMeta['state'] =
      this.building !== null && this.builtAt === null ? 'refreshing' : this.builtAt === null ? 'cold' : this.partial ? 'partial' : 'warm';
    return {
      state,
      builtAt: this.builtAt === null ? null : new Date(this.builtAt).toISOString(),
      ageMs,
      staleness: ageMs === null ? 'unknown' : ageMs > this.config.ttlMs ? 'stale' : 'fresh',
      docs: this.docStats(this.index.docs),
      watermarks: { ...this.watermarks },
      requestsLastBuild: this.requestsLastBuild,
      lastBuildError: this.buildError === null ? null : { ...this.buildError },
    };
  }

  /**
   * Build or refresh the index. `full` re-walks everything and drops documents missing from the
   * walk — the ONLY honest way to notice a deletion, because `updated_at` cannot see one.
   */
  async warm(opts: { full?: boolean; downgraded?: { value: boolean } } = {}): Promise<void> {
    const wantFull = opts.full === true;
    // Dedup, but never DOWNGRADE: awaiting an in-flight incremental build does not satisfy a
    // caller that asked for a full re-walk (only a full walk can notice a deletion). A bounded
    // number of attempts keeps a stream of concurrent callers from spinning here forever; past
    // the bound the answer proceeds on the last completed build, and `meta.index.staleness`
    // still reports its real age.
    for (let attempt = 0; attempt < MAX_WARM_ATTEMPTS; attempt += 1) {
      const existing = this.building;
      if (existing !== null) {
        const inFlightFull = this.buildingFull;
        await existing;
        if (!wantFull || inFlightFull) return;
        continue;
      }
      const run = this.build(wantFull);
      this.building = run;
      this.buildingFull = wantFull;
      try {
        await run;
      } finally {
        this.building = null;
        this.buildingFull = false;
      }
      return;
    }
    // The attempt bound was reached: the caller asked for a full re-walk and this answer is built on
    // a completed build that may be incremental. The CALLER's own holder is flagged, so the notice
    // reaches exactly the request that was downgraded (a shared counter would need an argument about
    // concurrent callers to say the same thing).
    if (wantFull && opts.downgraded !== undefined) opts.downgraded.value = true;
  }

  /** Start a warm build without waiting for it (the cold-client path must not block a tool call). */
  private startBackgroundWarm(): void {
    if (this.building !== null) return;
    // The automatic path is the ONLY one that keeps deletions out of the index over a long
    // session: `updated_at` cannot see a deletion, so a periodic FULL re-walk is required, and
    // this is where it has to be scheduled.
    const full = this.needsFullRefresh();
    void this.warm({ full }).catch((error: unknown) => {
      // The caller is a tool call that must not block, so the failure is RECORDED, never dropped:
      // `status().lastBuildError` and `meta.errors` name it for the next answer.
      // `errorCode` defaults a non-Hudu value to NETWORK_ERROR, which would mislabel an internal
      // fault (a TypeError in the walk) as a transport failure: name it for what it is.
      this.buildError = {
        code: isHuduError(error) ? error.code : 'INDEX_BUILD_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    });
  }

  /** The whole search: tier selection, scoring, snippets, and the honesty metadata. */
  async search(query: string, opts: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResult> {
    const started = this.now();
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HuduConfigError('operations.searchKnowledge requires a non-empty query');
    }
    const limit = resolveSearchLimit(opts.limit);
    const scope = resolveScope(opts.scope);
    const snippetChars = Math.max(1, Math.min(MAX_SEARCH_SNIPPET_CHARS, Math.floor(opts.snippetChars ?? DEFAULT_SEARCH_SNIPPET_CHARS)));
    const exactOnly = opts.exact_only === true;
    const { terms } = splitQueryTerms(query);

    const reasons: string[] = [];
    let truncation: KnowledgeSearchTruncation | undefined;
    const errors: KnowledgeSearchError[] = [];
    const requests = { count: 0 };
    let indexUsed = false;
    let candidatesScored = 0;
    let scanned = 0;
    const scoredRows: ScoredRow[] = [];
    const vendorScored: VendorScored[] = [];
    const vendorMs = { value: 0 };

    const tier = opts.tier ?? 'auto';
    // A downgrade is announced to the answer that ASKED for the refresh: the holder is this call's own.
    const downgraded = { value: false };
    if (opts.refresh === true) {
      await this.warm({ full: true, downgraded });
    } else if (tier === 'index') {
      await this.warm({ full: false });
    } else if (tier === 'auto') {
      if (this.builtAt === null) this.startBackgroundWarm();
      else if (this.isStale()) this.startBackgroundWarm();
    }

    const useIndex = tier !== 'vendor' && this.builtAt !== null;
    // The scored rows carry `docIndex` coordinates, and the vendor tier below is awaited between
    // scoring and hydration: capture the document ARRAY the rows were scored against, so a build
    // that completes during that await can never re-point a coordinate at another document.
    let generation: ScoredGeneration | null = null;
    let hits: { hits: KnowledgeSearchHit[]; truncation: KnowledgeSearchTruncation | undefined; candidatesScored: number };
    // The latch try starts BEFORE scoring: `scoreIndex` calls `beginRead`, and a throw inside the
    // synchronous scan must release the reader exactly like a throw during hydration.
    try {
      if (useIndex) {
        indexUsed = true;
        const scored = this.scoreIndex(terms, { exactOnly, maxDocsScored: this.config.maxDocsScored });
        generation = scored.generation;
        candidatesScored = scored.candidatesScored;
        if (scored.capped) {
          reasons.push('candidate-cap');
          truncation = {
            reason: 'candidate-cap',
            detail: `${scored.candidatesScored} candidate documents exceeded maxDocsScored=${this.config.maxDocsScored}`,
            candidatesScored: scored.candidatesScored,
          };
        }
        for (const row of scored.rows) scoredRows.push(row);
      }

      if (terms.length === 0) {
        reasons.push('no-scoreable-term');
      }

      const vendorRows = await this.runVendor(query, scope, terms, limit, errors, requests, vendorMs, exactOnly);
      scanned = candidatesScored + vendorRows.length;
      for (const row of vendorRows) vendorScored.push(row);
      hits = this.hydrate(scoredRows, generation?.docs ?? [], vendorScored, {
        terms,
        limit,
        snippetChars,
        scope,
        indexUsed,
        companyId: opts.company_id,
        updatedSince: opts.updated_since,
        minScore: opts.min_score,
        reasons,
        truncation,
      });
    } finally {
      // The snapshot lives exactly as long as the rows that address it.
      if (indexUsed) this.index.endRead();
    }
    truncation = hits.truncation;
    if (this.buildError !== null) {
      // Symmetry with the explicit path (which throws): a failed automatic build is announced in
      // the answer rather than leaving the caller to infer it from a cold index.
      errors.push({
        resource: 'index',
        code: this.buildError.code,
        message: `background index build failed: ${this.buildError.message}`,
      });
    }

    const bodiesIndexed = generation?.bodiesIndexed ?? this.bodiesIndexed();
    const bodyCapable = indexUsed && bodiesIndexed > 0;
    let degraded: KnowledgeSearchDegraded | null = null;
    if (!indexUsed) {
      degraded =
        hits.hits.length === 0
          ? { reason: 'body-not-indexed', advice: this.bodyNotIndexedAdvice() }
          : { reason: 'vendor-only', advice: this.vendorOnlyAdvice() };
      reasons.push(degraded.reason === 'vendor-only' ? 'vendor-only' : 'body-not-indexed');
    } else if (!bodyCapable) {
      const evicted = generation?.bodiesEvicted ?? 0;
      // The index exists but holds no body text: when the TEXT BUDGET evicted it, waiting cannot
      // help, so the advice names the real cause and the bound that would restore it.
      degraded = {
        reason: 'body-not-indexed',
        advice: evicted > 0 ? this.bodyEvictedAdvice(evicted) : this.bodyNotIndexedAdvice(),
      };
      reasons.push(evicted > 0 ? 'body-evicted' : 'body-not-indexed');
    }
    if (generation?.buildTruncated ?? this.lastBuildTruncated) reasons.push('index-partial');
    if ((generation?.bodiesEvicted ?? 0) > 0) reasons.push('body-evicted');
    if (downgraded.value) {
      // `refresh: true` promises a full re-walk, so a caller must be told when contention stopped it
      // from being one: the index may still hold a record the vendor has deleted.
      reasons.push('refresh-downgraded');
    }
    if ((generation?.truncatedDocs ?? this.truncatedDocs) > 0) reasons.push('body-truncated');

    const uniqueReasons = [...new Set(reasons)];
    const complete = uniqueReasons.length === 0;
    const localMs = Math.max(0, this.now() - started);

    const meta: KnowledgeSearchMeta = {
      query,
      terms,
      resources: scope,
      scanned,
      returned: hits.hits.length,
      limit,
      complete,
      reasons: uniqueReasons,
      ...(truncation ? { truncation } : {}),
      index: this.indexMeta(generation),
      degraded,
      errors,
      failed: errors,
      timings: { vendorMs: vendorMs.value, localMs, requests: requests.count },
      scoreScope: indexUsed ? 'cross-resource' : 'per-resource',
      bytes: 0,
      indexAge: (() => {
        const builtAt = generation === null ? this.builtAt : generation.builtAt;
        return builtAt === null ? null : Math.max(0, this.now() - builtAt);
      })(),
    };
    const result: KnowledgeSearchResult = { hits: hits.hits, meta };
    this.enforceResponseBudget(result, {
      reasons: uniqueReasons,
      truncation,
      candidatesScored: hits.candidatesScored,
    });
    return result;
  }

  // ---------------------------------------------------------------- vendor tier

  private async runVendor(
    query: string,
    scope: readonly KnowledgeResource[],
    terms: readonly string[],
    limit: number,
    errors: KnowledgeSearchError[],
    requests: { count: number },
    vendorMs: { value: number },
    exactOnly: boolean,
  ): Promise<VendorScored[]> {
    const out: VendorScored[] = [];
    const requested = scope.slice(0, this.config.maxVendorRequests);
    for (const resource of scope.slice(this.config.maxVendorRequests)) {
      errors.push({
        resource,
        code: 'CONFIG_ERROR',
        message: `not requested: maxVendorRequests=${this.config.maxVendorRequests} vendor searches are allowed per call`,
      });
    }
    for (const resource of requested) {
      const began = this.now();
      try {
        requests.count += 1;
        const rows = await this.deps.vendorSearch(resource, query, Math.min(limit * 4, 100));
        for (const row of rows) {
          const match = localLabelMatch(terms, row.label, exactOnly);
          const prior = RESOURCE_PRIOR[resource] ?? DEFAULT_PRIOR;
          out.push({
            resource,
            id: row.id,
            label: row.label,
            item: row.item,
            score: (0.5 + 0.5 * match.coverage) * prior,
            coverage: match.coverage,
            terms: match.terms,
            fuzzy: match.fuzzy,
          });
        }
      } catch (error) {
        errors.push({
          resource,
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        vendorMs.value += Math.max(0, this.now() - began);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- index tier

  private scoreIndex(
    terms: readonly string[],
    opts: { exactOnly: boolean; maxDocsScored: number },
  ): { rows: ScoredRow[]; candidatesScored: number; capped: boolean; generation: ScoredGeneration } {
    this.index.ensureFinalized();
    // Scoring is synchronous, so this snapshot and the postings it was derived from are consistent
    // for the whole scan; the caller keeps it for hydration and releases it with `endRead` (see
    // `search`), which pins it against in-place writes until then.
    const docs = this.index.beginRead();
    const rows = new Map<number, ScoredRow>();
    const compactQuery = opts.exactOnly ? null : compactOfQuery(terms);
    for (const term of terms) {
      const local = new Map<number, { score: number; field: IndexField; fuzzy: boolean; fields: Set<IndexField> }>();
      for (const field of INDEX_FIELDS) {
        const expansions = this.expansionsFor(field, term, compactQuery, opts);
        for (const expansion of expansions) {
          const posting = this.index.posting(field, expansion.token);
          if (posting === undefined) continue;
          const stats = this.index.stats(field);
          const df = this.index.documentFrequency(field, expansion.token);
          const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5));
          const weight = FIELD_WEIGHTS[field] * expansion.weight;
          for (let i = 0; i < posting.ids.length; i += 1) {
            const docIndex = posting.ids[i] as number;
            const docLen = this.index.lengthOf(docIndex, field);
            const tf = (posting.tfs[i] as number) * expansion.weight;
            const norm = 1 - B + B * (stats.avgLen === 0 ? 1 : docLen / stats.avgLen);
            const contribution = (idf * (tf * (K1 + 1))) / (tf + K1 * norm) * weight;
            const current = local.get(docIndex);
            if (current === undefined) {
              local.set(docIndex, { score: contribution, field, fuzzy: expansion.kind === 'fuzzy', fields: new Set([field]) });
            } else {
              // Every field that matched is reported, not only the one that scored best: the
              // snippet must be able to show a body match that a title match outscored.
              current.fields.add(field);
              if (expansion.kind === 'fuzzy') current.fuzzy = true;
              if (contribution > current.score) {
                current.score = contribution;
                current.field = field;
              }
            }
          }
        }
      }
      for (const [docIndex, best] of local) {
        const existing = rows.get(docIndex);
        if (existing === undefined) {
          rows.set(docIndex, { docIndex, score: best.score, terms: [term], fields: new Set(best.fields), fuzzy: best.fuzzy });
        } else {
          existing.score += best.score;
          if (!existing.terms.includes(term)) existing.terms.push(term);
          for (const field of best.fields) existing.fields.add(field);
          existing.fuzzy = existing.fuzzy || best.fuzzy;
        }
      }
    }
    const all = [...rows.values()];
    const candidatesScored = all.length;
    const generation = this.captureGeneration(docs);
    if (candidatesScored <= opts.maxDocsScored) return { rows: all, candidatesScored, capped: false, generation };
    all.sort((a, b) => b.score - a.score);
    return { rows: all.slice(0, opts.maxDocsScored), candidatesScored, capped: true, generation };
  }

  private expansionsFor(
    field: IndexField,
    term: string,
    compactQuery: string | null,
    opts: { exactOnly: boolean },
  ): { token: string; weight: number; kind: 'exact' | 'plural' | 'compact' | 'prefix' | 'fuzzy' }[] {
    const out: { token: string; weight: number; kind: 'exact' | 'plural' | 'compact' | 'prefix' | 'fuzzy' }[] = [
      { token: term, weight: 1, kind: 'exact' },
    ];
    if (opts.exactOnly) return out;
    for (const variant of pluralVariants(term)) out.push({ token: variant, weight: 0.9, kind: 'plural' });
    if (compactQuery !== null) out.push({ token: compactQuery, weight: 0.8, kind: 'compact' });
    if (term.length >= 3) {
      for (const token of this.index.prefixTokens(field, term, MAX_PREFIX_EXPANSIONS)) {
        out.push({ token, weight: 0.7, kind: 'prefix' });
      }
    }
    for (const candidate of this.index.fuzzyTokens(field, term, this.config.fuzzyBody)) {
      out.push({ token: candidate.token, weight: 0.5, kind: 'fuzzy' });
    }
    return out;
  }

  // ---------------------------------------------------------------- hits

  private hydrate(
    indexRows: readonly ScoredRow[],
    indexDocs: readonly SearchDoc[],
    vendorRows: readonly VendorScored[],
    ctx: {
      terms: readonly string[];
      limit: number;
      snippetChars: number;
      scope: readonly KnowledgeResource[];
      indexUsed: boolean;
      companyId?: number;
      updatedSince?: string;
      minScore?: number;
      reasons: string[];
      truncation: KnowledgeSearchTruncation | undefined;
    },
  ): { hits: KnowledgeSearchHit[]; truncation: KnowledgeSearchTruncation | undefined; candidatesScored: number } {
    const candidates: KnowledgeSearchHit[] = [];
    const byKey = new Map<string, number>();
    const vendorByKey = new Map<string, VendorScored>();
    for (const row of vendorRows) vendorByKey.set(`${row.resource}:${row.id}`, row);
    const queryTerms = Math.max(1, ctx.terms.length);

    for (const row of indexRows) {
      const doc = indexDocs[row.docIndex];
      // The pinned snapshot makes an out-of-range coordinate impossible, so this is an INVARIANT
      // assertion rather than a live path (the defect it replaces was a raw TypeError from a
      // property read on `undefined`). It stays because an unreachable invariant that names itself
      // beats a crash a caller cannot classify.
      if (doc === undefined) {
        throw new HuduError(
          `knowledge index generation changed while the search was in flight: candidate ${row.docIndex} is ` +
            `outside the scored generation of ${indexDocs.length} document(s); retry the search.`,
          {
            code: 'INDEX_GENERATION_MISMATCH',
            category: 'server',
            retryable: true,
            suggestedAction: 'Retry the search; the index was rebuilt while this search was in flight.',
          },
        );
      }
      if (!ctx.scope.includes(doc.resource as KnowledgeResource)) continue;
      if (ctx.companyId !== undefined && doc.company_id !== ctx.companyId) continue;
      if (ctx.updatedSince !== undefined && doc.updated_at < ctx.updatedSince) continue;
      const prior = RESOURCE_PRIOR[doc.resource] ?? DEFAULT_PRIOR;
      const coverage = row.terms.length / queryTerms;
      const score = row.score * (0.5 + 0.5 * coverage) * prior;
      if (ctx.minScore !== undefined && score < ctx.minScore) continue;
      // By KEY, never by the snapshot coordinate: the live array may have been rebuilt under it.
      this.index.touchDocument(doc.resource, doc.id);
      const vendor = vendorByKey.get(`${doc.resource}:${doc.id}`);
      const hit: KnowledgeSearchHit = {
        resource: doc.resource as KnowledgeResource,
        id: doc.id,
        title: vendor?.label ?? doc.title,
        score,
        relevance: 0,
        scoreScope: ctx.indexUsed ? 'cross-resource' : 'per-resource',
        match: {
          fields: [...row.fields].map(matchField).filter((f, i, all) => all.indexOf(f) === i),
          terms: row.terms,
          coverage,
          fuzzy: row.fuzzy,
        },
        snippet: this.snippetFor(row, doc, ctx.terms, ctx.snippetChars),
        company: doc.company_id === null ? undefined : { id: doc.company_id, ...(doc.company_name ? { name: doc.company_name } : {}) },
        updated_at: vendor !== undefined ? str(vendor.item.updated_at) || doc.updated_at : doc.updated_at,
        url: doc.url === '' ? undefined : doc.url,
        fetch: fetchCallFor(doc.resource as KnowledgeResource, doc.id, doc.company_id),
      };
      candidates.push(hit);
      byKey.set(`${doc.resource}:${doc.id}`, candidates.length - 1);
    }

    for (const row of vendorRows) {
      const key = `${row.resource}:${row.id}`;
      if (byKey.has(key)) continue;
      if (ctx.companyId !== undefined) {
        const company = num(row.item.company_id);
        if (company !== ctx.companyId) continue;
      }
      if (ctx.updatedSince !== undefined && str(row.item.updated_at) < ctx.updatedSince) continue;
      if (ctx.minScore !== undefined && row.score < ctx.minScore) continue;
      const hit: KnowledgeSearchHit = {
        resource: row.resource,
        id: row.id,
        title: row.label,
        score: row.score,
        relevance: 0,
        scoreScope: ctx.indexUsed ? 'cross-resource' : 'per-resource',
        match: ctx.terms.length === 0
          ? { fields: [], terms: [], coverage: 0, fuzzy: false }
          : { fields: ['title'], terms: row.terms, coverage: row.coverage, fuzzy: row.fuzzy },
        snippet: {
          text: '',
          spans: [],
          textStart: 0,
          textEnd: 0,
          source: 'title',
          truncated: false,
          available: false,
          reason: 'not-indexed' satisfies KnowledgeSnippetReason,
        },
        ...(num(row.item.company_id) !== null ? { company: { id: num(row.item.company_id) as number } } : {}),
        ...(str(row.item.updated_at) ? { updated_at: str(row.item.updated_at) } : {}),
        fetch: fetchCallFor(row.resource, row.id, num(row.item.company_id)),
      };
      candidates.push(hit);
      byKey.set(key, candidates.length - 1);
    }

    // T0: a query with no scoreable term is answered in the vendor's own order, never re-ranked
    // by a score that would be invented.
    const ranked =
      ctx.terms.length === 0
        ? candidates
        : candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.match.fields.length !== a.match.fields.length) return b.match.fields.length - a.match.fields.length;
            if (a.title.length !== b.title.length) return a.title.length - b.title.length;
            const au = a.updated_at ?? '';
            const bu = b.updated_at ?? '';
            if (au !== bu) return au < bu ? 1 : -1;
            if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
            return a.id - b.id;
          });

    const best = ranked[0]?.score ?? 0;
    const kept: KnowledgeSearchHit[] = [];
    let stopped = false;
    for (const hit of ranked) {
      if (kept.length >= ctx.limit) {
        stopped = true;
        break;
      }
      hit.relevance = best > 0 ? hit.score / best : 0;
      kept.push(hit);
    }
    if (stopped) ctx.reasons.push('result-limit');
    // The byte budget is NOT applied here: the honest unit is the UTF-8 size of the COMPLETE
    // response the caller receives, real meta included, and the meta does not exist yet. `search`
    // enforces it on the assembled result (see `enforceResponseBudget`).
    return { hits: kept, truncation: ctx.truncation, candidatesScored: ranked.length };
  }

  /**
   * Enforce `maxResponseBytes` on the complete serialised response, measured in UTF-8 BYTES.
   *
   * Two defects are closed here at once: the budget used to be accumulated from
   * `JSON.stringify(hit).length` (UTF-16 code units, so a CJK payload could roughly double the
   * budget unflagged) and it seeded the count with a placeholder `{ hits: [], meta: { bytes: 0 } }`
   * instead of the real meta. Both let an oversized response through with `truncation` unset.
   *
   * Hits are dropped from the tail until the response fits; the FIRST hit is always kept, even
   * alone over budget, because an empty answer would hide the match — that case is flagged.
   */
  private enforceResponseBudget(
    result: KnowledgeSearchResult,
    opts: { reasons: string[]; truncation: KnowledgeSearchTruncation | undefined; candidatesScored: number },
  ): void {
    const meta = result.meta;
    // `meta.bytes` is part of the response it measures, so the size is found by iteration: one pass
    // can change the width of the digit string, and the next pass then reproduces it. The bound is
    // safe by construction — a pass changes `meta.bytes` by at most a few characters of JSON — and
    // the four-pass cap only exists so a pathological value cannot spin. Anything the bound would
    // have caught is caught instead by the test that asserts `meta.bytes` equals the size of the
    // final serialisation.
    const sizeOf = (): number => {
      let size = meta.bytes;
      for (let pass = 0; pass < 4; pass += 1) {
        meta.bytes = size;
        const next = utf8Bytes(JSON.stringify(result));
        if (next === size) return size;
        size = next;
      }
      meta.bytes = size;
      return size;
    };
    let size = sizeOf();
    if (size <= this.config.maxResponseBytes) return;
    // A truncation already reported by the candidate cap is the FIRST thing that cut the answer, so
    // it is kept as `truncation`; the byte cut is reported alongside it in `reasons`.
    if (opts.truncation === undefined) {
      opts.truncation = {
        reason: 'result-limit',
        detail: `response stopped at maxResponseBytes=${this.config.maxResponseBytes}`,
        candidatesScored: opts.candidatesScored,
      };
    }
    // The flag is set BEFORE the size is taken again, so the reported `meta.bytes` counts the
    // truncation notice too (a notice added after the last measurement would be reported as free).
    meta.truncation = opts.truncation;
    opts.reasons.push('result-limit');
    meta.reasons = [...new Set(opts.reasons)];
    meta.complete = meta.reasons.length === 0;
    size = sizeOf();
    while (result.hits.length > 1 && size > this.config.maxResponseBytes) {
      result.hits.pop();
      meta.returned = result.hits.length;
      size = sizeOf();
    }
  }

  private snippetFor(
    row: ScoredRow,
    doc: SearchDoc,
    terms: readonly string[],
    snippetChars: number,
  ): KnowledgeSearchSnippet {
    const matchedLong = [...row.fields].some((field) => field === 'body' || field === 'cfield');
    if (!matchedLong) {
      return {
        text: '',
        spans: [],
        textStart: 0,
        textEnd: 0,
        source: doc.longSource,
        truncated: false,
        available: false,
        reason: 'matched-title-only',
      };
    }
    if (doc.longText === null) {
      // The document matched a body/custom-field term but holds no long text: the text is not in
      // memory. (Eviction releases the postings too, so an evicted document cannot reach this branch
      // with a body match; the eviction is reported per index instead — `bodiesEvicted`.)
      return {
        text: '',
        spans: [],
        textStart: 0,
        textEnd: 0,
        source: doc.longSource,
        truncated: false,
        available: false,
        reason: 'not-indexed' satisfies KnowledgeSnippetReason,
      };
    }
    const built = buildSnippet(doc.longText, [...terms], {
      snippetChars,
      source: doc.longSource,
      noMatchReason: 'no-match-in-body',
    });
    return {
      text: built.text,
      // Spans are relative to the returned `text` (so a caller can highlight it directly);
      // `textStart` is the same window's absolute offset, so the absolute form is one addition away.
      spans: built.spans.map(
        (span) => [Math.max(0, span.start - built.textStart), span.end - built.textStart] as [number, number],
      ),
      textStart: built.textStart,
      textEnd: built.textEnd,
      source: built.source,
      truncated: built.truncated.before || built.truncated.after,
      available: built.available,
      ...(built.reason ? { reason: built.reason as KnowledgeSnippetReason } : {}),
    };
  }

  // ---------------------------------------------------------------- index build

  private async build(full: boolean): Promise<void> {
    const sinceWatermark = full ? undefined : (this.watermarks.articles ?? undefined);
    const assetWatermark = full ? undefined : (this.watermarks.assets ?? undefined);
    const requests = { count: 0 };
    const keys = new Set<string>();
    let articleMax: string | null = this.watermarks.articles ?? null;
    let assetMax: string | null = this.watermarks.assets ?? null;
    let articleTotal: number | null = 0;
    let assetTotal: number | null = 0;
    let articleDocs = 0;
    let assetDocs = 0;

    const articles = await this.walk(
      this.deps.listArticlePages({ page_size: this.config.pageSize, ...(sinceWatermark ? { updated_at: `${sinceWatermark},` } : {}) }),
      requests,
    );
    for (const raw of articles.rows) {
      const doc = articleDoc(raw, this.config.bounds.maxDocBytes);
      if (doc === null) continue;
      keys.add(`articles:${doc.id}`);
      this.index.upsert(doc);
      articleDocs += 1;
      if (doc.updated_at > (articleMax ?? '')) articleMax = doc.updated_at;
    }
    if (articles.truncated) articleTotal = null;
    else articleTotal = full ? articleDocs : null;

    const assets = await this.walk(
      this.deps.listAssetPages({ page_size: this.config.pageSize, ...(assetWatermark ? { updated_at: `${assetWatermark},` } : {}) }),
      requests,
    );
    for (const raw of assets.rows) {
      const doc = assetDoc(raw);
      if (doc === null) continue;
      keys.add(`assets:${doc.id}`);
      this.index.upsert(doc);
      assetDocs += 1;
      if (doc.updated_at > (assetMax ?? '')) assetMax = doc.updated_at;
    }
    if (assets.truncated) assetTotal = null;
    else assetTotal = full ? assetDocs : null;

    const truncated = articles.truncated || assets.truncated;
    if (full) {
      // Delete-by-absence is sound ONLY for a resource whose walk COMPLETED: a capped walk that
      // never reached the older records of a resource would otherwise purge documents that are
      // still in the vendor corpus (the walk's absence proves nothing about them).
      const walkedFully = new Set<string>();
      if (!articles.truncated) walkedFully.add('articles');
      if (!assets.truncated) walkedFully.add('assets');
      this.index.retain(keys, walkedFully);
      // A full walk that completes re-establishes the index's completeness; a truncated one
      // leaves it partial until the next completed full walk (scheduled by `needsFullRefresh`).
      this.partial = truncated;
      this.totalKnown.articles = articleTotal;
      this.totalKnown.assets = assetTotal;
      this.lastFullAt = this.now();
    } else {
      // An incremental walk cannot PROVE completeness (records it never fetched stay unknown), so
      // it may raise `partial` but never lower it.
      if (truncated) this.partial = true;
      const knownArticles = this.totalKnown.articles;
      const knownAssets = this.totalKnown.assets;
      this.totalKnown.articles = knownArticles === null || knownArticles === undefined ? null : knownArticles + articleDocs;
      this.totalKnown.assets = knownAssets === null || knownAssets === undefined ? null : knownAssets + assetDocs;
    }
    this.truncatedDocs = this.index.docs.filter((doc) => doc.longTruncated).length;
    // Reported per answer: the reason belongs to THIS build's walk. The index-level state
    // (`partial`) carries the longer-lived fact and is what `meta.index.state` reports.
    this.lastBuildTruncated = truncated;
    this.buildError = null;
    this.watermarks.articles = articleMax;
    this.watermarks.assets = assetMax;
    // The document cap drops the OLDEST records, so a capped index is missing records it knows the
    // vendor has: `partial` is reported, never merely implied.
    if (this.index.capDocs() > 0) this.partial = true;
    this.index.finalize();
    this.requestsLastBuild = requests.count;
    this.builtAt = this.now();
    this.buildSeq += 1;
  }

  /**
   * Walk pages sequentially, stopping at the page cap. Never `Promise.all` across pages.
   *
   * `truncated` decides whether the caller may treat ABSENCE from this walk as a deletion, so it
   * must be exact: a walk whose last read page reports `hasMore: false` has seen the whole
   * collection, whether or not that page happened to be the cap. Only a page that claims more
   * data behind it makes the walk incomplete.
   *
   * The strict `=== false` comparison is deliberate: every bundled producer derives `hasMore` from
   * the page it just read (`items.length === page_size`, or `false` for a non-paginated endpoint),
   * never from the vendor's own flag — so `false` is trustworthy. An ABSENT `hasMore` is treated as
   * "more may follow" and stays bounded by `maxIndexPages`: the walk then reports truncated, which
   * costs a skipped delete-detection (over-reporting) and can never purge a live document.
   */
  private async walk(
    pages: AsyncIterable<Page<Record<string, unknown>>>,
    requests: { count: number },
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    const rows: Record<string, unknown>[] = [];
    let pages0 = 0;
    for await (const page of pages) {
      requests.count += 1;
      pages0 += 1;
      rows.push(...(page.items as Record<string, unknown>[]));
      if (page.hasMore === false) return { rows, truncated: false };
      if (pages0 >= this.config.maxIndexPages) return { rows, truncated: true };
    }
    return { rows, truncated: false };
  }

  private isStale(): boolean {
    if (this.builtAt === null) return true;
    const age = this.now() - this.builtAt;
    if (age > this.config.ttlMs * this.config.fullRefreshEvery) return true;
    return age > this.config.ttlMs;
  }

  private bodiesIndexed(): number {
    return this.index.docs.filter((doc) => doc.fields.body !== undefined).length;
  }

  private docStats(docs: readonly SearchDoc[]): Record<string, KnowledgeIndexDocStat> {
    const out: Record<string, KnowledgeIndexDocStat> = {};
    const blank = (resource: string): KnowledgeIndexDocStat => ({
      indexed: 0, bodiesIndexed: 0, bodiesTruncated: 0, bodiesEvicted: 0,
      totalKnown: this.totalKnown[resource] ?? null,
    });
    for (const doc of docs) {
      const stat = out[doc.resource] ?? (out[doc.resource] = blank(doc.resource));
      stat.indexed += 1;
      // A body that was cut at `maxDocBytes` and yielded no text is indexed WITHOUT a body field, so
      // the two counters describe different things and legitimately overlap.
      if (doc.fields.body !== undefined) stat.bodiesIndexed += 1;
      if (doc.longTruncated) stat.bodiesTruncated += 1;
      if (this.index.evictedDocs.has(doc)) stat.bodiesEvicted += 1;
    }
    for (const resource of Object.keys(this.totalKnown)) {
      if (!(resource in out)) out[resource] = blank(resource);
    }
    return out;
  }

  /** Capture everything the answer must report about the generation its hits came from. */
  private captureGeneration(docs: readonly SearchDoc[]): ScoredGeneration {
    const stats = this.docStats(docs);
    let bodiesIndexed = 0;
    let bodiesEvicted = 0;
    for (const stat of Object.values(stats)) {
      bodiesIndexed += stat.bodiesIndexed;
      bodiesEvicted += stat.bodiesEvicted;
    }
    return {
      docs,
      stats,
      bodiesIndexed,
      bodiesEvicted,
      truncatedDocs: this.truncatedDocs,
      builtAt: this.builtAt,
      buildSeq: this.buildSeq,
      partial: this.partial,
      buildTruncated: this.lastBuildTruncated,
    };
  }

  /**
   * The index block of an answer. With a scored generation it describes THAT generation (the data the
   * hits came from), plus `rebuiltAfterScore` when the index has moved on since; without one (the
   * vendor tier) it describes the live index, which is all the answer knows.
   */
  private indexMeta(generation: ScoredGeneration | null): KnowledgeIndexMeta {
    if (generation === null) {
      const status = this.status();
      return {
        state: status.state,
        ...(status.builtAt !== null ? { builtAt: status.builtAt } : {}),
        ...(status.ageMs !== null ? { ageMs: status.ageMs } : {}),
        staleness: status.staleness,
        docs: status.docs,
        rebuiltAfterScore: false,
      };
    }
    const ageMs = generation.builtAt === null ? null : Math.max(0, this.now() - generation.builtAt);
    const state: KnowledgeIndexMeta['state'] =
      generation.builtAt === null ? 'cold' : generation.partial ? 'partial' : 'warm';
    return {
      state,
      ...(generation.builtAt !== null ? { builtAt: new Date(generation.builtAt).toISOString() } : {}),
      ...(ageMs !== null ? { ageMs } : {}),
      staleness: ageMs === null ? 'unknown' : ageMs > this.config.ttlMs ? 'stale' : 'fresh',
      docs: generation.stats,
      rebuiltAfterScore: this.buildSeq !== generation.buildSeq,
    };
  }

  private bodyEvictedAdvice(evicted: number): string {
    return `No article body text is in memory: ${evicted} document(s) had their body text evicted under the ` +
      `text budget, so body terms in them are NOT searched. Call again later will not restore it — raise ` +
      `maxIndexTextBytes (or index fewer documents) and re-run, or search the vendor tier for titles.`;
  }

  private bodyNotIndexedAdvice(): string {
    return 'Hudu search does not match article body content, and no body index is loaded yet: call this tool again in a moment (the index is building), or pass tier "index" to build it before answering.';
  }

  private vendorOnlyAdvice(): string {
    return 'Answered from Hudu search alone (title and custom-field values): article body terms were NOT searched. Call again once the index is warm, or pass tier "index".';
  }

  /** Full re-walk decision: deletes are invisible to `updated_at`, so this is required periodically. */
  needsFullRefresh(): boolean {
    if (this.lastFullAt === null) return true;
    return this.now() - this.lastFullAt > this.config.ttlMs * this.config.fullRefreshEvery;
  }
}

/**
 * Error code of a thrown value, defaulting to NETWORK_ERROR for a non-HuduError.
 *
 * Exported because `operations.searchAcrossResources` reports per-resource failures with the same
 * vocabulary the engine uses for `searchKnowledge`: one answer to "what code is this failure?".
 */
export function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'NETWORK_ERROR';
}

/** Local token match of a query against a vendor label (the T1 re-rank). */
export function localLabelMatch(
  terms: readonly string[],
  label: string,
  exactOnly: boolean,
): { coverage: number; terms: string[]; fuzzy: boolean } {
  if (terms.length === 0) return { coverage: 0, terms: [], fuzzy: false };
  const labelTokens = tokenizeText(label);
  const matched: string[] = [];
  let fuzzy = false;
  for (const term of terms) {
    let hit = false;
    for (const token of labelTokens) {
      if (token === term) {
        hit = true;
        break;
      }
      if (exactOnly) continue;
      if (pluralVariants(term).includes(token) || (term.length >= 3 && token.startsWith(term))) {
        hit = true;
        break;
      }
      if (term.length >= 4 && editDistanceAtMost(term, token, 1) <= 1) {
        hit = true;
        fuzzy = true;
        break;
      }
    }
    if (hit) matched.push(term);
  }
  return { coverage: matched.length / terms.length, terms: matched, fuzzy };
}

/** Article row -> index document (full HTML `content` is already on the LIST payload). */
function articleDoc(raw: Record<string, unknown>, maxDocBytes: number): SearchDoc | null {
  const id = num(raw.id);
  if (id === null) return null;
  const name = str(raw.name);
  const content = str(raw.content);
  const extracted = extractHtml(content, { maxDocBytes });
  return {
    resource: 'articles',
    id,
    title: name,
    slug: str(raw.slug),
    url: str(raw.url),
    company_id: num(raw.company_id),
    company_name: null,
    updated_at: str(raw.updated_at),
    fields: {
      title: name,
      ...(str(raw.slug) ? { slug: str(raw.slug) } : {}),
      ...(extracted.text.length > 0 ? { body: extracted.text } : {}),
    },
    longText: extracted.text.length > 0 ? extracted.text : null,
    longSource: 'article.content',
    longTruncated: extracted.bytesTruncated || extracted.charsTruncated,
  };
}

/** Asset row -> index document (name + custom-field values + the identifiers the vendor cannot see). */
function assetDoc(raw: Record<string, unknown>): SearchDoc | null {
  const id = num(raw.id);
  if (id === null) return null;
  const name = str(raw.name);
  const fields = Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>[]) : [];
  const valueLines: string[] = [];
  const labelLines: string[] = [];
  for (const field of fields) {
    const label = str(field.label);
    const value = str(field.value);
    if (label.length > 0) labelLines.push(label);
    if (value.length > 0) valueLines.push(value);
  }
  const ident = [str(raw.primary_serial), str(raw.primary_model), str(raw.primary_manufacturer), str(raw.primary_mail)]
    .filter((value) => value.length > 0)
    .join(' ');
  const longText = valueLines.join('\n');
  return {
    resource: 'assets',
    id,
    title: name,
    slug: str(raw.slug),
    url: str(raw.url),
    company_id: num(raw.company_id),
    company_name: str(raw.company_name) || null,
    updated_at: str(raw.updated_at),
    fields: {
      title: name,
      ...(str(raw.slug) ? { slug: str(raw.slug) } : {}),
      ...(ident.length > 0 ? { ident } : {}),
      ...(longText.length > 0 ? { cfield: longText } : {}),
      ...(labelLines.length > 0 ? { cflabel: labelLines.join('\n') } : {}),
    },
    longText: longText.length > 0 ? longText : null,
    longSource: 'asset.fields',
    longTruncated: false,
  };
}

/** Re-exported so the operations module can build the default engine without a second import path. */
export type { KnowledgeScoreScope, KnowledgeSearchHit };
