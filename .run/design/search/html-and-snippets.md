# HTML -> clean text -> snippet pipeline (design)

Status: DESIGN ONLY. No file under `src/`, `test/` or `scripts/` was changed; nothing committed. All evidence is
from the live sandbox (Hudu 2.45.1, `hudu-sandbox.example.com`) or from a runnable prototype kept in
`/tmp/hx.mjs` (not part of the repo). Builds on `PROPOSAL.md` (amendment 11.1/11.2), `engine-design.md`
(S1.1 ingestion, S1.3 memory, S4.1 snippet honesty) and `mcp-surface.md`.

Prototype actually executed for every number below:
`/tmp/hx.mjs` (extractor + fold-with-index-map + snippet builder), driven by `/tmp/t1.mjs`, `/tmp/bench.mjs`,
`/tmp/v.mjs`, `/tmp/e.mjs`.

## 0. Summary / decisions at a glance

1. **Extraction is a single O(n) character scan, not a tag-stripping regex.** The regex approach provably leaks
   `<script>`/`<style>` bodies and glues adjacent table cells together (S2.7, measured).
2. **Output is a normalised plain-text document**: one newline at block boundaries (`p`, `div`, `li`, `tr`,
   `h1-h6`, `pre`, `table` roots), one space inside a table row between cells, one space between inline runs and
   at `</td>`; horizontal space collapsed; `&nbsp;`/U+00A0 and all Unicode spaces folded to a plain space.
3. **The vendor's own storage already mutates the HTML** (measured, S1.3): it decodes entities
   (`&nbsp;` -> U+00A0, `&#8212;`/`&mdash;` -> em dash), re-escapes bare `&`, **ingests inline base64 images into
   `/public_photo/<id>`**, **deletes `<![CDATA[...]]>`**, inserts newlines between block elements, and auto-closes
   unclosed tags - **but it keeps `<script>` and `<style>` verbatim**. The extractor therefore cannot assume
   either form: it must decode entities *and* drop raw script/style.
4. **Snippet offsets are absolute UTF-16 offsets into the document's extracted text**, and the snippet text is
   exactly `extracted.slice(textStart, textEnd)` - byte-for-byte, no added ellipsis characters, no invented spans.
5. **Work is bounded three ways**: raw input is capped before parsing (`maxDocBytes`), output chars are capped per
   document, and the per-query fold+offset map is built on demand for at most N candidate documents.
6. Extraction cost, measured: **0.22 ms per real 9.1 KB article**, **~24 ms/MB**, worst adversarial 200 KB case
   4.2 ms. For 2,000 articles / ~12 MB of HTML this is **~0.3 s**, once per TTL, at index time only.
7. **Memory maths changes**: the index now stores *extracted* text, measured at **0.47-0.49x the raw HTML bytes**
   (article 16: 9,136 -> 4,268; specimen: 1,169 -> 578). Section 4.3 re-derives `maxDocBytes` /
   `maxIndexTextBytes`.

## 1. Evidence: what real Hudu article HTML contains

### 1.1 Baseline articles (16-19) - markup family inventory

`GET /api/v1/articles?page=1&page_size=25` on the sandbox returns 4 articles; every row carries the **full HTML**
`content` (so one bounded page walk gets every body - re-confirmed here, not re-derived).

| id | name | raw `content` bytes |
|---|---|---|
| 16 | FortiOS Recommended Releases | 9,136 |
| 17 | Test article | 3 |
| 18 | AUPOST-WS013 - Workstation Summary | 551 |
| 19 | AUPOST-WS012 - Workstation Summary | 546 |

Tag and entity census over all four bodies (regex count, for inventory only):

| Family | Occurrences | Present? |
|---|---|---|
| `td` / `tr` / `th` / `thead` / `tbody` / `table` | 880 / 222 / 8 / 2 / 2 / 2 | yes - article 16 is essentially one 880-cell table |
| `p` / `h1` / `strong` / `a` | 8 / 4 / 2 / 2 | yes |
| attributes | `href` 1, `rel` 1, `target` 1 | yes - inline style / class attributes appear on custom content |
| entities | `&nbsp;` x11 | yes |
| comments, CDATA, `<style>`, `<script>`, `<pre>`/`<code>`, `<img>`, base64, `<br>`, inline `style=`, empty `<p>`/`<div>` | 0 in these four | absent in the baseline; all present in the specimen (S1.2) |

Article 16 raw head (verbatim):

```
<h1>Introduction</h1><p>This comprehensive guide provides the latest FortiOS software recommendations for optimal stability and deployment success. Based on Fortinet's official Technical Tip article, it is automatically synchronised nightly to ensure you have access to the most current release guidance.</p><p>The content is automatically synchronised from&nbsp;<a href="https://community.fortinet.com/t5/FortiGate/Technical-Tip-Recommended-Release-for-FortiOS/ta-p/227178" rel="noopener" target="_blank">https://community.fortinet.com/t5/FortiGate/Technical-Tip-Recommended-Release-for-FortiOS/ta/p/227178</a>.</p><p><strong>Current as of</strong>: Thu 10 July 2025, 10:20 am GMT+10</p><h1>Recommended releases</h1><table><thead><tr><th>Product Family</th>...<td>FortiGateRugged-35D</td><td>6.2.16</td><td>Y</td></tr>...
```

Fact worth carrying into the design: the body is **one line with no newlines**; the only separators a searcher can
rely on are the tags themselves. Any stripper that does not *insert* a separator where a tag was destroys token
boundaries (measured in S2.7).

### 1.2 Specimen created by this agent (article id 33) - awkward markup, live

Created via `POST /api/v1/articles` with a body containing a comment, a `<style>` block, an `<h2 style=...>`, a
`&nbsp;`, `&amp;`, `&mdash;`, `&#8212;`, `&#x2014;`, `&lt;below&gt;`, an inline base64 `<img>`, a `<ul>`, a
`<table>` with `thead`/`tbody`, an unknown entity `&foo;`, `&#169;`/`&#xA9;`, `<pre><code>` with a newline and a
tab, an **unclosed** `<b>` and an unclosed `<p>`, a `<script>` with `if (1<2)` and a raw NBSP, a **220-character
unbroken token**, a CDATA block, an empty `<p></p><p>   </p><div></div>`, and an `<a>` whose href contains `&amp;`.
Everything below is what the API actually stored and returned (not what was sent).

### 1.3 What the vendor does with the markup - measured mutation on write

Diff of *sent* vs *stored* `content` (1,281 -> 1,169 bytes). The API is destructive:

| Change | Evidence |
|---|---|
| named + numeric + hex entities are decoded to raw characters | `&nbsp;` -> `\u00a0`; `&mdash;`, `&#8212;`, `&#x2014;` -> `—`; `&#169;`, `&#xA9;` -> `©` (stored NBSP count 3) |
| an unknown entity is escaped, not decoded | `&foo;` -> `&amp;foo;` (so extraction must decode `&amp;` to get back the literal `&foo;`) |
| **inline base64 images are ingested and the src is rewritten** | `data:image/png;base64,iVBORw0KG...` -> `/public_photo/1478debd5740` (this is the 112-byte size drop) |
| **`<![CDATA[raw cdata block]]>` is deleted** | absent from stored content |
| newlines inserted between block elements; unclosed tags auto-closed | `<ul>\n<li>...`, `<b>bold text</b></p>`, `<p>` auto-closed |
| **`<script>` and `<style>` survive verbatim** | stored content still contains `var secret = "zephirine"; if (1<2) { alert(" "); }` and `.x{color:red}` |

Consequences the design must absorb:

- **Both entity forms occur in the wild.** Article 16 (imported/synced) stores 11 literal `&nbsp;`; article 33
  (written through the API) stores raw U+00A0. Decoding entities is necessary, and folding U+00A0 to a space is
  necessary - neither alone is sufficient.
- **`<script>`/`<style>` must be dropped by us**, because the vendor keeps them. Without that, a body index would
  index JavaScript identifiers and CSS colour values as document text (and a snippet could quote script source).
- **Images never enter the text path**: the extractor ignores `src` entirely, so neither a base64 blob nor the
  rewritten `/public_photo/...` URL can reach the index. (Hudu also exposes the ingested image as
  `public_photos[]`; the search path never fetches it.)
- **`&lt;below&gt;` decodes to `<below>` in the text.** A literal `<` in extracted text is real content, not a
  parsing failure - the leak test must therefore look for *tag names*, not for `<` (S2.5).

## 2. The extractor: in-repo, zero-dependency HTML -> text

### 2.1 Output contract and normalisation rules

```
extractText(html: string, opts: { maxDocBytes?: number, maxOutChars?: number }): string
```

Guarantees of the returned string:

1. No markup: no element/comment/declaration/PI survives; no `<tag`, `</tag` sequence of any source tag name
   survives (verified on both specimens, S5).
2. **No leading/trailing whitespace, no two consecutive newlines, no space adjacent to a newline, no repeated
   space.** The separator alphabet is exactly `{ ' ', '\n' }`.
3. Separators are *inserted* at boundaries, never depended upon from the source: a block element start/end emits a
   newline; a `br` emits a newline; a table cell boundary emits a space; inline element boundaries emit nothing
   (adjacent inline text stays glued, exactly as a browser renders `foo<span>bar</span>`).
4. Entities are decoded; unknown named entities are kept **literally** (`&foo;` stays `&foo;`, so it is findable);
   invalid numeric references become U+FFFD.
5. Spaces: tab/CR/LF/FF/VT, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 collapse to one
   space. U+200B (ZWSP) and U+FEFF (BOM/ZWNBSP) are treated as space. Other C0/C1 controls are dropped.
6. `pre` keeps its line breaks (each `\n` a hard newline); horizontal whitespace inside `pre` still collapses
   (matching is whitespace-insensitive, so preserving indent buys bytes and no recall).
7. Coordinates are **UTF-16 code units** (JavaScript string indices). Astral characters count as 2. This is the
   same coordinate space as the snippet offsets in S3.

### 2.2 Scanner structure (why one pass, not regexes)

```
i = 0
while i < n:
  lt = indexOf('<', i)
  if lt < 0: emitTextRun(i, n); break
  if lt > i: emitTextRun(i, lt)
  i = lt
  <!-- ... -->          -> skip to '-->'  (or EOF)
  <![CDATA[ ... ]]>     -> emit inner text, skip inside
  <! ... >, <? ... ?>   -> skip to '>'
  else parse tag:
     scan j from i+1 with a quote state ('"' / "'") until an unquoted '>' or EOF   # '>' inside an attribute value is not the tag end
     name = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/
     raw-skip element  -> skip a case-insensitive '</name' scan, then to its '>'
     'pre'             -> preDepth++
     'br'              -> pending = '\n'
     'img'             -> emit its alt attribute text (decoded, collapsed), ignore src
     block element     -> pending = '\n'
     cell element      -> pending = ' ' (only if no newline is already pending)
     anything else     -> nothing (inline)
```

`emitTextRun(from, to)` = `decodeEntities(slice)` then `normaliseWhitespace(...)` then `emit()`, where `emit()`
first flushes the pending separator (empty output emits nothing; `'\n'` never doubles; `' '` never sits next to a
newline). A final linear compaction pass over the joined output enforces guarantee 2 - this is the only regex in
the pipeline and it runs on already-extracted text, so it cannot see markup.

Raw-skip elements (content dropped entirely): `script`, `style`, `textarea`, `iframe`, `noscript`, `svg`, `math`,
`title`, `head`, `template`, `xmp`, `plaintext`.
Block elements (newline boundary): `p div h1-h6 li tr blockquote pre table thead tbody tfoot ul ol dl dt dd
section article header footer aside main nav figure figcaption hr form fieldset address caption details summary`.
Cell elements (space): `td`, `th`. `br`: newline.

### 2.3 Entity decoding

Single scan; an entity is only recognised when the terminating `;` is found within 12 characters and the body is
digits, `#`+digits, `#x`+hex, or letters. Otherwise the `&` is emitted literally and scanning continues.

- Named: an in-repo frozen table of the ~150 entities that actually occur in documentation prose (`amp lt gt quot
  apos nbsp copy reg trade mdash ndash hellip lsquo rsquo ldquo rdquo laquo raquo times divide deg plusmn sup2
  frac12` + the common accented Latin letters + `euro pound yen cent sect para middot bull dagger permil prime ne
  le ge larr rarr harr infin` + lower-case Greek + the Unicode space entities). The table is data, not code: a
  plain object, tree-shakeable, ~2 KB of source.
- Unknown named entity: **left literal**. Rationale: article 33 proved the vendor stores `&foo;` as `&amp;foo;`;
  decoding it to nothing would silently delete a token a caller may search for, and inventing a mapping is
  fabrication.
- Numeric decimal `&#NNN;` and hex `&#xHHH;`: decoded with `String.fromCodePoint` after validation. `0`, values
  above U+10FFFF and surrogate code points become U+FFFD; C1 control code points become U+FFFD (we deliberately do
  **not** ship the HTML5 Windows-1252 remap table - 32 entries of vendor folklore for prose that does not contain
  it; the cost is one replacement character).
- Missing-semicolon legacy entities (`&amp` without `;`) are **not** decoded - the `&` stays literal. Hudu content
  is produced by a WYSIWYG/API path that emits `;` (both specimens do), and guessing terminator-less entities adds
  an ambiguity class for no measured gain.
- `&lt;`/`&gt;` decode to `<`/`>` **in the text**, which is why guarantee 1 is phrased as "no tag name", not "no
  angle bracket" (S1.3).

### 2.4 Malformed / unclosed markup

The scanner has no tree and never backtracks, so malformed input degrades locally:

| Input | Behaviour | Measured (S2.5) |
|---|---|---|
| unclosed inline tag (`<b>bold text` then `<script>`) | no boundary emitted; text captured; the following raw-skip element is still detected as an element, so the script body does not leak | extract of article 33 contains `Unclosed paragraph with bold text` and no script text |
| unclosed block tag (`<div><p>...`) | the opening boundary newline was already emitted; text is captured; only the closing boundary is missing | article 33: `<div>\n<p>Unclosed...` -> a newline before the text |
| tag left open at EOF (`...<a href="x`) | dropped to EOF (bounded, single step) | adversarial case: 150 KB of `<a ` -> 0.30 ms, empty output |
| unterminated comment (`<!--` then 200 KB) | dropped to EOF | 0.04 ms |
| raw-skip element with no close (`<script>` then 100 KB of `<`) | `findCloseTag` scans to EOF once, no quadratic rescan | 0.90 ms |
| stray close tag (`</script>` alone) | ignored (no separator, no text) | by construction |
| `>` inside a quoted attribute (`<a title="a>b>c">text</a>`) | the quote state prevents a premature tag end | output `"text"` (verified) |
| CRLF, NUL, C0 controls | CR/LF are spaces (`pre` keeps LF); other C0 dropped | by construction |

### 2.5 Complexity, bounds and pathological behaviour

Time **O(n)** in the input length, output **O(n)**; no regex backtracking, no recursion, no allocation per
character beyond the output and one fold copy at query time. Measured with the prototype (Node 24, warm):

| Case | Input | Time | Output |
|---|---|---|---|
| real article 16 | 9,136 B | **0.216 ms** (mean of 200, warm) | 4,268 chars |
| real specimen 33 | 1,169 B | 0.31 ms (first, cold) | 578 chars |
| synthetic table doc | 64 KB | 1.59 ms | 27,711 chars |
| synthetic table doc | 256 KB | 7.75 ms | 110,770 chars |
| 1 MB input, `maxDocBytes` = 256 KB | 1 MB | 6.65 ms (cap applied) | 110,770 chars |
| 200,000 bare `<` | 200 KB | 2.66 ms | 0 |
| 150 KB of `<a ` with no `>` | 150 KB | 0.30 ms | 0 |
| unterminated `<!--` + 200 KB | 200 KB | 0.04 ms | 0 |
| `<script>` + 20,000 x `if (1<2) {}` and no close | 220 KB | 0.37 ms | `"ok"` |
| `<script>` + 100,000 `<` + `</script><p>after</p>` | 100 KB | 0.90 ms | `"after"` |
| 20,000 nested `<div>` | 220 KB | 4.18 ms | `"deep"` |
| 100,000 bare `&` | 100 KB | 3.41 ms | 100,000 `&` |

Throughput is **~24 ms per MB of raw HTML** (0.216 ms / 9.1 KB and 7.75 ms / 256 KB agree). Two hard caps keep a
hostile document from costing more than this: `maxDocBytes` truncates the input **before** scanning, and
`maxOutChars` caps the accumulated output (`emitText` slices the final write). Truncation is reported, never
silent (S4.2).

Leak test used: `/<\/?(p|div|td|th|tr|table|thead|tbody|ul|ol|li|strong|b|i|em|h1-h6|script|style|img|a|pre|code|span|br)\b/i`
must not match the extracted text. Verified `false` for article 16 **and** article 33 (which contains a decoded
`<below>` from `&lt;below&gt;` and still passes, because the test looks for tag names).

### 2.6 What we deliberately do NOT handle (and why that is safe)

| Not handled | Why safe |
|---|---|
| CSS (`display:none`, `visibility`) | Hudu article bodies are stored fragments with no stylesheet; no measured case where styling hides text. Dropping hidden text would require a CSS engine and would risk *losing* real content. |
| Table column semantics / headers | A row becomes `Low End FortiGate-40F 7.4.7 N`. The caller is told in S4.1 that tables are flattened; nobody should read a snippet as a column-aligned record. |
| Link URLs | The href is dropped; the display text is kept. Article 16's link shows the URL as its own text, so the information is present without duplicating every href into the index (a `Read more` link's URL is one `get` away). |
| Image content, alt-less images | Images carry no text. `alt` **is** kept (one attribute regex on the tag text) because it is authored prose; a base64 `src` is never inspected, so image bytes can never inflate the index. |
| `title`/`aria-label`/`data-*` | Authoring metadata, not prose; including it would let an attribute value outrank the sentence around it. |
| Font/colour/`class`/`style` attributes | Presentational only. Article 33's `style="color:#f00"` correctly contributes nothing. |
| The full HTML5 named-entity set (~2,230 entries, ~40 KB) and the C1 Windows-1252 remap | The in-repo subset covers prose; the fallback is *literal*, so an unhandled entity is findable as written rather than silently dropped. |
| Missing-semicolon legacy entities | Same reasoning; ambiguity without measured benefit. |
| `<template>`/`<canvas>`/`<noscript>` inner markup | treated as raw-skip or inert; they are not article prose. |
| HTML5 parsing error recovery (implied tags, foster parenting) | A tree is not needed to get *text*; the scanner is order-preserving, so mis-nesting cannot reorder content. |

### 2.7 Where naive approaches fail (measured on the real specimens)

`html.replace(/<[^>]*>/g, '')` on article 33 (prototype output, verbatim):

```
"\n.x{color:red}Awkward MarkupFalcon zephirine cutover &amp; rollback notes ... \nUnclosed paragraph with bold textvar secret = \"zephirine\"; if (1\nAAAAAAA..."
```

Four separate, measured failures:

1. **Script and style bodies leak into the text**: `var secret = "zephirine";` and `.x{color:red}` are in the
   output. The vendor stores `<script>`/`<style>` verbatim (S1.3), so this is a live defect, not a theoretical
   one: script identifiers become indexable terms and can be quoted back in a snippet.
2. **A `<` inside text silently swallows a region**: `if (1<2) { alert(" "); }` makes the regex search forward to
   the next `>`, so everything between the `1` and that `>` - the rest of the script, `</script>`, `<p>`, and the
   start of the 220-character token - is **deleted**. That is silent content loss, the one thing a search tool may
   not do.
3. **Entities are not decoded**: on article 16 the naive output still contains `&nbsp;` 11 times and keeps
   `&amp;`/`&lt;`; a query containing a literal space or copied from rendered text cannot match
   (`&nbsp;`-separated words are one glued token).
4. **No separator is inserted where a tag was**: article 16 is one newline-free line, so stripping glues adjacent
   cells: the naive output contains `Low EndFortiGateRugged-35D`, while the extractor produces
   `Low End FortiGateRugged-35D`. Body search then fails on every phrase that crosses an element boundary.

A two-step "strip tags then `decodeEntities`" variant fixes (3) but not (1), (2) or (4); and a global
`<script>...</script>` regex before stripping is still defeated by (2) when the script contains `<` - which is
exactly the `if (1<2)` case the specimen was built to contain.

## 3. Snippets

### 3.1 Offset contract (explicit)

Per hit:

```
snippet: {
  available: boolean, reason?: 'no-match-in-body' | 'matched-title-only' | 'no-span-in-shown-text' | 'evicted',
  source: 'body' | `field:${string}` | 'title',
  text: string, textStart: number, textEnd: number,
  spans: { start: number, end: number, terms: string[] }[],
  truncated: { before: boolean, after: boolean },
  omittedSpans: number, occurrencesCapped: boolean
}
```

Contract, stated once and tested:

1. **`text` is exactly `extracted.slice(textStart, textEnd)`.** The ellipsis is *not* in `text`; it is conveyed by
   `truncated.before` / `truncated.after` and may be rendered as `…` by the MCP presentation layer only. This is
   what makes "snippets are verbatim slices" checkable rather than promised.
2. **`spans[i].start` / `.end` are absolute offsets into the document's extracted text** - the same coordinate
   space as `textStart`/`textEnd`, 0-based, end-exclusive, in UTF-16 code units. Snippet-relative offsets are
   `span.start - snippet.textStart`. There is one coordinate space, so a span can never point at a different
   string than the one the caller sees.
3. `spans[i].terms` lists the query terms covered by that span (spans are merged when they overlap, so one span
   may cover two terms).
4. The extracted text in full is **not** returned; the caller gets a window and offsets into a string it has not
   received. That is deliberate (bytes), and it is why `fetch` is part of every hit (S4.1).

### 3.2 Match location through the fold (index map)

The engine matches on a folded form (NFKD + accent strip + case fold, camelCase split, per `engine-design.md`
S2.1). Offsets must survive that fold, so the snippet builder does **not** re-use the query-time fold blindly:

```
foldWithMap(text) -> { folded, map }
  for each code point (size 1 or 2 UTF-16 units):
    f = lowerCase(cp) then NFKD; keep the first base character only if every other output char is a
    combining mark and the base char occupies the same UTF-16 width; otherwise keep the source code point
    (this keeps the fold 1 source code point -> 1 UTF-16 unit, i.e. length-preserving)
    folded += f
    map[each UTF-16 unit of f] = source index
  map[folded.length] = text.length      // sentinel for end-exclusive math
```

Verified: `folded.length === text.length` for BMP text, `map.length === folded.length + 1`, `ZÉPHIRINE ->
zephirine`, `café -> cafe`, and an astral character (emoji) survives as 2 units with both units mapped to the same
source index. Match search is `folded.indexOf(needle, from)` - a contiguous scan over the *folded* text, with the
needle folded the same way, so **case-insensitive and accent-insensitive matches are located**, while the emitted
span is mapped back with `start = map[fs]`, `end = map[fe - 1] + 1`, i.e. offsets into the *unfolded* extracted
text the caller receives.

Cost control: the fold+map is built **per candidate document, on demand, only when a snippet is requested** - never
stored in the index. The index keeps extracted text (2 bytes/char); a stored map would cost 4 bytes/char, i.e. 3x
the text, for nothing, because ranking already works off the postings' folded tokens. Bounded by
`maxSnippetDocsPerQuery` (default 32 documents folded per query; a candidate that loses the bound gets
`snippet.available: false, reason: 'snippet-budget'`).

Occurrence scan is capped at `maxOccPerTerm` (default 16) per term; exceeding it sets `occurrencesCapped: true` so
a pathological document (e.g. 220 A's, below) cannot make the locator unbounded.

### 3.3 Windowing, word-boundary expansion, truncation

```
for each occurrence o (folded span fs..fe, term t):
    pad  = max(0, floor((snippetChars - (fe - fs)) / 2))
    win  = [max(0, fs - pad), min(len, fe + pad)]
score(win) = 1000 * distinctTermsFullyInside(win) + occurrencesFullyInside(win)
best  = max score, tie -> earliest start
s, e  = best window
firstMatch = min(start of occurrences fully inside), lastMatch = max(end of ...)
expand s left while s > firstMatch and text[s-1] is not whitespace   (cap 64 chars)
expand e right while e < lastMatch and text[e] is not whitespace     (cap 64 chars)
if e - s > snippetChars and (lastMatch - firstMatch) <= snippetChars:
    centre a snippetChars window on the match, then re-clamp to [firstMatch, lastMatch]
spans = merge overlapping occurrences (map back to extracted offsets), cap at maxSpans = 8
omittedSpans = totalOccurrences - spans.length
```

Rules that follow from this and are deliberate:

- **Word-boundary expansion can never clip a match.** `s` stops at `firstMatch` and `e` at `lastMatch`, so the
  highlighted span is always inside the returned text. Expansion is capped at 64 characters per side, so a
  220-character unbroken token cannot drag a 500-character window in (measured: the long-token snippet is 102
  chars and its single merged span covers the first 19 A's, `omittedSpans: 15`).
- **Truncation is expressed, not implied**: `truncated.before` is `s > 0`, `truncated.after` is `e < text.length`.
- **An over-long single match is clipped, not expanded**: when the match itself is longer than `snippetChars`, the
  window is centred on the match and the flags say the text is cut. The caller sees the head of the match rather
  than a window that silently excludes it.
- **Default `snippetChars` 200** (max 400, per `PROPOSAL.md`). Measured cost: an 8-article response as 200-char
  snippets is 1,299 bytes.

### 3.4 Multi-term matches in different places

A hit carries **one** snippet, chosen to cover as many query terms as possible (scoring above). Terms that fall
outside the chosen window are still reported:

- `matched.terms` (engine level) lists every term that matched somewhere in the document's fields;
- `snippet.omittedSpans` counts occurrence spans that were found but are not inside the window, and
  `spans[i].terms` names the terms the window does show.

So `cutover` + `SER88N9X` in the specimen (they sit ~100 characters apart, straddling the table) returns a window
around `cutover` with `omittedSpans: 1` - the caller is told a second term matched elsewhere instead of being shown
a window that pretends the terms are adjacent. Rejected alternative: one snippet per term. It multiplies response
bytes by the term count (the cost driver the proposal calls out) and makes ranking-vs-snippets ambiguous; an extra
`get` is cheaper than a padded search response.

### 3.5 Match only in a field we do not show

Three cases, three explicit outcomes - never an invented span:

| Case | Outcome |
|---|---|
| Match in the **body** | `source: 'body'`, window + spans (the normal path). |
| Match in a **shown non-body field** (asset `fields[].value`, `primary_serial`, `primary_model`, custom field label/value) | The scanned row already carries the field text, so the snippet is built from **that field's own text**: `source: 'field:Service tag'`, spans into the field string with `textStart`/`textEnd` relative to the field string (documented in `source`). No body text is quoted, because quoting unrelated prose next to a serial-number match is exactly the "misleading snippet" failure. |
| Match **only in the title** (or a field we never render, e.g. slug/url/id) | `snippet.available: false`, `reason: 'matched-title-only'` (or `'no-span-in-shown-text'`), `spans: []`. The title is already in the hit, so a body snippet would show unrelated text next to a match that is not in it. `matched.fields` still names where the match was. |

Verified live for the title-only case: `makeSnippet(extractText(article33), ['Specimen'], 200)` returns
`{available: false, reason: 'no-match-in-body', text: '', spans: []}` - the word `Specimen` exists only in the
article name, and the tool says so rather than slicing the body.

Asset rows expose `fields` as a list of `{id, label, value, position}` (measured: `{"label":"Service tag",
"value":"7GH2K83"}`), which is what makes `source: 'field:<label>'` implementable without a second request.

### 3.6 Verbatim proof

Two independent invariants, both executed against the real extracted text:

1. **Slice equality**: for 300 distinct terms from article 16, `snippet.text === extracted.slice(textStart,
   textEnd)` in **300/300** cases; for the accent/case query `CAFÉ` the snippet text is `café est là. Un autre
   café ici.` (34 chars) with two spans.
2. **Span read-back**: for each of the same 300 cases, `extracted.slice(span.start, span.end).toLowerCase()`
   equals the query term - i.e. the span points at the matched characters, not near them. **300/300**.

No step in the pipeline can introduce characters: the text is `slice`d from the extracted string, and the only
transform applied for *locating* (`foldWithMap`) is never emitted - it is inverted through `map` to produce
offsets. Highlighting therefore cannot fabricate a match: if the fold cannot find the term, no span exists and
`snippet.available` is `false`.

## 4. Honesty + budget

### 4.1 What the caller must know

1. **The snippet is derived text, not the stored body.** It comes from the extracted form of `content`, so its
   offsets are meaningless against the raw HTML: `textStart` cannot be used to slice `article.content`. To read or
   edit the body, the caller must follow `fetch` (`articles.get`) and use the raw HTML. `hit.snippet` is for
   *recognising* the hit, not for quoting the record.
2. **The index searches extracted text, so it finds things the vendor cannot** (a phrase split by `<strong>`, a
   word separated by `&nbsp;`, text inside a table cell) **and cannot find what extraction drops**. The drop list
   is explicit: script/style bodies, comments, CDATA (which the vendor deletes anyway), image bytes and `alt`-less
   images, `href` when the link text differs, attributes (`title`, `class`, `style`, `data-*`), and any text past
   `maxDocBytes`/`maxOutChars`. A caller searching for a JavaScript identifier or a CSS class will get nothing, and
   that is the correct answer for a documentation search.
3. **Tables are flattened to rows.** A snippet may read `Low End FortiGate-40F 7.4.7 N` with no header context;
   the caller must not treat a flattened row as a column mapping. Header cells do appear as the first row of the
   table (`Product Family Product Details Recommended Release ...`), which is usually enough to disambiguate.
4. **Case/accent folding is for locating only.** The emitted span always points at the *original* characters, so
   a caller may trust `text` verbatim; it must not assume the span is byte-equal to the query term.
5. **Language**: the extractor is HTML-aware, not language-aware. CJK text has no spaces, so a block boundary is
   the only separator it adds; the engine's CJK bigram tokenisation (engine S2.1) handles the rest, and a CJK
   snippet is a verbatim slice as usual.
6. **Extraction is idempotent and deterministic**: the same `content` bytes always produce the same text, so the
   index can be rebuilt and compared, and a snippet is reproducible.

### 4.2 Bound per document

| Bound | Default | Where it bites | Reported as |
|---|---|---|---|
| `maxDocBytes` | 256 KB of **raw** `content` (far above the 9.1 KB p100 seen) | input truncated **before** scanning | `index.coverage.bodiesTruncated`, and a query whose only match is past the cut is a miss, stated in `meta.reasons[]` |
| `maxOutChars` | 4x `maxDocBytes` worst case, effectively 128 KB of extracted text per doc | extraction stops accumulating | same truncation flag |
| extraction time | ~24 ms/MB, so 256 KB = ~6-8 ms | per document, at index time only | timing is not a bound; the byte cap is |
| fold+map | built on demand | `maxSnippetDocsPerQuery` = 32 | `snippet.reason: 'snippet-budget'` |
| occurrences | 16 per term, 8 merged spans | locator scan | `occurrencesCapped`, `omittedSpans` |

Extraction runs **once per document per index build** (TTL 10 min), never per query; a warm query does zero
extraction.

### 4.3 Updated memory maths (the index now stores extracted text)

Measured extraction ratio on real bodies: article 16 `9,136 -> 4,268` (**0.47**), specimen `1,169 -> 578`
(**0.49**). Rule of thumb: **extracted bytes ~= 0.5 x raw HTML bytes** (prose-heavy bodies score higher, table
rows lower because 4-5 tag bytes per cell collapse to one space).

Reconciling with the proposal's measured 8-article set (15,068 bytes of full records, of which 11,505 were HTML
`content`):

| Quantity | Before (design assumed raw HTML kept) | Now (extracted text stored) |
|---|---|---|
| 8 articles, full JSON records | 15,068 B | 15,068 B (unchanged; that is the `get` cost) |
| 8 articles, stored body text | 11,505 B if HTML were kept | **~5.4 KB** (0.47 x 11,505) |
| 8 articles, 200-char snippets | 1,299 B | 1,299 B (unchanged) |
| ratio full records : snippets | 11.6x | 11.6x |

So keeping raw HTML would have cost ~2.1x the memory for no recall; extraction is also a memory win, not just a
snippet-quality win.

Capacity re-derivation for `maxIndexTextBytes` = 64 MB of **extracted** text (2 bytes per UTF-16 unit):

| Articles | Typical extracted text (3 KB) | Total | Postings (est.) | Comment |
|---|---|---|---|---|
| 200 | 3 KB | **0.6 MB** | ~0.05 MB | the sandbox-sized tenant |
| 2,000 | 3 KB | **6 MB** | ~0.5 MB | 10% of the cap; the realistic target |
| 20,000 (`maxDocs`) | 3 KB | **60 MB** | ~4.8 MB | the two caps bite at almost the same point |

Findings and recommendations:

- `maxIndexTextBytes` 64 MB and `maxDocs` 20,000 are **mutually consistent** now (~60 MB at 20,000 typical
  articles), so neither cap is dead code. Keep 64 MB.
- `maxDocBytes` should stay **256 KB measured on the raw `content` string**, because that is the number the
  vendor's response can be checked against; the implied extracted ceiling is ~120 KB, which is why the extractor
  additionally carries `maxOutChars`. A single 120 KB document is ~24,000 tokens of postings; at 20,000 such
  documents the postings bound, not the text bound, would move first - hence the `maxDocs` cap on count.
- **The fold+map is never stored**, which is the difference between ~2 bytes/char of text and ~6 bytes/char
  (text + fold + int32 map). At 20,000 articles this is tens of MB saved, and it is why snippet building is
  bounded per query rather than precomputed.
- Eviction policy is unchanged and now applies to extracted text: dropping `bodyPlain` keeps postings, so body
  recall survives and only `snippet.available: false, reason: 'evicted'` changes - measured snippet-quality impact,
  honest degradation.
- Cost to build the index text for 2,000 articles: ~12 MB of HTML x 24 ms/MB = **~0.3 s of extraction**, on top of
  the ~3 s of page walking in the engine design - i.e. extraction is ~10% of a cold build.

## 5. Before / after examples on real HTML

### 5.1 Article 16 (9,136 bytes) - query `Rugged-35D` (a body-only match the vendor's own `?search=` cannot find)

**RAW** (excerpt; note: single line, no newlines, entities, table cells, escaped link):

```
<h1>Introduction</h1><p>This comprehensive guide provides the latest FortiOS software recommendations for optimal
stability and deployment success. ...</p><p>The content is automatically synchronised from&nbsp;<a
href="https://community.fortinet.com/t5/FortiGate/Technical-Tip-Recommended-Release-for-FortiOS/ta/p/227178"
rel="noopener" target="_blank">https://community.fortinet.com/...</a>.</p> ... <table><thead><tr><th>Product
Family</th><th>Product Details</th><th>Recommended Release</th><th>End of Engineering Support Passed
(Y/N)</th></tr></thead><tbody><tr><td>Low End</td><td>FortiGateRugged-35D</td><td>6.2.16</td><td>Y</td></tr>...
```

**EXTRACTED** (4,268 chars; head and the matched region, `\n` shown as a real newline):

```
Introduction
This comprehensive guide provides the latest FortiOS software recommendations for optimal stability and deployment success. Based on Fortinet's official Technical Tip article, it is automatically synchronised nightly to ensure you have access to the most current release guidance.
The content is automatically synchronised from https://community.fortinet.com/t5/FortiGate/Technical-Tip-Recommended-Release-for-FortiOS/ta/p/227178.
Current as of: Thu 10 July 2025, 10:20 am GMT+10
Recommended releases
Product Family Product Details Recommended Release End of Engineering Support Passed (Y/N)
Low End FortiGateRugged-35D 6.2.16 Y          <-- match at extracted offset 622
Low End FortiGate-30E 6.2.16 Y
...
```

**SNIPPET** (real output, `snippetChars` 200):

```json
{"available":true,"source":"body",
 "text":"Rugged-35D 6.2.16 Y\nLow End FortiGate-30E 6.2.16 Y\nLow End FortiWiFi-30E 6.2.16 Y\nLow End FortiGate-40F 7",
 "textStart":622,"textEnd":727,
 "spans":[{"start":622,"end":632,"terms":["Rugged-35D"]}],
 "truncated":{"before":true,"after":true},"omittedSpans":0}
```

Note what the caller gets: the matched row, the two following rows (context), an honest "there is more before and
after", and a span that reads back as `Rugged-35D` from the extracted text. Before extraction, the same 200
characters would have been `<h1>Introduction</h1><p>This comprehensive guide provides the latest FortiOS software
recommendations ...` - i.e. for a *match* deep in the table the naive version returns markup fragments and cell
text glued together (`Low EndFortiGateRugged-35D`).

### 5.2 Specimen article 33 (awkward markup) - query `zephirine` (inside `<p>` prose)

**RAW** (verbatim, as stored - note the surviving `<script>`, the rewritten img `src`, and the deleted CDATA):

```
<!-- leading comment: should never appear in extracted text -->
<style>.x{color:red}</style><h2 style="color:#f00;font-weight:700">Awkward Markup</h2><p>Falcon zephirine
cutover &amp; rollback notes — see — the — table &lt;below&gt;.</p><p><img src="/public_photo/1478debd5740"
alt="tiny"></p><ul>
<li>First bullet</li>
... <script>var secret = "zephirine"; if (1<2) { alert(" "); }</script></b></p> ...
```

**EXTRACTED** (578 chars, complete):

```
Awkward Markup
Falcon zephirine cutover & rollback notes — see — the — table <below>.
tiny
First bullet
Second bullet with nbsp
Host Serial
ws-013 SER88N9X
ws-012 SER77M1P
Unknown entity &foo; and numeric © and hex © stay literal.
line one
line two indented
Unclosed paragraph with bold text
AAAAAAAAAAAA...(220 A's)... token then normal text resumes.
Final paragraph with a link&more.
```

Everything that should be gone is gone: comment, `<style>` body, `<script>` body, `src`, `alt` *text* is kept
(`tiny`), CDATA, empty paragraphs, the `style` attribute. Everything that should survive survives: `&` decoded,
em dashes decoded (`&mdash;`/`&#8212;`/`&#x2014;` all became `—`), `&lt;below&gt;` became `<below>`, `&foo;` stayed
literal, NBSP became a real space (`Second bullet with nbsp`), the unclosed `<b>` did not break the scan, the
table became two readable rows, `pre` kept its line break.

**SNIPPET** (real output, query `zephirine`, `snippetChars` 200):

```json
{"available":true,"source":"body",
 "text":"zephirine cutover & rollback notes — see — the — table <below>.\ntiny\nFirst bullet\nSecond bullet with nbs",
 "textStart":22,"textEnd":126,
 "spans":[{"start":22,"end":31,"terms":["zephirine"]}],
 "truncated":{"before":true,"after":true},"omittedSpans":0}
```

The extracted offsets read directly off the extracted text: `Awkward Markup\n` is 15 units and `Falcon ` is 7, so
offset 22 is the `z` of `zephirine` - the window starts exactly at the match only because the pad
(`(200-10)/2 = 95`) exceeds the text before it in a 578-char document; on a longer document the window would start
95 characters earlier and be marked `truncated.before`. Either way the snippet is a slice of the extracted text, has
no markup and no script in it, and contains no ellipsis character - the "there is more" fact lives in
`truncated.before/after`.

Same specimen, `snippetChars` 120, query `AAAA` (the 220-character token): the window is 102 characters of the
token, one merged span of the first 19 A's, `omittedSpans: 15`, `occurrencesCapped: false` - a pathological match
degrades into a bounded, honest answer, not a 220-span payload.

## 6. Open questions / UNVERIFIED

| Item | Status |
|---|---|
| Live asset custom-field snippet (`source: 'field:Service tag'`) | **UNVERIFIED end-to-end.** The row shape is verified (`fields[].{label,value}` present on `GET /assets`), the rule is designed (S3.5), but no asset was created to exercise it (baseline assets are read-only for this task). |
| Fold+map behaviour on non-Latin scripts (CJK/Thai, no inter-word spaces) | **UNVERIFIED.** The fold is per-code-point and length-preserving by construction, so offsets must hold; only the Vietnamese/Hangul NFKD-decomposing cases were reasoned about, not run. |
| Whether any real Hudu tenant stores `<script>`/`<style>` in article bodies other than through a direct API write | **UNVERIFIED.** The sandbox path proves the API preserves them; whether the Trix UI would also preserve them is untested. The extractor's raw-skip is cheaper than the question. |
| `maxOccPerTerm` = 16 and `maxSpans` = 8 defaults | Chosen from the 220-A adversarial case, not from a distribution of real query-term frequency. Could be lowered after telemetry. |
| Article 17's 3-byte body | **VERIFIED** after the first draft: it is the literal string `123` (`repr` = `'123'`). It exercises the degenerate case - extracted text `"123"`, no block boundaries, a query for `123` snippets it whole with `truncated.before/after` false. Not a failure mode. |
| Whether Hudu rewrites content on *update* the same way as on create | Assumed identical (same endpoint family); only create was exercised. |
