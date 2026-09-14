/**
 * Snippet builder: verbatim slices with absolute UTF-16 spans.
 *
 * INTERNAL module: deliberately NOT re-exported from the package root (that would
 * change the public surface). Design of record: `html-and-snippets.md` S3 (search design doc,
 * kept outside this repo).
 *
 * The honesty contract, stated once and tested in `test/search/snippet.test.ts`:
 *
 *   1. `text` is EXACTLY `extracted.slice(textStart, textEnd)`. No ellipsis character is
 *      ever injected; "there is more" is carried by `truncated.before` / `truncated.after`.
 *   2. `spans[i].start` / `.end` are ABSOLUTE offsets into the same extracted text the
 *      caller's `text` was sliced from, so `extracted.slice(span.start, span.end)` reads back
 *      the matched characters. A match that cannot be located produces NO span - never an
 *      invented highlight, never a paraphrase.
 *   3. A term that matches nowhere returns `available: false` with empty spans. The caller
 *      passes `noMatchReason` to say why (e.g. a title-only match: nothing in the body).
 *
 * Locating is done on a FOLDED copy of the document (lowercase + NFKD, length-preserving,
 * with an index map back to the original), so matching is case- and accent-insensitive while
 * the emitted span still points at the original characters. The fold is built on demand and
 * never stored.
 */

/** Hard cap on `snippetChars` (design S3.3 / `PROPOSAL.md`). */
export const MAX_SNIPPET_CHARS = 400;
/** Default snippet window in UTF-16 code units. */
export const DEFAULT_SNIPPET_CHARS = 200;
/** Default cap on merged spans per snippet. */
export const DEFAULT_MAX_SPANS = 8;
/** Default cap on occurrences collected per term. */
export const DEFAULT_MAX_OCC_PER_TERM = 16;
/** Word-boundary expansion is capped at this many characters per side. */
export const MAX_BOUNDARY_EXPANSION = 64;

const COMBINING_ONLY = /^\p{M}*$/u;
const IS_COMBINING = /^\p{M}$/u;

/** A folded copy of `text` plus the map from folded UTF-16 units back to source units. */
export interface FoldResult {
  /** Length-preserving fold: `folded.length === text.length` for every input. */
  folded: string;
  /** `map[i]` is the source index of folded unit `i`; `map[folded.length]` is `text.length`. */
  map: Int32Array;
}

/** Fold one source code point (string of width 1 or 2), or return it unchanged. */
function foldCodePoint(source: string): string {
  const nfkd = source.toLowerCase().normalize('NFKD');
  const cp = nfkd.codePointAt(0);
  if (cp === undefined) return source;
  const first = String.fromCodePoint(cp);
  if (first.length !== source.length) return source; // would break offset preservation
  if (IS_COMBINING.test(first)) return source;
  if (!COMBINING_ONLY.test(nfkd.slice(first.length))) return source;
  return first;
}

/**
 * Build the folded form of `text` together with its index map.
 *
 * The fold is LENGTH-PRESERVING by construction (one source code point -> the same number
 * of UTF-16 units), so a folded offset and a source offset live in the same coordinate
 * space and `folded.length === text.length`. That is what makes the inverse map cheap.
 */
export function foldWithMap(text: string): FoldResult {
  const n = text.length;
  const map = new Int32Array(n + 1);
  const out: string[] = [];
  let fi = 0;
  let i = 0;
  while (i < n) {
    const cp = text.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    const unit = text.slice(i, i + width);
    let f = foldCodePoint(unit);
    if (f.length !== width) f = unit;
    for (let k = 0; k < f.length; k++) map[fi + k] = i + k;
    out.push(f);
    fi += f.length;
    i += width;
  }
  map[n] = n;
  return { folded: out.join(''), map };
}

/** Folded form of `text` (lowercase + accent-stripped, length-preserving). */
export function foldText(text: string): string {
  return foldWithMap(text).folded;
}

/** One merged highlight, in ABSOLUTE offsets of the extracted text. */
export interface SnippetSpan {
  start: number;
  end: number;
  /** Query terms covered by this span (spans merge on overlap, so it may hold several). */
  terms: string[];
}

/** Why a snippet could not be produced. Never used to hide a match. */
export type SnippetUnavailableReason =
  | 'no-match-in-body'
  | 'matched-title-only'
  | 'no-span-in-shown-text'
  | 'evicted'
  | 'snippet-budget';

/** Options for {@link buildSnippet}. */
export interface SnippetOptions {
  /** Window size in UTF-16 code units; default 200, clamped to {@link MAX_SNIPPET_CHARS}. */
  snippetChars?: number;
  /** Max merged spans; default {@link DEFAULT_MAX_SPANS}. */
  maxSpans?: number;
  /** Max occurrences collected per term; default {@link DEFAULT_MAX_OCC_PER_TERM}. */
  maxOccPerTerm?: number;
  /** Where the text came from: `'body'` (default) or `'field:<label>'`. */
  source?: string;
  /** Reason to report when nothing matched; default `'no-match-in-body'`. */
  noMatchReason?: SnippetUnavailableReason;
}

/** The snippet payload returned by {@link buildSnippet}. */
export interface SnippetResult {
  available: boolean;
  reason?: SnippetUnavailableReason;
  source: string;
  /** Exactly `extracted.slice(textStart, textEnd)`; no ellipsis is ever injected. */
  text: string;
  textStart: number;
  textEnd: number;
  /** Absolute UTF-16 offsets into the extracted text, merged on overlap, capped. */
  spans: SnippetSpan[];
  /** Whether the text was cut at each side (`…` is the caller's rendering choice). */
  truncated: { before: boolean; after: boolean };
  /** Occurrences found but not represented by a span (outside the window, or over the cap). */
  omittedSpans: number;
  /** At least one term had more than `maxOccPerTerm` occurrences; the list is incomplete. */
  occurrencesCapped: boolean;
}

interface Occurrence {
  /** Folded start (same coordinate space as the source text). */
  fs: number;
  /** Folded end, exclusive. */
  fe: number;
  /** Source start, absolute. */
  start: number;
  /** Source end, exclusive, absolute. */
  end: number;
  term: string;
}

function unavailable(reason: SnippetUnavailableReason, source: string): SnippetResult {
  return {
    available: false,
    reason,
    source,
    text: '',
    textStart: 0,
    textEnd: 0,
    spans: [],
    truncated: { before: false, after: false },
    omittedSpans: 0,
    occurrencesCapped: false,
  };
}

/** True when the character ends a word in extracted text (the separator alphabet is `' '`/`'\n'`). */
function isBoundaryChar(code: number): boolean {
  return code === 0x20 || code === 0x0a;
}

/**
 * Build one snippet for `terms` from `text` (the extracted document text).
 *
 * `text` is treated as read-only: the returned `text` is a slice of it and every span
 * points into it.
 */
export function buildSnippet(text: string, terms: readonly string[], opts: SnippetOptions = {}): SnippetResult {
  const source = opts.source ?? 'body';
  const noMatchReason = opts.noMatchReason ?? 'no-match-in-body';
  const rawChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const snippetChars = Math.max(1, Math.min(MAX_SNIPPET_CHARS, Math.floor(rawChars)));
  const maxSpans = Math.max(0, opts.maxSpans ?? DEFAULT_MAX_SPANS);
  const maxOccPerTerm = Math.max(0, opts.maxOccPerTerm ?? DEFAULT_MAX_OCC_PER_TERM);

  if (text.length === 0 || terms.length === 0) return unavailable(noMatchReason, source);

  const { folded, map } = foldWithMap(text);
  const docLen = folded.length;
  const occurrences: Occurrence[] = [];
  let occurrencesCapped = false;

  for (const term of terms) {
    if (typeof term !== 'string' || term.length === 0) continue;
    const needle = foldText(term);
    if (needle.length === 0) continue;
    let from = 0;
    let found = 0;
    while (found <= maxOccPerTerm) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      if (found === maxOccPerTerm) {
        occurrencesCapped = true;
        break;
      }
      occurrences.push({
        fs: at,
        fe: at + needle.length,
        start: map[at] as number,
        end: (map[at + needle.length - 1] as number) + 1,
        term,
      });
      found++;
      from = at + 1; // overlapping occurrences are kept (a long repeated token merges into one span)
    }
  }

  if (occurrences.length === 0) return unavailable(noMatchReason, source);

  // Pick the window covering the most distinct terms, then the most occurrences; ties -> earliest.
  let bestStart = occurrences[0]?.fs ?? 0;
  let bestEnd = occurrences[0]?.fe ?? docLen;
  let bestScore = -1;
  for (const o of occurrences) {
    const matchLen = o.fe - o.fs;
    const pad = Math.max(0, Math.floor((snippetChars - matchLen) / 2));
    const ws = Math.max(0, o.fs - pad);
    const we = Math.min(docLen, o.fe + pad);
    const seen = new Set<string>();
    let count = 0;
    for (const q of occurrences) {
      if (q.fs >= ws && q.fe <= we) {
        count++;
        seen.add(q.term);
      }
    }
    const score = 1000 * seen.size + count;
    if (score > bestScore) {
      bestScore = score;
      bestStart = ws;
      bestEnd = we;
    }
  }

  const inside = occurrences.filter((o) => o.fs >= bestStart && o.fe <= bestEnd);
  let s = bestStart;
  let e = bestEnd;
  if (inside.length > 0) {
    let firstMatch = inside[0]?.start ?? 0;
    let lastMatch = inside[0]?.end ?? 0;
    for (const o of inside) {
      if (o.start < firstMatch) firstMatch = o.start;
      if (o.end > lastMatch) lastMatch = o.end;
    }
    const matchLen = lastMatch - firstMatch;
    if (matchLen > snippetChars) {
      // An over-long match is CLIPPED at its head, never expanded: the caller still sees the
      // start of the match, and `truncated.after` says the text was cut.
      s = firstMatch;
      e = Math.min(docLen, firstMatch + snippetChars);
    } else {
      // Word-boundary expansion, applied LAST. It only ever GROWS the window, so it can never
      // clip a match, and it is capped at MAX_BOUNDARY_EXPANSION characters per side - the
      // returned text is therefore at most `snippetChars + 2 * MAX_BOUNDARY_EXPANSION` long.
      let steps = 0;
      while (s > 0 && steps < MAX_BOUNDARY_EXPANSION && !isBoundaryChar(text.charCodeAt(s - 1))) {
        s--;
        steps++;
      }
      steps = 0;
      while (e < docLen && steps < MAX_BOUNDARY_EXPANSION && !isBoundaryChar(text.charCodeAt(e))) {
        e++;
        steps++;
      }
    }
  }

  // Occurrences are CLIPPED to the window (an over-long match shows as much as the window
  // holds), so every span always lies inside `[textStart, textEnd]`.
  const inWindow = occurrences
    .filter((o) => o.start < e && o.end > s)
    .map((o) => ({ start: Math.max(s, o.start), end: Math.min(e, o.end), term: o.term }))
    .sort((a, b) => a.start - b.start);
  const merged: SnippetSpan[] = [];
  for (const o of inWindow) {
    const last = merged[merged.length - 1];
    if (last !== undefined && o.start <= last.end) {
      if (o.end > last.end) last.end = o.end;
      if (!last.terms.includes(o.term)) last.terms.push(o.term);
    } else {
      merged.push({ start: o.start, end: o.end, terms: [o.term] });
    }
  }
  const spans = merged.slice(0, maxSpans).map((sp) => ({ start: sp.start, end: sp.end, terms: sp.terms.slice() }));

  if (spans.length === 0) return unavailable('no-span-in-shown-text', source);

  return {
    available: true,
    source,
    text: text.slice(s, e),
    textStart: s,
    textEnd: e,
    spans,
    truncated: { before: s > 0, after: e < text.length },
    omittedSpans: occurrences.length - spans.length,
    occurrencesCapped,
  };
}
