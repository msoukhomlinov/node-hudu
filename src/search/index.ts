/**
 * Internal search building blocks: HTML extraction and verbatim snippets.
 *
 * NOT re-exported from the package root - the public SDK surface stays unchanged.
 * A later build step (the search engine) consumes these modules directly.
 */
export {
  htmlToText, extractHtml, decodeEntities, decodeEntityBody, compactWhitespace,
  NAMED_ENTITIES, DEFAULT_MAX_DOC_BYTES, DEFAULT_MAX_OUT_CHARS,
} from './html.js';
export type { HtmlToTextOptions, ExtractedText } from './html.js';
export {
  buildSnippet, foldWithMap, foldText,
  MAX_SNIPPET_CHARS, DEFAULT_SNIPPET_CHARS, DEFAULT_MAX_SPANS, DEFAULT_MAX_OCC_PER_TERM,
  MAX_BOUNDARY_EXPANSION,
} from './snippet.js';
export type {
  FoldResult, SnippetSpan, SnippetOptions, SnippetResult, SnippetUnavailableReason,
} from './snippet.js';
export {
  KnowledgeSearchEngine, DEFAULT_ENGINE_CONFIG, DEFAULT_SCOPE, KNOWLEDGE_RESOURCES,
  MAX_SEARCH_LIMIT, MAX_SEARCH_SNIPPET_CHARS, DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_SNIPPET_CHARS,
  MAX_PREFIX_EXPANSIONS, localLabelMatch, resolveScope, resolveSearchLimit,
} from './engine.js';
export type { EngineConfig, EngineDeps, EngineStatus, VendorRow } from './engine.js';
export {
  KnowledgeIndex, DEFAULT_INDEX_BOUNDS, FIELD_WEIGHTS, INDEX_FIELDS, utf8Bytes,
} from './index-store.js';
export type { FieldStats, IndexBounds, IndexField, LongTextSource, Posting, SearchDoc } from './index-store.js';
export {
  STOPWORDS, MAX_COMPACT_CHARS, MIN_FUZZY_CHARS, MIN_FUZZY_BODY_CHARS, DICE_FLOOR, MAX_FUZZY_CANDIDATES,
  normaliseText, tokenizeNormalised, tokenizeText, tokenizeField, splitQueryTerms, compactOfQuery,
  pluralVariants, ngramsOf, diceCoefficient, editDistanceAtMost, editBudget,
} from './tokenize.js';
export type { FieldTokens, QueryTerms } from './tokenize.js';
