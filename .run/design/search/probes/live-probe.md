# LIVE probes — Hudu 2.45.1 sandbox: SEARCH + INGESTION evidence

- Base URL: https://hudu-sandbox.example.com
- Date: 2026-09-12
- SDK branch: feat/agent-execution-layer (dist/ present)
- Probe article created: id 26 slug 68e0aac659b8 name "Onboarding checklist"
- Auth header: `x-api-key: <redacted>`
- All requests: python `requests`, single-threaded, from this machine.

## Probe 1 — Does vendor search index BODY text? AND/OR behaviour?

Command (creation):
```
POST /api/v1/articles  body {"article":{"name":"Onboarding checklist","content":"<h1>...Token: zqxwvaldrin42. Related threat technique: kerberoasting.</p>","draft":false}}
```
Body text markers: body-only nonsense `zqxwvaldrin42`, body-only normal word `kerberoasting`.
Title: `Onboarding checklist` (so `Onboarding` and `checklist` are title-only).

Command (each query):
```
GET /api/v1/articles?search=<q>&page_size=100
```

Raw output (recorded): [see /tmp/probe_search.json]

| query | returned n | contains id 26 |
|---|---|---|
| `zqxwvaldrin42` | 0 | False |
| `kerberoasting` | 0 | False |
| `Onboarding` | 1 | True |
| `checklist onboarding` | 0 | False |
| `zqxwvaldrin42 kerberoasting` | 0 | False |
| `Onboarding checklist` | 1 | True |
| `checklist` | 1 | True |
| `onboard` | 1 | True |
| `hecklis` | 1 | True |
| `Onboarding checklist zz` | 0 | False |
| `boarding checklist` | 1 | True |
| `kerberoasting zqxwvaldrin42` | 0 | False |
| `zqxwvaldrin42` | 0 | False |
| `ZQXWVALDRIN42` | 0 | False |

INTERPRETATION:
- **The vendor does NOT index body/HTML content.** `search=zqxwvaldrin42` (unique token present only in the article body) returned `{"articles":[]}` — the article was NOT returned. Same for `kerberoasting` (a normal English word, body-only): 0 results. Case does not matter (`ZQXWVALDRIN42` also 0).
- **The vendor search does index the TITLE/name**, and it is a case-insensitive substring (`LIKE %q%`) match, not a token match:
  - `Onboarding` -> 1 hit (id 26); `checklist` -> 1 hit; `onboard` (partial word) -> 1 hit; `hecklis` (mid-word fragment) -> 1 hit; `boarding checklist` (fragment phrase) -> 1 hit. A mid-word fragment matching proves substring, not tokenisation.
- **Multi-word queries are a literal SUBSTRING (phrase) match, NOT AND and not OR.** `checklist onboarding` (both words present in the title, but in the opposite order) -> 0 results, while `Onboarding checklist` (exact title order) -> 1 result. `Onboarding checklist zz` -> 0 results. So multiple words are concatenated into one phrase and matched as a single string.
- Consequence for the SDK: a vendor `search` call is only a cheap *prefilter* over titles — it will MISS every body-only match (for a KB that is the majority of relevant content) and it will MISS word-order-independent matches. Local re-ranking must own multi-term matching entirely, and it needs a full local pull to do so.
- Leftovers: whether the vendor `search` also matches `share_url` or the attached company/folder names was not tested -> UNVERIFIED. (Slug was tested: NOT matched, see the extra-confirmations section.)

## Probe 2 — INGESTION COST (page size, totals, latency, body presence)

Commands:
```
GET /api/v1/articles?page=1&page_size=100|250|1000
GET /api/v1/assets?page=1&page_size=100|250|1000
```
Raw output excerpt:
```
articles page_size 100  n=7  ms=[104, 101, 98]    headers: NO x-total-count, NO link, NO page meta
articles page_size 250  n=7  ms=[99, 111, 99]
articles page_size 1000 n=7  ms=[100, 137, 119]
assets   page_size 250  n=20 ms=[158, 141, 136]
assets   page_size 1000 n=20 ms=[141, 135, 134]
```
(a) page_size honoured (articles, while 7 existed): `ps=1 -> 1`, `5 -> 5`, `7 -> 7`, `8 -> 7`, `100 -> 7`, `250 -> 7`, `1000 -> 7`.
`ps=-1 -> 7` and `ps=0 -> 7` — invalid values are IGNORED (fall back to default), HTTP 200, not rejected.
For assets: `ps=5 -> 5`, `ps=10 -> 10`, `ps=20 -> 20`, `ps=21 -> 21`, `ps=25..100 -> 21` (all rows at the time).
So a hard cap above 21 rows could NOT be observed — the tenant holds only ~21 assets / ~10 articles during this run. Requests for 250/1000 are not rejected and behave like "all rows"; the real ceiling is **UNVERIFIED**. The SDK's own helper cap is a separate policy limit (MAX_HELPER_LIMIT = 100, `src/resources/articles.ts`).

(b) totals (point-in-time; another agent was writing the tenant DURING this run):
- articles: 7 at first measurement, 10 later (ids 16-19, 25-30).
- assets: 20 at the first walk, 21 later.
- The response has NO total/meta field (body is just `{"articles":[...]}` / `{"assets":[...]}`) and NO `X-Total-Count` / `Link` header, so **counting requires paging until an empty array returns** (2 requests for 21 assets at ps=100; page1=21, page2=0).

(c) latency, min/median/max of 3 runs (server `x-runtime` was only 0.016-0.021 s, so this host's RTT dominates):
- articles ps=100: 98/101/104 ms — ps=250: 99/99/111 ms — ps=1000: 100/119/137 ms
- assets ps=250: 136/141/158 ms — ps=1000: 134/135/141 ms
=> budget ~100-160 ms per page; ~20 KB JSON for a 1-row article page, i.e. cost scales with response bytes, so pulling bodies is cheap when the tenant is small.

(d) Does the LIST carry bodies?
- **articles: YES.** `GET /api/v1/articles?page_size=100` returns `content` (full HTML) for every row. A 1-row page measured 20,933 bytes. A full pull IS the full index — no per-article GET needed.
- **assets: the list DOES carry `fields` (custom-field values) and `cards`.** Keys observed: id, company_id, asset_layout_id, asset_type, slug, name, primary_serial, primary_mail, primary_model, primary_manufacturer, company_name, object_type, archived, url, created_at, updated_at, **fields**, **cards**. Note the field name in 2.45.1 is `fields`, NOT `custom_fields`.
- Leftovers: exact totals are APPROXIMATE (concurrent writer); max honoured page_size is UNVERIFIED (tenant too small).

## Probe 3 — LIST vs GET field surface (what can an index hold?)

Commands:
```
GET /api/v1/articles                    (list, page_size=100)
GET /api/v1/articles/26                 (single, probe article)
GET /api/v1/assets                      (list)
GET /api/v1/assets/332                  -> 404 {"status":404,"error":"Not Found"}
GET /api/v1/companies/20/assets/332     -> 200
```
Raw output:
```
ARTICLE list keys: ['archived','company_id','content','created_at','draft','enable_sharing','folder_id','id','name','object_type','public_photos','share_url','slug','updated_at','url']
ARTICLE GET  keys: IDENTICAL SET (15 keys)
GET-only keys: []      LIST-only keys: []
```
- For articles the LIST row and the single GET are the SAME 15 fields, including `content`. The body field is **`content`** (an HTML string). There is **no `html_content` and no `plain_text_content`**.
- `draft` is `null` in the POST response but `false` in the list — minor serialisation difference, callers should not rely on `null` meaning draft.
- Single-asset GET by numeric id at `/api/v1/assets/{id}` is **404 on Hudu 2.45.1**; the correct path is `/api/v1/companies/{company_id}/assets/{id}` (matches SDK `src/resources/assets.ts:168`). That GET returns the same 18 keys as the list row (same `fields`/`cards`) — no extra data.
- `DELETE /api/v1/articles/26` returned **204 No Content**; afterwards `GET /api/v1/articles/26` returned **HTTP 200 with body `null`** — NOT 404. Callers must null-check.
- Index implication: one paged pull of `GET /api/v1/articles` already contains every field an index can hold (title + full HTML body + slug + company_id + folder_id + timestamps). No second pass. HTML must be stripped locally for plain-text scoring.

## Probe 4 — Rate limits

Command: 25 back-to-back `GET /api/v1/articles?page_size=100` with no delay (about 60 requests total during the run).
Raw output:
```
burst statuses: [200 x25]
rate-limit headers seen: set()   -- no x-ratelimit-*, no retry-after
```
INTERPRETATION:
- No 429, no `Retry-After`, and **no rate-limit headers at all** at ~25 requests within a few seconds. The vendor does not advertise a quota, so an ingest loop must still self-throttle (bounded concurrency + backoff on 429/5xx) — but no hard limit was reached.
- Leftovers: a real saturation test (e.g. 10+ concurrent workers for a minute) was NOT run -> **UNVERIFIED**; 25 rapid sequential 200s is not proof of unlimited capacity.

## Cleanup / inventory (MANDATORY — executed)

Created: exactly ONE record — article id 26, slug 68e0aac659b8, name "Onboarding checklist" (2026-09-13T03:47:15Z).
No asset, company, folder or field was created or modified. No pre-existing record was touched.

`DELETE /api/v1/articles/26` -> `204`. Post-delete: `GET /api/v1/articles/26` -> `200 null`.

Inventory BEFORE (articles, id / name / created_at):
```
16 FortiOS Recommended Releases                  2025-07-09T12:48:54.726Z
17 Test article                                  2026-01-16T11:10:15.233Z
18 AUPOST-WS013 - Workstation Summary            2026-02-27T12:13:51.221Z
19 AUPOST-WS012 - Workstation Summary            2026-02-27T12:18:45.510Z
25 Design Probe Alpha zqxprobe7f3a9              2026-09-13T03:47:03.362Z  <- another agent, NOT touched
26 Onboarding checklist                          2026-09-13T03:47:15.011Z  <- MINE, deleted
27 Design Probe Beta                             2026-09-13T03:47:21.320Z  <- another agent, NOT touched
28 FortiGate VPN site-to-site troubleshooting    2026-09-13T03:48:51.678Z  <- another agent, NOT touched
29 New starter onboarding runbook (Microsoft 365) 2026-09-13T03:48:51.782Z <- another agent, NOT touched
30 Printer toner replacement and error codes     2026-09-13T03:48:51.892Z  <- another agent, NOT touched
```
Inventory AFTER (articles, id / name):
```
16 FortiOS Recommended Releases
17 Test article
18 AUPOST-WS013 - Workstation Summary
19 AUPOST-WS012 - Workstation Summary
25 Design Probe Alpha zqxprobe7f3a9
27 Design Probe Beta
28 FortiGate VPN site-to-site troubleshooting
29 New starter onboarding runbook (Microsoft 365)
30 Printer toner replacement and error codes
```
Proven: id 26 is absent, every other record intact. Ids 25/27/28/29/30 belong to other agents and were deliberately left alone.
Assets: none created by this agent; asset collection untouched.

## Extra confirmations on stable (other-agent) tenant data

```
search='onboard'            -> [29]   title "New starter onboarding runbook (Microsoft 365)"
search='onboarding runbook' -> [29]   exact substring of that title
search='RUNBOOK'            -> [29]   case-insensitive
search='printer toner'      -> [30]
search='toner replacement'  -> [30]
no search param             -> all articles
search='<slug of id 16>' (423e13093c63) -> []   slug NOT matched
```
INTERPRETATION: title-substring, case-insensitive behaviour reproduced on records this agent did not create. The slug is NOT searched -> slug, company and folder matching, plus all body matching, must be implemented locally.
UNVERIFIED: whether `search` matches `share_url`, company name or folder name; whether slug ever matches for other object types.

