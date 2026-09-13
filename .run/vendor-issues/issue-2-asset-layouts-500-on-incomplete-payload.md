# `POST /asset_layouts` returns HTTP 500 instead of 422 for an incomplete body (and 200 where the spec says 201)

**Endpoint:** `POST /api/v1/asset_layouts` (and `PUT /api/v1/asset_layouts/{id}`)

## Exact request

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/asset_layouts" \
  -H "x-api-key: $HUDU_API_KEY" -H 'content-type: application/json' \
  -d '{"asset_layout":{"name":"Test-Layout"}}'
```

## Observed response

```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

The same 500 is returned for the body unwrapped (no `asset_layout` root key) and for a partial update:

```bash
curl -sS -X PUT "$HUDU_BASE_URL/api/v1/asset_layouts/6" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"asset_layout":{"name":"Renamed","active":false}}'
```
```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

The full documented example, by contrast, succeeds — but with the wrong success code:

```
POST /api/v1/asset_layouts   (spec example: name, icon, color, icon_color, active, include_*, fields[...])
HTTP 200
{"asset_layout": {"id": 6, "slug": "783dd5b58d2b", "name": "Zz-Audit-Layout", ...}}
```

## What the spec says instead

`paths./asset_layouts.post` documents `201 "Successfully created an Asset Layout"`, `401`, `404`,
`422 "Unable to process request"` — no 500 — and gives a complete body schema plus example.
`paths./asset_layouts/{id}.put` likewise documents `200`, `401`, `404`, `422` — no 500.

## Why it matters

Validation failures return 500 instead of the documented 422, so callers cannot distinguish "your payload is
incomplete" from "the server is broken" and will retry a request that can never succeed. The success path
also contradicts the spec's `201` (it returns `200`), which breaks generated clients that check for 201.

## Requested fix

Return the documented 422 with a validation message for incomplete bodies, and 201 on successful creation.

## Note on our own testing

An earlier internal claim of ours said the spec example 500s. That was wrong — the example succeeds. Only
incomplete payloads 500, which is what this issue reports.
