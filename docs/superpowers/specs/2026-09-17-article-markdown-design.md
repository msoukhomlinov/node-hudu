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
| Dependencies | `turndown@^7.2.4`, `turndown-plugin-gfm@^1.0.2`, `marked@^15.0.12` | Correct GFM tables and edge cases for a fraction of the code. Retires the zero-dep property. **Version ceilings are load-bearing — see §1.2** |
| Default shape | `format` opt-in per call, default `'html'` | No existing consumer changes behaviour; no major version needed |
| Resource scope | Articles only, converter built resource-agnostic | Articles hold the token bulk; other resources adopt the same unit later |
| Lossy writes | Refused by default, override available | Prevents silently destroying the regions an agent never edited |

### 1.1 Retired property

Zero runtime dependencies is not a passing remark in this repo — it is a documented architectural
principle:

- `README.md:8` — headline feature bullet, "**Zero runtime dependencies.** Uses only native
  platform APIs"
- `ARCHITECTURE.md:12` — "zero-runtime-dependency TypeScript SDK"
- `ARCHITECTURE.md:384` — "**No runtime dependencies.**"
- `ARCHITECTURE.md:900` — an entire section 15, "Dependency & build decisions"
- Hindsight *Conventions and patterns* knowledge page

(The `package.json` description does **not** claim it — an earlier draft of this spec said it did.)

All of these must be updated, and `ARCHITECTURE.md` §15 needs a recorded rationale for why this
feature justified breaking the principle. The Hindsight page gets a `Correction:` document.

Reviewers should treat this as the most contestable decision in the design. If the principle is
worth more than the ergonomics, approach C from the brainstorm — a separate `hudu-markdown`
companion package, leaving node-hudu zero-dep — remains available and nothing below changes except
where the module lives.

### 1.2 Verified dependency facts

Checked against the live npm registry on 2026-09-17. **These corrected two errors in the first
draft of this spec**, so treat the pins as load-bearing rather than cosmetic.

| Package | Latest | Pin to | Why the ceiling |
|---|---|---|---|
| `turndown` | 7.2.4 | `^7.2.4` | None needed. `engines: node >=18` ✓. One runtime dep, `@mixmark-io/domino@^2.2.0` |
| `turndown-plugin-gfm` | 1.0.2 | `^1.0.2` | None needed, but see maintenance risk below |
| `marked` | 18.0.13 | **`^15.0.12`** | **marked ≥16.0.0 is ESM-only and requires Node ≥20.** Both break this repo |

**The marked ceiling is the important finding.** At v16.0.0 marked dropped its CJS export condition
(`exports["."]` now offers only `./lib/marked.esm.js`) and raised `engines.node` to `>= 20`. This
package builds dual ESM+CJS via tsup and declares `engines: {"node": ">=18.0.0"}`, so taking latest
marked would break the CJS build and the Node floor simultaneously. `15.0.12` is the last release
with both a `require` condition and `node >= 18`.

This leaves an open decision the implementer must not silently resolve:

- **(a)** Pin `marked@^15.0.12`, keep Node ≥18 and the dual build. Accepts sitting on a superseded
  major that will not receive fixes.
- **(b)** Bump this package's Node floor to ≥20 and consume latest marked via dynamic `import()`
  from the CJS build. Current and maintained, but a breaking change for this SDK's own consumers.

**Default is (a)** unless the owner says otherwise.

Two further verified points:

- **`turndown-plugin-gfm` is effectively abandoned** — last release 1.0.2 on 2018-05-11, roughly
  eight years ago. It is MIT, has zero dependencies, and still works. Turndown genuinely does *not*
  convert tables natively, so the plugin is required for GFM tables; there is no maintained
  alternative that does only this. Accept it with eyes open, or drop GFM table support and classify
  every table as a `complex-table` content loss.
- **No single package does both directions.** `node-html-markdown`, `html-to-md`, and
  `@joplin/turndown` are all HTML→MD only. The unified/remark/rehype route needs 5+ packages and
  every one is ESM-only, which is *worse* here than marked's situation. Do not "simplify" to fewer
  deps; the realistic set is these three.

All three are MIT; `LICENSE` confirms node-hudu is MIT. Compatible.

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
- marked: `gfm: true`, `breaks: false`. No sanitizer: marked removed its `sanitize`/`sanitizer`
  options in **v8.0.0** (deprecated from 0.7.0, present through 7.0.5, gone from 8.0.0 — an earlier
  draft of this spec said v9, which was wrong), so on the pinned v15 line it is not an available
  knob. This introduces no new vector — markdown may embed raw HTML, but
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

### 6.1 Baseline

Measured on this branch at commit `5f1446c`, 2026-09-17. All four gates must still pass at the end:

| Gate | Command | Baseline |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` (= `eslint src test`) | clean |
| Tests | `npm test` | 62 files / **1992** passed, ~12.5s |
| Capabilities | `npm run capabilities:check` | PASS — rows=227 scoped=227 registryRecords=227, 66 warnings |

Note `npm run lint` scopes to `src test`. A bare `eslint .` reports 223 errors from `scripts/`,
which are pre-existing and out of scope — do not "fix" them.

## 7. Calibration

The severity table in §2.2 is a first guess made without sight of real Hudu article HTML. Before
this ships, it should be run against genuine articles from a live instance to confirm that ordinary
documents classify as presentation-only and remain editable as markdown. If ordinary articles refuse
updates, the table is wrong, not the design.
