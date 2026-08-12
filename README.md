# node-hudu

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Fully-typed TypeScript SDK for the [Hudu IT documentation API](https://hudu.com).**
Designed from the ground up for building **MCP servers**, integrations, and ETL pipelines.

- **Zero runtime dependencies.** Uses only native platform APIs (`fetch`, `FormData`,
  `URLSearchParams`, `AbortSignal`) available in Node.js ≥ 18.
- **35 typed resource clients**, each exposing full CRUD plus Hudu's special operations.
- **Plain typed data** — every read returns concrete JSON-serialisable arrays and objects,
  ready to feed into zod output schemas, MCP tools, or downstream sinks.
- **`listAll()` is the MCP-preferred read**: one call, a plain array, no page-walking.

```bash
npm install node-hudu
```

> **Node.js ≥ 18** is required (native `fetch`).

---

## Quickstart

```ts
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: 'https://hudu.example.com', // origin only — no path, no trailing slash
  apiKey: process.env.HUDU_API_KEY!,   // Hudu Admin → Basic Information → API Keys
});

// listAll is the recommended read — returns a plain array
const companies = await hudu.companies.listAll({ search: 'acme' });

// get a single record by numeric id
const company = await hudu.companies.get(companies[0]!.id);

// create
const created = await hudu.companies.create({ name: 'Acme Corp' });

// delete
await hudu.companies.delete(created.id);
```

Type-only imports, errors, and standalone resource construction are all available from the
package root:

```ts
import type { Company, Asset, Page } from 'node-hudu';
import { HuduError, NotFoundError, RateLimitError } from 'node-hudu';
```

---

## Real usage examples

### 1. List all companies (MCP-style read)

```ts
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: process.env.HUDU_BASE_URL!,
  apiKey: process.env.HUDU_API_KEY!,
});

// One call, plain array. Raise page_size when expecting many records.
const all = await hudu.companies.listAll({ page_size: 100 });
console.log(all.length, all.map((c) => c.name));
```

### 2. Create an asset inside a company

Assets are company-scoped in the Hudu API, so `assets` methods take a `companyId`:

```ts
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: process.env.HUDU_BASE_URL!,
  apiKey: process.env.HUDU_API_KEY!,
});

const asset = await hudu.assets.create(companyId, {
  name: 'Workstation-001',
  asset_layout_id: 12, // look up asset layouts first via hudu.assetLayouts.listAll()
  primary_serial: 'SN-ABC-123',
});

// Move it to a different layout, or list everything across all companies:
await hudu.assets.moveLayout(companyId, asset.id, { asset_layout_id: 24 });
const accountWide = await hudu.assets.listAllAcrossCompanies();
```

### 3. Search

`search` is a partial, server-side substring match. Use it on resources that expose it
(`search` appears in the list params of companies, articles, asset passwords, groups,
users, websites, procedures, password folders, and more).

```ts
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: process.env.HUDU_BASE_URL!,
  apiKey: process.env.HUDU_API_KEY!,
});

const matches = await hudu.articles.listAll({ search: 'firewall', page_size: 100 });
```

---

## Model Context Protocol (MCP) motivation

`node-hudu` was built to power **MCP servers**. Three design decisions make it a natural fit:

1. **`listAll()` returns plain `T[]`.** MCP tool output schemas need concrete, serialisable
   data — not streaming handles or `this`. One call, ready to map to your output schema.
2. **Zero runtime deps.** MCP runtimes bundle their own validation (e.g. `zod`). The SDK
   never ships a conflicting copy, so there is no dependency mismatch.
3. **Typed errors** with machine-readable `code` values let your MCP tool report failures
   back to the model for self-correction (see Error handling below).

See [`examples/mcp-server.ts`](examples/mcp-server.ts) for a complete, working MCP server
that exposes `hudu_*` tools backed by this SDK.

A minimal skeleton built on MCP SDK v2 (`@modelcontextprotocol/server`, zod v4):

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({
  baseUrl: process.env.HUDU_BASE_URL!,
  apiKey: process.env.HUDU_API_KEY!,
});

serveStdio(() => {
  const server = new McpServer({
    name: 'my-hudu-mcp',
    version: '1.0.0',
    title: 'My Hudu MCP',
    websiteUrl: 'https://example.com',
  });

  server.registerTool(
    'hudu_search_companies',
    {
      description: 'Search companies by name. Returns Company[] with id for hudu_get_company calls.',
      inputSchema: z.object({
        search: z.string().optional().describe('Partial company name match'),
        limit: z.number().int().min(1).max(100).default(25).describe('Max results'),
      }),
      outputSchema: z.object({
        companies: z.array(z.object({ id: z.number(), name: z.string() })),
        total: z.number(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ search, limit }) => {
      // Bounded fetch: single page only via listPages()
      const pages = hudu.companies.listPages({ search, page_size: limit });
      const firstPage = await pages[Symbol.asyncIterator]().next();
      const items = firstPage.done ? [] : firstPage.value.items;
      const compact = items.map((c) => ({ id: c.id, name: c.name }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ companies: compact, total: compact.length }) }],
        structuredContent: { companies: compact, total: compact.length },
      };
    },
  );

  return server;
});
```

> **Note:** MCP SDK v2 requires Node >= 20. The SDK itself supports Node >= 18.

---

## Error handling

Every failure surfaces as a subclass of `HuduError`, so you can catch precisely. Each
carries a machine-readable `code` and, when available, the raw `status`, `url`, and `body`.

| Error class | HTTP status | `code` |
|-------------|-------------|--------|
| `HuduConfigError` | — (config validation) | `CONFIG_ERROR` |
| `HuduNetworkError` | — (transport/timeout) | `NETWORK_ERROR` |
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `MethodNotAllowedError` | 405 | `METHOD_NOT_ALLOWED` |
| `NotAcceptableError` | 406 | `NOT_ACCEPTABLE` |
| `UnprocessableEntityError` | 422 | `UNPROCESSABLE_ENTITY` |
| `RateLimitError` | 429 | `RATE_LIMIT` (carries `retryAfter?`) |
| `ServerError` | 5xx | `SERVER_ERROR` |

```ts
import { HuduClient, NotFoundError, RateLimitError } from 'node-hudu';

const hudu = new HuduClient({ baseUrl, apiKey });

try {
  const c = await hudu.companies.get(12345);
} catch (err) {
  if (err instanceof NotFoundError) console.log('company not found');
  else if (err instanceof RateLimitError) console.log('slow down', err.retryAfter);
  else throw err;
}

// Narrow with the type guard:
import { isHuduError } from 'node-hudu';
```

> **Retries**: idempotent requests (`GET`/`PUT`/`DELETE`) are retried automatically up to
> `maxRetries` (default 3) with exponential backoff on `429`/`5xx`, honouring
> `Retry-After`. `POST` is never retried.

---

## Configuration options

`HuduClient` accepts a single `HuduConfig` object:

```ts
const hudu = new HuduClient({
  baseUrl: 'https://hudu.example.com',   // REQUIRED: origin only
  apiKey: 'YOUR_API_KEY',                // REQUIRED: non-empty string
  basePath: '/api/v1',                   // optional, default '/api/v1'
  timeoutMs: 30_000,                     // optional, default 30000
  maxRetries: 3,                         // optional, default 3 (0 disables)
  logger: console,                       // optional log sink
  rateLimit: { perMinute: 300, burst: 300 }, // optional client-side token bucket
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | — (**required**) | Origin only (`https://…`); no path or trailing slash. |
| `apiKey` | `string` | — (**required**) | Hudu API key; sent as the `x-api-key` header. |
| `basePath` | `string` | `'/api/v1'` | The Swagger base path; override only for custom installs. |
| `timeoutMs` | `number` | `30000` | Max time for the ENTIRE request call (network request, retries, backoff, and rate-limit wait) in ms. |
| `maxRetries` | `number` | `3` | Retry budget for idempotent requests on 429/5xx (`0` disables). |
| `logger` | `Logger` | no-op | Optional request/log sink; API keys are always redacted. |
| `rateLimit` | `RateLimitConfig` | off | Optional client-side token bucket (`perMinute` default 300, `burst` defaults to `perMinute`). |

---

## Documentation

- **[Full API reference](docs/API.md)** — typed method signatures for every resource
  client, plus config, pagination, and error types.
- **[Architecture](ARCHITECTURE.md)** — design decisions and the public API surface.

## License

MIT. See [LICENSE](LICENSE).
