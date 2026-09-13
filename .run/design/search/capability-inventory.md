# node-hudu — search capability inventory (LIVE EVIDENCE)

**Environment**: real Hudu **2.45.1** tenant `https://hudu-sandbox.example.com`, throwaway API key, 2026-09-13.
**Method**: every claim below is a live HTTP call against `/api/v1` (Python `requests` with the same params a
`curl -H "x-api-key: $HUDU_API_KEY"` would send, plus real `curl` transcripts for section 3), and/or a live call
through the built SDK (`node /tmp/sdkprobe.cjs`, `dist/index.cjs` + `dist/operations/index.cjs`).
**Status of this document**: DESIGN INPUT ONLY. No file under `src/`, `test/`, `scripts/` was touched; nothing was
committed. All records created for probing were deleted (inventory in section 9).

---

## 0. Headline findings (all three are probed, not inferred)

1. **Hudu's `search` filter does NOT reach KB article body content.** An article whose NAME has no unique token and
   whose BODY contains the nonsense token `ebodytok9911` is **not** returned by `/articles?search=ebodytok9911`
   (`{"articles":[]}`), while `/articles?search=Evidence` (a word from the *name*) returns it. The same holds for a
   plain English word placed only in the body (`canoeing` → 0 hits) and for a real tenant article's body text
   (article 16, body contains `FortiGateRugged-35D` and `community.fortinet.com`; both → **0 hits**).
   **The article body the vendor returns in the list payload is never matched by any documented parameter.**
2. **Hudu's asset `search` filter DOES reach custom field values.** `/assets?search=efieldtok5512` returns an asset
   whose name does not contain the token and whose value lives only in a custom field (`Audit Field`).
   It does **not** reach `primary_serial`, `primary_mail`, `primary_model`, `primary_manufacturer`, the field
   *label*, or the parent company name.
3. **Every `search` (and `name`) filter is case-insensitive CONTIGUOUS SUBSTRING matching — never fuzzy.**
   `search=Design Probo` → 0, `search=Desgin` → 0, `search=probeaset` → 0, `search=Releases Recommended` → 0
   (word order matters: it is not token-AND), `search=esign Pro` → 2 (mid-word substring matches).
   `name=` is a different, **exact** (case-insensitive) filter: `?name=Microsoft` → 0 while
   `?name=Microsoft Corporation` → 1.

Consequence for the mission (KB content first, assets second, fuzzy matching): **the vendor gives none of the three.**
Body-content matching, rank, and typo tolerance must all be built in-repo on top of reads the SDK already makes.

---

## 1. What the vendor actually exposes (from `api-docs.json`, 82 documented paths)

Query parameters whose description mentions search/filter-by-name, verbatim:

| path | text params | live semantics (probed) |
|---|---|---|
| `/articles` | `search`, `name`, `slug`, `company_id`, `draft`, `enable_sharing`, `updated_at` | `search` = CI substring over **name only**; `name` = exact CI; `slug` = exact |
| `/assets` | `search`, `name`, `slug`, `primary_serial`, `company_id`, `id`, `asset_layout_id`, `archived`, `updated_at` | `search` = CI substring over **name + custom field values**; `name`/`slug`/`primary_serial` exact |
| `/companies` | `search`, `name`, `slug`, `phone_number`, `website`, `city`, `state`, `id_number`, `id_in_integration`, `updated_at` | `search` CI substring on name; `name` exact CI; `website` exact |
| `/asset_passwords` | `search`, `name`, `slug`, `company_id`, `archived`, `updated_at` | `search` CI substring over **name + username**; `name` exact CI |
| `/password_folders` | `search`, `name`, `company_id` | `search` CI substring on name; `name` exact CI |
| `/groups` | `search`, `name`, `default` | `search`/`name` both on name (`name` exact CI per API doc) |
| `/users` | `search`, `first_name`, `last_name`, `email`, `security_level`, `archived`, `portal_member_company_id` | `search` CI substring over **first + last name only, not email**; `email` exact CI |
| `/websites` | `search`, `name`, `slug`, `updated_at` | CI substring / exact CI on name |
| `/asset_layouts` | `name`, `slug` | `name` exact (probed: exact → 1, partial → 0) |
| `/flag_types`, `/label_types` | `name`, `slug` | documented "**exact** ... name"/slug |
| `/lists` | `query` (partial match), `name` (exact) | tenant list table empty → **UNVERIFIED live** |
| `/procedures` | `name` (documented "case-insensitive e..."), `slug`, dates, type | tenant has no procedures → **UNVERIFIED live** |
| `/networks` | `name`, `slug`; `/vlans`, `/vlan_zones` | documented **exact match** |
| `/folders`, `/procedure_tasks` | `name` only | **UNVERIFIED live** |
| `/activity_logs` | **no text-search param at all** (`action_message`, `user_email`, `resource_type`, `resource_id`, dates) | `?search=zzzzz` returns an **unfiltered page** (unknown params are silently ignored) |
| `/ip_addresses`, `/matchers`, `/relations`, `/cards/*`, `/photos`, `/public_photos`, `/uploads`, `/rack_storages`, `/rack_storage_items`, `/magic_dash`, `/expirations`, `/exports`, `/s3_exports`, `/flags`, `/labels`, `/api_info` | **no `search`/`name`/`query` parameter** | `?search=...` is ignored: `/activity_logs?search=zzzzz` returned a full 20-record page |

**Resources with NO vendor-side text filter at all (⇒ client-side scan is the only option today):**
`activity_logs`, `ip_addresses`, `matchers`, `relations`, `cards`, `photos`, `public_photos`, `uploads`,
`rack_storages`, `rack_storage_items`, `magic_dash`, `expirations`, `exports`, `s3_exports`, `flags`, `labels`,
`folders` (name only, exact), `procedure_tasks` (name only), `asset_layouts` (name only, exact).

There is **no global/global-search endpoint** in the API: `/api/v1/search` → 404 (`<!DOCTYPE html>...404`) and
`/api/v1/articles/search` → `null` (JSON `null`, not a search result). Cross-resource search exists only because
`operations.searchAcrossResources` fans out over eight per-resource `search` filters (section 5).

---

## 2. The 27 MCP search/find tools — what each really matches

`MCP_TOOL_MANIFEST.md` contains exactly 147 tool names; 27 of them are search/find:
8 `hudu_search_<resource>`, 18 `hudu_find_*_by_*`, 1 `hudu_search_across_resources`.

### 8 `hudu_search_*` — all forward the vendor `search` filter, all are CI contiguous substring

| tool | backing call | live probe (token → hits) | scope of the match |
|---|---|---|---|
| `hudu_search_articles` | `articles.search(q,{limit,company_id})` → `GET /articles?search=` | `Design Probe` → 2, `Probe Design` → 0, `esign Pro` → 2, `Desgin` → 0 | **article NAME only** (no body — section 3) |
| `hudu_search_assets` | `assets.search` → `GET /assets?search=` | `probea` → 1, `PROBEASSET66K` → 1, `obeasset66k` → 1, `probeaset` → 0 | **NAME + custom field VALUES**; not serial, not model/mail/manufacturer, not field labels, not company name |
| `hudu_search_companies` | `GET /companies?search=` | `micro` → 1, `Corporation Microsoft` → 0 | name |
| `hudu_search_asset_passwords` | `GET /asset_passwords?search=` | `pwprobe` → 1, `probeuser` (username) → 1, description token → 0 | **name + username** |
| `hudu_search_password_folders` | `GET /password_folders?search=` | `foldprobe` → 1 | name |
| `hudu_search_groups` | `GET /groups?search=` | `Defa` → 1, `default` → 1 | name |
| `hudu_search_users` | `GET /users?search=` | `Max` → 1, `Soukho` → 1, `user@example.com` → **0**, `Soukhomlinov Max` → 0 | **first/last name only** (not email, not reversed order) |
| `hudu_search_websites` | `GET /websites?search=` | `oogl` → 1 | name |

`limit` is the SDK's own bound (default 25, max 100, larger throws `HuduConfigError`); the vendor call is a single
`page=1&page_size=<limit>` request — **there is no offset/cursor in the helper**, and no total count.

### 18 `hudu_find_*` — exact lookups

Live-verified (the near-miss probe is what proves "exact"):

| tool | backing call | live probe |
|---|---|---|
| `hudu_find_assets_by_serial` | `GET /assets?primary_serial=` | full serial → 1 hit; `SER88` (prefix of it) → **0** |
| `hudu_find_users_by_email` | `GET /users?email=` | `user@example.com` → 1; `MAXS@INTELLECTIT.COM.AU` → 1 (exact, case-insensitive) |
| `hudu_find_companies_by_domain` | `GET /companies?website=` | `https://www.microsoft.com` → 1; `microsoft.com` → **0** |
| `hudu_find_articles_by_slug` | `filterScan({slug}, sameText)` then name fallback | vendor `slug` filter is exact; the SDK re-compares case-insensitively. Prefix/suffix near-miss **UNVERIFIED** |

**UNVERIFIED (no tenant data / not probed)**: `find_activity_logs_by_resource`, `find_asset_passwords_by_slug`,
`find_companies_by_slug`, `find_expirations_by_resource`, `find_flags_by_flagable`,
`find_ip_addresses_by_address`, `find_labels_by_labelable`, `find_lists_by_name`, `find_magic_dash_by_company`,
`find_matchers_by_sync_id`, `find_networks_by_address`, `find_relations_by_endpoints`, `find_vlans_by_vlan_id`,
`find_websites_by_slug`. All are `filterScan`-style exact compares in code, but the *vendor-side* filter's
exactness (the thing that decides whether a near-miss returns 0 or a false hit) was not probed for these. The
`lists` table was empty in this tenant, and `/activity_logs` exposes no text filter, so those two cannot be
server-filtered at all today.

---

## 3. THE CRITICAL QUESTION — does Hudu search article BODY content?  **NO.**

Setup: article `Zz Evidence Probe DELETEME` (id 32) created with a name that contains no probe token and a body
that contains the unique nonsense token `ebodytok9911` plus the ordinary word `canoeing`:

```bash
curl -s -X POST -H "x-api-key: $HUDU_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Zz Evidence Probe DELETEME","content":"<p>body marker ebodytok9911 and the word canoeing</p>","company_id":3}' \
  "$HUDU_BASE_URL/api/v1/articles"
```

Exact commands and observed output:

```bash
$ curl -s -H "x-api-key: $HUDU_API_KEY" "$HUDU_BASE_URL/api/v1/articles?search=ebodytok9911"
{"articles":[]}                                    # <- BODY token: NOT FOUND

$ curl -s -H "x-api-key: $HUDU_API_KEY" "$HUDU_BASE_URL/api/v1/articles?search=Evidence"
{"articles":[{"id":32,"slug":"1e49e909a876","name":"Zz Evidence Probe DELETEME","draft":null,
"content":"\u003cp\u003ebody marker ebodytok9911 and the word canoeing\u003c/p\u003e", ...   # <- NAME word: FOUND

$ curl -s -H "x-api-key: $HUDU_API_KEY" "$HUDU_BASE_URL/api/v1/articles?search=canoeing"
{"articles":[]}                                    # <- ordinary body word: NOT FOUND

$ curl -s -H "x-api-key: $HUDU_API_KEY" "$HUDU_BASE_URL/api/v1/articles?search=zqxprobe7f3a9-inner"
{"articles":[]}                                    # <- body substring of a name token: NOT FOUND
```

Cross-check on **pre-existing** tenant content (article 16, body contains `FortiGateRugged-35D`,
`community.fortinet.com`, `Technical Tip`), so the result is not an artefact of my record:

```
articles?search='FortiGateRugged-35D'  n=0
articles?search='community.fortinet.com' n=0
articles?search='Technical Tip'          n=0
articles?search='FortiOS'                n=1   # a TITLE word -> found
```

Every other documented parameter was tried on the same article: `?name=`, `?slug=`, `?draft=`, `?company_id=`,
`?updated_at=`, `?enable_sharing=` — none matches body text (`name` is exact-CI on the name, `slug` matches the
opaque slug only). **There is no documented, or undocumented (`/articles/search` → `null`), API path that matches
article body content.** Note the paradox the design must exploit: the list payload **already contains the full
`content`** (`"content":"\u003cp\u003e..."`), so body text is *available* to the client without an extra request —
it is simply *never matched server-side*.

## 4. Assets — what `search` reaches, probed the same way

```bash
$ curl -s -H "x-api-key: $HUDU_API_KEY" "$HUDU_BASE_URL/api/v1/assets?search=efieldtok5512"
{"assets":[{"id":364,"company_id":3,"asset_layout_id":6,...,"name":"Zz Evidence Asset DELETEME","primary_serial":null,...}]}
# token lives ONLY in custom field "Audit Field" -> FOUND
$ curl -s -H "x-api-key: $HUDU_API_KEY" "$HUDU_BASE_URL/api/v1/assets?search=Evidence"
{"assets":[{"id":364,...,"name":"Zz Evidence Asset DELETEME",...}]}   # name word -> FOUND
```

Field-by-field matrix (one asset, id 362, name `Zz Probe Asset probeasset66k`, custom field
`Audit Field = value probefield77m`, then `primary_serial=SER88N9X`, `primary_model=ModelTok mdlPROBE42`,
`primary_mail=probe-mdl42@example.invalid`, `primary_manufacturer=MfrTok mfrPROBE43`):

| searched value | lives in | `?search=` result |
|---|---|---|
| `probeasset66k` | asset name | **1 hit** |
| `obeasset66k` (mid-word) | asset name | **1 hit** (substring, no word boundary needed) |
| `probefield77m` | custom field value | **1 hit** |
| `value probefield77m` | custom field value (multi-word, same order) | **1 hit** |
| `SER88N9X` / `SER88` | `primary_serial` | **0** |
| `ModelTok mdlPROBE42` | `primary_model` | **0** |
| `probe-mdl42@example.invalid` | `primary_mail` | **0** |
| `MfrTok mfrPROBE43` | `primary_manufacturer` | **0** |
| `Audit Field` | field LABEL | **0** |
| `Microsoft` | parent company name (`company_name`) | **0** |
| `Deleteme` / `audit` | asset layout name (`Zz-audit-layout-deleteme`) | **0** |
| `Audit Field` vs `?search=` … | — | serial reachable only via the **exact** `?primary_serial=` filter (`SER88` → 0, full → 1) |

So today: **asset search = name ∪ custom-field values**, contiguous substring, case-insensitive. Serials are
reachable only through the exact-match `primary_serial` filter, which the SDK's `assets.search` does **not** expose.

## 5. `operations.searchAcrossResources` — what it really does (code + live)

Read from `src/operations/operations.ts` (verified live by `node /tmp/sdkprobe.cjs` against the same tenant):

- **Fan-out set**: exactly the 8 keys of `SEARCH_HELPERS` — `companies, articles, assets, websites,
  asset_passwords, password_folders, groups, users`, in that order. Anything else throws
  `HuduConfigError` `CONFIG_ERROR`: live →
  `CONFIG_ERROR operations.searchAcrossResources: unsupported resource name(s) "procedures"; supported: "companies", "articles", "assets", "websites", "asse…`.
- **Query construction**: none. It calls each resource's own helper-tier `search(query, {limit})`, which forwards
  the raw string as the vendor `search` param on one `page=1&page_size=limit` request. So every limitation in
  sections 2–4 applies unchanged, per resource.
- **Ranking**: none. Results are concatenated in resource order and, within a resource, in server order.
  Live: `searchAcrossResources('Probe')` → 6 hits in **158 ms**, order
  `articles:25, articles:27, articles:31, assets:362, asset_passwords:5, password_folders:3`.
- **Dedupe**: none across resources (the `resource` discriminator is the only identity). Inside one resource it is
  whatever the vendor returned.
- **Hit shape**: `{ resource, id, label, item }` where `label = name || email || '#<id>'`; `expand:true` puts the
  full typed record in `item` (which, for articles, includes the full body `content`). No score, no snippet,
  no matched-field indication, no total.
- **Concurrency**: at most `client.config.concurrency` (default 4) helper calls in flight, order preserved.
- **One resource erroring**: `searchAcrossResources` has **no per-resource try/catch** — the only try/catch in the
  module is inside `resolveOutcome` (used by `resolveAny`). A single resource failing (500/429 after retries,
  transport error) therefore **rejects the whole call** and discards the hits the other seven already paid for.
  *Evidence class: code reading of `operations.ts` (the `boundedMap` worker awaits `SEARCH_HELPERS[...]` with no
  catch) — NOT fault-injected live; mark UNVERIFIED-by-live-probe.* Contrast: `resolveAny` degrades
  per-resource (truncation → `truncated` flag, ambiguity → candidates), so the two helpers do not share a policy.

## 6. GAPS — what is NOT possible today (each backed by a probe or an absence)

| Gap | Status | Evidence |
|---|---|---|
| KB article **body/content** search | **NOT POSSIBLE server-side** | section 3 curl: body token → 0 hits; `?name=`/`?slug=`/`?draft=`/`?company_id=`/`?updated_at=` also 0; `/articles/search` → `null`; no `content`/`body`/`query` param anywhere in `api-docs.json` |
| **Fuzzy / typo-tolerant** matching | NOT POSSIBLE | `Desgin`→0, `Design Probo`→0, `probeaset`→0. No fuzzy param exists in `api-docs.json` |
| **Word-order-independent** multi-word search | NOT POSSIBLE | `Releases Recommended`→0 while `Recommended Releases`→1; `Corporation Microsoft`→0; `Soukhomlinov Max`→0 |
| **Relevance score / ranking** | NOT POSSIBLE | no score field in any response body; `SearchHit` = `{resource,id,label,item}` |
| **Snippet / matched-field** | NOT POSSIBLE | no tool returns one; the SDK's `ArticleSummary` drops `content` entirely |
| **Cross-resource ranking / dedupe** | NOT POSSIBLE | concatenation in resource order only (live, 158 ms, 6 hits) |
| **Searching custom fields of resources other than assets** | NOT POSSIBLE | `asset_passwords.search` reaches `username` but NOT `description` (`descPROBE51` → 0); asset fields are the only custom-field surface reached |
| **Searching asset serials/model/manufacturer via `search`** | NOT POSSIBLE | `SER88N9X`, `mdlPROBE42`, `probe-mdl42@…`, `mfrPROBE43` all → 0 via `?search=`; only exact `?primary_serial=` works |
| **Searching user email via `search`** | NOT POSSIBLE | `user@example.com` → 0 via `?search=`, → 1 via exact `?email=` |
| **Searching activity history / audit log** | NOT POSSIBLE | `/activity_logs` has no text param; `?search=zzzzz` returned an unfiltered page (`[{"id":1,...`) |
| **Total hit count / "is there more?"** | NOT POSSIBLE | no `X-Total-Count`/`Link` header; SDK infers `hasMore = items.length === pageSize` (`base.ts:128`) |
| **Paging beyond one page in a helper** | NOT EXPOSED | `articles.search`/`assets.search` are one `page=1` request; `limit` max 100; `articles.listAll` exists but is effectively unbounded (`MAX_PAGES = 100_000`) |
| **Prefix vs substring control** | NOT POSSIBLE | `probea` (prefix) and `obeasset66k` (mid-word) both hit; `search=Probe` matched mid-name. No anchoring option |
| **`name=` with partial input** | MISLEADING | `?name=Microsoft` → 0, `?name=Microsoft Corporation` → 1 (exact CI). A caller passing a partial name gets a confident empty answer |
| **`slug` filters** | low value | Hudu slugs are 12-hex opaque (`1e49e909a876`, `ae1459e1df60`); `search` does not match them, so slug lookup is only useful if the slug was already known |

## 7. What IS available to build on (the positive inventory)

- Article list responses **include the full HTML `content`** (article 16: several KB in one record) — body text is
  fetchable at list price. Measured on this tenant: `GET /articles?page_size=100` → **8 records / 26 KiB / 0.11 s**.
- Asset list responses include the full `fields[]` array with values (`{"id":3944,"value":"value probefield77m","label":"Audit Field","position":1}`).
  `GET /assets?page_size=100` → **21 records / 19 KiB / 0.14 s**.
- The only existing bounds for client-side scanning are `resolution.maxScanRecords` (default **500**) and
  `resolution.maxScanPages` (default **4**), enforced by `BaseResource.boundedScan` (`base.ts:504-526`) — those are
  resolution-cap values, not search caps; a body-scan helper would need its own explicit, reported bound.
- `articles.listAll(params)` accepts the vendor params including `search`, `updated_at`, `company_id` and returns
  full `Article[]` — the natural chokepoint for a bounded body scan (`articles.ts:135`, `filterScan` at
  `articles.ts:342` shows the house pattern: vendor filter first, bounded scan second).
- Case/locale comparison primitives already exist in-repo: `sameText()` (trim+lowercase equality) in
  `articles.ts`, `assets.ts`, and `toArticleSummary` for compact projection.
- `searchAcrossResources` is the only cross-resource composition, bounded at `concurrency` (default 4), so a
  cross-resource body/snippet layer has a concurrency-safe host to slot into.

## 8. Design-relevant readings of the mission (numbers behind the headline)

- 27/147 MCP tools are search/find; **0 of them return a snippet or a score**.
- **1 of 8** searchable resources (`assets`) reaches non-name data (custom field values); `asset_passwords` reaches
  one extra field (`username`); **0 of 8** reaches body/content text.
- **0 of the ~40 documented text filters** are fuzzy-aware; all are exact or contiguous-substring.
- KB-content matching therefore has exactly one server-side-free path: fetch article records (list already carries
  `content`) and match in-repo. Any such helper must report its own scanned/truncated bound, because the vendor
  exposes no total count and `hasMore` is inferred from a full page.

## 9. Sandbox hygiene — inventory after probing

Created by me and **deleted** (all `DELETE` → 204 except the already-removed re-delete):
article 25 `Design Probe Alpha zqxprobe7f3a9`, article 27 `Design Probe Beta`,
article 32 `Zz Evidence Probe DELETEME`, asset 362 `Zz Probe Asset probeasset66k`,
asset 364 `Zz Evidence Asset DELETEME`, asset_password 5 `Zz Probe Pwd pwprobeabc9`,
password_folder 3 `Zz Probe Folder foldprobeq7`.
One `POST /asset_layouts` attempt returned **500** and created nothing (verified: no `asset_layouts` row named
`Zz Design Probe DELETEME`). Final sweep over every probe token across articles/assets/asset_passwords/
password_folders/asset_layouts returned **no rows** — clean.
Pre-existing tenant data was read only; nothing pre-existing was modified or deleted.
**Not mine, left in place**: article 31 `ZZ probe Zephyrzzq7brmp runbook` and asset 363
`ZZ probe Wombatzzq7brmp laptop` (created by a sibling agent probing the same sandbox).
The API key was never written to a file in the repo.

---

### UNVERIFIED / not tested (explicit)
- Near-miss behaviour of the 14 `hudu_find_*` tools listed in section 2 (thin tenant data: `asset_passwords`,
  `password_folders`, `lists`, `flags`, `labels` were empty before I created my own records).
- `searchAcrossResources` failure isolation (code reading only; not fault-injected).
- Vendor-side exactness of `/procedures?name=`, `/folders?name=`, `/lists?query=`, `/flag_types?name=`,
  `/label_types?name=`, `/vlans`, `/vlans_zones`, `/networks` (no rows in this tenant / not probed).
- Whether Hudu's **web UI** KB search (not the API) matches body text — out of scope of the API contract, not tested.
- Rate-limit / large-tenant behaviour of a client-side body scan (tenant is small: 8 articles, 21 assets).
