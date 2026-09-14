/**
 * HTML -> clean plain text for the search pipeline.
 *
 * INTERNAL module: deliberately NOT re-exported from the package root (that would
 * change the public surface). Design of record: `html-and-snippets.md` S2 (search design doc,
 * kept outside this repo).
 *
 * The scanner is a single O(n) character pass and never uses a tag-stripping regex.
 * Measured against real Hudu markup, `<[^>]*>` stripping is wrong in four ways:
 *   1. it leaks `<script>`/`<style>` bodies (Hudu stores them verbatim);
 *   2. a bare `<` in text (`if (1<2)`) makes it swallow everything up to the next `>` -
 *      silent content loss;
 *   3. it does not decode entities, so `&nbsp;`-separated words never match;
 *   4. it inserts no separator where a tag was, so adjacent table cells glue together
 *      (`Low EndFortiGateRugged-35D` instead of `Low End FortiGateRugged-35D`).
 *
 * Output contract (guarantees tested in `test/search/html.test.ts`):
 *   - no markup survives, including raw-skipped element bodies (`script`, `style`, ...)
 *   - the separator alphabet is exactly `{ ' ', '\n' }`; no double newline, no space next
 *     to a newline, no repeated space, no leading/trailing whitespace
 *   - separators are INSERTED at boundaries: block element -> newline, `<br>` -> newline,
 *     table cell boundary -> space, inline element -> nothing
 *   - entities are decoded (named/decimal/hex); an UNKNOWN entity stays literal
 *   - `pre` keeps its line breaks; all other whitespace (including U+00A0) collapses to a space
 *   - offsets (for the snippet layer) are UTF-16 code units, i.e. plain JS string indices
 */

/** Default raw-input cap in UTF-8 bytes (design S4.2). Applied BEFORE scanning. */
export const DEFAULT_MAX_DOC_BYTES = 256 * 1024;

/** Default extracted-output cap in UTF-16 code units (design S4.2: 4x the raw cap worst case). */
export const DEFAULT_MAX_OUT_CHARS = 4 * DEFAULT_MAX_DOC_BYTES;

/** Elements whose whole body is dropped (never indexed). Hudu keeps `script`/`style` verbatim. */
const RAW_SKIP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'textarea', 'iframe', 'noscript', 'svg', 'math',
  'title', 'head', 'template', 'xmp', 'plaintext',
]);

/** Block-level elements: start/end emit a newline boundary. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'ul', 'ol', 'dl', 'dt', 'dd', 'section',
  'article', 'header', 'footer', 'aside', 'main', 'nav', 'figure', 'figcaption',
  'hr', 'form', 'fieldset', 'address', 'caption', 'details', 'summary',
]);

/** Table cells emit a SPACE boundary, so a row reads `Low End FortiGateRugged-35D`. */
const CELL_TAGS: ReadonlySet<string> = new Set(['td', 'th']);

/** `^\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)` applied to one tag's inner text only. */
const TAG_NAME = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/;

/** `alt` attribute on one tag's inner text only. Never run over a document. */
const ALT_ATTR = /\salt\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i;

const U_RANGE = String.fromCharCode;
const REPLACEMENT = U_RANGE(0xfffd);

/**
 * Named entities that occur in documentation prose (~150 entries, plain data).
 * An entity not in this table is left LITERAL (`&foo;` stays `&foo;`) rather than
 * dropped - Hudu itself re-escapes an unknown entity to `&amp;foo;` on write, so a
 * caller may legitimately search for it.
 */
export const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a', times: '\u00d7', divide: '\u00f7', deg: '\u00b0',
  plusmn: '\u00b1', sup2: '\u00b2', sup3: '\u00b3', sup1: '\u00b9', frac12: '\u00bd',
  frac14: '\u00bc', frac34: '\u00be', micro: '\u00b5', para: '\u00b6', sect: '\u00a7',
  middot: '\u00b7', bull: '\u2022', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  prime: '\u2032', Prime: '\u2033', ne: '\u2260', le: '\u2264', ge: '\u2265',
  larr: '\u2190', rarr: '\u2192', harr: '\u2194', uarr: '\u2191', darr: '\u2193',
  infin: '\u221e', minus: '\u2212', lowast: '\u2217', radic: '\u221a', asymp: '\u2248',
  equiv: '\u2261', sum: '\u2211', prod: '\u220f', int: '\u222b', part: '\u2202',
  nabla: '\u2207', isin: '\u2208', notin: '\u2209', ni: '\u220b', empty: '\u2205',
  cap: '\u2229', cup: '\u222a', sub: '\u2282', sup: '\u2283', sube: '\u2286',
  supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22a5', ang: '\u2220',
  and: '\u2227', or: '\u2228', not: '\u00ac', exist: '\u2203', forall: '\u2200',
  there4: '\u2234', sim: '\u223c', cong: '\u2245', prop: '\u221d', fnof: '\u0192',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5',
  zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8', iota: '\u03b9', kappa: '\u03ba',
  lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be', omicron: '\u03bf',
  pi: '\u03c0', rho: '\u03c1', sigmaf: '\u03c2', sigma: '\u03c3', tau: '\u03c4',
  upsilon: '\u03c5', phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395',
  Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039a',
  Lambda: '\u039b', Mu: '\u039c', Nu: '\u039d', Xi: '\u039e', Omicron: '\u039f',
  Pi: '\u03a0', Rho: '\u03a1', Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5',
  Phi: '\u03a6', Chi: '\u03a7', Psi: '\u03a8', Omega: '\u03a9',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  lrm: '\u200e', rlm: '\u200f', shy: '\u00ad', oelig: '\u0153', OElig: '\u0152',
  scaron: '\u0161', Scaron: '\u0160', yuml: '\u00ff', Yuml: '\u0178',
  aacute: '\u00e1', Aacute: '\u00c1', acirc: '\u00e2', Acirc: '\u00c2',
  agrave: '\u00e0', Agrave: '\u00c0', aring: '\u00e5', Aring: '\u00c5',
  atilde: '\u00e3', Atilde: '\u00c3', auml: '\u00e4', Auml: '\u00c4',
  aelig: '\u00e6', AElig: '\u00c6', ccedil: '\u00e7', Ccedil: '\u00c7',
  eacute: '\u00e9', Eacute: '\u00c9', ecirc: '\u00ea', Ecirc: '\u00ca',
  egrave: '\u00e8', Egrave: '\u00c8', euml: '\u00eb', Euml: '\u00cb',
  iacute: '\u00ed', Iacute: '\u00cd', icirc: '\u00ee', Icirc: '\u00ce',
  igrave: '\u00ec', Igrave: '\u00cc', iuml: '\u00ef', Iuml: '\u00cf',
  ntilde: '\u00f1', Ntilde: '\u00d1', oacute: '\u00f3', Oacute: '\u00d3',
  ocirc: '\u00f4', Ocirc: '\u00d4', ograve: '\u00f2', Ograve: '\u00d2',
  oslash: '\u00f8', Oslash: '\u00d8', otilde: '\u00f5', Otilde: '\u00d5',
  ouml: '\u00f6', Ouml: '\u00d6', szlig: '\u00df', uacute: '\u00fa',
  Uacute: '\u00da', ucirc: '\u00fb', Ucirc: '\u00db', ugrave: '\u00f9',
  Ugrave: '\u00d9', uuml: '\u00fc', Uuml: '\u00dc', yacute: '\u00fd', Yacute: '\u00dd',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  curren: '\u00a4', brvbar: '\u00a6', ordf: '\u00aa', ordm: '\u00ba', iexcl: '\u00a1',
  iquest: '\u00bf', cedil: '\u00b8', acute: '\u00b4', uml: '\u00a8', macr: '\u00af',
  circ: '\u02c6', tilde: '\u02dc',
});

/** Options for {@link extractHtml} / {@link htmlToText}. */
export interface HtmlToTextOptions {
  /** Raw-input cap in UTF-8 BYTES, applied before scanning. Default {@link DEFAULT_MAX_DOC_BYTES}. */
  maxDocBytes?: number;
  /** Extracted-output cap in UTF-16 code units. Default {@link DEFAULT_MAX_OUT_CHARS}. */
  maxOutChars?: number;
}

/** Result of {@link extractHtml}: the text plus the truncation facts (never silent). */
export interface ExtractedText {
  /** The extracted, normalised plain text. */
  text: string;
  /** UTF-8 byte length of the raw input as received. */
  rawBytes: number;
  /** UTF-8 byte length of the raw input actually scanned (after `maxDocBytes`). */
  scannedBytes: number;
  /** Raw input was cut at `maxDocBytes` before scanning. */
  bytesTruncated: boolean;
  /** Extraction stopped at `maxOutChars`. */
  charsTruncated: boolean;
}

/** True for every code point treated as whitespace (all fold to a normal space outside `pre`). */
function isSpaceCode(code: number): boolean {
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d) return true;
  if (code === 0x85) return true;
  if (code === 0xa0 || code === 0x1680 || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000) return true;
  if (code === 0x200b || code === 0xfeff) return true;
  return code >= 0x2000 && code <= 0x200a;
}

/** Other C0/C1 controls (and lone DEL) are dropped from the text. */
function isDroppedControl(code: number): boolean {
  if (code < 0x20) return true;
  if (code === 0x7f) return true;
  return code >= 0x80 && code <= 0x9f;
}

/**
 * Decode one entity body (the text between `&` and `;`).
 * Returns `undefined` when the body is not a recognised reference, in which case the
 * caller keeps the `&` literal. Out-of-range and C1 numeric references become U+FFFD.
 */
export function decodeEntityBody(body: string): string | undefined {
  if (body.length === 0) return undefined;
  if (body.charCodeAt(0) === 0x23 /* # */) {
    const hex = body.length > 1 && (body[1] === 'x' || body[1] === 'X');
    const digits = body.slice(hex ? 2 : 1);
    if (digits.length === 0) return undefined;
    for (let i = 0; i < digits.length; i++) {
      const c = digits.charCodeAt(i);
      const ok = hex ? (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
        : c >= 0x30 && c <= 0x39;
      if (!ok) return undefined;
    }
    const value = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isFinite(value) || value === 0 || value > 0x10ffff) return REPLACEMENT;
    if (value >= 0xd800 && value <= 0xdfff) return REPLACEMENT;
    if (value >= 0x80 && value <= 0x9f) return REPLACEMENT;
    return String.fromCodePoint(value);
  }
  const first = body.charCodeAt(0);
  const isAlpha = (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
  if (!isAlpha) return undefined;
  for (let i = 1; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const ok = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
    if (!ok) return undefined;
  }
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : undefined;
}

/**
 * Decode every entity in one text run. A `;` more than 12 characters after the `&`
 * is not a terminator (so prose containing a bare `&` cannot scan to a distant `;`).
 */
export function decodeEntities(text: string): string {
  if (text.indexOf('&') < 0) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const amp = text.indexOf('&', i);
    if (amp < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    // The terminator must sit within 12 characters, so the scan itself is bounded - a document
    // of 100k bare `&` with no `;` must stay O(n), not O(n^2).
    const limit = Math.min(n, amp + 13);
    let semi = -1;
    for (let k = amp + 1; k < limit; k++) {
      if (text.charCodeAt(k) === 0x3b) {
        semi = k;
        break;
      }
    }
    if (semi < 0) {
      out += '&';
      i = amp + 1;
      continue;
    }
    const decoded = decodeEntityBody(text.slice(amp + 1, semi));
    if (decoded === undefined) {
      out += '&';
      i = amp + 1;
      continue;
    }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

/** Map decoded characters to the separator alphabet: whitespace -> ' ' (or a hard '\n' inside `pre`). */
function normaliseRun(text: string, inPre: boolean): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const code = text.codePointAt(i) as number;
    const width = code > 0xffff ? 2 : 1;
    if (isSpaceCode(code)) {
      out += inPre && code === 0x0a ? '\n' : ' ';
    } else if (!isDroppedControl(code)) {
      out += width === 2 ? text.slice(i, i + 2) : text.charAt(i);
    }
    i += width;
  }
  return out;
}

/** Index of the tag-terminating `>`, honouring quoted attribute values; -1 when the tag is left open. */
function findTagEnd(source: string, start: number): number {
  let i = start + 1;
  const n = source.length;
  let quote = 0;
  while (i < n) {
    const c = source.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 0x22 || c === 0x27) {
      quote = c;
    } else if (c === 0x3e) {
      return i;
    }
    i++;
  }
  return -1;
}

/** Case-insensitive, allocation-free find of `</name` + terminator; returns the index AFTER its `>`. */
function findRawClose(source: string, name: string, from: number): number {
  const n = source.length;
  for (let k = from; k < n; k++) {
    if (source.charCodeAt(k) !== 0x3c) continue;
    if (source.charCodeAt(k + 1) !== 0x2f) continue;
    if (k + 2 + name.length > n) break;
    let match = true;
    for (let t = 0; t < name.length; t++) {
      const c = source.charCodeAt(k + 2 + t);
      const lowered = c >= 0x41 && c <= 0x5a ? c + 32 : c;
      if (lowered !== name.charCodeAt(t)) { match = false; break; }
    }
    if (!match) continue;
    const after = source.charCodeAt(k + 2 + name.length);
    // `</scriptx` is not a close tag: the next character must end the name.
    const ends = after === 0x3e || after === 0x20 || after === 0x09 || after === 0x0a || after === 0x0d || after === 0x2f;
    if (!ends) continue;
    const gt = source.indexOf('>', k + 2 + name.length);
    return gt < 0 ? -1 : gt + 1;
  }
  return -1;
}

/** `alt` of an `img` tag (decoded, collapsed); attribute values are read from the tag text only. */
function readAlt(tagText: string): string | undefined {
  const m = ALT_ATTR.exec(tagText);
  if (m === null) return undefined;
  const raw = m[2] ?? m[3] ?? m[4];
  if (raw === undefined || raw.length === 0) return undefined;
  const collapsed = normaliseRun(decodeEntities(raw), false).replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? undefined : collapsed;
}

/**
 * Final linear compaction of the emitted runs: one pass, no markup in sight.
 * Enforces the separator alphabet and guarantees no leading/trailing whitespace,
 * no space adjacent to a newline, no repeated space, no double newline.
 */
export function compactWhitespace(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x0a) {
      let hasNewline = false;
      let j = i;
      while (j < n) {
        const w = text.charCodeAt(j);
        if (w === 0x0a) hasNewline = true;
        else if (w !== 0x20) break;
        j++;
      }
      if (j >= n) break; // trailing whitespace never becomes a separator
      if (out.length > 0) out += hasNewline ? '\n' : ' ';
      i = j;
      continue;
    }
    out += text.charAt(i);
    i++;
  }
  return out;
}

/** Truncate a raw string to at most `maxBytes` UTF-8 bytes (binary search; only runs when over cap). */
function truncateToBytes(html: string, maxBytes: number): string {
  let lo = 0;
  let hi = html.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(html.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return html.slice(0, lo);
}

/**
 * Extract plain text from an HTML fragment, with truncation reported.
 *
 * @example
 * extractHtml('<td>Low End</td><td>FortiGateRugged-35D</td>').text
 * // 'Low End FortiGateRugged-35D'
 */
export function extractHtml(html: string, opts: HtmlToTextOptions = {}): ExtractedText {
  const maxDocBytes = opts.maxDocBytes ?? DEFAULT_MAX_DOC_BYTES;
  const maxOutChars = opts.maxOutChars ?? DEFAULT_MAX_OUT_CHARS;
  const rawBytes = Buffer.byteLength(html, 'utf8');
  const bytesTruncated = rawBytes > maxDocBytes;
  const source = bytesTruncated ? truncateToBytes(html, maxDocBytes) : html;
  const scannedBytes = bytesTruncated ? Buffer.byteLength(source, 'utf8') : rawBytes;

  const parts: string[] = [];
  let outLen = 0;
  let pending = '';
  let charsTruncated = false;

  const emit = (text: string): void => {
    if (text.length === 0) return;
    if (outLen >= maxOutChars) {
      charsTruncated = true;
      return;
    }
    let t = text;
    if (outLen + t.length > maxOutChars) {
      t = t.slice(0, maxOutChars - outLen);
      charsTruncated = true;
    }
    if (t.length === 0) return;
    if (parts.length > 0 && pending !== '') {
      parts.push(pending);
      outLen += pending.length;
    }
    pending = '';
    parts.push(t);
    outLen += t.length;
  };

  const emitRun = (raw: string, inPre: boolean): void => {
    emit(normaliseRun(decodeEntities(raw), inPre));
  };

  /** A cell boundary is a space, but a newline already pending always wins. */
  const setPendingSpace = (): void => {
    if (pending !== '\n') pending = ' ';
  };

  let i = 0;
  let preDepth = 0;
  const n = source.length;

  while (i < n) {
    if (outLen >= maxOutChars) {
      charsTruncated = true;
      break;
    }
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      emitRun(source.slice(i), preDepth > 0);
      break;
    }
    if (lt > i) emitRun(source.slice(i, lt), preDepth > 0);

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) break; // unterminated comment: drop to EOF, bounded
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      emitRun(end < 0 ? source.slice(lt + 9) : source.slice(lt + 9, end), preDepth > 0);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    const tagEnd = findTagEnd(source, lt);
    if (tagEnd < 0) break; // tag left open at EOF: drop to EOF, bounded
    const tagText = source.slice(lt + 1, tagEnd);
    const m = TAG_NAME.exec(tagText);
    if (m === null) {
      i = tagEnd + 1;
      continue;
    }
    const closing = m[1] === '/';
    const name = (m[2] as string).toLowerCase();

    if (RAW_SKIP_TAGS.has(name)) {
      if (closing) {
        i = tagEnd + 1;
        continue;
      }
      const close = findRawClose(source, name, tagEnd + 1);
      if (close < 0) {
        i = n; // unclosed raw-skip element: its body never leaks
        break;
      }
      i = close;
      continue;
    }

    if (name === 'pre') {
      const selfClosing = tagText.charCodeAt(tagText.length - 1) === 0x2f;
      if (closing) {
        if (preDepth > 0) preDepth--;
      } else if (!selfClosing) {
        preDepth++;
      }
      pending = '\n'; // `pre` is a block element as well as a line-break-preserving one
      i = tagEnd + 1;
      continue;
    }

    if (name === 'br') {
      pending = '\n';
      i = tagEnd + 1;
      continue;
    }

    if (name === 'img') {
      const alt = readAlt(tagText);
      if (alt !== undefined) emitRun(alt, preDepth > 0);
      i = tagEnd + 1;
      continue;
    }

    if (BLOCK_TAGS.has(name)) pending = '\n';
    else if (CELL_TAGS.has(name)) setPendingSpace();

    i = tagEnd + 1;
  }

  return {
    text: compactWhitespace(parts.join('')),
    rawBytes,
    scannedBytes,
    bytesTruncated,
    charsTruncated,
  };
}

/** Extract plain text from an HTML fragment. Thin wrapper over {@link extractHtml}. */
export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  return extractHtml(html, opts).text;
}
