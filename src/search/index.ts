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
