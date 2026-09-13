# `PUT` and `DELETE /matchers/{id}` return HTTP 500 instead of 404 for a nonexistent matcher

**Endpoints:** `PUT /api/v1/matchers/{id}`, `DELETE /api/v1/matchers/{id}`

## Exact requests

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

## What the spec says instead

* `paths./matchers/{id}.put` (`updateMatcherById`): `id` required, body `matcher` required; responses
  `200 "Matcher successfully updated"`, `401`, **`404 "Matcher not found"`**, `422`.
* `paths./matchers/{id}.delete` (`deleteMatcherById`): `id` required; responses
  **`204 "Matcher successfully deleted"`**, `401`, **`404 "Matcher not found"`**.

Neither documents a 500.

## Why it matters

The not-found path is the one clients hit most often (retrying a delete, cleaning up after a sync), and both
verbs answer it with an undocumented 500 instead of the documented 404. A client cannot tell "this matcher
was already removed" (safe to ignore) from a server outage (must retry/alert).

## Notes / limits

This tenant has no matchers (matchers are created by an integration, and none is installed), so only the
not-found path was exercised. The success paths (`200`/`204`) are **UNVERIFIED** here.
