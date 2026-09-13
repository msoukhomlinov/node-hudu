/**
 * Tokeniser and fuzzy primitives for the knowledge search engine.
 *
 * Design of record: `.run/design/search/engine-design.md` S2. This module is INTERNAL (not
 * re-exported from the package root) and has zero dependencies.
 *
 * The pipeline is deliberately not a stemmer: NFKD fold -> camelCase split on lower->upper
 * boundaries only -> lowercase -> non-letter/digit to space -> whitespace collapse -> tokens
 * (CJK runs become bigrams, plus the whole run when it is 1-2 characters) -> one synthetic
 * "compact" token per field. Prefix expansion and a minimal plural fold replace Porter/Snowball
 * stemming, which over-roots product codes on an IT-documentation corpus and is invisible to the
 * reader when it goes wrong.
 *
 * The camelCase rule is `(?<=[a-z])(?=[A-Z])`, NOT `[a-z0-9]`: with the digit-adjacent rule the
 * serial `7GH2K83` tokenises to `['7','gh2','k83']` and `search('7gh2k84')` finds nothing.
 * Digit-adjacent uppercase is a code, not a word boundary.
 */

/** Common English words that are dropped from SCORING (never from snippet context). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'how',
  'in', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was',
  'were', 'what', 'when', 'where', 'which', 'will', 'with', 'you', 'your',
]);

/** A field's compact token is emitted only when the normalised field is at most this long. */
export const MAX_COMPACT_CHARS = 32;

/** Fuzzy matching is allowed from this token length on, for the fields that allow it at all. */
export const MIN_FUZZY_CHARS = 3;
/** Body prose only tolerates typos from this length (shorter tokens generate near-random hits). */
export const MIN_FUZZY_BODY_CHARS = 6;
/** Dice gate for candidates of a token this long or longer. */
export const DICE_MIN_CHARS = 6;
/** Minimum trigram Dice similarity for a long token's fuzzy candidate. */
export const DICE_FLOOR = 0.4;
/** Maximum fuzzy candidates kept per query token. */
export const MAX_FUZZY_CANDIDATES = 5;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const COMBINING_RE = /\p{M}+/gu;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const WS_RE = /\s+/g;

/** Normalise text for matching: NFKD, accent fold, camelCase split, lowercase, punctuation to space. */
export function normaliseText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  const folded = input.normalize('NFKD').replace(COMBINING_RE, '');
  const split = folded.replace(/([a-z])([A-Z])/g, '$1 $2');
  return split.toLowerCase().replace(NON_WORD_RE, ' ').replace(WS_RE, ' ').trim();
}

/** Tokenise already-normalised text (whitespace separated, CJK runs expanded to bigrams). */
export function tokenizeNormalised(normalised: string): string[] {
  if (normalised.length === 0) return [];
  const out: string[] = [];
  for (const part of normalised.split(' ')) {
    if (part.length === 0) continue;
    if (CJK_RE.test(part)) {
      const chars = Array.from(part);
      if (chars.length <= 2) {
        // A 1-2 character run has no bigram to speak of: the run itself is the token.
        out.push(part);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i += 1) out.push(`${chars[i]}${chars[i + 1]}`);
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Normalise then tokenise. */
export function tokenizeText(input: string): string[] {
  return tokenizeNormalised(normaliseText(input));
}

/** One field's tokens plus its synthetic compact token (null when it adds nothing). */
export interface FieldTokens {
  tokens: string[];
  compact: string | null;
}

/**
 * Tokenise one indexed field. The compact token is the whole normalised field with whitespace
 * removed, so a query like `checklist onboarding` matches a title stored as `checklist-onboarding`
 * even though the two words were never adjacent in that order.
 */
export function tokenizeField(input: string): FieldTokens {
  const normalised = normaliseText(input);
  if (normalised.length === 0) return { tokens: [], compact: null };
  const tokens = tokenizeNormalised(normalised);
  const compactForm = normalised.replace(WS_RE, '');
  const compact =
    normalised.includes(' ') && compactForm.length > 0 && compactForm.length <= MAX_COMPACT_CHARS
      ? compactForm
      : null;
  return { tokens, compact };
}

/** Query terms after normalisation, with stopwords dropped unless that would empty the query. */
export interface QueryTerms {
  /** Terms used for scoring. */
  terms: string[];
  /** Terms dropped as stopwords (kept for the reader, never for a score). */
  dropped: string[];
}

export function splitQueryTerms(query: string): QueryTerms {
  const tokens = tokenizeText(query);
  const kept = tokens.filter((t) => !STOPWORDS.has(t));
  if (kept.length === 0) return { terms: tokens, dropped: [] };
  return { terms: kept, dropped: tokens.filter((t) => STOPWORDS.has(t)) };
}

/** The compact form of a whole query, used to reach a field's compact token. */
export function compactOfQuery(terms: readonly string[]): string | null {
  if (terms.length < 2) return null;
  const joined = terms.join('');
  return joined.length > 0 && joined.length <= MAX_COMPACT_CHARS ? joined : null;
}

/** Singular/plural variants of a term (the minimal plural fold, sym-directional). */
export function pluralVariants(term: string): string[] {
  const out: string[] = [];
  if (term.length >= 4 && term.endsWith('s')) {
    const singular = term.slice(0, -1);
    if (singular.length >= 3) out.push(singular);
  } else if (term.length >= 3) {
    out.push(`${term}s`);
  }
  return out;
}

/**
 * Character n-grams of a token: bigrams below 6 characters, trigrams from 6 on (and the token
 * itself below 3). Bigrams for short tokens are what let `vps` reach `vpn`: a 3-character token has
 * exactly one trigram, so a single typo would share NO trigram and candidate generation would miss
 * the match entirely — the design's flagship typo case (PROPOSAL §6 E1).
 */
export function ngramsOf(token: string): string[] {
  if (token.length < 3) return [token];
  const size = token.length < 6 ? 2 : 3;
  const out: string[] = [];
  for (let i = 0; i + size <= token.length; i += 1) out.push(token.slice(i, i + size));
  return out;
}

/** N-gram Dice similarity of two tokens (0 when they share no gram). */
export function diceCoefficient(a: string, b: string): number {
  const ta = ngramsOf(a);
  const tb = ngramsOf(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  let shared = 0;
  for (const t of ta) if (setB.has(t)) shared += 1;
  return (2 * shared) / (ta.length + tb.length);
}

/**
 * Banded Levenshtein distance with early exit: returns the true distance when it is <= k and
 * `k + 1` otherwise. `k` is at most 2 on this engine, so the band keeps it cheap.
 */
export function editDistanceAtMost(a: string, b: string, k: number): number {
  if (a === b) return 0;
  if (k <= 0) return k + 1;
  if (Math.abs(a.length - b.length) > k) return k + 1;
  const n = a.length;
  const m = b.length;
  const over = k + 1;
  let previous = new Array<number>(m + 1).fill(over);
  let current = new Array<number>(m + 1).fill(over);
  for (let j = 0; j <= Math.min(m, k); j += 1) previous[j] = j;
  for (let i = 1; i <= n; i += 1) {
    current.fill(over);
    const from = Math.max(1, i - k);
    const to = Math.min(m, i + k);
    current[0] = i <= k ? i : over;
    let rowMin = current[0] as number;
    for (let j = from; j <= to; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      const capped = value > k ? over : value;
      current[j] = capped;
      if (capped < rowMin) rowMin = capped;
    }
    if (rowMin > k) return over;
    const swap = previous;
    previous = current;
    current = swap;
  }
  const distance = previous[m] as number;
  return distance > k ? over : distance;
}

/** The edit budget for a token: 1 for short tokens, 2 from 7 characters on. */
export function editBudget(token: string): number {
  return token.length <= 6 ? 1 : 2;
}
