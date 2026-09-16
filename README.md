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

## Agent helpers

0.3.0 adds a helper tier so an agent does not have to re-implement matching, paging and ID resolution
in a prompt. Every helper is additive — the primitives below them are unchanged.

```ts
import { HuduClient } from 'node-hudu';

const hudu = new HuduClient({ baseUrl, apiKey });

// Resolve by anything: an id fetches directly, a name/slug/domain is looked up.
const company = await hudu.companies.resolve('acme.com');          // CompanySummary | null
const full = await hudu.companies.resolve({ name: 'Acme' }, { expand: true }); // Company | null

// Vendor filters, bounded, compact by default.
await hudu.assets.findBySerial('SN-1234');
await hudu.websites.search('intranet', { limit: 10 });
await hudu.companies.getContext(42);           // company + its assets, articles, websites, passwords

// Across resources, one bounded call.
await hudu.operations.searchAcrossResources('vpn', { resources: ['companies', 'articles'] });
await hudu.operations.resolveAny('10.0.0.5');

// Dry-run never writes: it validates, checks and reports, then you decide.
const plan = await hudu.companies.delete(42, { dryRun: true });
// { simulated: true, impact: { affected: 1, scope: 'single', reversible: false }, request: {…}, checks: […] }
```

**What the helpers guarantee**

- `resolve` never lies: an `{ id }` miss throws `NOT_FOUND`; `null` means a *complete* scan found nothing;
  a cap that stopped the search throws `RESOLUTION_TRUNCATED`; several exact matches throw
  `RESOLUTION_AMBIGUOUS` with the candidate ids. `{ resolutionDetails: true }` returns a `Resolution<T>`
  with `resolutionCost`, `scanned` and `scanTruncated`.
- Scans are bounded (500 records / 4 pages by default, configurable on the client) and never unbounded.
- `limit` defaults to 25 and throws above 100 instead of silently clamping.
- Helpers return compact summaries and declare which fields they drop; `expand: true` returns the full record.
- Repeated lookups can opt into a TTL cache, and bulk work can bound its concurrency (default 4).

**Mutation safety**

- Every mutation accepts `{ dryRun: true }` and a dry run cannot issue the write.
- Classification lives in the capability registry: `effect` (`read`/`write`/`destructive`) plus
  `sensitive`, `idempotent`, `requiresApproval`. Bulk deletes refuse to run unconfirmed.
- `{ expectedUpdatedAt }` on an `update()` raises `STALE_OBJECT` if the record changed under you.
- `onAudit(event)` receives a correlation id, the operation, the effect, the outcome and the impact;
  `redact()` strips credential-shaped fields from anything you log.

**Discover it all from the capability registry**

```ts
import { getCapability, CAPABILITY_NAMES } from 'node-hudu/capabilities';

getCapability('companies.resolve');
// { purpose, inputSchema, outputSchema, effect, flags, dryRun, resolution, errors, preferredWhen, usage, … }
```

`capabilities.json` and `capabilities.schema.json` ship at the package root for non-TypeScript
consumers, and `MCP_TOOL_MANIFEST.md` is projected from the same registry.

## Article HTML rules

Hudu's editor (Tiptap/ProseMirror) and its published-view renderer treat article body HTML in ways
that surprise authors: a code block's language class must be on `<code>` or nothing is highlighted,
a callout must be a `<div>` to be a callout, `class="align-*"` does not survive a resave. Three pure
functions encode those platform facts — no HTTP, no HTML parser, no new dependency:

```ts
import { validateArticleHtml, normalizeArticleHtml, diffArticleRoundTrip, ARTICLE_HTML_PROVENANCE } from 'node-hudu';

const findings = validateArticleHtml(html);
// [{ code: 'CODE_LANGUAGE_CLASS_MISSING_ON_CODE', severity: 'error', impact: 'content',
//    element: 'code', message: '…', index: 34, snippet: '<code>' }, …]

// Opt-in, idempotent, and NEVER called for you on a write path: it rewrites your content.
const fixed = normalizeArticleHtml(html);

// After a write: what did Hudu actually keep? Returns a list you filter, not a verdict.
const lost = diffArticleRoundTrip(sent, (await hudu.articles.get(id)).content);
if (lost.some((f) => f.impact === 'content')) { /* semantics disappeared, not just styling */ }
```

Findings carry a stable `code` (branch on it), a `severity`, an `impact` of `content` (information
the reader loses) or `presentation` (cosmetics only), the `element` family and a location hint. The
`/public_photo/<slug>` `src` rewrite Hudu applies to images is expected behaviour and is never
reported as a fault.

These are facts about **one Hudu build**, audited on 2026-09-16 against Hudu's container CSS and the
editor's compiled schema. `ARTICLE_HTML_PROVENANCE` and the per-rule dates in `ARTICLE_HTML_RULES`
are public API so you can check the age before trusting them — especially before letting
`normalizeArticleHtml` rewrite real articles. Editorial house style (section structure, tone, title
patterns, list-nesting limits) is deliberately **not** encoded: that belongs to your style guide.

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
| `AuthError` | — (credential could not be resolved; not retryable) | `AUTH_ERROR` |
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
  apiKey: 'YOUR_API_KEY',                // REQUIRED unless `auth` is set: non-empty string
  // auth: new BearerTokenAuth(token),    // alternative to apiKey - EXACTLY ONE of the two
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
| `apiKey` | `string` | — (**required unless `auth` is set**) | Hudu API key; sent as the `x-api-key` header. Trimmed; a blank key is refused. |
| `auth` | `AuthStrategy` | — (**required unless `apiKey` is set**) | Credential source. `new ApiKeyAuth(key)`, `new BearerTokenAuth(token)`, `new HeaderAuth(headers)`, or your own `{ name, headers(ctx) }`. Supply exactly one of `apiKey`/`auth`. |
| `basePath` | `string` | `'/api/v1'` | The Swagger base path; override only for custom installs. |
| `timeoutMs` | `number` | `30000` | Max time for the ENTIRE request call (network request, retries, backoff, and rate-limit wait) in ms. |
| `maxRetries` | `number` | `3` | Retry budget for idempotent requests on 429/5xx (`0` disables). |
| `logger` | `Logger` | no-op | Optional request/log sink; API keys are always redacted. |
| `rateLimit` | `RateLimitConfig` | off | Optional client-side token bucket (`perMinute` default 300, `burst` defaults to `perMinute`). |

---

## Per-request credentials

A client takes **exactly one** credential source: `apiKey` (the default, sent as `x-api-key`) or an
`auth` strategy. Supplying both, neither, or a malformed strategy throws `CONFIG_ERROR` during
construction — a request is never sent without a credential.

**Header precedence.** Every request merges headers in one fixed order, and a **later writer wins**:

```
strategy headers  <  caller-supplied `headers`  <  `Accept`  <  `Content-Type`
```

So a caller-supplied `headers` value overrides the credential the strategy produced — it can suppress
the credential entirely. Never forward untrusted headers into `headers`. Header names are
case-insensitive, so duplicate names that differ only in case collapse to ONE value (the later
writer's value, keeping its own spelling); the earlier duplicate is dropped, not combined.

```ts
import { HuduClient, ApiKeyAuth, BearerTokenAuth, HeaderAuth } from 'node-hudu';

// The default: apiKey becomes an ApiKeyAuth, so nothing changes for existing code.
const byKey = new HuduClient({ baseUrl, apiKey: process.env.HUDU_API_KEY! });

// A strategy instead of apiKey:
const byBearer = new HuduClient({
  baseUrl,
  auth: new BearerTokenAuth(process.env.HUDU_PROXY_TOKEN!),
});

const byHeader = new HuduClient({
  baseUrl,
  auth: new HeaderAuth({ 'x-tenant-key': tenantKey }),
});

// Any object with a name and a headers(ctx) method is a strategy. headers() may be async, and it is
// called at most once per ATTEMPT (so a retry after backoff can pick up a rotated credential):
const rotated = new HuduClient({
  baseUrl,
  auth: {
    name: 'vault',
    async headers(ctx) {
      return { 'x-api-key': await vault.read('hudu', ctx.correlationId) };
    },
  },
});
```

### Scoped clients — one client, many credentials

`client.withAuth(strategyOrToken)` returns a real `HuduClient` that shares the parent's transport
state — the rate-limit bucket, the queue, the logger, the audit hook, the timeouts — and differs only
in its credential. It is cheap enough to build per request, which is what a remote, multi-user MCP
server needs: one process-wide client, and one scope per caller.

```ts
import { HuduClient, ApiKeyAuth, BearerTokenAuth } from 'node-hudu';

const hudu = new HuduClient({ baseUrl, apiKey: process.env.HUDU_API_KEY! });

// Per request, in your server's own auth layer:
const scoped = hudu.withAuth(new ApiKeyAuth(endUserApiKey));
const companies = await scoped.companies.listAll();

// A bare string is an API KEY (the SDK's historical wire shape) — never a bearer token:
const same = hudu.withAuth(endUserApiKey);

// For a bearer token, say so explicitly:
const proxied = hudu.withAuth(new BearerTokenAuth(sessionToken));
```

Scopes are isolated by construction: two scopes in flight carry their own credential, and nothing is
mutated on the parent — `withAuth(a).withAuth(b)` sends `b`. Because the scopes share one token
bucket, a fan-out through several scopes still honours the single rate limit.

`withAuth` throws `CONFIG_ERROR` for an empty string or a non-strategy; `download()` and every
resource method use the scope's strategy with no extra wiring. If a credential cannot be produced for
an attempt — the strategy throws, returns blank headers, or does not resolve inside the call's
remaining `timeoutMs` — the call fails with `AuthError` (`AUTH_ERROR`, category `auth`, not retried)
and **no request is sent**. That is distinct from `UnauthorizedError` (401): there the server rejected
a credential that was sent. Redaction is unchanged in spirit: the logger masks credential-shaped
names, and a strategy may declare extra secret header names (`secretHeaders`) to extend it for audit
events.

> A runnable reference for the per-request case is
> [`examples/mcp-server-http.ts`](examples/mcp-server-http.ts) — a remote, multi-user MCP server that
> verifies its caller's bearer token, then scopes the shared client to that caller's own credential.

---

## Documentation

- **[Full API reference](docs/API.md)** — typed method signatures for every resource
  client, plus config, pagination, and error types.
- **[Architecture](ARCHITECTURE.md)** — design decisions and the public API surface.

## License

MIT. See [LICENSE](LICENSE).
