/**
 * Hudu article HTML rules — platform facts about how Hudu's editor and renderer treat
 * article body HTML, expressed as three pure functions:
 *
 *   validateArticleHtml(html, opts?)      report problems, never fix anything
 *   normalizeArticleHtml(html)            OPT-IN, mechanically-safe fixes only
 *   diffArticleRoundTrip(sent, readBack)  spot-check what Hudu gave back
 *
 * No network, no I/O, no dependencies, no mutation of the input. Nothing here is ever
 * called automatically by a write path — see the warning on `normalizeArticleHtml`.
 *
 * ## Scope: platform, not house style
 *
 * Every rule below is a property of Hudu itself (its Tiptap/ProseMirror editor schema, its
 * published-view renderer, its container CSS). Editorial preferences — section structure,
 * heading levels, tone, title patterns, list-nesting depth — are deliberately NOT encoded.
 * In particular there is no nesting-depth check: Hudu's list extensions have no cap, so a
 * depth limit would be an opinion, not a platform fact.
 *
 * ## Evidence
 *
 * The rules were captured while authoring real Hudu KB articles. Several were verified on
 * 2026-09-16 by reading Hudu's own shipped assets rather than by guessing:
 *
 *   - the `hudu2-app-1` container CSS (alignment classes, callout variants, the
 *     auto-applied table-scroll wrapper, `<kbd>` styling);
 *   - the editor's compiled JS schema — the Tiptap node/mark extensions for callouts,
 *     accordions (details/summary), images, task lists and tables;
 *   - the published view's highlighting bootstrap script (which element the highlighter
 *     actually reads the language class from).
 *
 * Each rule below cites its own evidence line, and the audit is declared in the public
 * {@link ARTICLE_HTML_PROVENANCE} constant (per-rule dates in {@link ARTICLE_HTML_RULES}).
 * These are facts about the audited build, not permanent properties of Hudu — the editor
 * generation has changed once already, and it invalidated rules when it did.
 *
 * Two related facts are SDK behaviour rather than HTML, so they are documented on
 * `ArticlesResource` instead of encoded here: reading an article body needs the full record
 * (the compact summary drops `content`), and the `slug` filter is an exact match on the
 * stored slug. Both were established 2026-07-25.
 *
 * ## Parsing approach and its failure modes
 *
 * The SDK is deliberately zero-dependency, so this module scans with regular expressions
 * rather than parsing. That is sound for the shallow, tag-shaped questions asked here, and
 * unsound in the usual ways. Known limits, all of which degrade to "say nothing" rather
 * than to a wrong claim:
 *
 *   - tag scanning (`openTags`) and attribute reading are quote-aware, so a `>` inside an
 *     attribute value (e.g. `alt="Settings > Users"`, which is legal and ordinary) does not
 *     truncate the tag. A tag with no closing `>` at all IS skipped: no finding is reported
 *     about it, and no rewrite touches it. Two scanners are NOT quote-aware and still stop at
 *     the first `>`: the containment helper (`innerOf`) and the task-item walk. Neither has
 *     been shown to misreport on article-shaped markup, but neither is covered by the
 *     guarantee above;
 *   - the Markdown scan ignores `<pre>`/`<code>`, comments, `<script>`/`<style>` bodies and
 *     attribute values, but markup written inside those regions is otherwise treated as
 *     markup;
 *   - element containment is approximated by "the text between an opening tag and its
 *     matching closing tag", with depth counting only for the element being matched;
 *   - a truncated element (no closing tag) is scanned to the end of the input by
 *     `validateArticleHtml`, and is left completely untouched by `normalizeArticleHtml`.
 *
 * The functions therefore report what they can prove from the text and stay quiet
 * otherwise. Treat a clean result as "no known Hudu-specific fault found", not as
 * "this HTML is valid".
 */

/** Severity of a finding. `error`: Hudu breaks or rewrites this. `warning`: it surprises you. */
export type ArticleHtmlSeverity = 'error' | 'warning';

/**
 * What a finding costs the reader of the published article.
 *
 * - `content` — semantics or information disappear: a code block's language, a callout's
 *   node identity, an image's alt text, a link, a table row.
 * - `presentation` — cosmetics only: an alignment class, a scroll wrapper Hudu regenerates
 *   itself, `<kbd>` styling Hudu never had.
 *
 * The split is per rule and is grounded in the platform facts documented on each check —
 * not in taste. A caller deciding whether a lossy transform is acceptable can filter on
 * `impact === 'content'` and ignore the rest.
 */
export type ArticleHtmlImpact = 'content' | 'presentation';

/** The element family a finding is about. Lets a caller group or filter without parsing messages. */
export type ArticleHtmlElement =
  | 'body'
  | 'markup'
  | 'code'
  | 'callout'
  | 'accordion'
  | 'heading'
  | 'img'
  | 'link'
  | 'table'
  | 'taskList'
  | 'kbd';

/** What happened to the element, for round-trip findings. */
export type ArticleHtmlChange = 'stripped' | 'escaped' | 'attribute-lost' | 'restructured' | 'malformed';

/**
 * Stable, machine-readable finding codes. Consumers branch on these; the messages are
 * free to be reworded, the codes are not. Codes prefixed `ROUNDTRIP_` come from
 * {@link diffArticleRoundTrip}, the rest from {@link validateArticleHtml}.
 */
export const ARTICLE_HTML_CODES = [
  // Rule 1 — body content must be HTML.
  'MARKDOWN_SYNTAX',
  'CONTENT_NOT_HTML',
  // Rule 2 — code block language class.
  'CODE_LANGUAGE_CLASS_MISSING_ON_CODE',
  'CODE_LANGUAGE_CLASS_ABSENT',
  'CODE_LANGUAGE_CLASS_MISMATCH',
  // Rule 3 — callouts.
  'CALLOUT_NOT_DIV',
  'CALLOUT_BASE_CLASS_MISSING',
  'CALLOUT_TYPE_UNKNOWN',
  // Rule 4 — accordions.
  'ACCORDION_BODY_MISSING',
  'ACCORDION_CLASS_MISSING',
  'ACCORDION_SUMMARY_BLOCK_CONTENT',
  // Rule 5 — alignment classes.
  'ALIGN_CLASS_ON_HEADING',
  'ALIGN_CLASS_ON_IMAGE',
  // Rule 6 — table scroll wrapper.
  'TABLE_SCROLL_WRAPPER',
  // Rule 7 — task lists.
  'TASK_LIST_NOT_INTERACTIVE',
  'TASK_ITEM_MALFORMED',
  // Rule 8 — images.
  'IMG_ALT_MISSING',
  // Rule 9 — <kbd>.
  'KBD_RENDERS_UNSTYLED',
  // Round-trip diff.
  'ROUNDTRIP_BODY_EMPTY',
  'ROUNDTRIP_CONTENT_ESCAPED',
  'ROUNDTRIP_TABLE_STRUCTURE_LOST',
  'ROUNDTRIP_THEAD_DROPPED',
  'ROUNDTRIP_CODE_BLOCK_LOST',
  'ROUNDTRIP_CODE_LANGUAGE_LOST',
  'ROUNDTRIP_LINK_LOST',
  'ROUNDTRIP_IMG_LOST',
  'ROUNDTRIP_IMG_ALT_LOST',
  'ROUNDTRIP_RAW_ELEMENT_LOST',
  'ROUNDTRIP_CALLOUT_FLATTENED',
  'ROUNDTRIP_ACCORDION_FLATTENED',
  'ROUNDTRIP_TASK_STATE_LOST',
] as const;

/** One of {@link ARTICLE_HTML_CODES}. */
export type ArticleHtmlCode = (typeof ARTICLE_HTML_CODES)[number];

/**
 * Where these rules come from, and what they are therefore worth.
 *
 * Every rule in this module is a fact about ONE Hudu build, established by ONE audit on
 * 2026-09-16 that read that build's shipped assets. They are not permanent properties of
 * Hudu: the editor generation changed once already (TinyMCE → Tiptap/ProseMirror), and that
 * change invalidated several earlier rules outright.
 *
 * Staleness here is silent. If Hudu ships an editor change, `validateArticleHtml` starts
 * reporting findings that are no longer real (or misses new ones), `normalizeArticleHtml`
 * rewrites real article bodies by a stale rule, and `diffArticleRoundTrip` can call a
 * content loss cosmetic. Nothing announces any of that.
 *
 * So the provenance is part of the public API, not a comment: surface it next to results,
 * assert on `auditedOn` in your own tests, or refuse to auto-rewrite content when the audit
 * is older than you are comfortable with. Deliberately NOT included: any runtime probe of a
 * live Hudu instance. That would be network I/O, and this module is pure.
 */
export interface ArticleHtmlProvenance {
  /** ISO date of the audit these rules were read from. */
  readonly auditedOn: string;
  /** The editor generation the rules assume. */
  readonly editorGeneration: string;
  /** The editor generation it replaced — rules predating the swap do not transfer. */
  readonly supersededEditor: string;
  /** What was inspected to establish the rules. */
  readonly sources: readonly string[];
  /** Plain-language statement of the shelf life. */
  readonly caveat: string;
}

/** @see ArticleHtmlProvenance */
export const ARTICLE_HTML_PROVENANCE: ArticleHtmlProvenance = {
  auditedOn: '2026-09-16',
  editorGeneration: 'Tiptap/ProseMirror',
  supersededEditor: 'TinyMCE',
  sources: [
    "Hudu's container CSS (hudu2-app-1): alignment classes, callout variants, the auto-applied table-scroll wrapper, <kbd> styling",
    "the editor's compiled JS schema: Tiptap node/mark extensions for callouts, accordions, images, task lists, tables and lists",
    "the published view's syntax-highlighting bootstrap script: which element the language class is read from",
  ],
  caveat:
    'These rules describe the Hudu build audited on 2026-09-16. A Hudu editor or renderer change can invalidate any of them silently — re-audit before trusting them to rewrite content.',
};

/** The fixed metadata of one rule. Severity, impact and element are properties of the CODE. */
export interface ArticleHtmlRule {
  readonly severity: ArticleHtmlSeverity;
  readonly impact: ArticleHtmlImpact;
  readonly element: ArticleHtmlElement;
  /** Default change kind for a round-trip code; a finding may narrow it. */
  readonly change?: ArticleHtmlChange;
  /** ISO date this specific rule was last verified against a Hudu build. */
  readonly verifiedOn: string;
  /** ISO date this rule was first established, when that predates `verifiedOn`. */
  readonly firstVerifiedOn?: string;
}

/**
 * The rule table: severity, content-vs-presentation impact and element family for every code.
 *
 * Exported so a caller can consult the classification without running a check — for example
 * to decide, before a lossy transform, which losses are acceptable. Each `impact` call is
 * justified by the platform fact documented on the corresponding check below:
 *
 * - CONTENT when the reader loses information: Markdown that Hudu escapes away; a code
 *   block's language (the published view then highlights nothing); a callout that is not a
 *   callout node (the editor does not round-trip it as one); an accordion body the editor
 *   restructures; a `<summary>` whose block structure Tiptap strips; a task item Hudu
 *   cannot render at all; a missing `alt`.
 * - PRESENTATION when only appearance changes and the words survive: `align-*` classes the
 *   editor drops on resave; the `mce-accordion` class, which exists for caret/heading
 *   alignment CSS; a `rich_text_content__table-scroll` wrapper Hudu's renderer regenerates
 *   itself; `<kbd>`, which the Hudu editor round-trips intact and leaves merely unstyled
 *   (the Markdown conversion drops it); a `<thead>` wrapper the editor has no node for,
 *   where the `<th>` cells (which carry the header semantics and styling) survive; and
 *   a task list's non-interactivity, where every item and its checked state still render.
 */
export const ARTICLE_HTML_RULES: Readonly<Record<ArticleHtmlCode, ArticleHtmlRule>> = {
  // The Markdown rule predates the editor audit: it is a property of the content field
  // itself and was established at the skill's initial release, not read from the schema.
  MARKDOWN_SYNTAX: { severity: 'error', impact: 'content', element: 'markup', verifiedOn: '2026-04-27' },
  CONTENT_NOT_HTML: { severity: 'warning', impact: 'content', element: 'body', verifiedOn: '2026-04-27' },
  CODE_LANGUAGE_CLASS_MISSING_ON_CODE: { severity: 'error', impact: 'content', element: 'code', verifiedOn: '2026-09-16' },
  CODE_LANGUAGE_CLASS_ABSENT: { severity: 'warning', impact: 'content', element: 'code', verifiedOn: '2026-09-16' },
  CODE_LANGUAGE_CLASS_MISMATCH: { severity: 'warning', impact: 'content', element: 'code', verifiedOn: '2026-09-16' },
  CALLOUT_NOT_DIV: { severity: 'error', impact: 'content', element: 'callout', verifiedOn: '2026-09-16' },
  CALLOUT_BASE_CLASS_MISSING: { severity: 'error', impact: 'content', element: 'callout', verifiedOn: '2026-09-16' },
  CALLOUT_TYPE_UNKNOWN: { severity: 'warning', impact: 'presentation', element: 'callout', verifiedOn: '2026-09-16' },
  ACCORDION_BODY_MISSING: { severity: 'error', impact: 'content', element: 'accordion', verifiedOn: '2026-09-16' },
  ACCORDION_CLASS_MISSING: { severity: 'warning', impact: 'presentation', element: 'accordion', verifiedOn: '2026-09-16' },
  ACCORDION_SUMMARY_BLOCK_CONTENT: { severity: 'warning', impact: 'content', element: 'accordion', verifiedOn: '2026-09-16' },
  ALIGN_CLASS_ON_HEADING: { severity: 'warning', impact: 'presentation', element: 'heading', verifiedOn: '2026-09-16' },
  ALIGN_CLASS_ON_IMAGE: { severity: 'warning', impact: 'presentation', element: 'img', verifiedOn: '2026-09-16' },
  TABLE_SCROLL_WRAPPER: { severity: 'warning', impact: 'presentation', element: 'table', verifiedOn: '2026-09-16' },
  TASK_LIST_NOT_INTERACTIVE: { severity: 'warning', impact: 'presentation', element: 'taskList', verifiedOn: '2026-09-16' },
  TASK_ITEM_MALFORMED: { severity: 'error', impact: 'content', element: 'taskList', verifiedOn: '2026-09-16' },
  IMG_ALT_MISSING: { severity: 'error', impact: 'content', element: 'img', verifiedOn: '2026-09-16' },
  // First established under TinyMCE (sandbox article 3208), re-verified against Tiptap.
  KBD_RENDERS_UNSTYLED: { severity: 'warning', impact: 'presentation', element: 'kbd', verifiedOn: '2026-09-16', firstVerifiedOn: '2026-05-12' },
  ROUNDTRIP_BODY_EMPTY: { severity: 'error', impact: 'content', element: 'body', change: 'stripped', verifiedOn: '2026-07-25' },
  ROUNDTRIP_CONTENT_ESCAPED: { severity: 'error', impact: 'content', element: 'markup', change: 'escaped', verifiedOn: '2026-04-27' },
  ROUNDTRIP_TABLE_STRUCTURE_LOST: { severity: 'error', impact: 'content', element: 'table', change: 'restructured', verifiedOn: '2026-09-16' },
  ROUNDTRIP_THEAD_DROPPED: { severity: 'warning', impact: 'presentation', element: 'table', change: 'restructured', verifiedOn: '2026-09-16' },
  ROUNDTRIP_CODE_BLOCK_LOST: { severity: 'error', impact: 'content', element: 'code', change: 'stripped', verifiedOn: '2026-09-16' },
  ROUNDTRIP_CODE_LANGUAGE_LOST: { severity: 'error', impact: 'content', element: 'code', change: 'attribute-lost', verifiedOn: '2026-09-16' },
  ROUNDTRIP_LINK_LOST: { severity: 'error', impact: 'content', element: 'link', change: 'stripped', verifiedOn: '2026-09-16' },
  ROUNDTRIP_IMG_LOST: { severity: 'error', impact: 'content', element: 'img', change: 'stripped', verifiedOn: '2026-09-16' },
  ROUNDTRIP_IMG_ALT_LOST: { severity: 'error', impact: 'content', element: 'img', change: 'attribute-lost', verifiedOn: '2026-09-16' },
  ROUNDTRIP_RAW_ELEMENT_LOST: { severity: 'error', impact: 'content', element: 'markup', change: 'stripped', verifiedOn: '2026-09-17' },
  ROUNDTRIP_CALLOUT_FLATTENED: { severity: 'error', impact: 'content', element: 'callout', change: 'restructured', verifiedOn: '2026-09-17' },
  ROUNDTRIP_ACCORDION_FLATTENED: { severity: 'error', impact: 'content', element: 'accordion', change: 'restructured', verifiedOn: '2026-09-17' },
  ROUNDTRIP_TASK_STATE_LOST: { severity: 'error', impact: 'content', element: 'taskList', change: 'attribute-lost', verifiedOn: '2026-09-17' },
};

/**
 * Advisory codes fire on *correct* markup: they describe a Hudu behaviour that surprises
 * authors, not a mistake. Mute them with `opts.ignore` when you already know.
 */
export const ARTICLE_HTML_ADVISORY_CODES: readonly ArticleHtmlCode[] = ['TASK_LIST_NOT_INTERACTIVE', 'KBD_RENDERS_UNSTYLED'];

/** The callout variants Hudu's editor and CSS define (evidence: container CSS + callout node extension, 2026-09-16). */
export const HUDU_CALLOUT_TYPES = ['info', 'success', 'warning', 'danger'] as const;

/**
 * One problem found in article HTML, or one element family changed across a round trip.
 *
 * The list is meant to be filtered programmatically: branch on `code`, group by `element`,
 * gate on `impact`. `message` is for humans and its wording is not part of the contract.
 */
export interface ArticleHtmlFinding {
  /** Stable machine-readable code — branch on this, not on `message`. */
  code: ArticleHtmlCode;
  /** `error`: Hudu will break or silently rewrite this. `warning`: it will surprise you. */
  severity: ArticleHtmlSeverity;
  /** Whether the reader loses information (`content`) or only appearance (`presentation`). */
  impact: ArticleHtmlImpact;
  /** The element family this finding is about. */
  element: ArticleHtmlElement;
  /** What happened to the element. Always set by `diffArticleRoundTrip`. */
  change?: ArticleHtmlChange;
  /** Human-readable explanation. Wording is not part of the contract. */
  message: string;
  /**
   * The specific values involved — the lost hrefs, language names or alt strings — so a
   * caller can enumerate them without re-parsing `message`.
   */
  detail?: readonly string[];
  /**
   * 0-based character offset of the offending markup, when known. For a round-trip finding
   * it points into `sent`, since that is the text the caller wrote.
   */
  index?: number;
  /** Up to 80 characters of the offending markup, when known. */
  snippet?: string;
}

/** Options of {@link validateArticleHtml}. */
export interface ValidateArticleHtmlOptions {
  /** Codes to suppress — typically {@link ARTICLE_HTML_ADVISORY_CODES}. */
  ignore?: readonly string[];
}

const SNIPPET_LENGTH = 80;

/** Non-throwing string guard: anything that is not a string is treated as empty content. */
function asHtml(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Build one finding, taking severity/impact/element/change from the rule table. */
function finding(
  source: string,
  code: ArticleHtmlCode,
  message: string,
  extra?: { index?: number; detail?: readonly string[]; change?: ArticleHtmlChange },
): ArticleHtmlFinding {
  const rule = ARTICLE_HTML_RULES[code];
  const out: ArticleHtmlFinding = {
    code,
    severity: rule.severity,
    impact: rule.impact,
    element: rule.element,
    message,
  };
  const change = extra?.change ?? rule.change;
  if (change !== undefined) out.change = change;
  if (extra?.detail !== undefined && extra.detail.length > 0) out.detail = extra.detail;
  if (extra?.index !== undefined && extra.index >= 0) {
    out.index = extra.index;
    out.snippet = source.slice(extra.index, extra.index + SNIPPET_LENGTH);
  }
  return out;
}

/**
 * Walk a tag's attribute text into name → value pairs (names lower-cased).
 *
 * Walking in order matters: searching the text for `class\s*=` would also match a `class=`
 * written INSIDE another attribute's value — `<p title="<div class='callout'>">` is prose
 * about HTML, not a callout. Consuming each quoted value as a unit makes that impossible.
 * A valueless attribute (`open`, `checked`) maps to `''`, which is how the callers read it.
 */
function parseAttrs(attrs: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const re = /([a-z_:@][-\w:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  for (let m = re.exec(attrs); m !== null; m = re.exec(attrs)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!pairs.has(name)) pairs.set(name, m[3] ?? m[4] ?? m[5] ?? '');
  }
  return pairs;
}

/** Extract the `class` attribute value of a tag's attribute text ("" when absent). */
function classOf(attrs: string): string {
  return parseAttrs(attrs).get('class') ?? '';
}

/** Extract an arbitrary attribute value, or undefined when the attribute is absent. */
function attrOf(attrs: string, name: string): string | undefined {
  return parseAttrs(attrs).get(name.toLowerCase());
}

function hasClass(classValue: string, name: string): boolean {
  return classValue.split(/\s+/).includes(name);
}

/** The `language-X` token of a class attribute, or undefined. */
function languageOf(classValue: string): string | undefined {
  for (const token of classValue.split(/\s+/)) {
    if (token.startsWith('language-') && token.length > 'language-'.length) return token.slice('language-'.length);
  }
  return undefined;
}

interface OpenTag {
  index: number;
  attrs: string;
  tag: string;
}

/**
 * Read one tag's attribute text, starting just after its element name, and report where the
 * tag really ends.
 *
 * A plain `[^>]*` stops at the first `>` — including one INSIDE an attribute value, and
 * `alt="Settings > Users"` or `title="Cost > $100"` is ordinary Hudu screenshot markup. Acting
 * on those truncated attributes is how a scan invents a missing `alt` that is right there in
 * the tag, and how a rewrite splices a document at an offset inside an attribute value. So the
 * scan is quote-aware: a `>` only ends the tag when it is outside quotes.
 *
 * Returns `null` for a tag that is never closed at all — genuinely truncated input, about
 * which nothing can be concluded and which nothing here may rewrite.
 */
function readAttrs(html: string, from: number): { attrs: string; end: number } | null {
  let quote: string | null = null;
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { attrs: html.slice(from, i), end: i + 1 };
    }
  }
  return null;
}

/** Iterate opening tags of one element name (the name may be a character-class pattern). */
function* openTags(html: string, name: string): Generator<OpenTag> {
  const re = new RegExp(`<${name}\\b`, 'gi');
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const read = readAttrs(html, m.index + m[0].length);
    if (read === null) continue;
    yield { index: m.index, attrs: read.attrs, tag: html.slice(m.index, read.end) };
    // Resume after the tag, so a `<div …>` written inside an attribute value is never
    // mistaken for markup.
    re.lastIndex = read.end;
  }
}

/** Count occurrences of an opening tag. */
function countTags(html: string, name: string): number {
  return [...openTags(html, name)].length;
}

/**
 * Inner text of the element whose opening tag ends at `from`, found by depth-counting
 * `<name>` / `</name>`. Returns the rest of the input when the element is never closed —
 * callers that must not touch malformed markup check `closed`.
 */
function innerOf(html: string, name: string, from: number): { inner: string; end: number; closed: boolean } {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  for (let m = re.exec(html), depth = 1; m !== null; m = re.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return { inner: html.slice(from, m.index), end: m.index + m[0].length, closed: true };
  }
  return { inner: html.slice(from), end: html.length, closed: false };
}

/**
 * Blank out everything that is not prose (length-preserving, so offsets stay meaningful):
 * `<pre>`/`<code>` bodies, HTML comments, `<script>`/`<style>` bodies and attribute values.
 *
 * All five legitimately contain text that looks like Markdown — a code sample, a commented-out
 * note, `title="[text](url)"`, a JS string — and none of it is article prose, so none of it is
 * evidence that the author wrote Markdown into the body.
 */
function blankNonProse(html: string): string {
  const blank = (block: string): string => ' '.repeat(block.length);
  return html
    .replace(/<!--[\s\S]*?-->|<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, blank)
    .replace(/=\s*("[^"]*"|'[^']*')/g, blank);
}

/** The index of the first tag of `name` in `html` whose attributes satisfy `pick`, or -1. */
function indexOfTag(html: string, name: string, pick: (tag: OpenTag) => boolean): number {
  for (const tag of openTags(html, name)) if (pick(tag)) return tag.index;
  return -1;
}

// ---------------------------------------------------------------------------
// validateArticleHtml
// ---------------------------------------------------------------------------

type Add = (code: ArticleHtmlCode, message: string, extra?: { index?: number; detail?: readonly string[] }) => void;

/**
 * Check article body HTML against the Hudu platform rules.
 *
 * Pure: never throws (any input, including a non-string, is accepted), never mutates,
 * never performs I/O. Returns findings grouped by rule, in document order within a rule.
 *
 * A clean result means "no known Hudu-specific fault found" — see the module header for
 * the parser's limits.
 *
 * @example
 * const findings = validateArticleHtml(article.content);
 * const blocking = findings.filter((f) => f.severity === 'error' && f.impact === 'content');
 */
export function validateArticleHtml(html: string, opts?: ValidateArticleHtmlOptions): ArticleHtmlFinding[] {
  const source = asHtml(html);
  if (source.trim().length === 0) return [];

  const findings: ArticleHtmlFinding[] = [];
  const add: Add = (code, message, extra) => {
    findings.push(finding(source, code, message, extra));
  };

  checkMarkdown(source, add);
  checkCodeBlocks(source, add);
  checkCallouts(source, add);
  checkAccordions(source, add);
  checkAlignment(source, add);
  checkTableScroll(source, add);
  checkTaskLists(source, add);
  checkImages(source, add);
  checkKbd(source, add);

  const ignore = opts?.ignore;
  return ignore === undefined || ignore.length === 0 ? findings : findings.filter((f) => !ignore.includes(f.code));
}

/**
 * Rule 1 — body content must be HTML. Hudu stores the `content` field as HTML and its
 * editor strips or escapes Markdown; Markdown left in the body never renders as intended,
 * which is why this is a CONTENT impact — the reader loses the structure entirely.
 * Evidence: 2026-04-27 initial release; restated in the skill's common-mistakes ledger.
 *
 * Markdown-looking text is legitimate outside prose — a code sample about Markdown, a
 * commented-out note, an attribute value, a script string — so `blankNonProse` removes all
 * of those before scanning. What remains that still matches is prose the author wrote.
 *
 * Known trade-off, disclosed rather than fixed: a paragraph whose text wraps onto a line
 * beginning with `- ` reads as a bullet. Markdown in a Hudu body is always wrong, so the
 * check errs towards reporting.
 */
function checkMarkdown(html: string, add: Add): void {
  const scan = blankNonProse(html);
  const constructs: ReadonlyArray<readonly [RegExp, string]> = [
    [/^[ \t]*#{1,6}[ \t]+\S/m, 'a Markdown ATX heading (`# Heading`)'],
    [/^[ \t]*```/m, 'a Markdown fenced code block (```)'],
    [/^[ \t]*[-*+][ \t]+\S/m, 'a Markdown bullet list item (`- item`)'],
    [/\[[^\]\n<>]+\]\([^)\s]+\)/, 'a Markdown link (`[text](url)`)'],
    [/\*\*[^\s*][^*\n]*\*\*/, 'Markdown bold (`**text**`)'],
  ];
  for (const [re, what] of constructs) {
    const m = re.exec(scan);
    if (m !== null) {
      add('MARKDOWN_SYNTAX', `Article body must be HTML: found ${what}. Hudu strips or escapes Markdown.`, {
        index: m.index,
        detail: [what],
      });
    }
  }
  if (!/<[a-z][a-z0-9-]*(\s|\/|>)/i.test(html)) {
    add(
      'CONTENT_NOT_HTML',
      'Article body contains no HTML element. Hudu renders the content field as HTML; plain text is not wrapped in paragraphs for you.',
      { index: 0 },
    );
  }
}

/**
 * Rule 2 — the `language-X` class must be on `<code>`, not only on `<pre>`.
 * Hudu's published-view highlighting bootstrap reads the language from the `<code>`
 * element; with the class only on `<pre>`, some languages (YAML is the observed case)
 * render with no highlighting at all even though the language name is valid. CONTENT
 * impact: the language is information about the block, and the reader loses it.
 * Evidence: 2026-09-16, read against Hudu's view-mode highlighting bootstrap script.
 */
function checkCodeBlocks(html: string, add: Add): void {
  for (const pre of openTags(html, 'pre')) {
    const preEnd = pre.index + pre.tag.length;
    const { inner } = innerOf(html, 'pre', preEnd);
    const code = /<code\b/i.exec(inner);
    if (code === null) continue;
    // Quote-aware, so a `>` inside one of the <code> tag's attribute values does not hide the
    // class that follows it. A tag with no closing `>` at all is skipped: nothing to read.
    const codeTag = readAttrs(inner, code.index + code[0].length);
    if (codeTag === null) continue;
    const index = preEnd + code.index;
    const preLang = languageOf(classOf(pre.attrs));
    const codeLang = languageOf(classOf(codeTag.attrs));
    if (preLang !== undefined && codeLang === undefined) {
      add(
        'CODE_LANGUAGE_CLASS_MISSING_ON_CODE',
        `Code block declares class="language-${preLang}" on <pre> but not on <code>. Hudu's published-view highlighter reads the class from <code>, so this block renders unhighlighted.`,
        { index, detail: [preLang] },
      );
    } else if (preLang === undefined && codeLang === undefined) {
      add(
        'CODE_LANGUAGE_CLASS_ABSENT',
        'Code block has no language-X class on <pre> or <code>, so Hudu applies no syntax highlighting. Use language-plaintext for output and logs.',
        { index },
      );
    } else if (preLang !== undefined && codeLang !== undefined && preLang !== codeLang) {
      add(
        'CODE_LANGUAGE_CLASS_MISMATCH',
        `Code block declares language-${preLang} on <pre> but language-${codeLang} on <code>. Hudu highlights using the <code> class; pick one language deliberately (this is not auto-corrected).`,
        { index, detail: [preLang, codeLang] },
      );
    }
  }
}

/**
 * Rule 3 — a callout must be `<div class="callout callout-X">`.
 * Hudu's editor parses only the div form into a real callout node. A `<p class="callout-X">`
 * still picks up the CSS on first publish but is not edit-aware (no callout toolbar, toggle
 * command or slash-menu recognition) and is not preserved as a callout by the editor —
 * the node identity is lost, so this is a CONTENT impact. An unknown severity modifier is
 * PRESENTATION: the div is still a callout node, it just has no variant styling.
 * Evidence: 2026-09-16, read against the editor's callout node extension.
 *
 * BLAST RADIUS: the scan keys off any element carrying a `callout` or `callout-*` class
 * token, because that is all a regex can see. An unrelated class that happens to start
 * with `callout-` — `<section class="callout-container">`, say — is therefore reported as
 * `CALLOUT_NOT_DIV` (error/content). A consumer gating writes on errors should expect that
 * false positive and can mute the code for content it knows uses the prefix for its own
 * purposes.
 */
function checkCallouts(html: string, add: Add): void {
  for (const tag of openTags(html, '[a-z][a-z0-9-]*')) {
    const cls = classOf(tag.attrs);
    if (cls === '') continue;
    const tokens = cls.split(/\s+/);
    const modifier = tokens.find((t) => t.startsWith('callout-'));
    const base = tokens.includes('callout');
    if (modifier === undefined && !base) continue;
    const name = /^<([a-z][a-z0-9-]*)/i.exec(tag.tag)?.[1]?.toLowerCase() ?? '';
    if (name !== 'div') {
      add(
        'CALLOUT_NOT_DIV',
        `Callout is a <${name}>, not a <div>. Hudu's editor only parses <div class="callout callout-X"> as a callout node.`,
        { index: tag.index, detail: [name] },
      );
      continue;
    }
    if (!base) {
      add(
        'CALLOUT_BASE_CLASS_MISSING',
        `Callout <div> carries "${modifier ?? ''}" without the base "callout" class. Both classes are required for Hudu to parse it as a callout.`,
        { index: tag.index },
      );
    }
    const type = modifier?.slice('callout-'.length);
    if (type !== undefined && !(HUDU_CALLOUT_TYPES as readonly string[]).includes(type)) {
      add('CALLOUT_TYPE_UNKNOWN', `Unknown callout type "${type}". Hudu defines: ${HUDU_CALLOUT_TYPES.join(', ')}.`, {
        index: tag.index,
        detail: [type],
      });
    }
  }
}

/**
 * Rule 4 — accordion body content must be wrapped in `<div class="mce-accordion-body">`.
 * Without the wrapper, Hudu's editor rewrites the structure the first time the article is
 * opened and saved, so the stored HTML changes underneath you (CONTENT: the body's block
 * structure is what gets rewritten). The `mce-accordion` class on `<details>` exists for
 * the renderer's caret/heading alignment CSS, so its absence is PRESENTATION only. A block
 * element inside `<summary>` (a heading, typically) is stripped by Tiptap on save.
 * Evidence: 2026-09-16, read against the editor's details/accordion extension.
 */
function checkAccordions(html: string, add: Add): void {
  for (const details of openTags(html, 'details')) {
    const from = details.index + details.tag.length;
    const { inner } = innerOf(html, 'details', from);
    if (!hasClass(classOf(details.attrs), 'mce-accordion')) {
      add(
        'ACCORDION_CLASS_MISSING',
        'Accordion <details> has no class="mce-accordion". Hudu\'s renderer styles caret and heading alignment from that class, and the editor emits it.',
        { index: details.index },
      );
    }
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
    if (summary !== null && /<(h[1-6]|p|div|ul|ol|table)\b/i.test(summary[1] ?? '')) {
      add(
        'ACCORDION_SUMMARY_BLOCK_CONTENT',
        '<summary> contains block content. Hudu\'s editor keeps only inline content there and strips the block structure on save.',
        { index: from + summary.index },
      );
    }
    const bodyStart = summary === null ? 0 : summary.index + summary[0].length;
    const body = inner.slice(bodyStart);
    if (body.trim().length === 0) continue;
    const firstDiv = /^\s*<div\b/i.exec(body);
    const divTag = firstDiv === null ? null : readAttrs(body, firstDiv.index + firstDiv[0].length);
    // An unterminated wrapper tag proves nothing either way — stay quiet.
    if (firstDiv !== null && divTag === null) continue;
    if (divTag === null || !hasClass(classOf(divTag.attrs), 'mce-accordion-body')) {
      add(
        'ACCORDION_BODY_MISSING',
        'Accordion body is not wrapped in <div class="mce-accordion-body">. Hudu\'s editor rewrites the accordion structure on the next open/save without it.',
        { index: from + bodyStart },
      );
    }
  }
}

/**
 * Rule 5 — `class="align-*"` does not survive an editor resave on headings or images.
 * The editor strips `class` from heading nodes entirely, and the image node re-emits
 * `data-align` only, so an alignment class on an image is silently dropped on the next
 * save even though the CSS matches it on first publish. PRESENTATION: the heading and the
 * image survive, only their alignment reverts. Other blocks (paragraphs, list items) keep
 * their alignment class and are not flagged.
 * Evidence: 2026-09-16, read against the Tiptap editor JS schema.
 */
function checkAlignment(html: string, add: Add): void {
  for (const tag of openTags(html, 'h[1-6]')) {
    const align = classOf(tag.attrs).split(/\s+/).find((t) => t.startsWith('align-'));
    if (align !== undefined) {
      add(
        'ALIGN_CLASS_ON_HEADING',
        `Heading carries class="${align}". Hudu's editor strips class from headings on resave; use style="text-align: …" or leave the heading left-aligned.`,
        { index: tag.index, detail: [align] },
      );
    }
  }
  for (const tag of openTags(html, 'img')) {
    const align = classOf(tag.attrs).split(/\s+/).find((t) => t.startsWith('align-'));
    if (align !== undefined) {
      add(
        'ALIGN_CLASS_ON_IMAGE',
        `Image carries class="${align}". Hudu's image node round-trips data-align only, so the class is dropped on the next editor save — use data-align="center" or "right".`,
        { index: tag.index, detail: [align] },
      );
    }
  }
}

/**
 * Rule 6 — do not hand-add a `rich_text_content__table-scroll` wrapper.
 * Hudu's renderer wraps wide tables for horizontal scrolling itself; a hand-added wrapper
 * duplicates it. PRESENTATION: the table and every cell survive either way.
 * Evidence: 2026-09-16, read against the `hudu2-app-1` container CSS.
 */
function checkTableScroll(html: string, add: Add): void {
  for (const div of openTags(html, 'div')) {
    if (hasClass(classOf(div.attrs), 'rich_text_content__table-scroll')) {
      add(
        'TABLE_SCROLL_WRAPPER',
        'Hand-added rich_text_content__table-scroll wrapper. Hudu\'s renderer applies scroll wrapping to wide tables automatically; submit a plain <table>.',
        { index: div.index },
      );
    }
  }
}

/**
 * Rule 7 — task lists are display-only in the published article, and every task item needs
 * the full structure Hudu's task-item node emits (`data-type`, `data-checked`, the
 * `<label>` with its checkbox, and the `<div>` content wrapper) or the item does not render.
 * Non-interactivity is PRESENTATION (every item and its checked state still render, the
 * reader just cannot tick a box); a malformed item is CONTENT, because it renders as
 * nothing.
 * Evidence: 2026-09-16, read against the editor's task-list/task-item extensions and the
 * container CSS.
 */
function checkTaskLists(html: string, add: Add): void {
  for (const list of openTags(html, 'ul')) {
    if (attrOf(list.attrs, 'data-type') !== 'taskList') continue;
    const from = list.index + list.tag.length;
    const { inner } = innerOf(html, 'ul', from);
    add(
      'TASK_LIST_NOT_INTERACTIVE',
      'Task list renders display-only in the published article: readers cannot tick the boxes. Use it for a fixed, printable checklist.',
      { index: list.index },
    );
    // Walk the items SEQUENTIALLY, jumping the cursor past each item's closing tag. A task
    // item's content div may legitimately hold a nested list, and those nested <li>s are
    // not task items — scanning every <li> in the subtree would report correct markup as
    // malformed. (A nested taskList is reached by the outer loop instead, so each list and
    // each item is still visited exactly once.)
    for (let cursor = 0; ; ) {
      const open = /<li\b([^>]*)>/i.exec(inner.slice(cursor));
      if (open === null) break;
      const openAt = cursor + open.index;
      const attrs = open[1] ?? '';
      const { inner: body, end } = innerOf(inner, 'li', openAt + open[0].length);
      const wellFormed =
        attrOf(attrs, 'data-type') === 'taskItem' &&
        attrOf(attrs, 'data-checked') !== undefined &&
        /<label\b[^>]*>[\s\S]*<input\b/i.test(body) &&
        /<div\b/i.test(body);
      if (!wellFormed) {
        add(
          'TASK_ITEM_MALFORMED',
          'Task item is missing part of the structure Hudu renders: <li data-type="taskItem" data-checked="…"><label><input type="checkbox"><span></span></label><div><p>…</p></div></li>.',
          { index: from + openAt },
        );
      }
      cursor = end;
    }
  }
}

/**
 * Rule 8 — every `<img>` needs a descriptive `alt`. CONTENT: the alt text is the only
 * description a screen reader (or a failed image load) has.
 *
 * Note for verification code: on write, Hudu rewrites the `src` into a
 * `/public_photo/<slug>` reference (embedded and remote images become PublicPhoto records).
 * That rewrite is expected behaviour, not corruption — verify that an `<img>` with the
 * right `alt` is present, never that the `src` string matches what was submitted.
 * {@link diffArticleRoundTrip} treats the rewrite as expected for exactly this reason.
 */
function checkImages(html: string, add: Add): void {
  for (const img of openTags(html, 'img')) {
    const alt = attrOf(img.attrs, 'alt');
    if (alt === undefined || alt.trim().length === 0) {
      add('IMG_ALT_MISSING', '<img> has no descriptive alt attribute.', { index: img.index });
    }
  }
}

/**
 * Rule 9 — `<kbd>` survives the editor round-trip (preserved as an inline mark) but Hudu
 * carries no styling for it, so it renders as plain running text rather than a key cap.
 * PRESENTATION, and advisory: it fires on correct markup.
 * Evidence: originally verified 2026-05-12 against sandbox article 3208 under TinyMCE;
 * re-verified 2026-09-16 against the Tiptap editor.
 */
function checkKbd(html: string, add: Add): void {
  const m = /<kbd\b/i.exec(html);
  if (m !== null) {
    add(
      'KBD_RENDERS_UNSTYLED',
      '<kbd> survives Hudu\'s editor round-trip but renders unstyled (plain text, not a key cap). Use it for semantics, not for visual emphasis.',
      { index: m.index },
    );
  }
}

// ---------------------------------------------------------------------------
// normalizeArticleHtml
// ---------------------------------------------------------------------------

/**
 * Apply the mechanically-safe subset of the rules and return corrected HTML.
 *
 * **This is opt-in. The SDK NEVER calls it for you.** No `create`, `update` or any other
 * write path invokes it: silently rewriting a caller's content would be unacceptable in an
 * SDK, because the caller — not this module — owns the article body. Call it deliberately,
 * diff the result, and submit it yourself if you agree with the change.
 *
 * Only two fixes qualify as mechanically safe (one correct outcome, no judgement call):
 *
 *  1. mirror a `language-X` class from `<pre>` onto a `<code>` that has none (rule 2) —
 *     skipped when the `<code>` class attribute is single-quoted or unquoted, since it
 *     cannot be extended in place without emitting a second `class` attribute;
 *  2. unwrap a hand-added `rich_text_content__table-scroll` div (rule 6) — the wrapper's
 *     OWN attributes (any extra classes, an `id`) go with it, and the unwrap is refused
 *     outright when a literal `</div>` may sit in a comment or an attribute value.
 *
 * Everything else is reported by {@link validateArticleHtml} and left alone: a `<pre>`/
 * `<code>` language mismatch (which one did you mean?), a `<p>` callout (moving to a `<div>`
 * changes the block structure), an unwrapped accordion body (what exactly is the body?),
 * and alignment classes (dropping or translating them changes the rendering).
 *
 * Idempotent: `normalize(normalize(x)) === normalize(x)`. Never throws; a non-string input
 * returns `''`. Markup that is truncated (no closing tag) is left untouched rather than
 * guessed at.
 *
 * **Staleness matters most here.** This is the only function that changes a caller's
 * content, and it does so by rules read from one Hudu build on one day — see
 * {@link ARTICLE_HTML_PROVENANCE} (`auditedOn`, and `verifiedOn` per rule in
 * {@link ARTICLE_HTML_RULES}). If Hudu changes its editor, this function will keep
 * rewriting article bodies to the old shape and nothing will complain. Before wiring it
 * into anything automated, check the audit date, and prefer showing the diff to a human
 * over applying it blind.
 */
export function normalizeArticleHtml(html: string): string {
  const source = asHtml(html);
  if (source === '') return '';
  return unwrapTableScroll(mirrorCodeLanguage(source));
}

/**
 * Rule 2 fix: copy `language-X` from `<pre>` onto a `<code>` that carries none.
 *
 * Nothing but the `<code>` opening tag is ever touched, and only when the whole block can be
 * read: the `<pre>` must be closed, and the `<code>` tag must have a closing `>`.
 */
function mirrorCodeLanguage(html: string): string {
  let out = '';
  let cursor = 0;
  // Lowercased once: taking it per-<pre> made the scan O(blocks x document).
  const lower = html.toLowerCase();
  for (const pre of openTags(html, 'pre')) {
    const lang = languageOf(classOf(pre.attrs));
    if (lang === undefined) continue;
    const bodyFrom = pre.index + pre.tag.length;
    // A <pre> with no </pre> has no provable extent, so it is left exactly as written.
    const closeAt = lower.indexOf('</pre>', bodyFrom);
    if (closeAt === -1) continue;
    const rewrite = codeOpenTagWithLanguage(html, bodyFrom, closeAt, lang);
    // A nested <pre> can resolve to a <code> an outer one already rewrote. Emitting it again
    // would duplicate the opening tag, so anything at or behind the cursor is skipped.
    if (rewrite === null || rewrite.at < cursor) continue;
    out += html.slice(cursor, rewrite.at) + rewrite.tag;
    cursor = rewrite.end;
  }
  return cursor === 0 ? html : out + html.slice(cursor);
}

/**
 * The replacement `<code …>` opening tag for the first `<code>` between `from` and `to`, or
 * `null` when it must be left alone.
 */
function codeOpenTagWithLanguage(html: string, from: number, to: number, lang: string): { at: number; end: number; tag: string } | null {
  const found = /<code\b/i.exec(html.slice(from, to));
  if (found === null) return null;
  const at = from + found.index;
  const read = readAttrs(html.slice(0, to), at + found[0].length);
  if (read === null) return null;
  const attrs = read.attrs;
  if (languageOf(classOf(attrs)) !== undefined) return null;
  // `classOf` reads double-quoted, single-quoted AND unquoted class attributes, but only the
  // double-quoted form can be extended in place below. For the other two, prepending
  // `class="language-X"` would emit a SECOND class attribute — and a parser keeps the first
  // and discards the rest, silently destroying the caller's classes. Report it, never
  // rewrite it: degrading to silence is this module's contract.
  const hasClassAttr = parseAttrs(attrs).has('class');
  const doubleQuoted = hasClassAttr && /(?:^|[\s/])class\s*=\s*"/i.test(attrs);
  if (hasClassAttr && !doubleQuoted) return null;
  const tag = doubleQuoted
    ? `<code${attrs.replace(/((?:^|[\s/])class\s*=\s*")([^"]*)(")/i, (_m, a: string, value: string, b: string) => `${a}${value === '' ? '' : `${value} `}language-${lang}${b}`)}>`
    : `<code class="language-${lang}"${attrs}>`;
  return { at, end: read.end, tag };
}

/**
 * Rule 6 fix: remove a hand-added table-scroll wrapper, keeping its contents.
 *
 * The wrapper element's own attributes go with it — a `class="rich_text_content__table-scroll
 * keepme"` loses `keepme`, and an `id` on the wrapper is dropped too. The wrapper is markup
 * Hudu regenerates for itself, so anything hung off it was never going to survive; if you
 * need those attributes, put them on the `<table>`.
 */
function unwrapTableScroll(html: string): string {
  let out = html;
  for (;;) {
    const at = indexOfTag(out, 'div', (d) => hasClass(classOf(d.attrs), 'rich_text_content__table-scroll'));
    if (at === -1) return out;
    // The depth scan below counts `</div>` as text, so a literal `</div>` inside an HTML
    // comment or a quoted attribute value would end it early and splice the document at the
    // wrong offset — mangling a caller's article instead of failing loudly. Neither can be
    // told apart from real markup without a parser, so the whole rewrite is refused (the
    // conservative test looks at everything from the wrapper onwards).
    const region = out.slice(at);
    if (/<!--/.test(region) || /=\s*("[^"]*<\/div\b|'[^']*<\/div\b)/i.test(region)) return out;
    const opener = [...openTags(out, 'div')].find((d) => d.index === at) as OpenTag;
    const from = opener.index + opener.tag.length;
    const { inner, end, closed } = innerOf(out, 'div', from);
    // A wrapper with no closing </div> is malformed; unwrapping it would change where the
    // rest of the document nests, so leave the whole input alone.
    if (!closed) return out;
    out = out.slice(0, opener.index) + inner + out.slice(end);
  }
}

// ---------------------------------------------------------------------------
// diffArticleRoundTrip
// ---------------------------------------------------------------------------

/**
 * Compare the HTML submitted to Hudu against the HTML Hudu read back, and return an
 * enumerable list of what changed.
 *
 * Each entry names the element family (`element`), what happened to it (`change`), whether
 * the reader lost information or only appearance (`impact`), the specific values involved
 * (`detail`) and where the affected markup sits in `sent` (`index`/`snippet`). It is a
 * list, never a verdict: the caller decides what is acceptable — for example, refusing a
 * lossy transform only when `findings.some((f) => f.impact === 'content')`.
 *
 * This is a lightweight spot-check across the families that actually break in practice --
 * tables, code blocks, links, images, raw elements, callouts, accordions and task-list
 * state -- not a byte diff. Hudu legitimately reformats whitespace, reorders attributes
 * and drops a `<thead>` wrapper, and none of that costs the reader anything.
 *
 * The `src` rewrite to `/public_photo/<slug>` is **expected behaviour**: on write, Hudu
 * turns embedded and remote images into PublicPhoto records and rewrites the reference.
 * It is never reported here. Image checks therefore look at presence and `alt`, never `src`.
 *
 * Never throws; non-string inputs are treated as empty.
 *
 * ## Contract: this is a pure HTML-vs-HTML comparison
 *
 * `readBack` is NOT required to have come from Hudu, and nothing here may ever assume it
 * did. Both arguments are just HTML strings, and the comparison is defined entirely by
 * their contents. A supported caller is a local lossy transform checking itself before it
 * writes anything — the article Markdown conversion feature calls
 * `diffArticleRoundTrip(original, mdToHtml(htmlToMd(original)))` to detect its OWN
 * converter's loss, with no Hudu instance involved.
 *
 * This constraint is load-bearing because its failure mode fails OPEN. An "optimisation"
 * reasoning that Hudu would never return shape X would quietly stop detecting that same
 * shape coming out of a converter, and a caller gating a destructive write on an empty
 * result would be told nothing was lost.
 * Every check is free of assumptions about the two arguments' provenance, and each carries a
 * per-code direction policy stated in its own comment: a check that fires only when a count
 * or set present in `sent` shrinks in `readBack` is safe ONLY because its missed (increase)
 * class is normalisation or presentation in BOTH supported contexts — the local Markdown
 * round trip and the Hudu read-back — and a check whose missed direction can hide content
 * loss must fire in either direction. As of 2026-09-17 (issue #40), per-code:
 *
 * - `diffEscaped` — symmetric (increase: markup stored as escaped text; decrease WITH a
 *   real-tag count increase: an escaped prose sample re-materialising as live markup; both
 *   are content loss in either context). Prose samples inside `<pre>`/`<code>` round-trip
 *   identity (2026-09-17 probes `escaped_missed_div`, `escaped_missed_table`,
 *   `escaped_in_pre`).
 * - `diffTables` — structural (table/tr/th/td) DECREASE-only: marked's GFM output preserves
 *   plain-table row/cell counts (2026-09-17 probe `tables_missed_nothead`); KNOWN GAP:
 *   merged-cell (rowspan/colspan) tables flatten with the span silently lost (probe
 *   `tables_missed_merged`) — a spot-check limitation, not a direction. Thead check is DECREASE-only:
 *   marked adds a thead 0→1 (probe `tables_missed_nothead`) and the editor has no thead node
 *   (2026-09-16 editor table extension), so the increase direction is normalisation on the
 *   Markdown path and unreachable on read-back.
 * - `diffCodeBlocks` — DECREASE-only / before-set-only: every `<code>` and language class in
 *   `sent` re-materialises (fence info-strings derive from `sent`'s own classes; 2026-09-17
 *   probes `code_missed`, `code_missed_nolang`); neither the converter nor the editor
 *   fabricates blocks or languages.
 * - `diffLinks` — before-set-only (every href in `sent` must come back): marked GFM autolinks
 *   bare URLs, adding hrefs that were never submitted — the URL text survives, so an added
 *   href is presentation, not loss (2026-09-17 probe `links_missed_autolink`).
 * - `diffImages` — DECREASE-only / before-set-only: img and alt are identity-stable across
 *   the round trip (2026-09-17 probe `images_missed`); `src` is never compared (2026-09-16,
 *   Hudu rewrites it on write).
 * - Raw elements, callouts, accordions, task state — symmetric by construction
 *   (`diffRawElements` / `diffCallouts` / `diffAccordions` / `diffTaskState` — a count
 *   differing in EITHER direction is loss). Two scoping decisions inside `diffRawElements`
 *   (2026-09-17, issue #43): the tag name is matched exactly (`<form-row>` is not a
 *   `<form>`), and `input[type=checkbox]` inside an OPEN `<li>` is a task item, not a raw
 *   element (HTML implicit-close semantics — a checkbox after the list's end is still
 *   counted). `diffAccordions` counts the
 *   canonical form: a `<details>` nested in a counted `mce-accordion` div is inner
 *   markup, not a second accordion (2026-09-17 probes: non-canonical wrap canonicalised
 *   to one element reports nothing; a real flattening still fires).
 *
 * The fail-open duty is unchanged: a missed direction is safe ONLY because the class it
 * misses is presentation/normalisation in BOTH contexts, per the per-code lines above.
 *
 * ## What the Markdown loss guard covers — and what it does not
 *
 * **What the Markdown loss guard covers.** `diffArticleRoundTrip` spot-checks the
 * structural spine of the stored body across the HTML → Markdown → HTML round trip:
 * table structure, code blocks and their language classes, link hrefs, image presence
 * and `alt` text, elements Markdown cannot express (`script`, `svg`, `input`, … — with one
 * scoped exception: a checkbox inside a task-list item is a task item, whose loss fires
 * `ROUNDTRIP_TASK_STATE_LOST` instead), Hudu callouts, Hudu accordions, and task-list
 * check state. A write is refused when any of these is lost.
 *
 * **What it does not cover.** The guard does not detect loss of inline presentational
 * markup: `<kbd>` is dropped, `<u>` is dropped, `<s>` becomes `<del>`, and
 * `align-*` classes on headings and images are removed — all with zero findings. For
 * example, `<p>Press <kbd>Ctrl</kbd></p>` round-trips to `<p>Press Ctrl</p>` and the
 * guard reports nothing. Image `src` values are never compared (Hudu rewrites them on
 * write), and a bare `<pre>` without a `<code>` child is not counted. Merged-cell
 * (rowspan/colspan) tables flatten across the round trip with the span silently lost —
 * a spot-check limitation, not a direction (2026-09-17 probe `tables_missed_merged`).
 * A clean result means "no structural loss detected", not "lossless".
 *
 * @param sent the HTML submitted in `content`
 * @param readBack the `content` Hudu returned (remember: the compact article summary drops
 *   `content` entirely — read it with `articles.get` or `{ expand: true }`)
 */
export function diffArticleRoundTrip(sent: string, readBack: string): ArticleHtmlFinding[] {
  const before = asHtml(sent);
  const after = asHtml(readBack);
  const findings: ArticleHtmlFinding[] = [];
  const add: Add = (code, message, extra) => {
    findings.push(finding(before, code, message, extra));
  };

  if (before.trim().length === 0) return [];
  if (after.trim().length === 0) {
    add(
      'ROUNDTRIP_BODY_EMPTY',
      'Hudu returned an empty body for content that was submitted. Confirm the read fetched the full record — a compact article summary drops `content`.',
      { index: 0 },
    );
    return findings;
  }

  diffEscaped(before, after, add);
  diffTables(before, after, add);
  diffCodeBlocks(before, after, add);
  diffLinks(before, after, findings, before);
  diffImages(before, after, add);
  diffRawElements(before, after, add);
  diffCallouts(before, after, add);
  diffAccordions(before, after, add);
  diffTaskState(before, after, add);
  return findings;
}

/**
 * Markup that came back as escaped text (`&lt;table&gt;`) was not stored as markup.
 *
 * An article about HTML legitimately contains escaped samples of the very elements it also
 * uses for real, so the mere presence of `&lt;div` proves nothing: a name is only in scope
 * when a real `<name` tag exists in either argument. Direction policy (2026-09-17, issue
 * #40): the escaped count is compared in BOTH directions, because both directions hide
 * content loss — an INCREASE means real markup was stored as escaped text, and a DECREASE
 * accompanied by a real-tag count increase for the same name means an escaped prose sample
 * re-materialised as live markup (2026-09-17 probes `escaped_missed_div`,
 * `escaped_missed_table`). Prose samples inside `<pre>`/`<code>` round-trip identity
 * (probe `escaped_in_pre`), so a bare decrease never fires. Counting (rather than blanking
 * code regions) also covers a sample written outside `<pre>`.
 */
function diffEscaped(before: string, after: string, add: Add): void {
  // issue #43 item #25: exact boundary, same shape as the #13 RAW_ELEMENTS fix — `\b`
  // counted `&lt;form-row` as an escaped `form` sample.
  const escapedCount = (html: string, name: string): number =>
    (html.match(new RegExp(`&lt;/?${name}(?![\\w-])`, 'gi')) ?? []).length;
  // issue #43 item #25: same exact boundary — `\b` counted `<form-row` as a real `<form>`.
  const realCount = (html: string, name: string): number =>
    (html.match(new RegExp(`<${name}(?![\\w-])`, 'gi')) ?? []).length;
  const scoped = new Set<string>();
  for (const m of before.matchAll(/&lt;\/?([a-z][a-z0-9-]*)\b/gi)) scoped.add((m[1] ?? '').toLowerCase());
  for (const m of after.matchAll(/&lt;\/?([a-z][a-z0-9-]*)\b/gi)) scoped.add((m[1] ?? '').toLowerCase());
  const escaped = new Set<string>();
  const increased = new Set<string>();
  const decreased = new Set<string>();
  const escPair = new Map<string, [number, number]>();
  for (const name of scoped) {
    // issue #43 item #25: same exact boundary — a real `<form-row>` must not scope `form`.
    if (!new RegExp(`<${name}(?![\\w-])`, 'i').test(before) && !new RegExp(`<${name}(?![\\w-])`, 'i').test(after)) continue;
    const a = escapedCount(before, name);
    const b = escapedCount(after, name);
    if (b > a || (a > b && realCount(after, name) > realCount(before, name))) {
      escaped.add(name);
      escPair.set(name, [a, b]);
      (b > a ? increased : decreased).add(name);
    }
  }
  if (escaped.size > 0) {
    const names = [...escaped];
    if (decreased.size === 0) {
      // Increase-only direction: byte-for-byte the pre-fix message and index (F2 pin).
      add(
        'ROUNDTRIP_CONTENT_ESCAPED',
        `Hudu returned escaped text where markup was submitted: ${names.map((n) => `<${n}>`).join(', ')}. The body was stored as text, not HTML.`,
        { index: before.indexOf(`<${names[0]}`), detail: names },
      );
      return;
    }
    // Materialisation direction (F2/F3): position the finding at the escaped sample in `before`
    // (the real tag it points at does not exist there), and state ONLY the observed counts — a
    // sample dropped while unrelated real tags were added is indistinguishable from one that
    // re-materialised by count alone (F4), so no mechanism is claimed.
    const countNote = (n: string): string => {
      const [a, b] = escPair.get(n) ?? [0, 0];
      const real = decreased.has(n)
        ? `, real tag count ${realCount(before, n)}->${realCount(after, n)}`
        : '';
      return `<${n}> (escaped count ${a}->${b}${real})`;
    };
    const sentences = [
      ...[...increased].map((n) => `Escaped text increased for ${countNote(n)}`),
      `Escaped sample count decreased while live tags increased in the read-back: ${[...decreased].map(countNote).join(', ')}`,
    ];
    add(
      'ROUNDTRIP_CONTENT_ESCAPED',
      `${sentences.join('. ')}. Content may have been lost — verify before accepting the write.`,
      // issue #43 item #25: same exact boundary — the index must point at the named element's sample.
      { index: before.search(new RegExp(`&lt;/?${[...decreased][0]}(?![\\w-])`, 'i')), detail: names },
    );
  }
}

/**
 * Tables: compare row and cell counts. A dropped `<thead>` with the `<th>` cells intact is
 * known Tiptap behaviour (its schema has no `thead` node) and is PRESENTATION — the header
 * cells, which carry the semantics and the styling, survive.
 * Evidence: 2026-09-16, editor table extension.
 *
 * Direction policy (2026-09-17, issue #40): structural (table/tr/th/td) DECREASE-only — marked's
 * GFM output preserves plain-table row/cell counts (2026-09-17 probe `tables_missed_nothead`);
 * KNOWN GAP: merged-cell (rowspan/colspan) tables flatten with the span silently lost (probe
 * `tables_missed_merged`) — a spot-check limitation, not a direction. Thead check is
 * DECREASE-only: marked adds a thead 0→1 (probe `tables_missed_nothead`) and the editor has no
 * thead node, so the increase direction is normalisation on the Markdown path and unreachable
 * on read-back.
 */
function diffTables(before: string, after: string, add: Add): void {
  const counts = (html: string) => ({
    table: countTags(html, 'table'),
    tr: countTags(html, 'tr'),
    th: countTags(html, 'th'),
    td: countTags(html, 'td'),
    thead: countTags(html, 'thead'),
  });
  const a = counts(before);
  const b = counts(after);
  const index = before.search(/<table\b/i);
  const lost = (['table', 'tr', 'th', 'td'] as const).filter((k) => b[k] < a[k]);
  if (lost.length > 0) {
    add('ROUNDTRIP_TABLE_STRUCTURE_LOST', `Table structure changed: ${lost.map((k) => `<${k}> ${a[k]} sent, ${b[k]} returned`).join('; ')}.`, {
      index,
      detail: lost.map((k) => `${k}:${a[k]}->${b[k]}`),
    });
    return;
  }
  if (b.thead < a.thead) {
    add(
      'ROUNDTRIP_THEAD_DROPPED',
      'Hudu dropped a <thead> wrapper while keeping the header cells. This is expected: the editor has no thead node, and <th> carries the header styling.',
      { index, detail: [`thead:${a.thead}->${b.thead}`] },
    );
  }
}

/**
 * Code blocks: block count first, then the language classes (rule 2's failure mode).
 * DECREASE-only / before-set-only: every `<code>` and language class in `sent` re-materialises
 * (fence info-strings derive from `sent`'s own classes; 2026-09-17 probes `code_missed`,
 * `code_missed_nolang`); neither the converter nor the editor fabricates blocks or languages.
 */
function diffCodeBlocks(before: string, after: string, add: Add): void {
  const sentBlocks = countTags(before, 'code');
  const backBlocks = countTags(after, 'code');
  if (backBlocks < sentBlocks) {
    add('ROUNDTRIP_CODE_BLOCK_LOST', `Code blocks lost: ${sentBlocks} <code> sent, ${backBlocks} returned.`, {
      index: before.search(/<code\b/i),
      detail: [`code:${sentBlocks}->${backBlocks}`],
    });
    return;
  }
  const langs = (html: string): string[] => {
    const out: string[] = [];
    for (const name of ['code', 'pre'] as const) {
      for (const tag of openTags(html, name)) {
        const lang = languageOf(classOf(tag.attrs));
        if (lang !== undefined) out.push(lang);
      }
    }
    return out;
  };
  const back = langs(after);
  for (const lang of new Set(langs(before).filter((l) => !back.includes(l)))) {
    add(
      'ROUNDTRIP_CODE_LANGUAGE_LOST',
      `Code block language class "language-${lang}" was not returned by Hudu. Without it the published view applies no highlighting.`,
      { index: indexOfTag(before, '(?:code|pre)', (tag) => languageOf(classOf(tag.attrs)) === lang), detail: [lang] },
    );
  }
}

/**
 * Links: every href submitted must come back (order and surrounding markup may differ).
 * The change kind distinguishes a dropped anchor from an anchor that kept its text and
 * lost its href, because the two are different repairs.
 *
 * Direction policy (2026-09-17, issue #40): before-set-only — every href in `sent` must come
 * back; marked GFM autolinks bare URLs, adding hrefs that were never submitted (the URL text
 * survives, so an added href is presentation, not loss; 2026-09-17 probe `links_missed_autolink`).
 */
function diffLinks(before: string, after: string, findings: ArticleHtmlFinding[], source: string): void {
  const hrefs = (html: string): string[] => {
    const out: string[] = [];
    for (const tag of openTags(html, 'a')) {
      const href = attrOf(tag.attrs, 'href');
      if (href !== undefined) out.push(href);
    }
    return out;
  };
  const back = hrefs(after);
  const anchorsLost = countTags(after, 'a') < countTags(before, 'a');
  for (const href of new Set(hrefs(before).filter((h) => !back.includes(h)))) {
    findings.push(
      finding(source, 'ROUNDTRIP_LINK_LOST', `Link href not returned by Hudu: ${href}.`, {
        index: indexOfTag(before, 'a', (tag) => attrOf(tag.attrs, 'href') === href),
        detail: [href],
        change: anchorsLost ? 'stripped' : 'attribute-lost',
      }),
    );
  }
}

/**
 * Images: presence and `alt` only. `src` is deliberately not compared — Hudu rewrites it to
 * `/public_photo/<slug>` on write, which is expected behaviour, not corruption.
 *
 * Direction policy (2026-09-17, issue #40): DECREASE-only / before-set-only — img and alt are
 * identity-stable across the round trip (2026-09-17 probe `images_missed`); `src` is never
 * compared (2026-09-16, Hudu rewrites it on write).
 */
function diffImages(before: string, after: string, add: Add): void {
  const sentImgs = countTags(before, 'img');
  const backImgs = countTags(after, 'img');
  if (backImgs < sentImgs) {
    add('ROUNDTRIP_IMG_LOST', `Images lost: ${sentImgs} <img> sent, ${backImgs} returned.`, {
      index: before.search(/<img\b/i),
      detail: [`img:${sentImgs}->${backImgs}`],
    });
    return;
  }
  const alts = (html: string): string[] =>
    [...openTags(html, 'img')].map((tag) => (attrOf(tag.attrs, 'alt') ?? '').trim()).filter((alt) => alt !== '');
  const back = alts(after);
  for (const alt of new Set(alts(before).filter((a) => !back.includes(a)))) {
    add('ROUNDTRIP_IMG_ALT_LOST', `Image alt text not returned by Hudu: "${alt}".`, {
      index: indexOfTag(before, 'img', (tag) => (attrOf(tag.attrs, 'alt') ?? '').trim() === alt),
      detail: [alt],
    });
  }
}

/** The raw elements Markdown cannot express — `diffRawElements` defines what its count means. */
const RAW_ELEMENTS = [
  'script', 'style', 'iframe', 'noscript', 'svg', 'math', 'form', 'input', 'button',
  'select', 'textarea', 'object', 'embed', 'video', 'audio', 'canvas',
] as const;

/**
 * Elements Markdown cannot represent at all. Counted, not matched positionally: Hudu and
 * a converter both reorder freely, and a count change is the loss that matters.
 *
 * Two scoping decisions keep the count honest (2026-09-17, issue #43):
 *
 * - Exact tag-name boundary: `<name` must be followed by a character that is neither a
 *   word character nor a hyphen, so a custom element's name is not counted as a raw
 *   element — `<form-row>` is not a `<form>`, `<input-group>` is not an `<input>`,
 *   `<audio-note>` is not an `<audio>` (the shared `openTags` `\b` boundary WOULD count
 *   them, because `-` is a non-word character). Scoped to THIS count only: `openTags` and
 *   the other helpers keep their boundaries; the region-awareness work is deferred.
 * - `input[type=checkbox]` inside an OPEN `<li>` is excluded: that shape is a task item — the
 *   input branch of `countTaskItems` already treats it as a valid task representation — so
 *   representation churn (a Hudu read-back or converter that stores the task as
 *   `li[data-checked]` instead of, or in addition to, `<li><input type="checkbox">`) is
 *   not raw-element loss, and genuine loss of the state still fires
 *   `ROUNDTRIP_TASK_STATE_LOST`. "Open" follows HTML implicit-close semantics (see
 *   `countTaskContextCheckboxes`): a checkbox AFTER the list's end — including one whose
 *   `<li>` was only implicitly closed — is counted as a raw element again and its loss
 *   still fires this check, just like a standalone checkbox outside any list (2026-09-17
 *   probes: a GFM task list round-trips the real Markdown path with no `RAW_ELEMENT_LOST`;
 *   a lone checkbox the converter drops — or one after a list's close,
 *   `<ul><li>a<li>b</ul><input type="checkbox">` — still fires; T2 memo probes
 *   `task_input` / `raw_input`).
 *
 * Symmetric by construction -- a count differing in EITHER direction is reported, because
 * this function may not assume which argument came from Hudu.
 */
function diffRawElements(before: string, after: string, add: Add): void {
  for (const tag of RAW_ELEMENTS) {
    let b = countTagsExact(before, tag);
    let a = countTagsExact(after, tag);
    if (tag === 'input') {
      // Task-context checkboxes are task items, not raw elements (see the note above).
      b -= countTaskContextCheckboxes(before);
      a -= countTaskContextCheckboxes(after);
    }
    if (b === a) continue;
    // The index hint uses the SAME exact boundary as the count: with a plain `\b`, a lost
    // real <form> next to a <form-row> would point the hint at the custom element
    // (2026-09-17 fix-round probe K).
    add(
      'ROUNDTRIP_RAW_ELEMENT_LOST',
      `<${tag}> count changed across the round trip (${b} -> ${a}). Markdown cannot represent this element, so a transform through it silently drops the whole node.`,
      { index: before.search(new RegExp(`<${tag}(?![\\w-])`, 'i')), detail: [tag] },
    );
  }
}

/**
 * Count the opening tags of `name` with an EXACT element-name boundary: the character
 * right after `name` must be neither a word character nor a hyphen. A plain `\b` would
 * match `<form-row` as a `<form>` (a hyphen is a non-word character, so the word boundary
 * sits right after `form`); the raw-element count must not.
 */
function countTagsExact(html: string, name: string): number {
  const re = new RegExp(`<${name}(?![\\w-])`, 'gi');
  let count = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const read = readAttrs(html, m.index + m[0].length);
    if (read === null) continue;
    count += 1;
    // Resume after the tag, so a `<name …>` written inside an attribute value is never
    // mistaken for markup (same discipline as `openTags`).
    re.lastIndex = read.end;
  }
  return count;
}

/**
 * Count `input[type=checkbox]` opening tags that sit inside an OPEN `<li>` at their position —
 * the GFM/marked task-list shape (`<li><input … type="checkbox">…</li>`). These are exactly
 * the checkboxes `diffRawElements` subtracts from the raw-element count.
 *
 * "Inside an open `<li>`" follows HTML implicit-close semantics (2026-09-17 fix-round, B1-F1).
 * A single document-wide depth counter would be wrong: neither `</ul>`/`</ol>` nor an
 * implicitly-closed `<li>` resets it, so a checkbox AFTER the list's end stayed excluded.
 * So the walk tracks open elements — `<ul>`/`<ol>`/`<li>`/`</li>`/`<input>` in document
 * order: `ulDepth` counts open lists, and the stack records the `ulDepth` at which each
 * `<li>` opened. A new `<li>` implicitly closes the previous `<li>` of the SAME list, and
 * `</ul>`/`</ol>` implicitly closes every item the list still contains. A checkbox is
 * task-context (excluded from the raw count) iff the `<li>` stack is non-empty at the
 * checkbox's position; after the list's end it is a raw element again (fix-round probe:
 * lost `<ul><li>a<li>b</ul><input type="checkbox">` fires `ROUNDTRIP_RAW_ELEMENT_LOST`).
 *
 * Each tag's real attributes are read through the quote-aware `readAttrs` and the walk
 * resumes after the tag's real end, so a `<ul>`, `<li>` or `<input>` written inside an
 * attribute value is never mistaken for markup. Region-unaware like the module's other
 * scans: an `<li>` inside a `<pre>` body is taken at face value — a spot-check limitation,
 * disclosed in the module header.
 */
function countTaskContextCheckboxes(html: string): number {
  let count = 0;
  let ulDepth = 0;
  const openLi: number[] = []; // ulDepth recorded at each open <li>, in document order
  const re = /<(\/?)(ul|ol|li|input)\b/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const closing = m[1] === '/';
    const name = m[2]?.toLowerCase();
    if (name === 'ul' || name === 'ol') {
      if (closing) {
        // A list close implicitly closes every item it still contains, then the list
        // itself. The stack is non-decreasing and holds only entries at ulDepth <= the
        // current one, so those items are the trailing entries; a stray close with no
        // list open is ignored and ulDepth never goes negative.
        if (ulDepth > 0) {
          for (;;) {
            const last = openLi[openLi.length - 1];
            if (last === undefined || last < ulDepth) break;
            openLi.pop();
          }
          ulDepth -= 1;
        }
        re.lastIndex = m.index + m[0].length;
      } else {
        ulDepth += 1;
        const read = readAttrs(html, m.index + m[0].length);
        re.lastIndex = read === null ? m.index + m[0].length : read.end;
      }
    } else if (name === 'li') {
      if (closing) {
        if (openLi.length > 0) openLi.pop();
        re.lastIndex = m.index + m[0].length;
      } else {
        // HTML implicit close: a new <li> in the same list closes the previous one.
        while (openLi.length > 0 && openLi[openLi.length - 1] === ulDepth) openLi.pop();
        openLi.push(ulDepth);
        const read = readAttrs(html, m.index + m[0].length);
        re.lastIndex = read === null ? m.index + m[0].length : read.end;
      }
    } else if (!closing && openLi.length > 0) {
      const read = readAttrs(html, m.index + m[0].length);
      if (read !== null && attrOf(read.attrs, 'type') === 'checkbox') count += 1;
      re.lastIndex = read === null ? m.index + m[0].length : read.end;
    }
  }
  return count;
}

/**
 * Callouts: counted by the base `callout` class token, order-independent (Hudu legitimately
 * reorders classes and attributes on save; that is not loss).
 *
 * The scan is `<div>`-only on purpose: `CALLOUT_NOT_DIV` (Rule 3) already reports a callout
 * carried by any other element as a validation error, so a non-div callout is a known fault
 * elsewhere — this count guards the one shape Hudu accepts.
 */
function countCallouts(html: string): number {
  let count = 0;
  for (const tag of openTags(html, 'div')) {
    if (hasClass(classOf(tag.attrs), 'callout')) count += 1;
  }
  return count;
}

/**
 * Symmetric by construction -- a callout count differing in EITHER direction is reported,
 * because this function may not assume which argument came from Hudu.
 */
function diffCallouts(before: string, after: string, add: Add): void {
  const b = countCallouts(before);
  const a = countCallouts(after);
  if (b === a) return;
  add(
    'ROUNDTRIP_CALLOUT_FLATTENED',
    `Callout count changed across the round trip (${b} -> ${a}). A flattened callout keeps its words and loses the signal that they are a warning.`,
    { index: indexOfTag(before, 'div', (t) => hasClass(classOf(t.attrs), 'callout')), detail: [`callout: ${b} -> ${a}`] },
  );
}

/**
 * Whether an already-scanned `<div>`/`<details>` tag counts as an accordion: a `<div>` needs
 * the exact `mce-accordion` class token, and a `<details>` counts either way (Hudu's own
 * check only warns when it lacks the class, it does not disqualify the element). One
 * predicate checked once per tag -- rather than two additive passes -- so there is no way for
 * a details element to be matched by both and double-counted.
 *
 * The exact-token match matters: a body wrapper's `mce-accordion-body` class must never be
 * mistaken for a second accordion, which is exactly what a `\bmce-accordion\b` SUBSTRING test
 * would do (`-` is a non-word character, so that word boundary sits INSIDE `-body` too).
 *
 * This predicate is used for the finding's index hint; the counting itself is
 * `countAccordions`, which applies one further canonical-form rule this predicate does not
 * see: a `<details>` nested inside a counted `mce-accordion` div is inner markup of that
 * accordion, not a second one (issue #43).
 */
function isAccordionTag(tag: OpenTag): boolean {
  return hasClass(classOf(tag.attrs), 'mce-accordion') || /^<details\b/i.test(tag.tag);
}

function countAccordions(html: string): number {
  let count = 0;
  const openDivs: boolean[] = []; // per open <div>: whether it is a counted mce-accordion div
  let accordionDepth = 0;
  const re = /<(\/?)(div|details)\b/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const closing = m[1] === '/';
    const name = m[2]?.toLowerCase();
    if (name === 'div') {
      if (closing) {
        if (openDivs.pop() === true) accordionDepth -= 1;
        re.lastIndex = m.index + m[0].length;
      } else {
        const read = readAttrs(html, m.index + m[0].length);
        const isAccordionDiv = hasClass(classOf(read === null ? '' : read.attrs), 'mce-accordion');
        if (isAccordionDiv) {
          count += 1;
          accordionDepth += 1;
        }
        openDivs.push(isAccordionDiv);
        re.lastIndex = read === null ? m.index + m[0].length : read.end;
      }
    } else if (!closing && accordionDepth === 0) {
      // A <details> is an accordion only when no counted mce-accordion div is open: one
      // nested inside such a div is that accordion's inner markup (the non-canonical
      // wrapped form), not a second accordion — canonicalising it to a single
      // <details class="mce-accordion"> must not read as a flattening (issue #43).
      count += 1;
      const read = readAttrs(html, m.index + m[0].length);
      re.lastIndex = read === null ? m.index + m[0].length : read.end;
    }
  }
  return count;
}

/**
 * Symmetric by construction -- an accordion count differing in EITHER direction is reported,
 * because this function may not assume which argument came from Hudu.
 */
function diffAccordions(before: string, after: string, add: Add): void {
  const b = countAccordions(before);
  const a = countAccordions(after);
  if (b === a) return;
  add(
    'ROUNDTRIP_ACCORDION_FLATTENED',
    `Accordion count changed across the round trip (${b} -> ${a}). Flattening one reveals collapsed content and loses the summary/body split.`,
    { index: indexOfTag(before, '(?:div|details)', isAccordionTag), detail: [`accordion: ${b} -> ${a}`] },
  );
}

/**
 * Task-list check state: item count and checked count. Read through `attrOf` (quote-aware,
 * and bounded by the tag's real end) rather than a `[^>]*`-spanning regex, so a preceding
 * attribute's `>` or a single-quoted `data-checked`/`type` value cannot hide the state.
 *
 * `data-checked` is compared case-insensitively (`data-checked="TRUE"` still counts, and
 * still counts as checked) -- Hudu itself always emits lower case, but the brief's own regex
 * carried `/i`, and a value comparison that silently stopped matching on case would be exactly
 * the kind of silent miss this guard exists to prevent.
 */
function countTaskItems(html: string): number {
  let count = 0;
  for (const tag of openTags(html, 'li')) {
    const state = attrOf(tag.attrs, 'data-checked')?.toLowerCase();
    if (state === 'true' || state === 'false') count += 1;
  }
  for (const tag of openTags(html, 'input')) {
    if (attrOf(tag.attrs, 'type') === 'checkbox') count += 1;
  }
  return count;
}

function countChecked(html: string): number {
  let count = 0;
  for (const tag of openTags(html, 'li')) {
    if (attrOf(tag.attrs, 'data-checked')?.toLowerCase() === 'true') count += 1;
  }
  for (const tag of openTags(html, 'input')) {
    if (attrOf(tag.attrs, 'type') === 'checkbox' && attrOf(tag.attrs, 'checked') !== undefined) count += 1;
  }
  return count;
}

/**
 * Symmetric by construction -- a task item or checked count differing in EITHER direction is
 * reported, because this function may not assume which argument came from Hudu.
 *
 * Count-based ceiling (documented per issue #43's ask): a check-state SWAP between two
 * items — one item flips to checked and another flips to unchecked — is invisible, because
 * the item count and the checked count both match.
 */
function diffTaskState(before: string, after: string, add: Add): void {
  const items = { b: countTaskItems(before), a: countTaskItems(after) };
  const checked = { b: countChecked(before), a: countChecked(after) };
  if (items.b === items.a && checked.b === checked.a) return;
  add(
    'ROUNDTRIP_TASK_STATE_LOST',
    `Task-list state changed across the round trip (${items.b} item(s)/${checked.b} checked -> ${items.a}/${checked.a}). Which steps are done is content, not decoration.`,
    {
      index: indexOfTag(before, 'li', (t) => attrOf(t.attrs, 'data-checked') !== undefined),
      detail: [`taskItems: ${items.b} -> ${items.a}; checked: ${checked.b} -> ${checked.a}`],
    },
  );
}
