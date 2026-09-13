# `GET /matchers` returns HTTP 500 when the required `integration_id` is missing

**Endpoint:** `GET /api/v1/matchers`

## Exact request

```bash
curl -sS "$HUDU_BASE_URL/api/v1/matchers" -H "x-api-key: $HUDU_API_KEY"
```

## Observed response

```
HTTP 500
{"status": 500, "error": "Internal Server Error"}
```

With an id that simply does not exist, the endpoint behaves correctly and returns a JSON error:

```bash
curl -sS "$HUDU_BASE_URL/api/v1/matchers?integration_id=999999" -H "x-api-key: $HUDU_API_KEY"
```
```
HTTP 404
{"error": "No matching integration"}
```

## What the spec says instead

`paths./matchers.get` ("List matchers for an integration") declares the query parameter as required:

```json
{"name": "integration_id", "type": "integer", "in": "query", "required": true}
```

and documents the responses:

```json
"responses": {"200": {"description": "A list of matchers"}, "401": {"description": "Unauthorized"},
              "404": {"description": "Not Found"}}
```

No 500 is documented.

## Why it matters

A missing required query parameter is ordinary client input. Returning 500 hides the real cause (the caller
usually sees only "Internal Server Error" in logs and dashboards) and inflates server-error alerting for a
request that should be rejected as a 4xx. The existing 404 path shows the endpoint already knows how to
reject bad input cleanly.
