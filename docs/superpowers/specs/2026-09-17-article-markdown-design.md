# Article content: HTML ↔ Markdown conversion

**Status:** approved design, ready for implementation plan
**Date:** 2026-09-17
**Scope:** `node-hudu` SDK, article `content` field
**Motivation:** MCP agents burn context on Hudu's raw HTML. Markdown of the same article is
materially smaller and is the format an LLM edits most reliably.

## 1. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Direction | Bidirectional, markdown writes opt-in | Reading markdown is free; writing it is lossy, so it must be an explicit act |
| Dependencies | `turndown`, `turndown-plugin-gfm`, `marked` | Correct GFM tables and edge cases for a fraction of the code. Retires the zero-dep property |
| Default shape | `format` opt-in per call, default `'html'` | No existing consumer changes behaviour; no major version needed |
| Resource scope | Articles only, converter built resource-agnostic | Articles hold the token bulk; other resources adopt the same unit later |
| Lossy writes | Refused by default, override available | Prevents silently destroying the regions an agent never edited |

### 1.1 Retired property

The package currently advertises zero runtime dependencies in `README.md`, the `package.json`
description, and the Hindsight *Conventions* knowledge page. This is now false. All three must be
updated; the Hindsight page gets a `Correction:` document.

`turndown` pulls `@mixmark-io/domino` transitively. We do **not** depend on domino directly.

## 2. The converter

New module `src/content/markdown.ts`. Pure, no knowledge of resources, HTTP, or auth.

```ts
export type ContentFormat = 'html' | 'markdown';

/** Why a feature could not survive the round trip. */
export type LossSeverity = 'content' | 'presentation';

export interface DroppedFeature {
  kind: 'raw-element' | 'complex-table' | 'inline-style' | 'attributes';
  /** The specific trigger, e.g. 'script', 'td[colspan]', 'class'. */
  tag: string;
  count: number;
  severity: LossSeverity;
}

export interface HtmlToMarkdownResult {
  markdown: string;
  /** Everything markdown could not carry. Empty === perfectly round-trippable. */
  dropped: DroppedFeature[];
}

export function htmlToMarkdown(html: string, opts?: { maxBytes?: number }): HtmlToMarkdownResult;
export function markdownToHtml(md: string): string;

/** True when `dropped` contains any entry of severity 'content'. */
export function hasContentLoss(dropped: readonly DroppedFeature[]): boolean;
```

### 2.1 Loss detection is not a second pass

turndown accepts custom rules. The rules that match a non-representable node **record it and return
`''`**. One conversion therefore yields both the markdown and the exact inventory of what markdown
could not hold. No separate scanner, no DOM walk, no second parse.

### 2.2 Severity classification

This is the critical tuning surface. Hudu's editor emits `class`, `id`, and `style` attributes on
most elements. If every dropped attribute counted as loss, every markdown update would refuse and
the feature would be useless.

Only losses that destroy **content or behaviour** refuse a write. Losses that destroy
**presentation** are reported and allowed.

| kind | Triggers | Severity |
|---|---|---|
| `raw-element` | `script`, `style`, `iframe`, `noscript`, `svg`, `math`, `form`, `input`, `button`, `select`, `textarea`, `object`, `embed`, `video`, `audio`, `canvas` | `content` |
| `complex-table` | `colspan`/`rowspan` > 1, nested table, or a table with no header row (GFM requires one) | `content` |
| `inline-style` | any non-empty `style=` attribute | `presentation` |
| `attributes` | `id`, `class`, `data-*` on an otherwise-convertible element | `presentation` |

**This table must be a single exported const**, not logic scattered through the rules. We do not yet
know what real Hudu markup contains, and this is the knob that gets turned when it meets production
data. Implementation must keep it trivially editable.

### 2.3 Converter configuration

- turndown: `headingStyle: 'atx'`, `codeBlockStyle: 'fenced'`, plus `turndown-plugin-gfm` for tables
  and strikethrough.
- marked: `gfm: true`, `breaks: false`. No sanitizer: marked removed its `sanitize` option in v9, so
  it is not an available knob. This introduces no new vector — markdown may embed raw HTML, but
  `articles.update` already accepts arbitrary HTML in `content` by design, so a markdown caller
  reaches exactly the surface an HTML caller already had. Hudu remains the trust boundary that
  decides what its own renderer will execute.
- Input cap: reuse `DEFAULT_MAX_DOC_BYTES` (256 KiB) from `src/search/html.ts` so both HTML paths in
  this repo refuse oversized documents identically. Over the cap throws, never truncates.

### 2.4 Export surface

New `./content` subpath in `package.json` and `tsup.config.ts`, matching the existing
`.` / `./resources` / `./types` / `./errors` / `./capabilities` pattern. The MCP server can call the
converter directly without going through a resource.

## 3. Resource wiring

### 3.1 Read path

`src/resources/articles.ts:127` — `get(id: number)` takes no options today, so adding them is purely
additive:

```ts
export interface ArticleGetOptions { format?: ContentFormat }

async get(id: number, opts?: ArticleGetOptions): Promise<Article>;
```

With `format: 'markdown'`, `content` is converted in place and the `Article` is returned with
`content` holding markdown. `dropped` is **not** surfaced on reads — a read destroys nothing, and an
extra field would change the shape every consumer sees.

`getContext(id, { expand: true })` (`:270`) returns the full `Article` including `content`, so it
gains `format` too. Without it that path would silently keep returning HTML — an inconsistency, not
a saving. The compact tier (`resolve`, `findBySlug`, `search`) needs nothing: `toArticleSummary`
(`:69-79`) already drops `content`.

### 3.2 Write path

`WriteOptions` (local to `articles.ts`) gains `format`. `MutationOptions`
(`src/types/common.ts:162`) gains both:

```ts
export interface MutationOptions {
  dryRun?: boolean;
  expectedUpdatedAt?: string;
  /** Interpret `data.content` as markdown and convert before sending. */
  format?: ContentFormat;
  /** Proceed with a markdown update that would destroy content-severity features. */
  allowLossyMarkdown?: boolean;
}
```

**`create`** needs no guard — there is no stored content to destroy. It converts and posts.

**`update`** with `format: 'markdown'`:

1. Fetch the current article.
2. `htmlToMarkdown(current.content)`.
3. `hasContentLoss(dropped)` and not `allowLossyMarkdown` → throw `HuduContentLossError` listing
   every dropped feature and its count.
4. Otherwise `markdownToHtml(data.content)` and PUT.

Step 2 asks "does the **stored** article survive a round trip". That is precisely the right
question: it catches destruction of the regions the agent never touched, independent of what was
submitted.

### 3.3 One fetch per call

`updateOne` (`src/resources/base.ts:298-330`) already fetches the current record when
`expectedUpdatedAt` is set. The loss check **must reuse that fetch**, not issue its own. A markdown
update costs at most one extra GET, and zero extra when the stale guard is already in use.

### 3.4 Interaction with `dryRun`

`{ format: 'markdown', dryRun: true }` performs the fetch and the loss check, then reports the
outcome in the `DryRunResult` without writing. A dry run that would have thrown
`HuduContentLossError` throws — that is the useful answer, and it is how a caller discovers an
article is unsafe to edit as markdown without risking it.

### 3.5 No content, no conversion

`format: 'markdown'` with no `content` key in `data` converts nothing, checks nothing, and issues no
extra fetch. Updating an article's `name` should not pay for the guard.

## 4. Error handling

One new failure mode, in `src/errors.ts` alongside the existing six classes:

```ts
export class HuduContentLossError extends HuduError {
  readonly code = 'CONTENT_LOSS';
  readonly dropped: readonly DroppedFeature[];
}
```

The message names each content-severity feature and its count, and states that
`allowLossyMarkdown: true` or sending HTML are the two ways forward. Presentation-severity entries
are carried in `dropped` but never cause the throw.

A conversion that produces empty output from non-empty input throws rather than writing a blank
article over someone's documentation. Oversized input reuses the existing cap behaviour. Malformed
markdown is not an error — `marked` accepts anything.

## 5. Files

| File | Change |
|---|---|
| `src/content/markdown.ts` | new — converter, loss rules, severity table |
| `src/content/index.ts` | new — subpath barrel |
| `src/errors.ts` | new `HuduContentLossError` |
| `src/types/common.ts:162` | `format`, `allowLossyMarkdown` on `MutationOptions`; export `ContentFormat` |
| `src/resources/articles.ts` | `ArticleGetOptions`; `format` threaded through `get`, `getContext`, `create`, `update`, including every overload signature |
| `src/resources/base.ts` | `updateOne` exposes its fetched record so the loss check can reuse it |
| `scripts/generate-capabilities.mjs` | teach it the new options, then regenerate |
| `package.json` | 3 deps, `./content` export, description no longer claims zero deps |
| `tsup.config.ts` | `./content` entry |
| `README.md`, `ARCHITECTURE.md` | retire zero-dep claim, document `format` |

Regenerated, never hand-edited: `src/capabilities.ts`, `capabilities.json`,
`MCP_TOOL_MANIFEST.md`.

**Explicitly out of scope:** asset rich-text fields (`AssetLayoutField.field_type` is a bare
`string`; RichText-ness is only knowable at runtime from the layout, so it needs layout lookups and
is its own job), procedures, magic_dash, company/website notes. The 12 duplicated `helperLimit`
copies are pre-existing debt and stay untouched.

## 6. Testing

TDD throughout — test first, watch it fail, then implement.

- **Converter, both directions:** tables, nested lists, fenced code, entities, `<pre>`, links,
  images, blockquotes.
- **Loss detection:** one fixture per row of the severity table, each asserting the exact
  `DroppedFeature` including `severity`. Explicitly: an article carrying only `class`/`style`
  attributes must **not** refuse a markdown update.
- **Resource:** `get` with `format`; `getContext` with `expand` + `format`; `update` refusing
  content loss; `allowLossyMarkdown` override; `dryRun` + markdown; `format` with no `content` key
  issuing no fetch; single-fetch assertion when `expectedUpdatedAt` is also set.
- **Property:** for any fixture whose `dropped` contains no content-severity entry,
  HTML → MD → HTML must be semantically stable. "Semantically stable" is defined concretely as:
  feeding both the original and the rebuilt HTML through `htmlToText` from `src/search/html.ts`
  yields identical strings. That function already normalises whitespace, decodes entities, and
  inserts block/cell boundaries, so it compares the text a reader sees while ignoring the
  presentation markup we have already agreed to drop.

Guaranteed direction is HTML → MD → HTML. MD → HTML → MD is **not** identity — `marked` and
`turndown` disagree at the edges — and nothing in this design depends on it.

The full suite (62 files / ~1971 tests at time of writing) must stay green, plus lint and typecheck.

## 7. Calibration

The severity table in §2.2 is a first guess made without sight of real Hudu article HTML. Before
this ships, it should be run against genuine articles from a live instance to confirm that ordinary
documents classify as presentation-only and remain editable as markdown. If ordinary articles refuse
updates, the table is wrong, not the design.
