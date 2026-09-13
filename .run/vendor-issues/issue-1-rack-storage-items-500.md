# `POST /rack_storage_items` returns HTTP 500 for every payload, including the documented example

**Endpoint:** `POST /api/v1/rack_storage_items`

**Environment:** Hudu 2.45.1, `basePath /api/v1`, spec `api-docs.json` from the same build.

## Exact request

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/rack_storage_items" \
  -H "x-api-key: $HUDU_API_KEY" -H 'content-type: application/json' \
  -d '{"rack_storage_item":{"rack_storage_role_id":1,"asset_id":123,"start_unit":1,"end_unit":4,
       "status":0,"side":0,"max_wattage":500,"power_draw":250,"reserved_message":"Reserved for new server"}}'
```

This body is copied verbatim from the `example` in the spec for this operation.

## Observed response

```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

Four further shapes all returned the same 500:

* the same body unwrapped (no `rack_storage_item` root key),
* a minimal body (`rack_storage_role_id`, `asset_id`, `start_unit`, `end_unit`),
* `{"rack_storage_item":{"company_id":3,"start_unit":1,"end_unit":1}}`,
* a body sent *after* we created a real rack storage (`POST /rack_storages` → `201`, id 8, later deleted).

For context, `GET /api/v1/rack_storage_items` returns `200 []` in this tenant.

## What the spec says instead

`paths./rack_storage_items.post` documents exactly three responses:

```json
"responses": {"201": {"description": "Rack Storage Item created successfully"},
              "401": {"description": "Unauthorized"},
              "422": {"description": "Unable to process request"}}
```

There is no 500. The operation also publishes a full request example (the one used above), and
`definitions.RackStorageItem` declares no `required` fields. Separately, the definition has no
`rack_storage_id` property, so the documented body cannot identify the parent rack storage it belongs to.

## Why it matters

The endpoint is unusable through its own documented contract: a client cannot create a rack storage item
at all, and it cannot tell a bad payload (which should be the documented 422) from a server fault. We had to
record `rack_storage_items.create` as untestable.

## Notes / limits

The tenant contained zero rack storages, so we could not exercise the success path, and we could not learn a
valid `rack_storage_role_id` from the API. The response code is nevertheless wrong independently of the
cause: an invalid reference must not be a 500.
