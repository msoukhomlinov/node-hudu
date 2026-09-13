# A missing id returns HTTP 200 with a `null` body instead of 404 (5 resources)

**Endpoints:** `GET /api/v1/articles/{id}`, `GET /api/v1/asset_layouts/{id}`, `GET /api/v1/asset_passwords/{id}`,
`GET /api/v1/folders/{id}`, `GET /api/v1/websites/{id}`

## Exact requests and observed responses

```bash
curl -sS -i "$HUDU_BASE_URL/api/v1/articles/99999999" -H "x-api-key: $HUDU_API_KEY"
```

| Request | Observed |
|---------|----------|
| `GET /api/v1/articles/99999999` | `200` — body `null` |
| `GET /api/v1/asset_layouts/99999999` | `200` — body `null` |
| `GET /api/v1/asset_passwords/99999999` | `200` — body `null` |
| `GET /api/v1/folders/99999999` | `200` — body `null` |
| `GET /api/v1/websites/99999999` | `200` — body `null` |

The same tenant, same run, for sibling resources:

| Request | Observed |
|---------|----------|
| `GET /api/v1/ip_addresses/99999999` | `404 {"error": "IpAddress not found"}` |
| `GET /api/v1/vlans/99999999` | `404 {"error": "VLAN not found"}` |
| `GET /api/v1/networks/99999999` | `404 {"error": "Network not found"}` |
| `GET /api/v1/users/99999999` | `404 {"error": "User not found"}` |

## What the spec says instead

All five affected operations document a `404` for this case:

```json
"/articles/{id}" GET:      "404": {"description": "Not Found"}
"/asset_layouts/{id}" GET: "404": {"description": "Not Found"}
"/asset_passwords/{id}" GET: "404": {"description": "Not Found"}
"/folders/{id}" GET:       "404": {"description": "Folder not found"}
"/websites/{id}" GET:      "404": {"description": "Not Found"}
```

## Why it matters

Any client that trusts the status code will parse `null` as a record and either raise a type error or,
worse, treat "does not exist" as "exists and is empty" — for example a sync that believes a resource was
successfully read. The inconsistency inside one API version is also the reason our SDK needed a defensive
`null` guard on these five paths only, which is exactly the kind of special case a contract should not
require.

## Requested fix

Return `404` (in the API's standard JSON error shape) for these five paths, matching their own spec and the
behaviour of the other resources.
