# `POST /ip_addresses` requires `network_id`, but the spec marks every field optional (and the error message is misleading)

**Endpoint:** `POST /api/v1/ip_addresses`

## Exact request

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/ip_addresses" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' -d '{"ip_address":{"address":"10.99.99.7","company_id":3}}'
```

## Observed response

```
HTTP 422
{"errors": "Network does not belong to the specified company"}
```

The message names a network relationship, although the request contained **no** `network_id` at all. With
`network_id` supplied (the network of company 3) the same body succeeds:

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/ip_addresses" -H "x-api-key: $HUDU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"ip_address":{"address":"10.99.99.7","company_id":3,"network_id":8,"notes":"IP-NOTES-SENTINEL"}}'
```
```
HTTP 201
{"id": 10, "address": "10.99.99.7", "status": "Unassigned", "notes": "IP-NOTES-SENTINEL", ...}
```

(The test address went away with its parent network when the test network was deleted.)

## What the spec says instead

`paths./ip_addresses.post` (`createIpAddress`) takes the body as `$ref: #/definitions/IpAddress` and
documents `201`, `401`, `422 "Validation Error"`. `definitions.IpAddress` declares `address`, `status`,
`fqdn`, `description`, `notes`, `asset_id`, `network_id`, `company_id`, `skip_dns_validation` and has **no
`required` array** — so, read literally, every field is optional. Nothing in the spec states the rule "the
address must belong to a network of the given company".

## Why it matters

The 422 status itself is documented, so this is a documentation gap rather than a behaviour defect — but a
client cannot construct a valid create from the spec, and the misleading message ("Network does not belong
to the specified company") points the caller at the wrong problem when the actual problem is a missing
parameter. That message cost us debugging time.

## Requested fix

Mark `network_id` as required for create (or document the company/network consistency rule) and say
"network_id is required" when it is absent.
