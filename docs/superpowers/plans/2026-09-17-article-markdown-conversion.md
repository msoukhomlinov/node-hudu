# Article HTML ↔ Markdown Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP agent read a Hudu article as Markdown and write one back, refusing any Markdown write that would destroy content the agent never touched.

**Architecture:** Two thin pure functions in a new `src/content/` module wrap `turndown` (HTML→MD) and `marked` (MD→HTML). All loss detection is delegated to the existing `diffArticleRoundTrip` in `src/resources/article-html.ts`, extended with the four element families Markdown destroys that it does not yet cover. `articles.update` runs the guard against the **stored** article, using a single fetch shared with the `expectedUpdatedAt` stale check.

**Tech Stack:** TypeScript 5.7, Node ≥24, vitest, tsup dual ESM+CJS, `turndown`, `@joplin/turndown-plugin-gfm`, `marked`.

**Spec:** `docs/superpowers/specs/2026-09-17-article-markdown-design.md`

---

## Global Constraints

- **Node floor `>=24.0.0`.** Already landed on `main` (PR #36, `df2a05b`). Do not change it.
- **Dependency pins, exact:** `turndown` `^7.2.4`, `@joplin/turndown-plugin-gfm` `^1.0.68`, `marked` `^18.0.13`. These are `dependencies`, not `devDependencies`.
- **The zero-runtime-dependency property is deliberately retired.** Every claim of it must be updated in Task 1 — this is in scope, not a follow-up.
- **No `turndown` or `marked` type may appear in any exported signature**, and no option of theirs may bleed into the public API. `src/content/turndown-engine.ts` is the only file that may import `turndown`; `src/content/marked-engine.ts` is the only file that may import `marked`. Swapping the converter must mean rewriting one of those two files and nothing else.
- **Regression fixtures assert BEHAVIOUR, not turndown's exact formatting**, wherever the difference is cosmetic. Where exact output matters, assert it and write a comment saying why.
- **Input cap:** reuse `DEFAULT_MAX_DOC_BYTES` (256 KiB) from `src/search/html.ts`. Over the cap throws, never truncates.
- **`lint` scopes to `src test`.** A bare `eslint .` reports pre-existing errors from `scripts/`. Do not "fix" them.
- **Regenerated, never hand-edited:** `src/capabilities.ts`, `capabilities.json`, `MCP_TOOL_MANIFEST.md`, `src/mcp/catalog.generated.ts`.

### Baseline — all gates must still pass at the end

Measured on `main` at `df2a05b`, 2026-09-17:

| Gate | Command | Baseline |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| Lint | `npm run lint` | clean |
| Tests | `npm test` | **63 files / 2110 passed**, ~12.5s |
| Capabilities | `npm run capabilities:check` | PASS — rows=227 scoped=227 registryRecords=227, 66 warnings |
| Catalog | `npm run catalog:check` | PASS — 227 rows, 139 exposed |
| Example | `node scripts/project-mcp-tools.mjs --check-example` | OK — 15 tools |

---

## Deviations from the spec — read before starting

The spec was approved on 2026-09-17 before PRs #34 and #36 landed. Three of its sections are superseded. These are **decided**, not open:

**1. Spec §1.2 dependency pins are obsolete.** The spec pinned `marked@^15.0.12` and offered options (a)/(b) for the Node floor. Option (b) was taken and has already shipped: the Node floor is `>=24.0.0` as of `df2a05b`, which makes `marked@^18` consumable from the CJS build via `require(esm)` (Node ≥22.12). The spec's `turndown-plugin-gfm@^1.0.2` is the original, unmaintained since 2018; use the `@joplin` fork at `^1.0.68` instead.

**2. Spec §2.1/§2.2's `DroppedFeature` / `LossSeverity` / `hasContentLoss` vocabulary is dropped.** It is a parallel spelling of machinery `src/resources/article-html.ts` already ships and tests: `ArticleHtmlFinding` carries the same `impact: 'content' | 'presentation'` union under a different name, and `ARTICLE_HTML_RULES` is already the single editable severity table §2.2 asked for. Reuse it. Loss detection is therefore `diffArticleRoundTrip(original, markdownToHtml(htmlToMarkdown(original)))` — a named, documented, supported caller of that function (see its contract block at `src/resources/article-html.ts:978-991`). `htmlToMarkdown` returns a plain `string`; it does no loss detection of its own.

The differ does not yet see four families that Markdown genuinely destroys — raw elements, Hudu callouts, Hudu accordions, and task-list check state. **Task 3 adds them to the differ**, not to the converter. That keeps one vocabulary, and it closes the same gap on the real Hudu write path, where a silently-eaten callout is equally a loss.

**3. Spec §3.3 and §5's `src/resources/base.ts` change is unnecessary.** The spec wanted `updateOne` to expose its fetched record. It does not need to: `assertNotStale` (`src/resources/base.ts`) already takes the fetch as a callback parameter, so `articles.update` can fetch once itself and hand the same record to the guard *and* to `assertNotStale` via `() => Promise.resolve(current)`. `base.ts` is shared by every resource; leaving it untouched removes the riskiest edit in the spec. This also makes spec §3.4 fall out for free — the guard runs in `articles.update` before it delegates, so a dry run reaches it without `updateOne`'s `dryRun` short-circuit skipping it.

**4. One behaviour change to flag in the CHANGELOG.** Task 3 makes `diffArticleRoundTrip` report loss it previously missed. An existing caller gating a Hudu write on `findings.some(f => f.impact === 'content')` may newly refuse a write that used to pass. That is the correct direction (it fails closed on real loss), but it is a behaviour change and must be called out.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/content/turndown-engine.ts` | **new.** The only file importing `turndown`. Exports one function, `convertHtmlToMarkdown(html: string): string`. The swap unit. |
| `src/content/marked-engine.ts` | **new.** The only file importing `marked`. Exports one function, `convertMarkdownToHtml(md: string): string`. The swap unit. |
| `src/content/markdown.ts` | **new.** Public seam: byte-cap enforcement, empty-output guard, and the two exported functions. Imports the two engine files; nothing else imports them. |
| `src/content/index.ts` | **new.** `./content` subpath barrel. |
| `src/resources/article-html.ts` | **modify.** Four new diff families + their codes and rule rows. |
| `src/errors.ts` | **modify.** `HuduContentLossError`. |
| `src/types/common.ts` | **modify.** `ContentFormat`; `format` + `allowLossyMarkdown` on `MutationOptions`. |
| `src/resources/articles.ts` | **modify.** `format` threaded through `get`, `getContext`, `create`, `update`, every overload. |
| `package.json`, `tsup.config.ts` | **modify.** 3 deps, `./content` export and entry. |
| `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | **modify.** Retire the zero-dep claim, document `format`. |
| `test/content/markdown.test.ts` | **new.** Converter, both directions, all required fixture families. |
| `test/content/whole-article.test.ts` | **new.** The converter-swap fixture. |
| `test/resources/article-html.test.ts` | **modify.** The four new diff families. |
| `test/resources/articles.test.ts` | **modify.** Read path, write path, guard, dry run, single-fetch. |

---

### Task 1: Land the dependencies and retire the zero-dependency property

Nothing else compiles until the packages are installed, and the moment they are, five places in the docs are lying. Both halves ship together.

**Files:**
- Modify: `package.json` (deps, `./content` export)
- Modify: `tsup.config.ts` (`./content` entry)
- Modify: `README.md:8`
- Modify: `ARCHITECTURE.md:12`, `ARCHITECTURE.md:384`, `ARCHITECTURE.md` §15 (~line 900)
- Test: `test/content/deps.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: installed `turndown`, `@joplin/turndown-plugin-gfm`, `marked`; a `./content` export path resolving to `dist/content/index.{js,cjs}`.

- [ ] **Step 1: Rebase the feature branch onto `main`**

The branch is based on `483256f` (0.5.0) and is missing the Node 24 floor and the `article-html.ts` parser fix this plan depends on.

```bash
cd /Users/maxs/gitrepos/node-hudu/.claude/worktrees/markdown-feature
git fetch origin
git rebase main
git log --oneline -3
```

Expected: `fa90cfb`'s two doc commits replayed on top of `df2a05b`. Do **not** `cd` into this worktree from the main session's shell — run these from the worktree or with `git -C`.

- [ ] **Step 2: Write the failing test**

This test is the executable form of the "no converter type in the public API" constraint. It fails now because the module does not exist.

```ts
// test/content/deps.test.ts
/**
 * The converter dependencies and the seam that keeps them swappable.
 * Rationale for retiring the zero-dependency property: ARCHITECTURE.md §15.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('converter dependencies', () => {
  it('pins the three runtime dependencies the design settled on', () => {
    expect(pkg.dependencies).toMatchObject({
      turndown: '^7.2.4',
      '@joplin/turndown-plugin-gfm': '^1.0.68',
      marked: '^18.0.13',
    });
  });

  it('loads marked from CJS through require(esm), which is why the Node floor is 24', () => {
    // marked >=16 is ESM-only. Node >=22.12 resolves it from require() anyway.
    const require = createRequire(import.meta.url);
    const marked = require('marked');
    expect(typeof marked.parse).toBe('function');
  });

  it('exposes ./content as a dual-format subpath', () => {
    expect(pkg.exports['./content']).toEqual({
      import: { types: './dist/content/index.d.ts', default: './dist/content/index.js' },
      require: { types: './dist/content/index.d.cts', default: './dist/content/index.cjs' },
    });
  });
});

describe('the converter seam', () => {
  const read = (p: string) => readFileSync(new URL(`../../src/content/${p}`, import.meta.url), 'utf8');

  it('confines turndown to turndown-engine.ts and marked to marked-engine.ts', () => {
    // Swapping converters (the @xberg-io watchlist) must mean rewriting one file, not auditing the SDK.
    expect(read('turndown-engine.ts')).toMatch(/from 'turndown'/);
    expect(read('marked-engine.ts')).toMatch(/from 'marked'/);
    for (const file of ['markdown.ts', 'index.ts']) {
      expect(read(file), `${file} must not import a converter directly`).not.toMatch(/from '(turndown|marked|@joplin\/)/);
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run test/content/deps.test.ts
```

Expected: FAIL — `Cannot find module` for `src/content/turndown-engine.ts`, and the dependency assertions fail because `pkg.dependencies` is undefined.

- [ ] **Step 4: Install the three dependencies**

```bash
cd /Users/maxs/gitrepos/node-hudu/.claude/worktrees/markdown-feature
npm install --save turndown@^7.2.4 @joplin/turndown-plugin-gfm@^1.0.68 marked@^18.0.13
npm install --save-dev @types/turndown
```

Then confirm the lockfile records real resolutions, not a `file:` link (this bit the previous session):

```bash
node -e "const l=require('./package-lock.json');for(const k of ['node_modules/turndown','node_modules/marked','node_modules/@joplin/turndown-plugin-gfm'])console.log(k, l.packages[k]?.resolved ?? 'MISSING')"
```

Expected: three `https://registry.npmjs.org/...` URLs. Any `file:` entry means `npm install` reused a stale resolution — delete `node_modules` and the lockfile entry and reinstall.

- [ ] **Step 5: Add the `./content` export and tsup entry**

In `package.json`, insert after the `"./capabilities"` block:

```json
    "./content": {
      "import": {
        "types": "./dist/content/index.d.ts",
        "default": "./dist/content/index.js"
      },
      "require": {
        "types": "./dist/content/index.d.cts",
        "default": "./dist/content/index.cjs"
      }
    },
```

In `tsup.config.ts`, add `'src/content/index.ts'` to `entry`:

```ts
  entry: ['src/index.ts', 'src/resources/index.ts', 'src/types/index.ts', 'src/errors.ts', 'src/capabilities.ts', 'src/operations/index.ts', 'src/mcp/index.ts', 'src/content/index.ts'],
```

- [ ] **Step 6: Create the two engine files and the seam, minimally**

Just enough to make Task 1's seam test pass; Task 2 gives them real behaviour.

```ts
// src/content/turndown-engine.ts
/**
 * The ONLY file that may import turndown.
 *
 * HTML->Markdown sits behind this one function so the converter stays swappable:
 * `@xberg-io/html-to-markdown` produced byte-identical output on a tables/code/list
 * fixture at 2000 conversions in 16ms, and is on a maturity watchlist for mid-2027
 * (created 2026-06-26, one maintainer, native .node binaries in an otherwise pure-JS SDK).
 * Swapping means rewriting this file. No turndown type escapes it.
 */
import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

export function convertHtmlToMarkdown(html: string): string {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  service.use(gfm);
  return service.turndown(html);
}
```

```ts
// src/content/marked-engine.ts
/**
 * The ONLY file that may import marked.
 *
 * marked >=16 is ESM-only; this package's CJS build reaches it through Node's
 * require(esm) support, which is why the Node floor is >=24. There is no sanitizer
 * knob: marked removed `sanitize`/`sanitizer` in v8.0.0. That introduces no new
 * vector -- `articles.update` already accepts arbitrary HTML in `content` by design,
 * so a Markdown caller reaches exactly the surface an HTML caller already had, and
 * Hudu remains the trust boundary for what its own renderer will execute.
 */
import { marked } from 'marked';

export function convertMarkdownToHtml(md: string): string {
  return marked.parse(md, { gfm: true, breaks: false, async: false });
}
```

```ts
// src/content/markdown.ts
import { convertHtmlToMarkdown } from './turndown-engine.js';
import { convertMarkdownToHtml } from './marked-engine.js';

export function htmlToMarkdown(html: string): string {
  return convertHtmlToMarkdown(html);
}

export function markdownToHtml(md: string): string {
  return convertMarkdownToHtml(md);
}
```

```ts
// src/content/index.ts
export { htmlToMarkdown, markdownToHtml } from './markdown.js';
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run test/content/deps.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Retire the zero-dependency claim in the docs**

`README.md:8` — replace the headline bullet:

```markdown
- **Three runtime dependencies.** `turndown`, `@joplin/turndown-plugin-gfm` and `marked`, all used only by the `./content` Markdown converter. Every other path uses native platform APIs alone.
```

`ARCHITECTURE.md:12` — replace "zero-runtime-dependency TypeScript SDK" with:

```markdown
TypeScript SDK with three runtime dependencies, all confined to the Markdown converter
```

`ARCHITECTURE.md:384` — replace the "**No runtime dependencies.**" bullet with:

```markdown
**Three runtime dependencies, confined to one module.** `src/content/` uses `turndown`, `@joplin/turndown-plugin-gfm` and `marked`. Nothing outside `src/content/` imports them, and no type of theirs appears in an exported signature. Every other subsystem — HTTP, auth, pagination, search, MCP — still uses native platform APIs alone.
```

`ARCHITECTURE.md` §15 "Dependency & build decisions" — append:

```markdown
### 15.1 Why the zero-dependency property was retired (2026-09-17)

HTML↔Markdown conversion for article bodies broke it, deliberately. The property was
worth keeping while every subsystem could be written against native platform APIs.
Correct GFM table conversion and Markdown parsing are not in that category: turndown
does not convert tables without a plugin, and a hand-rolled converter would be a
standing correctness liability on the one path that can overwrite a customer's
documentation.

Three alternatives were weighed and rejected:

- **A separate `hudu-markdown` companion package** (the design's "approach C"), leaving
  this SDK zero-dep. Rejected: it splits the guard from the resource that needs it, and
  the loss check must run inside `articles.update` to be safe by default.
- **The unified/remark/rehype route.** Rejected: 5+ packages, every one ESM-only.
- **`@xberg-io/html-to-markdown`** — zero JS dependencies, byte-identical output to
  turndown on a tables/code/list fixture, 2000 conversions in 16ms, and structured
  `warnings`/`tables` output that would have suited the loss guard well. Rejected on
  maturity alone: created 2026-06-26, 27 versions to 3.14.0 in twelve weeks, ~4k weekly
  downloads against turndown's 6.65M, one maintainer, and 8 native `.node` binaries in
  an otherwise pure-JS SDK. On a watchlist for mid-2027; `src/content/turndown-engine.ts`
  exists as a one-file swap unit precisely for that.

The containment rule that makes this acceptable: the dependencies live behind
`src/content/`, no type of theirs appears in an exported signature, and every other
subsystem remains dependency-free.
```

- [ ] **Step 9: Verify no stale zero-dep claim survives**

```bash
grep -rn "[Zz]ero.runtime.dep\|[Nn]o runtime dep\|zero-dep" README.md ARCHITECTURE.md docs/ package.json
```

Expected: matches only inside the new §15.1 prose (which discusses the retirement) and nowhere else as a live claim.

- [ ] **Step 10: File the Hindsight correction**

The Hindsight *Conventions and patterns* knowledge page for this repo states the
zero-runtime-dependency property as a convention. A page that contradicts the code is
worse than no page: an agent reading it will reject a correct PR. It gets a `Correction:`
document rather than an edit, so the history of the decision survives.

Content:

```
Correction: node-hudu is no longer a zero-runtime-dependency SDK (2026-09-17)

As of v0.7.0 node-hudu has three runtime dependencies -- turndown,
@joplin/turndown-plugin-gfm and marked -- introduced for article HTML <-> Markdown
conversion. They are confined to src/content/ and no type of theirs appears in an
exported signature; every other subsystem (HTTP, auth, pagination, search, MCP) still
uses native platform APIs alone.

The convention as previously stated ("zero runtime dependencies, native platform APIs
only") is retired. The replacement convention is: dependencies are confined to the one
module that needs them and never surface in the public API.

Rationale and the three rejected alternatives are recorded in ARCHITECTURE.md section 15.1.
```

If the Hindsight MCP tools are unavailable in the executing session, say so explicitly in
the PR body rather than silently skipping this step — a stale convention page is the kind
of thing nobody notices until it misleads someone.

- [ ] **Step 11: Run the full gates**

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npm test
```

Expected: exit 0, clean, 64 files / 2114 passed.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsup.config.ts README.md ARCHITECTURE.md src/content test/content
git commit -m "feat(content): add the Markdown converter dependencies and retire the zero-dependency property

turndown, @joplin/turndown-plugin-gfm and marked land as runtime dependencies,
confined to the new src/content/ module behind two one-function engine files so
the converter stays swappable. ARCHITECTURE.md gains a section 15.1 recording
why the property was given up and what was rejected instead."
```

---

### Task 2: The converter

**Files:**
- Modify: `src/content/markdown.ts`
- Test: `test/content/markdown.test.ts` (new)

**Interfaces:**
- Consumes: `convertHtmlToMarkdown`, `convertMarkdownToHtml` from Task 1; `DEFAULT_MAX_DOC_BYTES` from `src/search/html.ts`.
- Produces:
  - `htmlToMarkdown(html: string, opts?: HtmlToMarkdownOptions): string`
  - `markdownToHtml(md: string, opts?: HtmlToMarkdownOptions): string`
  - `export interface HtmlToMarkdownOptions { maxBytes?: number }`
  - Both throw `HuduConfigError` on over-cap input and on non-empty input producing empty output.
- **Not** produced here: `ContentFormat`. It has one home, `src/types/common.ts`, added in Task 5. Nothing in `src/content/markdown.ts` references it; the barrel re-exports it only for convenience.

- [ ] **Step 1: Write the failing tests**

```ts
// test/content/markdown.test.ts
/**
 * HTML <-> Markdown conversion.
 *
 * These assert BEHAVIOUR, not turndown's exact formatting, wherever the difference is
 * cosmetic -- the converter is a swap unit (see src/content/turndown-engine.ts). Where a
 * test pins exact output, a comment says why that exact shape is load-bearing.
 */
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from '../../src/content/markdown.js';
import { DEFAULT_MAX_DOC_BYTES } from '../../src/search/html.js';
import { HuduConfigError } from '../../src/errors.js';

describe('htmlToMarkdown', () => {
  it('converts a GFM table with a header row', () => {
    const md = htmlToMarkdown('<table><thead><tr><th>Host</th><th>IP</th></tr></thead><tbody><tr><td>vpn1</td><td>10.0.0.1</td></tr></tbody></table>');
    // Cell content and the header separator are behaviour; column padding is not.
    expect(md).toMatch(/\|\s*Host\s*\|\s*IP\s*\|/);
    expect(md).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(md).toMatch(/\|\s*vpn1\s*\|\s*10\.0\.0\.1\s*\|/);
  });

  it('converts a wide table, which Hudu auto-wraps in a scroll div', () => {
    const cells = Array.from({ length: 12 }, (_, i) => `<th>Column ${i}</th>`).join('');
    const body = Array.from({ length: 12 }, (_, i) => `<td>v${i}</td>`).join('');
    const md = htmlToMarkdown(`<div class="table-scroll-wrapper"><table><thead><tr>${cells}</tr></thead><tbody><tr>${body}</tr></tbody></table></div>`);
    expect(md).toContain('Column 11');
    expect(md).toContain('v11');
  });

  it('converts nested lists four deep -- the SDK imposes no depth limit', () => {
    const html = '<ul><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li></ul>';
    const md = htmlToMarkdown(html);
    for (const item of ['a', 'b', 'c', 'd']) expect(md).toContain(item);
    // Depth is behaviour: 'd' must be indented further than 'a'.
    const indent = (t: string) => (md.split('\n').find((l) => l.includes(t)) ?? '').search(/\S/);
    expect(indent('d')).toBeGreaterThan(indent('a'));
  });

  it('keeps the language of a fenced code block', () => {
    const md = htmlToMarkdown('<pre><code class="language-bash">npm run build</code></pre>');
    // Exact shape IS load-bearing: the fence info string is the only place the language
    // survives in Markdown, and markdownToHtml must put it back on the <code> element.
    expect(md).toContain('```bash');
    expect(md).toContain('npm run build');
  });

  it('keeps links and images with their href, alt and public_photo src', () => {
    const md = htmlToMarkdown('<p><a href="https://example.com/kb">KB</a> <img src="/public_photo/abc-123" alt="Topology"></p>');
    expect(md).toContain('[KB](https://example.com/kb)');
    expect(md).toContain('![Topology](/public_photo/abc-123)');
  });

  it('survives malformed HTML without throwing', () => {
    for (const bad of [
      '<p>unclosed',
      '<p>stray</p></div>',
      '<a href="a>b.html">gt inside an attribute value</a>',
      '<table><tr><td>no tbody',
    ]) {
      expect(() => htmlToMarkdown(bad), bad).not.toThrow();
    }
  });

  it('refuses input over the shared 256 KiB document cap instead of truncating', () => {
    const huge = `<p>${'x'.repeat(DEFAULT_MAX_DOC_BYTES + 1)}</p>`;
    expect(() => htmlToMarkdown(huge)).toThrow(HuduConfigError);
  });

  it('refuses to turn non-empty input into empty output', () => {
    // A blank result would overwrite someone's documentation with nothing.
    expect(() => htmlToMarkdown('<script>alert(1)</script>')).toThrow(HuduConfigError);
  });

  it('returns empty for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('markdownToHtml', () => {
  it('restores the language class on the <code> element, not just the <pre>', () => {
    // Hudu's rule CODE_LANGUAGE_CLASS_MISSING_ON_CODE is an error-severity content rule:
    // the class must sit on <code>. This is the exact shape that satisfies it.
    const html = markdownToHtml('```bash\nnpm run build\n```');
    expect(html).toMatch(/<code[^>]*class="[^"]*language-bash/);
  });

  it('builds a GFM table', () => {
    const html = markdownToHtml('| Host | IP |\n| --- | --- |\n| vpn1 | 10.0.0.1 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Host</th>');
    expect(html).toContain('<td>10.0.0.1</td>');
  });

  it('does not turn a single newline into a <br> (breaks: false)', () => {
    expect(markdownToHtml('one\ntwo')).not.toContain('<br');
  });

  it('accepts malformed markdown rather than erroring', () => {
    expect(() => markdownToHtml('| broken |\n| --')).not.toThrow();
  });

  it('refuses to turn non-empty markdown into empty HTML', () => {
    expect(() => markdownToHtml('<!-- just a comment -->')).toThrow(HuduConfigError);
  });

  it('returns empty for empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });
});

describe('round trip', () => {
  it('is stable for content markdown can carry', () => {
    const original = '<h2>Setup</h2><p>Run <code>npm ci</code> first.</p><ul><li>one</li><li>two</li></ul>';
    const once = markdownToHtml(htmlToMarkdown(original));
    const twice = markdownToHtml(htmlToMarkdown(once));
    expect(htmlToMarkdown(twice)).toBe(htmlToMarkdown(once));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run test/content/markdown.test.ts
```

Expected: FAIL — the cap, empty-output and language-class-on-`<code>` tests fail; the rest may already pass from Task 1's pass-through.

- [ ] **Step 3: Implement the seam**

```ts
// src/content/markdown.ts
/**
 * HTML <-> Markdown for article bodies.
 *
 * Pure: no knowledge of resources, HTTP or auth. This module is the seam -- the
 * converters themselves live in ./turndown-engine and ./marked-engine, one file each,
 * so either can be replaced without touching anything that calls these functions.
 *
 * There is deliberately NO loss reporting here. `diffArticleRoundTrip` in
 * src/resources/article-html.ts already classifies content-vs-presentation loss against
 * an audited rule table, and it is a documented supported caller pattern to run it as
 * `diffArticleRoundTrip(original, markdownToHtml(htmlToMarkdown(original)))`. One
 * vocabulary, one severity table.
 */
import { DEFAULT_MAX_DOC_BYTES } from '../search/html.js';
import { HuduConfigError } from '../errors.js';
import { convertHtmlToMarkdown } from './turndown-engine.js';
import { convertMarkdownToHtml } from './marked-engine.js';

export interface HtmlToMarkdownOptions {
  /** Raw-input cap in UTF-8 bytes. Default {@link DEFAULT_MAX_DOC_BYTES} (256 KiB). */
  maxBytes?: number;
}

function assertWithinCap(op: string, input: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > maxBytes) {
    throw new HuduConfigError(
      `${op}: input is ${bytes} bytes, over the ${maxBytes}-byte document cap. It is refused, never truncated.`,
      {
        operation: op,
        suggestedAction: 'Split the article, or raise maxBytes knowing the whole document is held in memory.',
      },
    );
  }
}

function assertNotEmptied(op: string, input: string, output: string): void {
  if (input.trim().length > 0 && output.trim().length === 0) {
    throw new HuduConfigError(
      `${op}: non-empty input converted to empty output. Writing this would replace the stored body with nothing.`,
      {
        operation: op,
        suggestedAction: 'Send the content as HTML instead; it holds nothing this converter can represent.',
      },
    );
  }
}

/** Convert article HTML to Markdown. Throws rather than truncating or emptying. */
export function htmlToMarkdown(html: string, opts?: HtmlToMarkdownOptions): string {
  if (typeof html !== 'string' || html.trim().length === 0) return '';
  assertWithinCap('content.htmlToMarkdown', html, opts?.maxBytes ?? DEFAULT_MAX_DOC_BYTES);
  const markdown = convertHtmlToMarkdown(html).trim();
  assertNotEmptied('content.htmlToMarkdown', html, markdown);
  return markdown;
}

/** Convert Markdown to article HTML. Throws rather than emptying. */
export function markdownToHtml(md: string, opts?: HtmlToMarkdownOptions): string {
  if (typeof md !== 'string' || md.trim().length === 0) return '';
  assertWithinCap('content.markdownToHtml', md, opts?.maxBytes ?? DEFAULT_MAX_DOC_BYTES);
  const html = convertMarkdownToHtml(md).trim();
  assertNotEmptied('content.markdownToHtml', md, html);
  return html;
}
```

- [ ] **Step 4: Make the language class land on `<code>`**

`marked`'s default renderer emits `<pre><code class="language-bash">`, which already satisfies the rule. Verify it does before writing any override:

```bash
node --input-type=module -e "import {marked} from 'marked'; console.log(marked.parse('\`\`\`bash\nx\n\`\`\`',{gfm:true,breaks:false,async:false}))"
```

If the output has the class on `<code>`, `marked-engine.ts` needs no change. If it does not, add a renderer override in `src/content/marked-engine.ts` only:

```ts
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) =>
  `<pre><code class="language-${(lang ?? '').replace(/[^\w.+-]/g, '')}">${text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>\n`;
```

- [ ] **Step 5: Export the new types from the barrel**

```ts
// src/content/index.ts
export { htmlToMarkdown, markdownToHtml } from './markdown.js';
export type { HtmlToMarkdownOptions } from './markdown.js';
// ContentFormat has ONE home, src/types/common.ts (Task 5); re-exported here for convenience.
export type { ContentFormat } from '../types/common.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/content/
```

Expected: PASS, all tests in both files.

- [ ] **Step 7: Commit**

```bash
git add src/content test/content
git commit -m "feat(content): htmlToMarkdown and markdownToHtml

Both refuse over-cap input rather than truncating and refuse to turn non-empty
input into empty output, which would otherwise overwrite a stored article body
with nothing. Loss detection is deliberately absent: diffArticleRoundTrip
already classifies it against an audited rule table."
```

---

### Task 3: Teach `diffArticleRoundTrip` the four families Markdown destroys

The differ covers escaping, tables, code blocks, links and images. Markdown also destroys raw elements, Hudu callouts, Hudu accordions and task-list check state, and none of those are currently reported. Adding them here rather than in the converter keeps one vocabulary and closes the same gap on the real Hudu write path.

**Files:**
- Modify: `src/resources/article-html.ts` (`ARTICLE_HTML_CODES`, `ARTICLE_HTML_RULES`, `diffArticleRoundTrip`)
- Test: `test/resources/article-html.test.ts`

**Interfaces:**
- Consumes: the existing `ArticleHtmlFinding`, `Add` callback and `finding()` helper in that file.
- Produces: four new members of `ArticleHtmlCode` —
  `ROUNDTRIP_RAW_ELEMENT_LOST`, `ROUNDTRIP_CALLOUT_FLATTENED`, `ROUNDTRIP_ACCORDION_FLATTENED`, `ROUNDTRIP_TASK_STATE_LOST` — each with a row in `ARTICLE_HTML_RULES`.

- [ ] **Step 1: Write the failing tests**

Append to `test/resources/article-html.test.ts`:

```ts
describe('round-trip diff: the families a Markdown converter destroys', () => {
  it('reports a raw element that vanished', () => {
    const sent = '<p>Watch this</p><iframe src="https://video.example.com/1"></iframe>';
    const f = diffArticleRoundTrip(sent, '<p>Watch this</p>');
    expect(has(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(true);
    expect(find(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')?.impact).toBe('content');
    expect(find(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')?.detail).toContain('iframe');
  });

  it('is symmetric: a raw element appearing from nowhere is also reported', () => {
    // The contract forbids assuming which side came from Hudu. Both directions are loss.
    const f = diffArticleRoundTrip('<p>Watch this</p>', '<p>Watch this</p><script>x()</script>');
    expect(has(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(true);
  });

  it('does not report a raw element that survived', () => {
    const html = '<p>a</p><iframe src="https://video.example.com/1"></iframe>';
    expect(has(diffArticleRoundTrip(html, html), 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(false);
  });

  it('reports a callout flattened to plain prose', () => {
    const sent = '<div class="callout callout-warning"><p>Back up first.</p></div>';
    const f = diffArticleRoundTrip(sent, '<p>Back up first.</p>');
    expect(has(f, 'ROUNDTRIP_CALLOUT_FLATTENED')).toBe(true);
    expect(find(f, 'ROUNDTRIP_CALLOUT_FLATTENED')?.impact).toBe('content');
  });

  it('tolerates a callout Hudu reordered or restyled', () => {
    // Hudu legitimately reorders attributes and rewrites class order; that is not loss.
    const sent = '<div class="callout callout-info"><p>FYI</p></div>';
    const back = '<div data-type="callout" class="callout-info callout"><p>FYI</p></div>';
    expect(has(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_CALLOUT_FLATTENED')).toBe(false);
  });

  it('reports an accordion flattened away', () => {
    const sent = '<div class="mce-accordion"><summary>More</summary><div class="mce-accordion-body"><p>Detail</p></div></div>';
    const f = diffArticleRoundTrip(sent, '<p>More</p><p>Detail</p>');
    expect(has(f, 'ROUNDTRIP_ACCORDION_FLATTENED')).toBe(true);
    expect(find(f, 'ROUNDTRIP_ACCORDION_FLATTENED')?.impact).toBe('content');
  });

  it('reports task-list check state that did not survive', () => {
    const sent = '<ul data-type="taskList"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>';
    const f = diffArticleRoundTrip(sent, '<ul><li>done</li><li>todo</li></ul>');
    expect(has(f, 'ROUNDTRIP_TASK_STATE_LOST')).toBe(true);
    expect(find(f, 'ROUNDTRIP_TASK_STATE_LOST')?.impact).toBe('content');
  });

  it('does not report a task list whose checked count survived', () => {
    const sent = '<ul data-type="taskList"><li data-checked="true">done</li></ul>';
    const back = '<ul data-type="taskList"><li data-checked="true">done</li></ul>';
    expect(has(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_TASK_STATE_LOST')).toBe(false);
  });

  it('leaves an ordinary article with only class and style attributes clean', () => {
    // The load-bearing calibration case: if ordinary articles report content loss, every
    // Markdown update refuses and the feature is useless.
    const sent = '<h2 class="text-left">Setup</h2><p style="color:#333">Run it.</p>';
    const back = '<h2>Setup</h2><p>Run it.</p>';
    expect(diffArticleRoundTrip(sent, back).filter((f) => f.impact === 'content')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run test/resources/article-html.test.ts
```

Expected: FAIL — the four new codes are not in `ARTICLE_HTML_CODES`, so `has(...)` is false and the rule-table completeness test at the top of the file still passes (it iterates codes, which do not exist yet).

- [ ] **Step 3: Add the codes and rule rows**

In `ARTICLE_HTML_CODES`, after `'ROUNDTRIP_IMG_ALT_LOST'`:

```ts
  'ROUNDTRIP_RAW_ELEMENT_LOST',
  'ROUNDTRIP_CALLOUT_FLATTENED',
  'ROUNDTRIP_ACCORDION_FLATTENED',
  'ROUNDTRIP_TASK_STATE_LOST',
```

In `ARTICLE_HTML_RULES`, after the `ROUNDTRIP_IMG_ALT_LOST` row:

```ts
  ROUNDTRIP_RAW_ELEMENT_LOST: { severity: 'error', impact: 'content', element: 'markup', change: 'stripped', verifiedOn: '2026-09-17' },
  ROUNDTRIP_CALLOUT_FLATTENED: { severity: 'error', impact: 'content', element: 'callout', change: 'restructured', verifiedOn: '2026-09-17' },
  ROUNDTRIP_ACCORDION_FLATTENED: { severity: 'error', impact: 'content', element: 'accordion', change: 'restructured', verifiedOn: '2026-09-17' },
  ROUNDTRIP_TASK_STATE_LOST: { severity: 'error', impact: 'content', element: 'taskList', change: 'attribute-lost', verifiedOn: '2026-09-17' },
```

- [ ] **Step 4: Implement the four diff families**

Add to `src/resources/article-html.ts`, near the other `diff*` helpers, and call them from `diffArticleRoundTrip` after `diffImages(before, after, add)`:

```ts
/**
 * Elements Markdown cannot represent at all. Counted, not matched positionally: Hudu and
 * a converter both reorder freely, and a count change is the loss that matters.
 *
 * Symmetric by construction -- a count differing in EITHER direction is reported, because
 * this function may not assume which argument came from Hudu.
 */
const RAW_ELEMENTS = [
  'script', 'style', 'iframe', 'noscript', 'svg', 'math', 'form', 'input', 'button',
  'select', 'textarea', 'object', 'embed', 'video', 'audio', 'canvas',
] as const;

function countTag(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length;
}

function diffRawElements(before: string, after: string, add: Add): void {
  for (const tag of RAW_ELEMENTS) {
    const b = countTag(before, tag);
    const a = countTag(after, tag);
    if (b === a) continue;
    add(
      'ROUNDTRIP_RAW_ELEMENT_LOST',
      `<${tag}> count changed across the round trip (${b} -> ${a}). Markdown cannot represent this element, so a transform through it silently drops the whole node.`,
      { detail: `${tag}: ${b} -> ${a}` },
    );
  }
}

function countCallouts(html: string): number {
  // Match the base class wherever it sits in the class list: Hudu reorders it.
  return (html.match(/<div\b[^>]*class="[^"]*\bcallout\b[^"]*"/gi) ?? []).length;
}

function diffCallouts(before: string, after: string, add: Add): void {
  const b = countCallouts(before);
  const a = countCallouts(after);
  if (b === a) return;
  add(
    'ROUNDTRIP_CALLOUT_FLATTENED',
    `Callout count changed across the round trip (${b} -> ${a}). A flattened callout keeps its words and loses the signal that they are a warning.`,
    { detail: `callout: ${b} -> ${a}` },
  );
}

function countAccordions(html: string): number {
  return (html.match(/<(?:div|details)\b[^>]*(?:class="[^"]*\bmce-accordion\b[^"]*")/gi) ?? []).length
    + (html.match(/<details\b(?![^>]*mce-accordion)/gi) ?? []).length;
}

function diffAccordions(before: string, after: string, add: Add): void {
  const b = countAccordions(before);
  const a = countAccordions(after);
  if (b === a) return;
  add(
    'ROUNDTRIP_ACCORDION_FLATTENED',
    `Accordion count changed across the round trip (${b} -> ${a}). Flattening one reveals collapsed content and loses the summary/body split.`,
    { detail: `accordion: ${b} -> ${a}` },
  );
}

function countChecked(html: string): number {
  return (html.match(/data-checked="true"/gi) ?? []).length
    + (html.match(/<input\b[^>]*\bchecked\b/gi) ?? []).length;
}

function countTaskItems(html: string): number {
  return (html.match(/data-checked="(?:true|false)"/gi) ?? []).length
    + (html.match(/<input\b[^>]*type="checkbox"/gi) ?? []).length;
}

function diffTaskState(before: string, after: string, add: Add): void {
  const items = { b: countTaskItems(before), a: countTaskItems(after) };
  const checked = { b: countChecked(before), a: countChecked(after) };
  if (items.b === items.a && checked.b === checked.a) return;
  add(
    'ROUNDTRIP_TASK_STATE_LOST',
    `Task-list state changed across the round trip (${items.b} item(s)/${checked.b} checked -> ${items.a}/${checked.a}). Which steps are done is content, not decoration.`,
    { detail: `taskItems: ${items.b} -> ${items.a}; checked: ${checked.b} -> ${checked.a}` },
  );
}
```

Wire them in:

```ts
  diffEscaped(before, after, add);
  diffTables(before, after, add);
  diffCodeBlocks(before, after, add);
  diffLinks(before, after, findings, before);
  diffImages(before, after, add);
  diffRawElements(before, after, add);
  diffCallouts(before, after, add);
  diffAccordions(before, after, add);
  diffTaskState(before, after, add);
```

- [ ] **Step 5: Extend the function's doc block**

The contract block at `src/resources/article-html.ts:978` says the diff is "a lightweight spot-check across the four families that actually break in practice — tables, code blocks, links, images". Update that sentence:

```
 * This is a lightweight spot-check across the families that actually break in practice --
 * tables, code blocks, links, images, raw elements, callouts, accordions and task-list
 * state -- not a byte diff. Hudu legitimately reformats whitespace, reorders attributes
 * and drops a `<thead>` wrapper, and none of that costs the reader anything.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/resources/article-html.test.ts
```

Expected: PASS, including the pre-existing rule-table completeness test, which now iterates 32 codes.

- [ ] **Step 7: Run the whole suite — this changes behaviour for existing callers**

```bash
npm test
```

Expected: PASS. If an existing round-trip test now reports a new code, read it before "fixing" it: the new finding is probably correct and the old fixture was passing because the check did not exist.

- [ ] **Step 8: Commit**

```bash
git add src/resources/article-html.ts test/resources/article-html.test.ts
git commit -m "feat(article-html): diff raw elements, callouts, accordions and task state

diffArticleRoundTrip covered escaping, tables, code, links and images. Markdown
also destroys raw elements, Hudu callouts and accordions, and task-list check
state, none of which were reported. Each family is counted in both arguments and
reported when the counts differ in either direction, keeping the function
symmetric and free of assumptions about which side came from Hudu.

Behaviour change: an existing caller gating a write on any content-impact finding
may now refuse a write that previously passed. That is the correct direction --
the previous silence was a missed loss, not a permission."
```

---

### Task 4: `HuduContentLossError`

**Files:**
- Modify: `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: `ArticleHtmlFinding` from `src/resources/article-html.ts`; the existing `HuduError` base class.
- Produces: `HuduContentLossError` with `code = 'CONTENT_LOSS'` and `readonly findings: readonly ArticleHtmlFinding[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/errors.test.ts`:

```ts
describe('HuduContentLossError', () => {
  const finding = {
    code: 'ROUNDTRIP_CALLOUT_FLATTENED' as const,
    severity: 'error' as const,
    impact: 'content' as const,
    element: 'callout' as const,
    message: 'Callout count changed across the round trip (1 -> 0).',
  };

  it('carries the findings and names both ways forward', () => {
    const err = new HuduContentLossError('articles.update', [finding]);
    expect(err).toBeInstanceOf(HuduError);
    expect(err.code).toBe('CONTENT_LOSS');
    expect(err.findings).toEqual([finding]);
    expect(err.message).toContain('ROUNDTRIP_CALLOUT_FLATTENED');
    expect(err.message).toContain('allowLossyMarkdown');
    expect(err.message).toContain('HTML');
  });

  it('names every content-impact finding, not just the first', () => {
    const second = { ...finding, code: 'ROUNDTRIP_TASK_STATE_LOST' as const, element: 'taskList' as const };
    const err = new HuduContentLossError('articles.update', [finding, second]);
    expect(err.message).toContain('ROUNDTRIP_CALLOUT_FLATTENED');
    expect(err.message).toContain('ROUNDTRIP_TASK_STATE_LOST');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run test/errors.test.ts
```

Expected: FAIL — `HuduContentLossError is not defined`.

- [ ] **Step 3: Implement**

Add to `src/errors.ts` alongside the existing classes, and export it from wherever the other error classes are re-exported:

```ts
/**
 * A Markdown write would have destroyed content in the STORED article.
 *
 * Thrown by `articles.update` when the current body does not survive an HTML -> Markdown
 * -> HTML round trip. The question it answers is "does what is already there survive",
 * which is why it catches destruction of regions the caller never edited.
 *
 * Presentation-impact findings never cause this throw; they are carried in `findings` so
 * a caller can report them.
 */
export class HuduContentLossError extends HuduError {
  readonly code = 'CONTENT_LOSS';
  readonly findings: readonly ArticleHtmlFinding[];

  constructor(operation: string, findings: readonly ArticleHtmlFinding[]) {
    const lost = findings.filter((f) => f.impact === 'content');
    super(
      `${operation}: this article cannot be edited as Markdown without losing content. ` +
        lost.map((f) => `${f.code} (${f.element}): ${f.message}`).join(' ') +
        ' Send the update as HTML to keep everything, or pass allowLossyMarkdown: true to accept the loss.',
      {
        operation,
        suggestedAction:
          'Send the update as HTML, or pass { allowLossyMarkdown: true } having read the findings on this error.',
      },
    );
    this.findings = findings;
  }
}
```

If `src/errors.ts` cannot import from `src/resources/article-html.ts` without a cycle, move the `ArticleHtmlFinding` **type** import to a `import type { ... }` statement — a type-only import is erased at build time and creates no runtime cycle.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/errors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Check the public surface test still holds**

`test/public-surface.test.ts` asserts the exported surface. Add `HuduContentLossError` to whatever list it maintains.

```bash
npx vitest run test/public-surface.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts test/errors.test.ts test/public-surface.test.ts
git commit -m "feat(errors): HuduContentLossError for refused Markdown writes"
```

---

### Task 5: Read path — `format` on `get` and `getContext`

**Files:**
- Modify: `src/types/common.ts`
- Modify: `src/resources/articles.ts` (`get` at `:148`, `getContext` at `:303-307`)
- Test: `test/resources/articles.test.ts`

**Interfaces:**
- Consumes: `htmlToMarkdown` from `src/content/markdown.js`.
- Produces:
  - `export type ContentFormat = 'html' | 'markdown'` re-exported from `src/types/common.ts`
  - `export interface ArticleGetOptions { format?: ContentFormat }` in `articles.ts`
  - `articles.get(id: number, opts?: ArticleGetOptions): Promise<Article>`
  - `articles.getContext(id, opts?: { expand?: boolean; format?: ContentFormat })`

- [ ] **Step 1: Write the failing tests**

Append to `test/resources/articles.test.ts`:

```ts
describe('reading an article as Markdown', () => {
  afterEach(clearFetch);

  it('returns content as Markdown when format is markdown', async () => {
    stubFetch([json({ article: { ...article, content: '<h2>Setup</h2><p>Run it.</p>' } })]);
    const client = new HuduClient({ baseUrl: 'https://h.example.com', apiKey: 'k' });
    const result = await client.articles.get(1, { format: 'markdown' });
    expect(result.content).toBe('## Setup\n\nRun it.');
  });

  it('returns HTML by default, unchanged', async () => {
    stubFetch([json({ article: { ...article, content: '<h2>Setup</h2>' } })]);
    const client = new HuduClient({ baseUrl: 'https://h.example.com', apiKey: 'k' });
    expect((await client.articles.get(1)).content).toBe('<h2>Setup</h2>');
  });

  it('converts inside getContext when expand is set', async () => {
    stubFetch([
      json({ article: { ...article, content: '<p>Body</p>' } }),
      json({ company }),
      json({ folder }),
    ]);
    const client = new HuduClient({ baseUrl: 'https://h.example.com', apiKey: 'k' });
    const ctx = await client.articles.getContext(1, { expand: true, format: 'markdown' });
    expect(asRecord(ctx.article).content).toBe('Body');
  });

  it('leaves the compact getContext tier alone -- it already drops content', async () => {
    stubFetch([json({ article }), json({ company }), json({ folder })]);
    const client = new HuduClient({ baseUrl: 'https://h.example.com', apiKey: 'k' });
    const ctx = await client.articles.getContext(1, { format: 'markdown' });
    expect(asRecord(ctx.article).content).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run test/resources/articles.test.ts
```

Expected: FAIL — `get` takes no second argument, so TypeScript rejects `{ format: 'markdown' }`.

- [ ] **Step 3: Add `ContentFormat` to `src/types/common.ts`**

```ts
/** Which representation a caller wants a rich-text field in. */
export type ContentFormat = 'html' | 'markdown';
```

- [ ] **Step 4: Implement the read path in `src/resources/articles.ts`**

Add near `WriteOptions` at `:36`:

```ts
/** Options for reading a single article. */
export interface ArticleGetOptions {
  /**
   * Return `content` as Markdown instead of HTML. A read destroys nothing, so no loss is
   * reported here -- the guard belongs on the write path.
   */
  format?: ContentFormat;
}

/** Convert `content` in place when the caller asked for Markdown. */
function projectContent<T extends { content?: string }>(record: T, format?: ContentFormat): T {
  if (format !== 'markdown' || typeof record.content !== 'string') return record;
  return { ...record, content: htmlToMarkdown(record.content) };
}
```

Change `get` at `:148`:

```ts
  async get(id: number, opts?: ArticleGetOptions): Promise<Article> {
    return projectContent(await this.getOne<Article>(id), opts?.format);
  }
```

Change `getContext`'s three overload signatures and its body at `:303-307` to accept `format`:

```ts
  async getContext(id: number, opts?: { expand?: boolean; format?: ContentFormat }): Promise<ArticleContext>;
  async getContext(id: number, opts: { expand: true; format?: ContentFormat }): Promise<ArticleContextExpand>;
  async getContext(id: number, opts?: { expand?: boolean; format?: ContentFormat }): Promise<ArticleContext | ArticleContextExpand>;
  async getContext(id: number, opts?: { expand?: boolean; format?: ContentFormat }): Promise<ArticleContext | ArticleContextExpand> {
```

Inside the body, where the full `article` is returned under `expand`, wrap it: `projectContent(article, opts?.format)`. The compact branch calls `toArticleSummary`, which already drops `content` — leave it untouched.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/resources/articles.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/common.ts src/resources/articles.ts test/resources/articles.test.ts
git commit -m "feat(articles): read content as Markdown with { format: 'markdown' }"
```

---

### Task 6: Write path — the loss guard

**Files:**
- Modify: `src/types/common.ts` (`MutationOptions`)
- Modify: `src/resources/articles.ts` (`WriteOptions`, `create` at `:160-169`, `update` at `:173-181`)
- Test: `test/resources/articles.test.ts`

**Interfaces:**
- Consumes: `htmlToMarkdown`, `markdownToHtml`; `diffArticleRoundTrip` from `src/resources/article-html.js`; `HuduContentLossError`; the inherited `assertNotStale` and `getOne` from `src/resources/base.ts`.
- Produces: `MutationOptions.format`, `MutationOptions.allowLossyMarkdown`, `WriteOptions.format`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('writing an article as Markdown', () => {
  afterEach(clearFetch);
  const client = () => new HuduClient({ baseUrl: 'https://h.example.com', apiKey: 'k' });
  const sentBody = (call = 0) => JSON.parse(String(asRecord(stubFetch.calls[call].init).body));

  it('converts Markdown to HTML on create, with no guard and no extra fetch', async () => {
    stubFetch([json({ article })]);
    await client().articles.create({ name: 'N', content: '## Setup', folder_id: 5 }, { format: 'markdown' });
    expect(stubFetch.calls).toHaveLength(1);
    expect(sentBody().article.content).toContain('<h2');
  });

  it('refuses an update when the STORED article would lose content', async () => {
    // The agent never touched the callout; converting the stored body would destroy it.
    stubFetch([json({ article: { ...article, content: '<div class="callout callout-warning"><p>Back up first.</p></div>' } })]);
    await expect(
      client().articles.update(1, { content: '## New' }, { format: 'markdown' }),
    ).rejects.toThrow(HuduContentLossError);
    expect(stubFetch.calls).toHaveLength(1); // the GET only; no PUT was issued
  });

  it('allows the same update with allowLossyMarkdown', async () => {
    stubFetch([
      json({ article: { ...article, content: '<div class="callout callout-warning"><p>Back up first.</p></div>' } }),
      json({ article }),
    ]);
    await client().articles.update(1, { content: '## New' }, { format: 'markdown', allowLossyMarkdown: true });
    expect(stubFetch.calls).toHaveLength(2);
    expect(sentBody(1).article.content).toContain('<h2');
  });

  it('allows an update whose only losses are presentation', async () => {
    // The calibration case: an ordinary article must stay editable as Markdown.
    stubFetch([
      json({ article: { ...article, content: '<h2 class="text-left">Setup</h2><p style="color:#333">Run it.</p>' } }),
      json({ article }),
    ]);
    await client().articles.update(1, { content: '## Setup\n\nRun it.' }, { format: 'markdown' });
    expect(stubFetch.calls).toHaveLength(2);
  });

  it('issues no extra fetch when data carries no content key', async () => {
    stubFetch([json({ article })]);
    await client().articles.update(1, { name: 'Renamed' }, { format: 'markdown' });
    expect(stubFetch.calls).toHaveLength(1); // the PUT alone -- no guard fetch
  });

  it('shares ONE fetch between the guard and expectedUpdatedAt', async () => {
    stubFetch([json({ article }), json({ article })]);
    await client().articles.update(
      1,
      { content: '## New' },
      { format: 'markdown', expectedUpdatedAt: article.updated_at },
    );
    expect(stubFetch.calls).toHaveLength(2); // one GET, one PUT
  });

  it('still throws StaleObjectError through the shared fetch', async () => {
    stubFetch([json({ article: { ...article, updated_at: '2030-01-01T00:00:00.000Z' } })]);
    await expect(
      client().articles.update(1, { content: '## New' }, { format: 'markdown', expectedUpdatedAt: article.updated_at }),
    ).rejects.toThrow(StaleObjectError);
  });

  it('runs the guard on a dry run and reports rather than writing', async () => {
    stubFetch([json({ article: { ...article, content: '<div class="callout callout-info"><p>FYI</p></div>' } })]);
    await expect(
      client().articles.update(1, { content: '## New' }, { format: 'markdown', dryRun: true }),
    ).rejects.toThrow(HuduContentLossError);
  });

  it('leaves an HTML update completely unchanged', async () => {
    stubFetch([json({ article })]);
    await client().articles.update(1, { content: '<p>x</p>' });
    expect(stubFetch.calls).toHaveLength(1);
    expect(sentBody().article.content).toBe('<p>x</p>');
  });
});
```

Adjust `sentBody` and `stubFetch.calls` to whatever `test/helpers.ts` actually exposes — read it before writing these; the shape above is illustrative of intent, the assertions are not.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run test/resources/articles.test.ts
```

Expected: FAIL — `format` is not a `MutationOptions` key.

- [ ] **Step 3: Extend `MutationOptions` in `src/types/common.ts:162`**

```ts
export interface MutationOptions {
  /** Describe the mutation instead of performing it. */
  dryRun?: boolean;
  /** Opt-in stale-object guard: the `updated_at` the caller last read for this record. */
  expectedUpdatedAt?: string;
  /** Interpret `data.content` as Markdown and convert it to HTML before sending. */
  format?: ContentFormat;
  /**
   * Proceed with a Markdown update that would destroy content in the STORED article.
   * Read the `findings` on the {@link HuduContentLossError} first -- this is how a
   * region the caller never edited gets overwritten.
   */
  allowLossyMarkdown?: boolean;
}
```

Also add `format?: ContentFormat` to `WriteOptions` in `articles.ts:36`.

- [ ] **Step 4: Implement `create`**

There is no stored content to destroy, so no guard and no fetch:

```ts
  async create(data: ArticleCreate, opts?: WriteOptions): Promise<Article | DryRunResult<Article>> {
    const payload =
      opts?.format === 'markdown' && typeof data.content === 'string'
        ? { ...data, content: markdownToHtml(data.content) }
        : data;
    return this.createOne<Article>(payload, undefined, opts);
  }
```

- [ ] **Step 5: Implement `update` with the shared single fetch**

```ts
  async update(id: number, data: ArticleUpdate, opts?: MutationOptions): Promise<Article | DryRunResult<Article>> {
    if (opts?.format !== 'markdown' || typeof data.content !== 'string') {
      return this.updateOne<Article>(id, data, undefined, opts);
    }

    // ONE fetch serves both the loss guard and the stale check. updateOne would issue its
    // own for expectedUpdatedAt, so the guard is run here and expectedUpdatedAt is consumed
    // here too -- assertNotStale takes the fetch as a callback, so the same record feeds both.
    const current = await this.getOne<Article>(id);
    await this.assertNotStale('articles.update', this.resourcePath, id, opts.expectedUpdatedAt, () =>
      Promise.resolve(current),
    );

    if (opts.allowLossyMarkdown !== true && typeof current.content === 'string') {
      // The question is whether the STORED body survives the round trip: that catches
      // destruction of the regions the caller never touched, independent of what they sent.
      const findings = diffArticleRoundTrip(current.content, markdownToHtml(htmlToMarkdown(current.content)));
      if (findings.some((f) => f.impact === 'content')) {
        throw new HuduContentLossError('articles.update', findings);
      }
    }

    const { expectedUpdatedAt: _checked, ...rest } = opts;
    return this.updateOne<Article>(id, { ...data, content: markdownToHtml(data.content) }, undefined, rest);
  }
```

Note `expectedUpdatedAt` is stripped before delegating: it has already been verified against `current`, and leaving it in would make `updateOne` fetch a second time.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/resources/articles.test.ts
```

Expected: PASS, including the two fetch-count assertions.

- [ ] **Step 7: Commit**

```bash
git add src/types/common.ts src/resources/articles.ts test/resources/articles.test.ts
git commit -m "feat(articles): Markdown writes, refused by default when they would lose content

update with { format: 'markdown' } asks whether the STORED body survives an
HTML -> Markdown -> HTML round trip, which is what catches destruction of the
regions the caller never edited. One fetch serves both that guard and the
expectedUpdatedAt stale check."
```

---

### Task 7: The whole-article fixture that catches a bad converter swap

The family fixtures catch a bad converter. This one catches a bad *swap*: a replacement engine that handles tables and code correctly can still flatten a Hudu callout.

**Files:**
- Test: `test/content/whole-article.test.ts` (new)
- Create: `test/fixtures/hudu-article.html` (new)

**Interfaces:**
- Consumes: `htmlToMarkdown`, `markdownToHtml`, `diffArticleRoundTrip`, `htmlToText` from `src/search/html.js`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the fixture**

```html
<!-- test/fixtures/hudu-article.html -->
<h2>VPN rollout</h2>
<p>Run the steps below. Literal Markdown characters must survive: *not emphasis*, _not italic_, # not a heading, and a pipe | in prose.</p>
<div class="callout callout-warning"><p>Back up the config before you start.</p></div>
<ul data-type="taskList">
  <li data-checked="true">Export the current profile</li>
  <li data-checked="false">Push the new profile</li>
</ul>
<div class="mce-accordion">
  <summary>Advanced options</summary>
  <div class="mce-accordion-body"><p>Set <kbd>MTU</kbd> to 1400.</p></div>
</div>
<table>
  <thead><tr><th>Host</th><th>IP</th></tr></thead>
  <tbody><tr><td>vpn1</td><td>10.0.0.1</td></tr><tr><td>vpn2</td><td>10.0.0.2</td></tr></tbody>
</table>
<pre><code class="language-bash">sudo systemctl restart openvpn</code></pre>
<p>See the <a href="https://example.com/kb/vpn">runbook</a> and <img src="/public_photo/topology-9f2" alt="Topology"> for detail.</p>
```

- [ ] **Step 2: Write the failing test**

```ts
// test/content/whole-article.test.ts
/**
 * One representative Hudu article through the full round trip.
 *
 * The per-family fixtures catch a bad converter. THIS one catches a bad SWAP: a
 * replacement engine can get tables and code right and still flatten a callout. When
 * src/content/turndown-engine.ts is replaced, this test is the gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { htmlToMarkdown, markdownToHtml } from '../../src/content/markdown.js';
import { diffArticleRoundTrip } from '../../src/resources/article-html.js';
import { htmlToText } from '../../src/search/html.js';

const original = readFileSync(new URL('../fixtures/hudu-article.html', import.meta.url), 'utf8');

describe('a whole Hudu article', () => {
  const md = htmlToMarkdown(original);
  const rebuilt = markdownToHtml(md);
  const findings = diffArticleRoundTrip(original, rebuilt);

  it('keeps every piece of prose a reader can see', () => {
    for (const phrase of [
      'VPN rollout', 'Back up the config before you start.', 'Export the current profile',
      'Push the new profile', 'Advanced options', 'vpn1', '10.0.0.2',
      'sudo systemctl restart openvpn', 'runbook', 'Topology',
    ]) {
      expect(htmlToText(rebuilt), `lost: ${phrase}`).toContain(phrase);
    }
  });

  it('does not let literal Markdown characters in prose turn into markup', () => {
    expect(htmlToText(rebuilt)).toContain('*not emphasis*');
    expect(htmlToText(rebuilt)).toContain('# not a heading');
    expect(rebuilt).not.toMatch(/<em>not emphasis<\/em>/);
  });

  it('keeps the table, the code fence and its language', () => {
    expect(rebuilt).toContain('<table>');
    expect(rebuilt).toMatch(/<code[^>]*class="[^"]*language-bash/);
  });

  it('reports exactly the structures Markdown cannot hold, and no others', () => {
    // These three are known, accepted losses -- a Markdown editor cannot express them.
    // The point of the assertion is that the list does not GROW when the engine is swapped.
    expect(new Set(findings.filter((f) => f.impact === 'content').map((f) => f.code))).toEqual(
      new Set(['ROUNDTRIP_CALLOUT_FLATTENED', 'ROUNDTRIP_ACCORDION_FLATTENED', 'ROUNDTRIP_TASK_STATE_LOST']),
    );
  });

  it('is therefore an article the SDK refuses to edit as Markdown by default', () => {
    expect(findings.some((f) => f.impact === 'content')).toBe(true);
  });
});

describe('the semantic-stability property', () => {
  /**
   * For any fixture the differ reports NO content-impact finding on, HTML -> MD -> HTML
   * must be semantically stable. "Semantically stable" is defined concretely as: both the
   * original and the rebuilt HTML fed through htmlToText yield identical strings. That
   * function already normalises whitespace, decodes entities and inserts block/cell
   * boundaries, so it compares the text a reader sees while ignoring the presentation
   * markup we have agreed to drop.
   *
   * Only HTML -> MD -> HTML is guaranteed. MD -> HTML -> MD is NOT identity -- marked and
   * turndown disagree at the edges -- and nothing here depends on it.
   */
  const stable = [
    '<h2>Setup</h2><p>Run <code>npm ci</code> first.</p>',
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '<pre><code class="language-bash">echo hi</code></pre>',
    '<p><a href="https://example.com">link</a> and <strong>bold</strong> and <em>italic</em>.</p>',
    '<blockquote><p>Quoted.</p></blockquote>',
    '<h3 class="text-left">Styled heading</h3><p style="color:#333">Styled prose.</p>',
    '<p>Entities: &amp; &lt; &gt; &quot; and &nbsp; space.</p>',
  ];

  for (const html of stable) {
    it(`is stable for: ${html.slice(0, 48)}...`, () => {
      const out = markdownToHtml(htmlToMarkdown(html));
      const lossy = diffArticleRoundTrip(html, out).filter((f) => f.impact === 'content');
      // Guard the guard: if a fixture DOES report content loss it does not belong in this
      // list, and silently skipping it would make the property vacuously true.
      expect(lossy.map((f) => f.code), 'fixture must be loss-free to test stability').toEqual([]);
      expect(htmlToText(out)).toBe(htmlToText(html));
    });
  }
});
```

- [ ] **Step 3: Run it**

```bash
npx vitest run test/content/whole-article.test.ts
```

Expected: PASS if Tasks 2 and 3 are correct. If the content-loss code set differs from the three listed, do **not** edit the expectation to match — read each unexpected code and decide whether the converter or the differ is wrong. The whole value of this test is that it fails when the set changes.

- [ ] **Step 4: Commit**

```bash
git add test/content/whole-article.test.ts test/fixtures/hudu-article.html
git commit -m "test(content): whole-article round-trip fixture, the converter-swap gate"
```

---

### Task 8: Regenerate the capability surface, document, and close the gates

**Files:**
- Modify: `scripts/generate-capabilities.mjs`
- Regenerate: `src/capabilities.ts`, `capabilities.json`, `MCP_TOOL_MANIFEST.md`, `src/mcp/catalog.generated.ts`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: the released surface.

- [ ] **Step 1: Teach the capability generator the new options**

`scripts/generate-capabilities.mjs` derives each operation's input schema. `articles.get`, `articles.getContext`, `articles.create` and `articles.update` now take `format`, and `update` also takes `allowLossyMarkdown`. Find where the generator reads the option interfaces and add the two fields, then:

```bash
npm run capabilities:build
npm run capabilities:check
```

Expected: PASS, rows=227 (the count does not change — no new operations, only new option fields).

- [ ] **Step 2: Regenerate the tool catalog**

```bash
node scripts/build-tool-catalog.mjs
npm run catalog:check
node scripts/project-mcp-tools.mjs --check-example
```

Expected: all PASS/OK.

- [ ] **Step 3: Document `format` in the README**

Add under the articles section:

```markdown
### Reading and writing articles as Markdown

An article body is HTML. `format: 'markdown'` converts it in both directions, which is
materially cheaper to put in an LLM's context and far more reliable for one to edit.

```ts
const article = await hudu.articles.get(42, { format: 'markdown' });
// article.content is Markdown

await hudu.articles.update(42, { content: '## Updated\n\nNew steps.' }, { format: 'markdown' });
```

A Markdown **write** is refused when the *stored* article would not survive the round
trip — a callout, an accordion or a task list, none of which Markdown can express. The
check runs against what is already in Hudu, so it catches destruction of the regions you
never edited:

```ts
try {
  await hudu.articles.update(42, { content: md }, { format: 'markdown' });
} catch (err) {
  if (err instanceof HuduContentLossError) {
    console.error(err.findings.filter((f) => f.impact === 'content'));
    // Send HTML to keep everything, or pass { allowLossyMarkdown: true } to accept the loss.
  }
}
```

Reads are never refused — a read destroys nothing.
```

- [ ] **Step 4: Write the CHANGELOG entry**

```markdown
## Unreleased

### Added

- **Article bodies as Markdown.** `articles.get(id, { format: 'markdown' })` and
  `getContext(id, { expand: true, format: 'markdown' })` return `content` as Markdown;
  `articles.create` and `articles.update` accept it with the same option. A new
  `./content` subpath exports `htmlToMarkdown` and `markdownToHtml` directly.
- `HuduContentLossError`, thrown when a Markdown update would destroy content in the
  stored article. Override with `{ allowLossyMarkdown: true }`.
- `diffArticleRoundTrip` now also reports raw elements, Hudu callouts, Hudu accordions
  and task-list check state.

### Changed

- **The zero-runtime-dependency property is retired.** `turndown`,
  `@joplin/turndown-plugin-gfm` and `marked` are now runtime dependencies, confined to
  `src/content/`. No type of theirs appears in an exported signature. Rationale and the
  rejected alternatives are recorded in ARCHITECTURE.md §15.1.
- **Behaviour change:** because `diffArticleRoundTrip` detects four more families, a
  caller gating a write on `findings.some(f => f.impact === 'content')` may now refuse a
  write that previously passed. The previous silence was a missed loss, not a permission.
```

- [ ] **Step 5: Run every gate**

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
npm test
npm run capabilities:check
npm run catalog:check
node scripts/project-mcp-tools.mjs --check-example
npm run verify:pack
```

Expected: all pass. `verify:pack` is the only check that proves the `./content` export map matches the real tarball in both module systems — it must be run, not assumed.

- [ ] **Step 6: Commit and open the PR**

```bash
git add -A
git commit -m "feat(content): document Markdown conversion and regenerate the capability surface"
gh pr create --title "feat: article HTML <-> Markdown conversion" --body "..."
```

---

## Calibration — do this before merging

The severity classification is inherited from `ARTICLE_HTML_RULES`, which derives from a
single audit of one Hudu build (`ARTICLE_HTML_PROVENANCE`, 2026-09-16). It has never been
run against a corpus of real articles.

Before merging, run `htmlToMarkdown` + `diffArticleRoundTrip` over a sample of genuine
articles from a live instance and count how many report a content-impact finding. If
*ordinary* documents refuse Markdown updates, the classification is wrong, not the design
— the likeliest culprit is `diffCallouts` firing on markup that is not really a callout.
A feature that refuses every article is not a safe feature, it is a broken one.
