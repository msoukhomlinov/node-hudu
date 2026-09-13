# impl: HTML -> clean text -> snippet pipeline (build-order step 1)

Status: IN PROGRESS. Files: `src/search/html.ts`, `src/search/snippet.ts`, `test/search/*.test.ts`.
Design of record: `.run/design/search/html-and-snippets.md` (S2 extractor, S3 snippets, S4 honesty).
Internal modules - NOT exported from the package root (see "Public surface" below).

## Deliverables
| # | Item | Status |
|---|---|---|
| 1 | `htmlToText(html, opts)` single O(n) character scan | PENDING |
| 2 | entity decoding (named/decimal/hex, unknown stays literal) | PENDING |
| 3 | `buildSnippet(text, terms, opts)` honesty contract | PENDING |
| 4 | property test: slice equality + span read-back | PENDING |
| 5 | naive-regex regression cases | PENDING |
| 6 | 200 KB perf bound | PENDING |

## Measured numbers
PENDING (ms per KB, extracted/raw ratio)

## Evidence / gates
PENDING (tsc, lint, test, check-capabilities)

## Deviations from the design
PENDING

## Public surface
PENDING

## UNVERIFIED
PENDING
