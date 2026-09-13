# Implementation report: `hudu_search`, surface cleanup, and the search-mode gates

Build-order step 3 (`.run/design/search/single-search-tool.md` + `PROPOSAL.md` 13-14). Files owned and
changed: `scripts/project-mcp-tools.mjs`, `scripts/check-capabilities.mjs`, `scripts/build-tool-catalog.mjs`,
`scripts/derive-plan.mjs`, `MCP_TOOL_OVERRIDES.json`, `capabilities.plan.json`, `examples/mcp-server.ts`,
`test/mcp-tool-catalog.test.ts`, plus the regenerated artifacts (`src/capabilities.ts`, `capabilities.json`,
`capabilities.schema.json`, `MCP_TOOL_MANIFEST.md`, `examples/tool-catalog.generated.ts`). No file under
`src/**` was hand-edited; nothing was committed.

## 1. What shipped

1. **ONE self-describing search tool.** `hudu_search` (rename of `hudu_search_knowledge` by an override; the
   backing operation stays `operations.searchKnowledge`, the SDK default stays lazy). One optional `mode`
   enum = `search | help | resources`, default `search`. Ambiguity is killed by construction, not by hope:
   a missing `query` in search mode is a `CONFIG_ERROR` naming `mode:"help"` and never falls back to help; a
   field the selected mode cannot honour is a `CONFIG_ERROR` naming the fields that mode honours; each mode
   returns a DISTINCT top-level shape with the mode echoed back (`{mode:"search",query,hits,meta}` /
   `{mode:"help",topic,help}` / `{mode:"resources",resources}`). The curated description names all three
   modes in its first clause.
2. **Search mode defaults to `tier: "index"`** in the reference server: the tool builds or awaits the body
   index, so a cold, body-blind answer is not what an agent gets by default. The SDK default is unchanged.
3. **`resources` mode is generated, never hand-written**: `capabilities.plan.json` -> rows declaring
   `search: "search"` (8 today) plus a new `resources[].searchCovers` field recording what each vendor text
   filter really covers (`scripts/derive-plan.mjs` declares it, so a re-derived plan keeps it). The payload
   also lists the 27 resources where `?search=` is silently ignored.
4. **`help` mode is generated** from the projection's curated schema plus the mode table: the LIMITS section
   is the honoured fields' own descriptions, so help cannot advertise a bound the tool does not have.
5. **Surface cleanup.** 139 projected tools (was 148): 9 redundant search tools retired with `exclude`
   overrides (8 `hudu_search_<resource>` + `hudu_search_across_resources`), 6 mis-named list tools renamed
   to `hudu_list_*_for_*`, the 12 genuine `find_*` identity lookups and all `get_*`/`create_*` untouched.
   The 9 retired operations stay callable in the SDK and reachable through `hudu_invoke` (catalog
   `unexposed` goes 56 -> 65, refused stays 22). Bonus cleanup: 51 curated descriptions that named a retired
   `hudu_search_*` tool now name `hudu_search`.
6. **`examples/mcp-server.ts`** registers the new CORE (15 tools: 3 META + 12 typed, was 16 + later 15),
   replaces `hudu_search_knowledge` with the three-mode tool, and now takes its descriptions from the
   generated `TOOL_DESCRIPTIONS` map (`--check-example` resolves that reference against the projection, so a
   tool can never ship prose that is not its own curated text).

## 2. Measured before / after

| Measurement | Before | After |
|---|---|---|
| Projected tools | 148 | **139** |
| CORE profile | 16 tools | **15 tools** (3 META + 12 typed) |
| CORE `tools/list` payload | ~29,919 bytes (derived) | **30,066 bytes** (budget 32,000) |
| Catalog rows | 226 | 226 = 139 exposed + 65 invoke-only + 22 refused |
| Reference server registrations | 20 -> 16 | **15** |
| `MCP_TOOL_MANIFEST.md` | 990,709 B | 945,505 B |

CORE grew by 147 bytes against a 2,081-byte headroom because a three-mode tool costs more than a
single-mode one; the budget is kept by trimming the curated always-on text (search tool description/schema,
plus two bulky `outputSchema` field expansions replaced by typed references — the full schemas stay in the
registry and in `hudu_describe`).

## 3. Live verification (Hudu 2.45.1 sandbox, read-only calls)

| Modal answer | Bytes | Vendor request? | Observed |
|---|---|---|---|
| `mode:"search"` (`{"query":"vpn tunnel","limit":3,"snippetChars":120}`) | **629** | yes | `hits=0, complete=true, degraded=null`, 288-549 ms |
| `mode:"search"` (`{"query":"test"}`) | ~1,100 | yes | `returned=1`, index `warm` (4 article bodies indexed, 20 assets), `complete=true`, `degraded=null` |
| `mode:"help"` (`topic:"core"`) | **6,359** | no (by design) | modes + limits + degradation + results + follow-up |
| `mode:"resources"` | **6,428** | no (by design) | 8 searchable resources, 27 silently-unfiltered resources |

Transient: one `500 Internal Server Error` from the vendor on `assets.listAcrossCompanies` during repeated
live calls (retryable, surfaced as a `HuduError`, not swallowed). No fixture was created; no baseline record
was read beyond the search responses themselves.

## 4. Gates

`npx tsc --noEmit` clean; `npm run lint` clean; `npm test` **1834 passed (58 files)**;
`node scripts/check-capabilities.mjs` **PASS**; `--ship` **PASS**;
`MCP_PROFILE=core node scripts/project-mcp-tools.mjs --check-example` **OK**;
`node scripts/build-tool-catalog.mjs --check` **PASS**; CORE inside its 32,000-byte budget.

Three new rules, each proven NON-VACUOUS by injecting the violation it names and watching the checker exit 1
(`--plan`/`--catalog` fixtures, repo untouched):

| Rule | Injected violation | Result |
|---|---|---|
| `searchable-resource-parity` | removed `resources.articles.searchCovers` | exit 1, rule named |
| `mode-honours-fields` | dropped `query` from `modes.search.fields` (+ gave `help` a refused field) | exit 1, both directions named |
| `help-mode-documents-resources` | renamed `vendor-only` in the generated help text | exit 1, rule named |

`prose-dangling-projection` is **NOT shipped**, as instructed: 48 sections named the tools this change
retires and 59 already named tools absent from the projection, so a hard failure would be red on day one.
The 51 curated descriptions this change touches were fixed instead; the rest is a separate prose-cleanup
stage.

## 5. P2 (coordinator): union-enum validation hole — FIXED

`scripts/build-tool-catalog.mjs`'s `checkValue` union branch checked `anyOf` types and RETURNED, so a union
carrying an `enum` was never enforced: `procedures.create`'s `process_type`
(`string|string|null` + `enum ["global","company","null"]`) accepted `"anything"` and would have forwarded
it to the vendor. The branch now enforces a union-level `enum` and a variant's own `enum`.
`test/mcp-tool-catalog.test.ts` adds the regression test (out-of-enum refused, path named; in-enum accepted).
**Verification caveat:** the fix is proven by the unit test and by the regenerated catalog;
`test/mcp-tool-catalog.test.ts` = 23 passed.

## 6. Not done / UNVERIFIED

- No MCP transport was driven end to end (no `tsx`/MCP client in `node_modules`): the three modal answers were
  produced by the same generated payloads the server registers and by a real SDK call for search mode. The
  server's own dispatch code is exercised by the test suite and by `--check-example`, not by a stdio session.
- The SDK's `operations.searchKnowledge` still does not accept `mode`/`topic` (the other agent owns
  `src/**`); the mode dispatch therefore lives in `examples/mcp-server.ts`, and `resources` is mapped to the
  SDK's `scope`. If the SDK grows native modes, the host-side dispatch becomes a pass-through.
- `mode:"help"` `topic:"all"`/single-section payloads were not byte-measured live (only `core`).
- Empty-result honesty observation: several explicit live queries returned `hits=0, complete=true,
  degraded=null`. `meta.scanned` was 2 for that shape, so `complete=true` on a nearly empty candidate set is
  the index reporting "nothing matched in what was indexed", not "nothing exists" - worth a follow-up look,
  recorded here rather than smoothed over.
