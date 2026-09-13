# `POST /label_types` publishes no request schema, so the required body cannot be built from the docs

**Endpoint:** `POST /api/v1/label_types`

## Exact request

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/label_types" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"label_type":{"name":"Test-LT","color":"#0000ff"}}'
```

## Observed response

```
HTTP 422
{"error": "Validation failed", "details": ["Applicable record types can't be blank"]}
```

The field that decides whether the record may be applied to *anything* is therefore required, but this is
not discoverable from the documentation. A body that satisfies the server succeeds:

```
{"label_type":{"name":"Test-LT","color":"#0000ff","applicable_record_types":["Asset"]}}
HTTP 201
{"label_type": {"id": 2, "name": "Test-LT", "applicable_record_types": ["Asset"],
 "access_level": "all_companies", "allowed_company_ids": [], ...}}
```

## What the spec says instead

`paths./label_types.post` (`create_label_type`) declares the body as an anonymous, empty object:

```json
{"name": "body", "in": "body", "required": true, "schema": {"type": "object"}}
```

There are no properties, no `required` list and no example. The only vocabulary available is the *response*
schema `definitions.LabelType`, which lists `applicable_record_types` (with an enum: Article, Asset,
AssetPassword, Website, IpAddress, Vlan, VlanZone, Procedure, Network, RackStorage), `access_level` and
`allowed_company_ids`.

## Why it matters

A client generated from this spec, or an integrator reading it, cannot produce a valid request: the
required field, its allowed values and the accepted `access_level` enum are all invisible on the request
side. Every caller has to discover them by trial and error against 422 responses.

## Requested fix

Give the POST body the same schema as the `LabelType` definition (properties, `required:
["applicable_record_types"]`, the record-type enum) and an example.

## Not a bug: `"Company"` is rejected

For the avoidance of doubt, this issue is **not** about `applicable_record_types: ["Company"]`, which returns
`422 {"details": ["Applicable record types contains invalid record types: Company"]}`. The `LabelType` enum
never contained `Company`, so that rejection is correct.
