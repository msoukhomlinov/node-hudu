/**
 * Result shapes of `operations.searchKnowledge` (the knowledge search engine).
 *
 * Design of record: `engine-design.md` S4/S5 and `PROPOSAL.md` S2-S4 (search design docs, kept
 * outside this repo). One writer per shape: the engine, the capability registry row and the MCP
 * projection all read these declarations.
 *
 * HONESTY IS THE POINT of this shape:
 *   - `meta.reasons[]` names every bound that bit; `meta.complete` is false whenever any did;
 *   - `meta.degraded` is set when a body-content query could not search bodies, so an empty hit
 *     list is never a bare lie by omission;
 *   - `meta.scoreScope` says whether the scores are comparable across resources;
 *   - `meta.errors[]` / `meta.failed[]` carry a per-resource failure instead of losing the call;
 *   - `hit.snippet.text` is a VERBATIM slice of the document's extracted text (HTML stripped) and
 *     `hit.fetch` is the call that returns the full record, because a snippet is a lossy view.
 */

/** The eight resources the engine can search (the ones with a vendor text filter). */
export type KnowledgeResource =
  | 'articles'
  | 'assets'
  | 'companies'
  | 'users'
  | 'groups'
  | 'websites'
  | 'asset_passwords'
  | 'password_folders';

/** Fields a hit can have matched, as reported to the caller. */
export type KnowledgeMatchField = 'title' | 'slug' | 'body' | 'custom_field' | 'ident';

/** Whether this response's scores may be compared across resources. */
export type KnowledgeScoreScope = 'cross-resource' | 'per-resource';

/** One matched field/term summary for a hit. */
export interface KnowledgeSearchMatch {
  /** Fields that contributed to the score. */
  fields: KnowledgeMatchField[];
  /** Query terms that actually matched (expanded terms are reported under the query term). */
  terms: string[];
  /** matchedTerms / queryTerms, 0..1. */
  coverage: number;
  /** At least one match came from edit distance (a typo-tolerant match). */
  fuzzy: boolean;
}

/** Why a snippet could not be produced. Never used to hide a match. */
export type KnowledgeSnippetReason =
  | 'not-indexed'
  | 'matched-title-only'
  | 'no-match-in-body'
  | 'no-span-in-shown-text'
  | 'snippet-budget';

/** A verbatim slice of a document's extracted text, with absolute spans. */
export interface KnowledgeSearchSnippet {
  /** Exactly `extracted.slice(textStart, textEnd)`; no ellipsis is ever injected. */
  text: string;
  /**
   * Half-open offsets INTO `text` (never into the raw HTML); empty when nothing was located.
   * `text.slice(start, end)` therefore reads back the matched characters.
   */
  spans: [number, number][];
  /**
   * Absolute offsets into the document's extracted text: `text` is EXACTLY
   * `extracted.slice(textStart, textEnd)`. Add `textStart` to a span to get the absolute position.
   */
  textStart: number;
  textEnd: number;
  /** Where the text came from. */
  source: string;
  /** The window is not the whole field (the caller decides how to render the cut). */
  truncated: boolean;
  /** False when no text could be sliced; `reason` then says why. */
  // (available:false still carries textStart/textEnd so a caller can tell where the window was.)
  available: boolean;
  reason?: KnowledgeSnippetReason;
}

/** The call that returns the full record behind a hit. */
export interface KnowledgeSearchFetch {
  /** Registry operation name, e.g. `articles.get`. */
  operation: string;
  /** Its arguments, e.g. `{ id: 28 }` or `{ companyId: 20, id: 332 }`. */
  args: Record<string, unknown>;
}

/** One ranked hit. */
export interface KnowledgeSearchHit {
  resource: KnowledgeResource;
  id: number;
  /** The record's name, verbatim. */
  title: string;
  /** Raw score; see `meta.scoreScope` before comparing across resources. */
  score: number;
  /** 1.0 for the best hit in THIS response; safe to display. */
  relevance: number;
  scoreScope: KnowledgeScoreScope;
  match: KnowledgeSearchMatch;
  snippet?: KnowledgeSearchSnippet;
  company?: { id: number; name?: string };
  updated_at?: string;
  url?: string;
  /** The call that gets the full record: snippets are a lossy view of it. */
  fetch: KnowledgeSearchFetch;
}

/** One resource's index counts. */
export interface KnowledgeIndexDocStat {
  /** Documents of this resource in the index. */
  indexed: number;
  /**
   * Documents whose body text is indexed — INCLUDING bodies that were cut at `maxDocBytes`, so this
   * count and `bodiesTruncated` overlap (a cut body is indexed AND truncated). They do not coincide:
   * a body cut down to nothing is truncated without being indexed.
   */
  bodiesIndexed: number;
  /** Documents whose raw input was cut at the byte cap (`maxDocBytes`): raise that cap to see more. */
  bodiesTruncated: number;
  /** Documents whose body text was EVICTED under the text budget (`maxIndexTextBytes`), so their
   * body terms are not searchable. Raising `maxDocBytes` does not restore this — the knob is
   * `maxIndexTextBytes` (or a smaller corpus). */
  bodiesEvicted: number;
  /** Documents seen on the last complete walk, or null when the walk was capped. */
  totalKnown: number | null;
}

/**
 * The index's own state, so a caller can tell a fresh answer from a stale one.
 *
 * With a scored generation (`scoreScope: 'cross-resource'`) every figure here describes the generation
 * the hits came from, so an answer cannot report metadata that contradicts its own hits.
 */
export interface KnowledgeIndexMeta {
  state: 'cold' | 'warm' | 'partial' | 'refreshing';
  builtAt?: string;
  ageMs?: number;
  staleness: 'fresh' | 'stale' | 'unknown';
  docs: Record<string, KnowledgeIndexDocStat>;
  /**
   * True when the index's CONTENT changed after this answer scored its rows — including a build that
   * mutated the documents and then failed, and a bare eviction, which a completed-build counter would
   * miss. The figures above still describe the generation the hits came from; a later query uses the
   * newer content.
   */
  indexChangedSinceScore: boolean;
  /** When the last FULL re-walk completed, or absent when none has (a capped or incremental index has
   * never seen the whole collection, so deletions in it are invisible). */
  lastFullAt?: string;
  /** Whether a full re-walk is due now (`lastFullAt` older than `ttlMs * fullRefreshEvery`, or none
   * yet). `staleness` says the data is old; this says whether the index has recently seen EVERYTHING. */
  fullWalkDue: boolean;
}

/** The bound that shortened this answer. */
export interface KnowledgeSearchTruncation {
  reason:
    | 'result-limit'
    | 'candidate-cap'
    | 'index-partial'
    | 'fetch-budget'
    | 'body-truncated'
    | 'body-not-indexed';
  detail: string;
  candidatesScored: number;
}

/** A resource that failed: the other resources still answered. */
export interface KnowledgeSearchError {
  resource: string;
  code: string;
  message: string;
}

/** A degradation, announced rather than implied. */
export interface KnowledgeSearchDegraded {
  reason: 'no-index' | 'vendor-only' | 'body-not-indexed';
  advice: string;
}

/** Request timings and request count. */
export interface KnowledgeSearchTimings {
  vendorMs: number;
  localMs: number;
  requests: number;
}

/** Response-level metadata: what was searched, how completely, and what bit. */
export interface KnowledgeSearchMeta {
  query: string;
  /** Query terms after normalisation and stopword handling. */
  terms: string[];
  resources: KnowledgeResource[];
  /** Documents and vendor rows that were scored. */
  scanned: number;
  returned: number;
  limit: number;
  /** False whenever any bound bit; `reasons` then names it. */
  complete: boolean;
  /** Every bound that bit, by name. */
  reasons: string[];
  truncation?: KnowledgeSearchTruncation;
  index: KnowledgeIndexMeta;
  degraded: KnowledgeSearchDegraded | null;
  /** Per-resource failures: a 5xx in one resource never loses the call. */
  errors: KnowledgeSearchError[];
  /** The same list under the name the capability plan uses. */
  failed: KnowledgeSearchError[];
  timings: KnowledgeSearchTimings;
  scoreScope: KnowledgeScoreScope;
  /** Serialised size of this response, for budget accounting. */
  bytes: number;
  /** Age of the index in ms, or null when there is no index. */
  indexAge: number | null;
}

/** The whole result of one search. */
export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  meta: KnowledgeSearchMeta;
}

/** Options of `operations.searchKnowledge`. */
export interface KnowledgeSearchOptions {
  /** Resources to search; default `['articles', 'assets']` (KB content first, assets second). */
  scope?: KnowledgeResource[];
  /** Maximum hits; default 8, maximum 25 (above it the call fails, never clamps). */
  limit?: number;
  /** Snippet window in UTF-16 code units; default 200, maximum 400. */
  snippetChars?: number;
  /** Only records of this company. */
  company_id?: number;
  /** Only records updated at or after this ISO timestamp. */
  updated_since?: string;
  /** Drop hits scoring below this raw score. */
  min_score?: number;
  /** Exact matching only: no prefix, plural, compact or fuzzy expansion. */
  exact_only?: boolean;
  /**
   * Which tier answers: `'auto'` (the default) uses the body index when it is warm and the
   * vendor-only tier otherwise; `'vendor'` forces the vendor tier; `'index'` builds the index
   * before answering, so the FIRST call already has body recall (it can take seconds on a large
   * tenant, which is exactly why the default does not do it).
   */
  tier?: 'auto' | 'vendor' | 'index';
  /** Re-walk every source before answering, dropping documents the walk no longer sees. */
  refresh?: boolean;
}
