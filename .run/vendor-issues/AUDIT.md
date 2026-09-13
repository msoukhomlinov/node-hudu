# Vendor-issue audit — node-hudu live run vs `api-docs.json`

Sandbox: `https://hudu-sandbox.example.com` (Hudu 2.45.1, throwaway tenant, user-authorised).
Spec under test: vendored `api-docs.json` (Swagger 2.0, `basePath: /api/v1`, 82 paths, 535 KB).
Date: 2026-09-13. Auditor: read-only on the repo (no edits, no commit, no build/test run).

Method: for each item the spec was read first (path, method, parameters + `required`, response codes,
schema/example, `definitions`), then the live call was made with `httpx` from a scratch script
(`/tmp/vendor-audit/run*.py`, raw responses stored in `/tmp/vendor-audit/*.json`). One to four calls per
item. Records created during the audit were deleted; the single exception is documented in
"Tenant side effects" below.

## Summary

| # | Item | Verdict | One-line reason |
|---|------|---------|-----------------|
| 1 | `POST /rack_storage_items` 500 | **VENDOR-BUG** | 500 on every shape incl. the spec's own example; spec lists only 201/401/422 |
| 2 | `POST /asset_layouts` 500 | **OUR-BUG + VENDOR-BUG** | the spec example *succeeds* (we mis-reported it); incomplete payloads 500 instead of 422 |
| 3 | `GET /matchers` without `integration_id` | **VENDOR-BUG** | param is `required: true`; a missing required param must not 500 — spec has no 500 |
| 4 | `PUT`/`DELETE /matchers/{id}` | **VENDOR-BUG** | nonexistent id returns 500; spec documents 404 "Matcher not found" |
| 5 | `POST /magic_dash` with `company_id` | **OUR-BUG** | spec body documents `company_name` only; `company_id` exists only as a GET filter |
| 6 | `/networks` silently drop `notes` | **VENDOR-BUG** | `notes` is in `definitions.Network`; create and update both return 200/201 with `notes: null` |
| 7 | `POST /label_types` requires `applicable_record_types`, rejects `"Company"` | **OUR-BUG + DOCS-GAP** | the `LabelType` enum never contained `Company`; requiredness is undocumented (no request schema) |
| 8 | `POST /photos` 422 for `photoable_type: "Company"` | **NOT-A-BUG** | `Company` + matching `photoable_id` returns 201; our repro omitted `photoable_id` |
| 9 | `POST /uploads` rejects `uploadable_type: "Company"` | **DOCS-GAP** | spec types `uploadable_type` as a free string; the allowed-type whitelist is undocumented |
| 10 | missing id → 200 + `null` instead of 404 | **VENDOR-BUG** | 5 resources return `200 null` while their spec documents 404; other resources do 404 |
| 11 | `?slug=` silently ignored on `/groups`, `/users` | **OUR-BUG** | neither endpoint documents a `slug` filter (groups: name/default/search; users: email/search) |
| 12 | `POST /ip_addresses` needs `network_id` | **DOCS-GAP** | `IpAddress` has no `required` list, but the API rejects a payload without `network_id` |
| 13 | `POST /assets` rejects `custom_fields` as a map | **OUR-BUG** | the spec's request example is an array of single-key objects, and the API says so verbatim |
| 14 | `GET /users?search=<email>` → 0 rows | **OUR-BUG** | spec defines `search` as "Search across first name and last name"; use the documented `email` param |
| 15 | Is there a `POST /expirations`? | **DOCS-GAP** | no POST in the spec, and the live route 404s (HTML); expirations cannot be created via the API |
| 16 | Bulk `DELETE /activity_logs` with empty `datetime` | **NOT-A-BUG** | `datetime` is `required: true` and the 400 is documented; our guard is correct |

Primary verdict counts: VENDOR-BUG 5, OUR-BUG 6 (items 2, 5, 7, 11, 13, 14), DOCS-GAP 3, NOT-A-BUG 2.
Secondary verdicts: item 2 also VENDOR-BUG, item 7 also DOCS-GAP.

## Corrections to our earlier claims (read this first)

These are cases where our live-run interpretation was wrong, so the fix is in the SDK, not upstream:

* **Item 2** — we reported "500 on 5 payload variants, **including the example in the spec**". The spec
  example does not 500; it creates a layout. Only *incomplete* payloads 500. The upstream defect is
  narrower than we claimed (500 instead of the documented 422), plus a 200-vs-201 success-code mismatch.
* **Item 8** — `photoable_type: "Company"` is supported. `{"photoable_type":"Company","photoable_id":3,
  "company_id":3}` returns 201. Our 422 came from omitting `photoable_id` (or sending an id that does not
  resolve). The API's own message names the missing piece: "Photoable must exist".
* **Item 5** — `company_id` is not a documented body field for `POST /magic_dash`; only `company_name` is.
  We copied a GET filter param into a POST body.
* **Item 11** — no documented endpoint takes `slug` as a *filter*; silently ignoring an unknown query
  parameter is normal HTTP behaviour, and the rows returned were correct.
* **Item 13** — the spec's request example is `"custom_fields": [ {...}, {...} ]`; the prose "key-value
  pair" describes each array element. The API returns the exact remedy:
  "custom_fields must be an array of objects (use [ ] not { })."
* **Item 14** — `search` is explicitly documented as name-only; `email` is a separate documented filter.
* **Item 7 (part)** — `"Company"` was never a legal `applicable_record_types` value; the enum in
  `definitions.LabelType` lists Article, Asset, AssetPassword, Website, IpAddress, Vlan, VlanZone,
  Procedure, Network, RackStorage.
* **Item 16** — the spec does *not* suggest that an empty `datetime` deletes everything; it marks
  `datetime` required and documents a 400 for it being missing. Our refusal is right for the right reason.
* **Not a finding (checked and withdrawn):** `GET /asset_layouts?name=Computer` returns `[]` while layout
  id 2 is named "Computer Assets" — but `?name=Computer Assets` (exact) returns it. The filter is
  exact-match, not a silent-ignore defect. We did not claim this; it is recorded so nobody re-files it.

## Tenant side effects

Created and deleted during the audit (all verified gone by a final sweep):
network `Zz-Audit-Net` (id 8), rack storage `Zz-Audit-Rack` (id 8), IP address `10.99.99.7` (id 10, went
with its parent network), label type `Zz-Audit-LT` (id 2), magic dash item `Zz-Audit-MD` (id 5), photo id 2,
upload id 2, photoable/asset probes (all 4xx, nothing created).

**One leftover that we could not remove:** asset layout id 6, now renamed `Zz-Audit-Layout-DELETEME` and
`active: false`. There is no documented `DELETE /asset_layouts/{id}`; the live route returns an HTML 404;
`PUT` with a partial body 500s; `PUT` with the full field list 422s ("Asset layout fields label has already
been taken", because fields are merged, not replaced). Please delete layout 6 in the Hudu UI.

---


## 1. `POST /rack_storage_items` → HTTP 500 on every payload shape  — VENDOR-BUG

**What the docs say.** `paths./rack_storage_items.post` (operationId `post_rack_storage_items`), body
parameter `rack_storage_item` (required), `consumes: ["application/json"]`, and the response block is:

```json
"responses": { "201": {"description": "Rack Storage Item created successfully"},
               "401": {"description": "Unauthorized"},
               "422": {"description": "Unable to process request"} }
```

There is **no 500** in the spec. The spec even supplies a complete example:

```json
"example": {"rack_storage_item": {"rack_storage_role_id": 1, "asset_id": 123, "start_unit": 1,
  "end_unit": 4, "status": 0, "side": 0, "max_wattage": 500, "power_draw": 250,
  "reserved_message": "Reserved for new server"}}
```

`definitions.RackStorageItem` has no `required` array. Note also that the definition has **no
`rack_storage_id` property** — the documented body cannot identify the parent rack storage.

**What the live API does.** Five shapes, all `500`:

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/rack_storage_items" \
  -H "x-api-key: $HUDU_API_KEY" -H 'content-type: application/json' \
  -d '{"rack_storage_item":{"rack_storage_role_id":1,"asset_id":123,"start_unit":1,"end_unit":4,
       "status":0,"side":0,"max_wattage":500,"power_draw":250,"reserved_message":"Reserved for new server"}}'
```
```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

Also 500: the same body unwrapped (no `rack_storage_item` key), a minimal body
(`rack_storage_role_id`+`asset_id`+units), a `company_id`-only body, and a body sent *after* a real rack
storage existed (we created `rack_storage` id 8 with `starting_unit:1, height:12`, then deleted it).
`GET /rack_storage_items` returns `[]` — the tenant has no rows, so no success path was available.

**Verdict: VENDOR-BUG.** A request that matches the spec's own example, to a spec-201 endpoint, must not
return an undocumented 500. Even a semantically invalid body (nonexistent FK, unknown rack storage) should
be the documented 422.

**Confidence:** high that the 500 contradicts the spec. Medium on the *cause*, because the tenant has zero
rack storages (and no way to learn a valid `rack_storage_role_id`); "500 because no rack storage exists"
is a hypothesis we could not confirm. Would raise confidence: a valid `rack_storage_role_id` from a seeded
tenant, or the server-side error/id from the vendor's log. Independently of the cause, the response code is
wrong.


## 2. `POST /asset_layouts` → HTTP 500 on incomplete payloads (but NOT on the spec example)  — OUR-BUG + VENDOR-BUG

**What the docs say.** `paths./asset_layouts.post`, body `asset_layout` (required), responses
`201 "Successfully created an Asset Layout"`, `401`, `404`, `422 "Unable to process request"` — no 500.
The body schema is fully specified (`name`, `icon`, `color`, `icon_color`, `include_*`, `password_types`,
`fields[]`) with an example that includes `fields`.

**What the live API does.**

```
POST /api/v1/asset_layouts   (the spec example, verbatim)
HTTP 200
{"asset_layout": {"id": 6, "slug": "783dd5b58d2b", "name": "Zz-Audit-Layout", "icon": "fas fa-laptop", ...}}
```

So the example **works**. Our earlier claim ("500 on 5 variants, including the example in the spec") is
wrong — that part is OUR-BUG (the SDK was sending an incomplete body). The remaining live defect:

```
POST /api/v1/asset_layouts   {"asset_layout":{"name":"Zz-Audit-Layout-2"}}
HTTP 500 {"status": 500, "error": "Internal Server Error"}

POST /api/v1/asset_layouts   {"name":"Zz-Audit-Layout","icon":"fas fa-laptop", ...}   (unwrapped, no asset_layout key)
HTTP 500 {"status": 500, "error": "Internal Server Error"}

PUT  /api/v1/asset_layouts/6  {"asset_layout":{"name":"Zz-Audit-REMOVE-ME","active":false}}   (partial update)
HTTP 500 {"status": 500, "error": "Internal Server Error"}
```

**Verdict: OUR-BUG (primary) + VENDOR-BUG (secondary).** Our SDK must always send the full layout body
(that is the SDK fix). Upstream, a validation failure must return the documented 422, not 500; and success
must be **201**, not the 200 the API actually returns.

**Confidence:** high on both halves (the example-201/200 and the incomplete-payload-500 were reproduced
directly). Would raise confidence on the vendor half: their log line for the 500.


## 3. `GET /matchers` without `integration_id` → HTTP 500  — VENDOR-BUG

**What the docs say.** `paths./matchers.get` (`getMatchers`, "List matchers for an integration"):

```json
{"name": "integration_id", "type": "integer", "in": "query", "required": true},
...
"responses": { "200": {"description": "A list of matchers", "schema": {"properties": {"matchers": {"type": "array", "items": {"$ref": "#/definitions/Matcher"}}}}},
               "401": {"description": "Unauthorized"},
               "404": {"description": "Not Found"} }
```

`integration_id` is `required: true`. The documented failure codes are 401/404 only — no 500 and no 400.

**What the live API does.**

```bash
curl -sS "$HUDU_BASE_URL/api/v1/matchers" -H "x-api-key: $HUDU_API_KEY"
```
```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

With a value that does not exist the endpoint behaves correctly and documents itself:
`GET /api/v1/matchers?integration_id=999999` → `404 {"error": "No matching integration"}`.

**Verdict: VENDOR-BUG.** A missing required query parameter is client input; the documented behaviour of
this API for bad client input is 404 (or a 4xx), never 500. Do not read this as "we expected 400/422" —
the spec offers no 400; the point is that 500 is undocumented and unnecessary.

**Confidence:** high. Would raise confidence: nothing needed for the code itself; the vendor's log would
tell them where the nil integration is dereferenced.


## 4. `PUT` and `DELETE /matchers/{id}` → HTTP 500  — VENDOR-BUG

**What the docs say.**

* `paths./matchers/{id}.put` (`updateMatcherById`): path `id` required (integer), body `matcher` required;
  responses `200 "Matcher successfully updated"`, `401`, **`404 "Matcher not found"`**, `422`.
* `paths./matchers/{id}.delete` (`deleteMatcherById`): path `id` required; responses
  **`204 "Matcher successfully deleted"`**, `401`, **`404 "Matcher not found"`**.

Neither operation documents a 500.

**What the live API does.**

```bash
curl -sS -X PUT "$HUDU_BASE_URL/api/v1/matchers/999999" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"matcher":{"name":"x"}}'
```
```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

```bash
curl -sS -X DELETE "$HUDU_BASE_URL/api/v1/matchers/999999" -H "x-api-key: $HUDU_API_KEY"
```
```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

The tenant has no matchers (`GET /matchers?integration_id=...` needs an integration; there is none), so
only the not-found path was exercised — and that is exactly the path the spec says must return 404.

**Verdict: VENDOR-BUG.** Both verbs contradict their own documented 404 for a nonexistent id.

**Confidence:** high for the not-found path. UNVERIFIED: the update/delete success path (204/200), because
no matcher exists in this tenant and matchers are created by an integrator/integration, not by the API.
Would raise confidence: a tenant with any integration, or a seeded matcher row.


## 5. `POST /magic_dash` with `company_id` → HTTP 500 (while `company_name` works)  — OUR-BUG

**What the docs say.** `paths./magic_dash.post` (`post_magic_dash`, "Create or update a Magic Dash Item"),
body `magic_dash_item` (required, JSON) with these properties and no others:
`message`, **`company_name`**, `title`, `icon`, `image_url`, `content_link`, `content`, `shade`.
Responses: `201`, `401`, `404`, `422`. There is **no `company_id` in the POST body**.

`company_id` *is* documented — as a query filter on `GET /magic_dash`
(`{"name":"company_id","in":"query","required":false,...}`).

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/magic_dash" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"title":"Zz-Audit-MD","message":"audit","company_id":3}'
```
```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/magic_dash" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"title":"Zz-Audit-MD","message":"audit","company_name":"Microsoft Corporation"}'
```
```
HTTP 200
{"id": 5, "title": "Zz-Audit-MD", "message": "audit", "company_id": 3, "company_name": "Microsoft Corporation", "position": 1, ...}
```

The item was deleted afterwards (`DELETE /api/v1/magic_dash` with `title` + `company_name` form fields →
`204`). Two secondary observations, both minor and NOT filed on their own: an unknown body field produces
500 rather than the documented 422, and the create returned **200** where the spec says **201**.

**Verdict: OUR-BUG.** The spec never offered `company_id` on create; our SDK invented it (most likely from
the GET filter, or from the `company_id` echoed in the response — the server resolves it from
`company_name`). SDK fix: send `company_name`; resolve id → name via `GET /companies` if the caller only
has an id.

**Confidence:** high. Would raise confidence on the secondary 500 point: the vendor's log.


## 6. `POST /networks` and `PUT /networks/{id}` silently drop `notes`  — VENDOR-BUG

**What the docs say.** `definitions.Network` documents `notes` as a first-class property:

```json
"notes": {"type": "string", "description": "Additional comments about the network."}
```

`POST /networks` returns the created network as `definitions.Network` (`201`), and `PUT /networks/{id}`
returns `definitions.Network` (`200`). Both bodies are typed only as `object` in the request, so the
request schema does not restrict fields — but the response schema promises `notes`.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/networks" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"network":{"company_id":3,"name":"Zz-Audit-Net","address":"10.99.99.0/24","description":"desc-here","notes":"NOTES-SENTINEL-123"}}'
```
```
HTTP 201
{"id": 8, "name": "Zz-Audit-Net", "address": "10.99.99.0/24", "company_id": 3,
 "description": "desc-here", "notes": null, ...}
```

```bash
curl -sS -X PUT "$HUDU_BASE_URL/api/v1/networks/8" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"network":{"notes":"NOTES-SENTINEL-456"}}'
```
```
HTTP 200
{"id": 8, ..., "description": "desc-here", "notes": null, ...}
```

`GET /networks/8` returned `"notes": null` after both calls. `name`, `address` and `description` persisted
normally. For contrast, `POST /ip_addresses` with `"notes":"IP-NOTES-SENTINEL"` echoed the value back
(`201`, `"notes": "IP-NOTES-SENTINEL"`), and `definitions.Vlan` also declares `notes`. The network was
deleted (`DELETE /api/v1/networks/8` → `204`).

**Verdict: VENDOR-BUG.** A documented field is accepted, acknowledged with 201/200, and silently discarded
— the caller has no way to detect the loss (no warning, no 422, and the response even says `notes: null`).
Silent data loss is the worst class of API defect here: our SDK's write-then-verify test is the only reason
we noticed.

**Confidence:** high (reproduced on both create and update). Would raise confidence: the vendor confirming
whether `notes` is intended to be writable for networks, i.e. whether the fix is "accept it" or "remove it
from the schema and return 422".


## 7. `POST /label_types` requires `applicable_record_types`; rejects `"Company"`  — OUR-BUG + DOCS-GAP

**What the docs say.** `paths./label_types.post` (`create_label_type`) declares the body as:

```json
{"name": "body", "in": "body", "required": true, "schema": {"type": "object"}}
```

— an **unnamed `object` with no properties at all**: the request schema is empty, so no field's
requiredness is knowable from the spec. The response schema points at `definitions.LabelType`, whose
`applicable_record_types` is an enum:

```json
{"type": "array", "items": {"type": "string", "enum": ["Article", "Asset", "AssetPassword", "Website",
 "IpAddress", "Vlan", "VlanZone", "Procedure", "Network", "RackStorage"]},
 "description": "The record types this label type may be applied to."}
```

`"Company"` is **not** in that enum.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/label_types" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"label_type":{"name":"Zz-Audit-LT","color":"#0000ff"}}'
```
```
HTTP 422
{"error": "Validation failed", "details": ["Applicable record types can't be blank"]}
```

```bash
... -d '{"label_type":{"name":"Zz-Audit-LT","color":"#0000ff","applicable_record_types":["Company"]}}'
```
```
HTTP 422
{"error": "Validation failed", "details": ["Applicable record types contains invalid record types: Company"]}
```

```bash
... -d '{"label_type":{"name":"Zz-Audit-LT","color":"#0000ff","applicable_record_types":["Asset"]}}'
```
```
HTTP 201
{"label_type": {"id": 2, "name": "Zz-Audit-LT", "applicable_record_types": ["Asset"], "access_level": "all_companies", ...}}
```

(label type id 2 was deleted: `DELETE /api/v1/label_types/2` → `204`.)

**Verdict: OUR-BUG for the `"Company"` expectation** — the value was never legal, and the API's error
message states the rule. **DOCS-GAP for requiredness** — the spec cannot be used to build a valid request
because the POST body has no properties; `applicable_record_types` (and `access_level` /
`allowed_company_ids`) should be documented as a request schema, with the enum and required flags.
Filed as `issue-7-...` (docs only; do not file the `Company` rejection as a bug).

**Confidence:** high. Would raise confidence on the docs half: nothing — the gap is visible in the file.


## 8. `POST /photos` → 422 for `photoable_type: "Company"` + `company_id`  — NOT-A-BUG

**What the docs say.** `paths./photos.post` (`create_photo`, `consumes: ["multipart/form-data"]`) declares
`file` (required), `caption` (required), and optional `company_id`, `photoable_type`, `photoable_id`,
`folder_id`, `pinned`; responses `201`, `401`, `404 "Photoable record not found"`,
`422 "Validation failed"`. `definitions.Photo.photoable_type` describes the field as "The type of record
this photo is attached to (Company, Asset, Article, etc.)" — `Company` is explicitly an expected value.
So the spec supports the Company case.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/photos" -H "x-api-key: $HUDU_API_KEY" \
  -F 'file=@/tmp/vendor-audit/zz-audit.png' -F 'caption=Zz audit' \
  -F 'company_id=3' -F 'photoable_type=Company' -F 'photoable_id=3'
```
```
HTTP 201
{"photo": {"id": 2, "company_id": 3, "photoable_type": "Company", "photoable_id": 3,
 "caption": "Zz audit", "pinned": null, "archived": false, ...}}
```

With `photoable_id` omitted (which is how our failing case was built):

```bash
... -F 'company_id=3' -F 'photoable_type=Company'          # no photoable_id
```
```
HTTP 422
{"errors": ["Photoable must exist", "Company cannot be set directly. Change the photoable to update the company."]}
```

Photo id 2 was deleted (`DELETE /api/v1/photos/2` → `204`).

**Verdict: NOT-A-BUG.** A Company photo *is* creatable, and the pair `photoable_type` + `photoable_id` is
what makes it work. Our earlier claim ("Company cannot be set directly" blocks the use case) was a
misreading of an error message that also included the real cause — "Photoable must exist".

Two small observations, not filed as issues: (a) the same `"Company cannot be set directly..."` sentence
is emitted when the payload has *no* company semantics at all (e.g. `photoable_type=Asset,
photoable_id=99999999` returned it too), so the message is misleading; (b) the spec marks `company_id` and
`photoable_id` optional, yet submitting `company_id` without a resolvable photoable returns 422 — the
"photoable is required in practice" rule is undocumented. SDK fix: always send a consistent
`photoable_type` + `photoable_id`.

**Confidence:** high (both outcomes reproduced side by side). Would raise confidence on (b): a vendor
statement on whether `company_id` alone is meant to be accepted.


## 9. `POST /uploads` rejects `uploadable_type: "Company"` → 422  — DOCS-GAP

**What the docs say.** `paths./uploads.post` (`post_uploads`, `multipart/form-data`) declares
`file` (required), `upload[uploadable_id]` (required, integer) and `upload[uploadable_type]`
(required, **string**) — with no enum and no list of allowed values. Responses: `201`, `400`, `401`, `422`.
`definitions.Upload.uploadable_type` is also just `{"type": "string", "description": "Type of the object
the file is associated with"}`.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/uploads" -H "x-api-key: $HUDU_API_KEY" \
  -F 'file=@/tmp/vendor-audit/zz-audit.png' \
  -F 'upload[uploadable_id]=3' -F 'upload[uploadable_type]=Company'
```
```
HTTP 422
{"errors": ["Uploadable type is not included in the list"]}
```

Control with a type that is allowed:

```bash
... -F 'upload[uploadable_id]=332' -F 'upload[uploadable_type]=Asset'
```
```
HTTP 201
{"id": 2, "slug": "c9eac6baa1c8", "name": "zz-audit.png", "ext": "png", "mime": "image/png",
 "size": "67 Bytes", "uploadable_id": 332, "uploadable_type": "Asset"}
```

(upload id 2 was deleted: `DELETE /api/v1/uploads/2` → `204`.)

**Verdict: DOCS-GAP.** The constraint is real and intentional (an `inclusion` validation exists server
side) but cannot be discovered from the spec: the parameter is typed as an unconstrained `string`. The
spec should publish the allowed `uploadable_type` values (or state that files cannot be attached to a
company). Filed as `issue-9-...`.

**Confidence:** high that the whitelist is undocumented. Medium on the complete allowed set — we only
verified that `Asset` works and `Company` does not. Would raise confidence: the vendor listing the allowed
values.


## 10. A missing id returns `200` with a `null` body instead of `404` (5 resources)  — VENDOR-BUG

**What the docs say.** Every one of these GET-by-id operations documents a 404:

| Path | Documented responses |
|------|----------------------|
| `/articles/{id}` GET | `200` "Successful operation", `401`, **`404 "Not Found"`** |
| `/asset_layouts/{id}` GET | `200 "Success"`, `401`, **`404 "Not Found"`** |
| `/asset_passwords/{id}` GET | `200 "Success"`, `401`, **`404 "Not Found"`** |
| `/folders/{id}` GET | `200 "Folder retrieved successfully"`, `401`, **`404 "Folder not found"`** |
| `/websites/{id}` GET | `200 "Successful operation"`, `401`, **`404 "Not Found"`** |

**What the live API does.** `GET` with id `99999999`:

```
GET /api/v1/articles/99999999         → HTTP 200   body: null
GET /api/v1/asset_layouts/99999999    → HTTP 200   body: null
GET /api/v1/asset_passwords/99999999  → HTTP 200   body: null
GET /api/v1/folders/99999999          → HTTP 200   body: null
GET /api/v1/websites/99999999         → HTTP 200   body: null
```

Controls from the same tenant, same run (documented 404 **and** correct live behaviour):

```
GET /api/v1/ip_addresses/99999999 → 404 {"error": "IpAddress not found"}
GET /api/v1/vlans/99999999        → 404 {"error": "VLAN not found"}
GET /api/v1/networks/99999999     → 404 {"error": "Network not found"}
GET /api/v1/users/99999999        → 404 {"error": "User not found"}
```

**Verdict: VENDOR-BUG.** Five endpoints contradict their own documented 404 and break the resource family's
own convention, so the two behaviours are inconsistent within the same API version. This is also a real SDK
footgun: any client that trusts the status code parses `null` and either crashes or silently treats "not
found" as "found, empty"; our SDK needed a defensive guard.

**Confidence:** high (reproduced in one run, with four sibling controls returning 404). Would raise
confidence: nothing — but note that the fix must be applied to all five paths for consistency.


## 11. `?slug=` is accepted but silently ignored on `/groups` and `/users`  — OUR-BUG

**What the docs say.**

* `paths./groups.get` (`get_groups`) declares query params **`name`** (case-insensitive filter),
  **`default`**, **`search`** ("Search across group names"), `page`, `page_size`. There is no `slug` filter.
  (`/groups/{id}` and `/groups/{id}/...` exist for lookups by id.)
* `paths./users.get` (`get_users`) declares `first_name`, `last_name`, **`search`** ("Search across first
  name and last name"), `portal_member_company_id`, `archived`, **`email`**, `security_level`, `page`,
  `page_size`. There is no `slug` filter.

Both resources *return* a `slug` field (`definitions.Group`, `definitions.User`), which is where the
mistake likely came from.

**What the live API does.**

```
GET /api/v1/groups?slug=zz-definitely-not-a-slug → 200, 1 row: [{"id":1,"name":"Default Group","slug":"9fd63e9f4ca2",...}]
GET /api/v1/groups                               → 200, 1 row: identical body
GET /api/v1/users?slug=zz-definitely-not-a-slug  → 200, row: [{"id":1,"email":"user@example.com","slug":"0000000000",...}]
GET /api/v1/users                                → 200, row: identical body
```

**Verdict: OUR-BUG.** An unknown query parameter is not part of the contract; servers are free to ignore
it, and both responses are correct (the unfiltered list). SDK fix: remove `slug` from the collection
filters for `/groups` and `/users` (or filter client-side on the returned `slug`), and use the documented
`search` / `email` / `name` params.

**Confidence:** high. Would raise confidence: nothing — but see the withdrawn near-miss in "Corrections"
(`GET /asset_layouts?name=` is exact-match, so do not re-file a similar silent-filter claim without an
exact-match control).


## 12. `POST /ip_addresses` → 422 unless `network_id` is supplied  — DOCS-GAP

**What the docs say.** `paths./ip_addresses.post` (`createIpAddress`) documents the body as
`"$ref": "#/definitions/IpAddress"`, and responses `201`, `401`, `422 "Validation Error"`.
`definitions.IpAddress` lists `address`, `status`, `fqdn`, `description`, `notes`, `asset_id`,
`network_id`, `company_id`, `skip_dns_validation` — and has **no `required` array**, so every field reads as
optional. Nothing in the file describes a company/network consistency rule.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/ip_addresses" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"ip_address":{"address":"10.99.99.7","company_id":3}}'
```
```
HTTP 422
{"errors": "Network does not belong to the specified company"}
```

With `network_id` (the network belonging to company 3) it succeeds:

```bash
... -d '{"ip_address":{"address":"10.99.99.7","company_id":3,"network_id":8,"notes":"IP-NOTES-SENTINEL"}}'
```
```
HTTP 201
{"id": 10, "address": "10.99.99.7", "status": "Unassigned", "notes": "IP-NOTES-SENTINEL", ...}
```

The record went away with its parent network (`DELETE /api/v1/networks/8` → `204`; a later
`GET /ip_addresses?address=10.99.99.7` returned `[]`).

**Verdict: DOCS-GAP.** The 422 code itself is documented; what is missing is the rule. The spec should mark
`network_id` required for creation (or state the rule "the address must belong to a network of
`company_id`"), because a spec-driven client cannot build a valid body from the current file. Filed as
`issue-12-...`. Secondary, in the same issue: when **no** `network_id` is sent at all, the message is
"Network does not belong to the specified company" — it should say the parameter is required.

**Confidence:** high on the gap. Would raise confidence: a vendor statement on whether a network-less IP
address is meant to be legal (if it is, the defect moves from docs to behaviour).


## 13. `POST /assets` rejects `custom_fields` as an object map  — OUR-BUG

**What the docs say.** `paths./companies/{company_id}/assets.post` (`post_companies_company_id_assets`,
"Create an Asset") documents `company_id` (path, required) and `asset` (body, required, JSON). The body
description is prose, and the **machine-readable example is an array of single-key objects**:

```json
"example": {"name": "Test Asset", "asset_layout_id": 123, "primary_serial": "SN123456",
  "custom_fields": [ {"your_custom_text_field_one": "Some text here"},
                     {"your_custom_text_field_two": "Other text here"},
                     {"your_due_date": "01/15/2024"},
                     {"is_active": "true"},
                     {"office_location": {"address_line_1": "123 Main St", "city": "Denver", ...}} ]}
```

The prose says "Each custom field should be provided as a key-value pair, where the key must exactly match
the name of the custom field ... (converted to snake case)"; read together with the example, each array
element is one such pair. `definitions.Asset` does not define `custom_fields` at all.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/companies/3/assets" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"asset":{"name":"Zz-Audit-Asset","asset_layout_id":1,"custom_fields":{"some_field":"some value"}}}'
```
```
HTTP 422
{"error": "Invalid custom fields", "details": ["custom_fields must be an array of objects (use [ ] not { })."]}
```

The array form is accepted by the validator:

```bash
... -d '{"asset":{"name":"Zz-Audit-Asset","asset_layout_id":1,"custom_fields":[{"some_field":"some value"}]}}'
```
```
HTTP 422
{"error": "Invalid custom fields", "details": ["Invalid field names: some_field"]}
```
— i.e. the *shape* passed and only the (deliberately fake) field name failed, confirming the array contract.
No asset was created (`GET /assets?search=Zz-Audit` → `[]`).

**Verdict: OUR-BUG.** The API matches its own example and states the fix in the error message. SDK fix:
serialise `custom_fields` as an array of single-key objects. The prose is worth a one-line clarification
upstream ("each element of the array is a single key-value pair"), but that is a nit, not a defect, so no
issue file was opened.

**Confidence:** high. Would raise confidence on the success path: an asset created with a real custom field
name from layout 2 ("Computer Assets") would prove the array form end-to-end; we did not need it to
adjudicate, and we did not want to write tenant data.


## 14. `GET /users?search=<a real user's email>` returns 0 rows  — OUR-BUG

**What the docs say.** `paths./users.get`, query parameter:

```json
{"name": "search", "type": "string", "in": "query",
 "description": "Search across first name and last name"}
```

and a separate, explicit filter:

```json
{"name": "email", "type": "string", "in": "query"}
```

**What the live API does.**

```
GET /api/v1/users?search=user@example.com → 200 {"users": []}
GET /api/v1/users?search=Soukhomlinov            → 200 {"users": [{"id": 1, "email": "user@example.com", "first_name": "Max", "last_name": "Soukhomlinov", ...}]}
GET /api/v1/users?email=user@example.com  → 200 {"users": [{"id": 1, "email": "user@example.com", ...}]}
```

**Verdict: OUR-BUG.** `search` is documented as a *name* search and behaves exactly as documented; the
documented way to look a user up by email is `email=`. SDK fix: use `email` for email lookups (keep
`search` for names). No defect on either side.

**Confidence:** high (all three calls returned coherent, mutually consistent results). Would raise
confidence: nothing needed.


## 15. Is there a `POST /expirations`?  — DOCS-GAP

**What the docs say.** The vendored spec has exactly two expiration paths, and neither creates:

* `GET /expirations` (`get_expirations`, "Retrieve expirations for the account") — query filters
  `page`, `company_id`, `expiration_type`, `resource_id`, `resource_type`, `archived`, `page_size`;
  responses `200` (array of `definitions.Expiration`), `401`, `404`.
* `PUT /expirations/{id}` (`update_expiration`) and `DELETE /expirations/{id}` (`delete_expiration`) —
  `200`/`204` with `404 "Expiration not found"` and `422`.

There is **no `POST /expirations`**, and also **no `GET /expirations/{id}`** (only PUT and DELETE exist for
the by-id path). `definitions.Expiration` shows where rows come from: `expirationable_type`/`_id`,
`expiration_type` (`ssl_certificate`, `domain`, ...), `asset_layout_field_id`, `asset_field_id` — i.e.
expirations are generated by other records, not created directly.

**What the live API does.**

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/expirations" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{}'                       # → HTTP 404
curl -sS -X POST "$HUDU_BASE_URL/api/v1/expirations" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"expiration":{"date":"2027-01-01","expirationable_type":"Website","expirationable_id":1,"company_id":3}}'
                                                                    # → HTTP 404
```

Both 404s are the application's **HTML** error page (`<!DOCTYPE html><title>404</title>...`), not the JSON
error envelope the rest of the API uses. `GET /api/v1/expirations?page_size=3` → `200` with pre-existing
rows (`{"id":1,"date":"2026-11-02","expiration_type":"ssl_certificate",...}`).

**Verdict: DOCS-GAP.** The absence of a create endpoint is real and consistent between spec and live API
(we could not find one either). What is missing is a statement in the docs: expirations are read-only via
the API and are produced by website/domain/SSL sync and asset-layout expiration fields; there is therefore
no way to exercise `update`/`delete` unless such a row already exists. Filed as `issue-15-...`. Minor
secondary point in the same issue: the 404 for a missing POST route returns an HTML page instead of the
JSON error shape, which a client cannot parse.

**Confidence:** high that no create route exists on this version/tenant. Would raise confidence: a vendor
confirmation that the omission is intended (read-only resource) rather than an unpublished route.


## 16. Bulk `DELETE /activity_logs` with an empty `datetime`  — NOT-A-BUG (guard is correct)

**What the docs say.** `paths./activity_logs.delete` (`delete_activity_logs`):

```json
{"name": "datetime", "type": "string", "in": "query", "required": true,
 "description": "Specify the starting datetime from which logs will be deleted; must be in ISO 8601 format"},
{"name": "delete_unassigned_logs", "type": "boolean", "in": "query", "required": false,
 "description": "If true, only deletes logs where user_id is nil"}
"responses": { "200": "Successful operation",
               "400": "Bad Request - Invalid datetime format or missing datetime parameter",
               "401": "Unauthorized" }
```

The endpoint **bounds** itself by `datetime` ("from which logs will be deleted"); `datetime` is required,
it is not a flag that means "all", and there is no documented option to omit it. `GET /activity_logs`
documents `start_date` (plus `page`, `user_id`, `user_email`, `resource_id`, `resource_type`,
`action_message`, `page_size`) and, notably, no `200` response (only `401`/`404` — itself a small gap, see
below).

**What the live API does.**

```bash
curl -sS -X DELETE "$HUDU_BASE_URL/api/v1/activity_logs" -H "x-api-key: $HUDU_API_KEY"
```
```
HTTP 400
{"error": "Datetime parameter is required"}
```

`GET /api/v1/activity_logs?page_size=1` → `200` with rows (unchanged), i.e. the refused call deleted
nothing.

**Verdict: NOT-A-BUG.** The spec does not suggest that an empty `datetime` deletes everything; it requires
the parameter and documents a 400 for its absence, and the live API matches. Our SDK guard (refuse to call
the bulk delete with an empty `datetime`) is correct behaviour for the documented contract and should stay.

**Confidence:** high for the missing-parameter case (documented + reproduced).
**UNVERIFIED by choice:** the behaviour of `datetime=` (present but empty string) was deliberately **not**
tested — the plausible failure mode is "deletes the whole activity log", and this is a shared tenant we
must not disturb. A definitive answer needs a vendor statement or a disposable tenant.
Minor gap worth mentioning to the vendor, not filed separately: `DELETE /activity_logs` documents no
dry-run/preview and no count of affected rows, so a client cannot verify the blast radius before deleting.

**Related, not part of this item:** `GET /activity_logs` failed to declare a `200` response in the spec
(responses are `401`/`404` only) while returning `200` with a JSON array — a small spec omission.
