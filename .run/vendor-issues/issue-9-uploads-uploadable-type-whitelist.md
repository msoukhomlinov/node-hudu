# `POST /uploads`: the allowed `uploadable_type` values are an undocumented whitelist

**Endpoint:** `POST /api/v1/uploads`

## Exact request

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/uploads" -H "x-api-key: $HUDU_API_KEY" \
  -F 'file=@/tmp/zz-audit.png' -F 'upload[uploadable_id]=3' -F 'upload[uploadable_type]=Company'
```

## Observed response

```
HTTP 422
{"errors": ["Uploadable type is not included in the list"]}
```

A control with a type the server accepts succeeds:

```bash
curl -sS -X POST "$HUDU_BASE_URL/api/v1/uploads" -H "x-api-key: $HUDU_API_KEY" \
  -F 'file=@/tmp/zz-audit.png' -F 'upload[uploadable_id]=332' -F 'upload[uploadable_type]=Asset'
```
```
HTTP 201
{"id": 2, "slug": "c9eac6baa1c8", "name": "zz-audit.png", "ext": "png", "mime": "image/png",
 "size": "67 Bytes", "uploadable_id": 332, "uploadable_type": "Asset"}
```

(The test upload, and the audit's other test records, were deleted afterwards.)

## What the spec says instead

`paths./uploads.post` declares the parameter as an unconstrained string:

```json
{"name": "upload[uploadable_type]", "in": "formData", "required": true, "type": "string"}
```

`definitions.Upload.uploadable_type` is likewise `{"type": "string", "description": "Type of the object the
file is associated with"}`. No enum, no list, no note that companies cannot have uploads. The documented
responses are `201`, `400`, `401`, `422`.

## Why it matters

The validation exists server side, but the contract does not describe it, so the client cannot know which
`uploadable_type` values are legal. The failure only appears at runtime, as a 422 with a generic message,
after the file has already been uploaded — an avoidable round trip and an avoidable support question.

## Requested fix

Publish the allowed `uploadable_type` values (and, if files genuinely cannot be attached to a company, say
so in the parameter description).
