# Changelog

All notable changes to **node-hudu** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-10

### Added — Initial release

- **Fully-typed TypeScript SDK** for the Hudu IT documentation API with **zero runtime
  dependencies** (native `fetch`, `FormData`, `URLSearchParams`, `AbortSignal` on Node ≥ 18).
- **One client facade**

```ts
const hudu = new HuduClient({ baseUrl, apiKey });
```

- **All 35 resource clients**, each exposing typed CRUD plus Hudu's special operations:

| Resource | Reads | Writes / special ops |
|----------|-------|----------------------|
| companies | get, list, listPages, listAll | create, update, delete, archive, unarchive |
| articles | get, list, listPages, listAll | create, update, delete, archive, unarchive |
| asset_layouts | get, list, listPages, listAll | create, update (no delete) |
| asset_passwords | get, list, listPages, listAll | create, update, delete, archive, unarchive |
| assets | get, list, listPages, listAll, listAllAcrossCompanies | create, update, delete, archive, unarchive, moveLayout |
| expirations | list, listPages, listAll | update, delete (no get/create) |
| exports | list, listPages, listAll, get | create (initiate), get(download) |
| flag_types | get, list, listPages, listAll | create, update, delete |
| flags | get, list, listPages, listAll | create, update, delete |
| folders | get, list, listPages, listAll | create, update, delete |
| groups | get, list, listPages, listAll | read-only |
| ip_addresses | get, list, listPages, listAll | create, update, delete |
| label_types | get, list, listPages, listAll | create, update, delete |
| labels | get, list, listPages, listAll | create, update, delete |
| lists | get, list, listPages, listAll | create, update, delete |
| magic_dash | list, listPages, listAll | create, delete, deleteById, updatePositions |
| matchers | list, listPages, listAll | update, delete (no get/create) |
| networks | get, list, listPages, listAll | create, update, delete |
| password_folders | get, list, listPages, listAll | create, update, delete |
| photos | get, list, listPages, listAll | create (multipart), update, delete, get(download) |
| procedure_tasks | get, list, listPages, listAll | create, update, delete |
| procedures | get, list, listPages, listAll | create, update, delete, duplicate, createFromTemplate, kickoff |
| public_photos | get, list, listPages, listAll | create/update (multipart), no delete |
| rack_storage_items | get, list, listPages, listAll | create, update, delete |
| rack_storages | get, list, listPages, listAll | create, update, delete |
| relations | list, listPages, listAll | create, delete (no get/update) |
| s3_exports | — | create (initiate) |
| uploads | list, listPages, listAll, get | upload (multipart), delete, get(download) |
| users | get, list, listPages, listAll | read-only |
| vlan_zones | get, list, listPages, listAll | create, update, delete |
| vlans | get, list, listPages, listAll | create, update, delete |
| websites | get, list, listPages, listAll | create, update, delete |
| api_info | get | — |
| activity_logs | list, listPages, listAll | deleteAll |
| cards | lookup, jump | — |

- **MCP-ready reads**: every list method exposes `list()`, `listPages()`, and `listAll()`;
  `listAll()` returns a plain `T[]` in a single call and is the recommended MCP read.
- **Plain typed data** everywhere — no wrappers, no `this`, results feed directly into zod
  output schemas, MCP tools, or ETL.
- **Typed error hierarchy** (`HuduError` + `HuduConfigError`, `HuduNetworkError`,
  `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`,
  `MethodNotAllowedError`, `NotAcceptableError`, `UnprocessableEntityError`,
  `RateLimitError`, `ServerError`) with machine-readable `code` values.
- **Retries** with exponential backoff on `429`/`5xx` (idempotent `GET`/`PUT`/`DELETE`
  only, honouring `Retry-After`; `POST` never retried).
- **Config validation** (`HuduClient`) and an **optional client-side token-bucket rate
  limiter** for bursty MCP servers.
- **Dual ESM + CJS** build (`dist/index.js` / `dist/index.cjs`) with full `.d.ts` types, and
  optional deep-import subpaths (`node-hudu/resources`, `node-hudu/types`,
  `node-hudu/errors`).
