# `POST /networks` and `PUT /networks/{id}` silently discard `notes`

**Endpoints:** `POST /api/v1/networks`, `PUT /api/v1/networks/{id}`

## Exact requests

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/networks" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"network":{"company_id":3,"name":"Zz-Audit-Net","address":"10.99.99.0/24",
       "description":"desc-here","notes":"NOTES-SENTINEL-123"}}'
```
```
HTTP 201
{"id": 8, "name": "Zz-Audit-Net", "address": "10.99.99.0/24", "network_type": 0, "slug": "486f3be05bb8",
 "company_id": 3, "description": "desc-here", "notes": null, ...}
```

```bash
curl -sS -X PUT "$HUDU_BASE_URL/api/v1/networks/8" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"network":{"notes":"NOTES-SENTINEL-456"}}'
```
```
HTTP 200
{"id": 8, ..., "description": "desc-here", "notes": null, ...}
```

`GET /api/v1/networks/8` returned `"notes": null` after both calls. `name`, `address` and `description`
persisted normally. For contrast, the same tenant stores notes on a sibling resource:
`POST /api/v1/ip_addresses` with `"notes":"IP-NOTES-SENTINEL"` echoed `"notes": "IP-NOTES-SENTINEL"` in its
`201` body, and `definitions.Vlan` also declares a `notes` property.

The test network was deleted afterwards (`DELETE /api/v1/networks/8` → `204`).

## What the spec says instead

`definitions.Network` documents `notes` as a normal property:

```json
"notes": {"type": "string", "description": "Additional comments about the network."}
```

and both `POST /networks` (`201`) and `PUT /networks/{id}` (`200`) return that schema as their response
body. Nothing in the spec warns that `notes` is read-only for networks.

## Why it matters

This is silent data loss: the request is accepted with a success status, the field appears in the response
schema, it comes back as `null`, and no warning or validation error is raised. A client (or a user through
a script) believes the note was saved. Clients can only detect it with a write-then-read verification, which
is exactly how we found it.

## Requested fix

Either persist `notes` on create/update, or reject it (422) and remove it from the write contract, so the
failure is visible.
