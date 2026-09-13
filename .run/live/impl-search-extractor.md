# impl: HTML -> clean text -> snippet pipeline (build-order step 1)

Status: DONE. Files changed: `src/search/html.ts` (new), `src/search/snippet.ts` (new),
`src/search/index.ts` (new, internal barrel), `test/search/html.test.ts` (new),
`test/search/snippet.test.ts` (new). Nothing else touched; nothing committed.
Design of record: `.run/design/search/html-and-snippets.md` (S2 extractor, S3 snippets, S4 honesty),
reconciled in `.run/design/search/PROPOSAL.md` S12-14.
Modules are INTERNAL: not exported from the package root (see "Public surface").

## Deliverables
| # | Item | Status |
|---|---|---|
| 1 | `htmlToText(html, opts)` / `extractHtml(html, opts)` single O(n) character scan, no tag regex | DONE |
| 2 | entity decoding (named ~200 entries / decimal / hex; unknown stays literal) | DONE |
| 3 | `buildSnippet(text, terms, opts)` honesty contract (slice equality, absolute spans, caps) | DONE |
| 4 | property test: slice equality + span read-back (corpus x terms x 5 window sizes) | DONE (`test/search/snippet.test.ts`, >500 assertions) |
| 5 | naive-regex regression cases (script/style leak, `if (1<2)`, glued cells, entities) | DONE (`test/search/html.test.ts`) |
| 6 | ~200 KB perf bound with a generous ceiling | DONE (250 ms ceiling; worst measured 4.99 ms) |

Test totals: **79 new tests** (`test/search/html.test.ts` 48, `test/search/snippet.test.ts` 31).

## Measured numbers

### Extraction throughput and ratio (Node 24, warm, mean of 500 for article 16)
| Case | Input | Extracted | ms | ms/MB |
|---|---|---|---|---|
| **real article 16** (`GET /articles/16`, live) | 9,136 B | **4,268 chars** (**ratio 0.467**) | **0.138** | 15.1 |
| real-ish table doc | 190.4 KB | 92,499 chars | 3.46 | 18.2 |
| 20,000 nested `<div><p>` | 351.6 KB (capped to 256 KB) | 4 chars | 4.99 | 14.2 |
| 234 KB `<script>` + 20k x `if (1<2) {}`, no close | 234.4 KB | 0 chars | 0.457 | 2.0 |
| 200,000 bare `<` | 195.3 KB | 0 chars | 0.305 | 1.6 |
| 37,500 x `<a ` with no `>` | 109.9 KB | 0 chars | 0.177 | 1.6 |
| unterminated `<!--` + 200 KB | 195.3 KB | 0 chars | 0.048 | 0.2 |
| `<script>` + 100,000 `<` + `</script><p>after</p>` | 97.7 KB | 5 chars (`after`) | 0.284 | 2.9 |
| 100,000 bare `&` | 97.7 KB | 100,000 chars | 3.75 | 38.4 |

Ratio **0.467 extracted chars per raw byte** on the real article reproduces the design's 0.47 (9,136 -> 4,268)
exactly, so the `maxIndexTextBytes`/`maxDocBytes` re-derivation in design S4.3 stands.
Throughput is **~15-18 ms per MB** of raw HTML; a 1 MB input passed through the default `maxDocBytes` 256 KB cap in
**8 ms** in the test suite. Worst measured adversarial case: **4.99 ms**, i.e. inside the design's 4.2 ms-class claim.

### Snippet numbers on the real article (verbatim reproduction of the design's example)
```
buildSnippet(extracted, ['Rugged-35D'], {snippetChars: 200})
textStart 522, textEnd 731 (209 chars = 200 window + 9 word-boundary expansion)
spans [{start: 622, end: 632, terms: ['Rugged-35D']}]   -> read-back 'Rugged-35D'   (design: 622-632, identical)
truncated {before: true, after: true}, omittedSpans 0
text contains 'Low End FortiGateRugged-35D 6.2.16 Y'; 'Low EndFortiGateRugged-35D' is absent; '&nbsp;' is absent
```
220 x `A` token, term `AAAA`, `snippetChars` 120: one merged span covering the first **19** A's, `omittedSpans: 15`
(identical to the design), `occurrencesCapped: true` (design said false - see deviation D4).
Snippet build over ~100 KB of extracted text: **8 ms** in-suite (ceiling 250 ms).

## Evidence / gates (all run in this checkout)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **0** |
| `npm run lint` | **0** |
| `npm test` (`npx vitest run`) | **1784 passed / 54 files, 0 failed** |
| `npm run test:coverage` | All files **99.07 lines / 92.77 branches / 99.89 functions / 99.64 statements** (thresholds 97/94/83/97, unchanged); `src/search` 96.94 / 92.92 / 100 / 99.44 |
| `node scripts/check-capabilities.mjs` | **PASS** - 0 failures, rows=225 (66 warnings, all pre-existing: e.g. `websites.listPages` unplanned-surface) |
| `node scripts/check-capabilities.mjs --ship` | **PASS** - 0 failures |
| `node scripts/project-mcp-tools.mjs --check-example` | **OK** (this change touches neither the registry nor the projection; run for completeness) |
| `npm run build` | **OK** (tsup ESM+CJS+dts) |

No existing test was edited, skipped or weakened. No generated file was hand-edited.

## Live sandbox use
Read-only: one `GET /api/v1/articles/16` to obtain the real body for the ratio/timing/snippet measurements
(the key stayed in the request header, never in a file in the repo). **No record was created, modified or deleted**
- no POST/PUT/DELETE was issued, so the final inventory is the baseline: articles 16, 17, 18, 19 and the 20
account-wide assets untouched, **delta = 0**.
The measurement harness lives outside the repo (`/tmp/bench.mjs` + a `npx esbuild` bundle of `src/search/index.ts`);
no scratch file was added to the repo.

## Deviations from the design (each deliberate, each tested)
- **D1 - truncation is returned, not implied.** Design S2.1 sketches `extractText(html, opts): string`, but S4.2
  requires `maxDocBytes`/`maxOutChars` truncation to be *reported*. So the primitive is
  `extractHtml(html, opts): { text, rawBytes, scannedBytes, bytesTruncated, charsTruncated }` and
  `htmlToText(html, opts): string` is the thin wrapper (the name the brief asked for).
- **D2 - astral fold mapping.** Design S3.2 maps both UTF-16 units of an astral character to the *same* source
  index. With `end = map[fe - 1] + 1` that yields a half-surrogate end offset. Both units map to their own source
  unit here (`map[fi + k] = i + k`), so `end` is correct for every input width; `folded.length === text.length`
  and `map.length === folded.length + 1` still hold (property-tested, emoji case included).
- **D3 - window expansion vs. `snippetChars`.** Design S3.3 orders "expand, then re-centre if over the cap".
  Measured: whenever the expansion grew the window past the cap the re-centre fired and discarded the boundary
  work, i.e. the expansion was unobservable (the re-centre always reset `s` to a mid-word offset). Expansion is
  therefore applied LAST and the returned text is at most `snippetChars + 2 * MAX_BOUNDARY_EXPANSION`
  (= +128 chars, ~16 tokens). A match longer than `snippetChars` is head-clipped and never expanded. Both bounds
  are asserted in the property test.
- **D4 - `occurrencesCapped: true` for the 220x `A` case** (design S5.2 records `false`). The term `AAAA` has 217
  occurrences and only `maxOccPerTerm` (16) are collected, so reporting `false` would claim a complete list. The
  flag is set the moment a 17th occurrence exists; `omittedSpans: 15` still matches the design exactly.
- **D5 - spans are clipped to the window** (intersect + clamp) instead of requiring full containment. With
  full-containment filtering, a query term longer than `snippetChars` returned `available: false` even though the
  match *is* in the shown text. Clipped spans keep the invariant `textStart <= span.start <= span.end <= textEnd`
  and the property test asserts each span reads back contiguous characters of the matched term.
- **D6 - the entity terminator scan is a bounded 12-character loop**, not `indexOf(';')`. The `indexOf` form was
  quadratic on a document of bare `&`: **76.8 ms for 100k `&`, 3.75 ms after the fix** (found by the adversarial
  case, kept as a perf test).
- **D7 - "idempotent" is too strong in S4.1.6.** Extraction is *deterministic* on the same bytes (tested), but
  re-extracting already-extracted text is not identity: source newlines are just whitespace, and a decoded
  `<below>` would be read as a tag. The test asserts determinism plus stability on plain, markup-free text.
- **D8 - `pre` emits a block newline as well as preserving line breaks** (it is in both design lists; without the
  boundary `<p>a</p><pre>x</pre>` would glue to `ax`).
- Blank lines inside `pre` collapse, because guarantee 2 forbids a double newline; horizontal whitespace inside
  `pre` collapses as designed.

## Public surface
`src/search/*` is **not** exported from `src/index.ts`, adds no `package.json` export entry, and is not a `tsup`
entry: the public surface is unchanged and no public-surface fixture update is needed.
`test/search/html.test.ts` asserts that `htmlToText`, `extractHtml`, `decodeEntities`, `buildSnippet`,
`foldWithMap` and `foldText` are all absent from the package root, so a later accidental re-export fails a test.
Trade-off if it were exported: consumers would gain the extractor and the snippet builder (`htmlToText`,
`extractHtml`, `buildSnippet`, `foldWithMap`) as supported API; the cost is that their shapes freeze (the
`ExtractedText` truncation flags, the `SnippetResult` field set, the `MAX_BOUNDARY_EXPANSION` semantics) plus a
`public-surface.json` fixture update. The engine in step 2 needs them internally; a later step can promote them
deliberately, with a fixture change, instead of leaking them by accident now.

## UNVERIFIED
| Item | Status |
|---|---|
| Whether the Trix editor (not the API) preserves `<script>`/`<style>` in article bodies | UNVERIFIED here (that was the design's own open question); the raw-skip is cheaper than the answer, and the sandbox article 16 was read-only |
| Live asset custom-field snippet (`source: 'field:<label>'`) | UNVERIFIED end-to-end (no record created). The `source` label and the field-relative offsets are implemented and unit-tested |
| Fold behaviour on CJK/Thai (no inter-word spaces) | UNVERIFIED, as in the design. The fold is per-code-point and length-preserving by construction; only Latin/accent/emoji cases were run |
| Multi-byte `maxDocBytes` boundary | PARTIALLY VERIFIED - tested with 3-byte `é` characters; a 4-byte astral boundary was not exercised |
| `fn`/`exotic` named entities outside the ~200-entry table | UNVERIFIED by definition; they stay **literal** by design (tested with `&foo;`), never dropped |
