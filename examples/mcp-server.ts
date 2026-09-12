/**
 * mcp-server.ts — reference Model Context Protocol (MCP) v2 server backed by node-hudu.
 *
 * Protocol 2026-07-28, official SDK v2 (`@modelcontextprotocol/server`), zod v4
 * (`import * as z from 'zod/v4'`), `structuredContent` paired with an `outputSchema` per tool.
 *
 * Ground rules this example follows (see MCP_TOOL_MANIFEST.md, curated by MCP_TOOL_OVERRIDES.json):
 * - Every READ tool calls the SDK's HELPER tier: `search`, `findBy*`, `resolve`, `getContext`, or
 *   the cross-resource `operations.searchAcrossResources` / `operations.resolveAny`. No tool is
 *   backed by `listAll`, `listPages`, or a streaming `list`.
 * - Results are BOUNDED: `limit` defaults to 25 and hard-caps at 100 on every read tool. The SDK
 *   validates the bound and throws `CONFIG_ERROR` above it — it never silently clamps.
 * - Every MUTATING tool exposes `dry_run`, which calls the SDK's `{ dryRun: true }` path and
 *   returns a `DryRunResult` (`simulated: true`, impact, diff) without issuing the write.
 * - Tool names, titles and descriptions are the curated ones from `MCP_TOOL_MANIFEST.md`;
 *   `npm run mcp:project -- --check-example` fails if this file drifts from that manifest.
 * - Errors surface `HuduError.code` (NOT_FOUND, RESOLUTION_AMBIGUOUS, POLICY_DENIED, …) so a
 *   model can self-correct instead of retrying blindly.
 *
 * This is a REFERENCE CONSUMER, not the whole surface: the curated manifest projects 147 tools,
 * and this file exposes the core tier (20). Tools curation dropped as duplicates of another
 * tool's outcome are absent here too — the manifest lists them under "Excluded by curation".
 *
 * Requires:  npm install @modelcontextprotocol/server zod      (both are devDependencies here)
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=xxx npx tsx examples/mcp-server.ts
 *
 * Note: MCP SDK v2 requires Node >= 20.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { HuduClient } from 'node-hudu';
import { Operations } from 'node-hudu/operations';

const baseUrl = process.env.HUDU_BASE_URL;
const apiKey = process.env.HUDU_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error('HUDU_BASE_URL and HUDU_API_KEY must be set');
}

/** Helper `limit` bounds (manifest: "default 25 results, hard maximum 100"). */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The eight resources the cross-resource helpers can reach, in their documented fan-out order. */
const SEARCHABLE_RESOURCES = z.array(
  z.enum([
    'companies',
    'articles',
    'assets',
    'websites',
    'asset_passwords',
    'password_folders',
    'groups',
    'users',
  ]),
);

/** Every read tool's bound, stated identically everywhere. */
const LIMIT = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe('Maximum rows returned (1-100, default 25). A larger value throws CONFIG_ERROR - the SDK never silently clamps.');

const EXPAND = z
  .boolean()
  .default(false)
  .describe('Return the full typed records instead of the compact summaries (default false).');

const DRY_RUN = z
  .boolean()
  .default(false)
  .describe('Validate without issuing the write: returns a DryRunResult with simulated: true, the impact and the diff. Dry-run every destructive or approval-gated call first.');

/** Accepts a bare id/name/slug or the identifier object the resource documents. */
const IDENTIFIER = z.union([
  z.number().int(),
  z.string().min(1),
  z.object({
    id: z.number().int().optional().describe('Numeric id - the direct fetch.'),
    name: z.string().optional().describe('Exact name.'),
    slug: z.string().optional().describe('Exact slug.'),
    external_id: z.string().optional().describe('Vendor-side external id.'),
    domain: z.string().optional().describe('Domain, for resources that have one.'),
  }),
]);

/** `companies.resolve` also accepts a website. */
const COMPANY_IDENTIFIER = z.union([
  z.number().int(),
  z.string().min(1),
  z.object({
    id: z.number().int().optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
    website: z.string().optional(),
    domain: z.string().optional(),
  }),
]);

/** `assets.resolve` / `assets.getContext` also accept a primary serial and a company scope. */
const ASSET_IDENTIFIER = z.union([
  z.number().int(),
  z.string().min(1),
  z.object({
    id: z.number().int().optional(),
    companyId: z.number().int().optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
    primary_serial: z.string().optional(),
  }),
]);

/**
 * Row shape of a compact summary (`CompanySummary`, `ArticleSummary`, …).
 *
 * Stays loose on purpose: the exact kept/dropped field list is published per resource in
 * MCP_TOOL_MANIFEST.md (`outputSchema.drops`). Restating it here would add ~15 fields of JSON
 * schema per resource for no extra information the model does not already have.
 */
const ROWS = z.array(z.unknown());

/** One row of a bounded list result. `hasMore` is a hint: the SDK returned exactly `limit` rows. */
const LIST_OUTPUT = z.object({
  items: ROWS,
  total: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
});

/** One resolved record: `found: false` is a complete answer, not an error. */
const ONE_OUTPUT = z.object({ found: z.boolean(), record: z.unknown() });

/** A cross-resource result; `truncated` names resources whose scan hit its cap (undecided). */
const HITS_OUTPUT = z.object({
  hits: z.array(
    z.object({ resource: z.string(), id: z.number(), label: z.string(), item: z.unknown() }),
  ),
  total: z.number(),
  truncated: z.array(z.string()),
  scanned: z.number(),
});

/** A bundled context read (`getContext`, `getWithTasks`). */
const CONTEXT_OUTPUT = z.object({ context: z.unknown() });

/** A write result: `simulated: true` means the dry-run path ran and nothing was written. */
const WRITE_OUTPUT = z.object({ simulated: z.boolean(), result: z.unknown() });

type ToolReturn =
  | { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }
  | { content: Array<{ type: 'text'; text: string }>; isError: true };

/** A successful structured result. `outputSchema` describes `structuredContent`. */
function ok(text: string, structuredContent: Record<string, unknown>): ToolReturn {
  return { content: [{ type: 'text', text }], structuredContent };
}

/** Bounded list result: the count is the number of rows actually returned. */
function listResult(what: string, items: unknown[], limit: number): ToolReturn {
  return ok(`${items.length} ${what} record(s) returned (bound ${limit}).`, {
    items,
    total: items.length,
    limit,
    hasMore: items.length >= limit,
  });
}

/** One-record result. A `null` from a helper is a complete, bounded "no match" answer. */
function oneResult(what: string, record: unknown): ToolReturn {
  return ok(record === null ? `No ${what} matched.` : `${what} resolved.`, {
    found: record !== null,
    record,
  });
}

/** Surface `HuduError.code` (and HTTP status) so the model can correct itself. */
function errorContent(err: unknown): ToolReturn {
  const code = (err as { code?: string })?.code;
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: true, code, status, message }) }],
    isError: true,
  };
}

const handle = serveStdio(() => {
  const hudu = new HuduClient({ baseUrl, apiKey });
  /** Cross-resource reads (`searchAcrossResources`, `resolveAny`); same client, no extra config. */
  const ops = new Operations(hudu);

  const server = new McpServer({
    name: 'hudu-mcp',
    version: '0.3.0',
    title: 'Hudu MCP Server',
    websiteUrl: 'https://github.com/msoukhomlinov/node-hudu',
  });

  // =========================================================================================
  // READ TOOLS - helper tier only (search / findBy* / resolve / getContext / operations.*)
  // =========================================================================================

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_search_across_resources',
    {
      title: 'Search Across Resources',
      description: 'Search several Hudu resources for one query in a single bounded call. Preferred over calling several resources\' search methods yourself whenever the caller does not know which resource holds the record. Returns one SearchHit row per match as { resource, id, label, item }, in resource order (expand: true returns the full typed records). Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when the resource type is known: that resource\'s own hudu_search_<resource> issues one request instead of eight.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Text to search every requested resource for.'),
        opts: z.object({ resources: SEARCHABLE_RESOURCES.describe('Resources to search; default all eight, in fan-out order.'), limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: HITS_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'operations.searchAcrossResources', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { query, opts } = args;
      try {
        const resources = opts?.resources;
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      const hits = opts?.expand
        ? await ops.searchAcrossResources(query, { ...(resources ? { resources } : {}), limit, expand: true })
        : await ops.searchAcrossResources(query, { ...(resources ? { resources } : {}), limit });
      return ok(`Found ${hits.length} matching record(s) across resources.`, { hits, total: hits.length, truncated: [], scanned: hits.length });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_resolve_any',
    {
      title: 'Resolve Any',
      description: 'Resolve an identifier against several resources and return the candidates that match. Preferred when the caller has an identifier but not the resource type; use the resource\'s own resolve when the type is known. Returns ResolutionCandidateHit rows for each resource that matched, with scanned/truncated counts; it does not throw RESOLUTION_AMBIGUOUS across resources. Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when the resource type is known: call that resource\'s hudu_get_<singular>.',
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name/slug, or an identifier object; resolved against every requested resource.'),
        opts: z.object({ resources: SEARCHABLE_RESOURCES.describe('Resources to try; default all eight, in fan-out order.'), limit: LIMIT }).optional(),
      }),
      outputSchema: HITS_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'operations.resolveAny', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const resources = opts?.resources;
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      const resolved = await ops.resolveAny(identifier, { ...(resources ? { resources } : {}), limit });
      return ok(
        resolved.truncated.length
          ? `Found ${resolved.hits.length} candidate(s); these resources hit their scan cap and are undecided: ${resolved.truncated.join(', ')}.`
          : `Found ${resolved.hits.length} candidate(s).`,
        { hits: resolved.hits, total: resolved.hits.length, truncated: resolved.truncated, scanned: resolved.scanned },
      );
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_search_companies',
    {
      title: 'Search Companies',
      description: 'Search companies by a free-text query. Preferred over companies.list for any text search. Returns rows: a compact CompanySummary (address_line_1, address_line_2, zip, … dropped); expand: true returns the full Company. Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when you already have an id, slug or domain: call hudu_get_company instead.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Partial company name (prefer this over an exact name match).'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: LIST_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.search', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { query, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const items = opts?.expand
        ? await hudu.companies.search(query, { limit, expand: true })
        : await hudu.companies.search(query, { limit });
      return listResult('companies', items, limit);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_company',
    {
      title: 'Get Company',
      description: 'Resolve a company from an id, name, slug or domain. Use when the caller has an identifier rather than a numeric id; companies.get is cheaper when the id is known. Returns one record: a compact CompanySummary (address_line_1, address_line_2, zip, … dropped); expand: true returns the full Company. Bounded: limit defaults to 25 with a hard maximum of 100, and the client scan stops at 500 records / 4 pages (it throws RESOLUTION_TRUNCATED rather than returning a partial answer). Do not use it for free-text discovery across many records: call hudu_search_companies (or hudu_search_across_resources when the resource type is unknown).',
      inputSchema: z.object({
        identifier: COMPANY_IDENTIFIER.describe('Id, exact name, slug, website or domain. A numeric id is fetched directly.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: ONE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.resolve', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const record = opts?.expand
        ? await hudu.companies.resolve(identifier, { limit, expand: true })
        : await hudu.companies.resolve(identifier, { limit });
      return oneResult('company', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_company_context',
    {
      title: 'Get Company Context',
      description: 'Fetch a company together with the bounded context an agent needs about it. Preferred over four separate list calls when an agent starts work on a company. Returns CompanyContext. Bounded: every sub-list is fetched with limit, default 25, hard maximum 100 — no sub-fetch walks the account. Do not use it to page a resource: call hudu_search_companies. It issues several bounded reads per call.',
      inputSchema: z.object({
        id: z.number().int().describe('Numeric company id.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: CONTEXT_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.getContext', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { id, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const context = opts?.expand
        ? await hudu.companies.getContext(id, { limit, expand: true })
        : await hudu.companies.getContext(id, { limit });
      return ok(`Context for company ${id}: assets, articles, websites and passwords, each bounded to ${limit}.`, { context });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_find_companies_by_domain',
    {
      title: 'Find Companies By Domain',
      description: 'Find one company by its website/domain. Preferred over companies.list for any domain lookup. Returns one record: a compact CompanySummary (address_line_1, address_line_2, zip, … dropped); expand: true returns the full Company. Bounded: limit defaults to 25 with a hard maximum of 100, and the client scan stops at 500 records / 4 pages (it throws RESOLUTION_TRUNCATED rather than returning a partial answer). Do not use it to enumerate or to page: it returns at most one exact match (call hudu_search_companies or hudu_get_company for that).',
      inputSchema: z.object({
        domain: z.string().min(1).describe('Company domain or website URL; compared on the host, with no www. or scheme.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: ONE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.findByDomain', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { domain, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const record = opts?.expand
        ? await hudu.companies.findByDomain(domain, { limit, expand: true })
        : await hudu.companies.findByDomain(domain, { limit });
      return oneResult('company', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_search_articles',
    {
      title: 'Search Articles',
      description: 'Search knowledge-base articles by a free-text query. Preferred over articles.list for any text search. Returns rows: a compact ArticleSummary (content, url, object_type, … dropped); expand: true returns the full Article. Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when you already have an id, slug or domain: call hudu_get_article instead.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Partial article name or body text.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND, company_id: z.number().int().optional().describe('Restrict the search to one company knowledge base.') }).optional(),
      }),
      outputSchema: LIST_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'articles.search', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { query, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const items = opts?.expand
        ? await hudu.articles.search(query, { limit, expand: true })
        : await hudu.articles.search(query, { limit });
      return listResult('articles', items, limit);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_article',
    {
      title: 'Get Article',
      description: 'Resolve a knowledge-base article from an id, name or slug. Use when the article identifier is a name or slug; articles.get is cheaper for a known id. Returns one record: a compact ArticleSummary (content, url, object_type, … dropped); expand: true returns the full Article. Bounded: limit defaults to 25 with a hard maximum of 100, and the client scan stops at 500 records / 4 pages (it throws RESOLUTION_TRUNCATED rather than returning a partial answer). Do not use it for free-text discovery across many records: call hudu_search_articles (or hudu_search_across_resources when the resource type is unknown).',
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name, slug or external id.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: ONE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'articles.resolve', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const record = opts?.expand
        ? await hudu.articles.resolve(identifier, { limit, expand: true })
        : await hudu.articles.resolve(identifier, { limit });
      return oneResult('article', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_search_assets',
    {
      title: 'Search Assets',
      description: 'Search assets by a free-text query, optionally scoped to one company. Preferred over the asset list endpoints for any text search. Returns rows: a compact AssetSummary (slug, primary_mail, primary_model, … dropped); expand: true returns the full Asset. Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when you already have an id, slug or domain: call hudu_get_asset instead.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Partial asset name or serial.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND, company_id: z.number().int().optional().describe('Restrict to one company; this is the company-scoped list.') }).optional(),
      }),
      outputSchema: LIST_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'assets.search', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { query, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const items = opts?.expand
        ? await hudu.assets.search(query, { limit, expand: true })
        : await hudu.assets.search(query, { limit });
      return listResult('assets', items, limit);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_asset',
    {
      title: 'Get Asset',
      description: 'Resolve an asset from an id, serial, name or slug. Use when the identifier is a serial or a name; assets.get is cheaper for a known id. Returns one record: a compact AssetSummary (slug, primary_mail, primary_model, … dropped); expand: true returns the full Asset. Bounded: limit defaults to 25 with a hard maximum of 100, and the client scan stops at 500 records / 4 pages (it throws RESOLUTION_TRUNCATED rather than returning a partial answer). Do not use it for free-text discovery across many records: call hudu_search_assets (or hudu_search_across_resources when the resource type is unknown).',
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name, slug or primary serial.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: ONE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'assets.resolve', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const record = opts?.expand
        ? await hudu.assets.resolve(identifier, { limit, expand: true })
        : await hudu.assets.resolve(identifier, { limit });
      return oneResult('asset', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_asset_context',
    {
      title: 'Get Asset Context',
      description: 'Fetch an asset with the context an agent needs about it. Preferred over four separate calls when an agent starts from an asset. Returns AssetContext. Bounded: every sub-list is fetched with limit, default 25, hard maximum 100 — no sub-fetch walks the account. Do not use it to page a resource: call hudu_search_assets. It issues several bounded reads per call.',
      inputSchema: z.object({
        identifier: ASSET_IDENTIFIER.describe('Id, name, slug, primary serial or { id, companyId }.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: CONTEXT_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'assets.getContext', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const context = opts?.expand
        ? await hudu.assets.getContext(identifier, { limit, expand: true })
        : await hudu.assets.getContext(identifier, { limit });
      return ok(`Context for the asset, each sub-list bounded to ${limit}.`, { context });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_search_asset_passwords',
    {
      title: 'Search Asset Passwords',
      description: 'Search password records by a free-text query. Preferred over asset_passwords.list for any text search. Returns rows: a compact AssetPasswordSummary (passwordable_id, passwordable_type, description, … dropped); expand: true returns the full AssetPassword. Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when you already have an id, slug or domain: call hudu_get_asset_password instead. Sensitive: it returns credential-shaped fields; the SDK redacts them from logs and audit payloads by default.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Partial password entry name or username.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND.describe('Return the full records, including secrets. Off by default: the summaries omit credential fields.') }).optional(),
      }),
      outputSchema: LIST_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'asset_passwords.search', sensitive: true, requiresApproval: false },
    },
    async (args) => {
      const { query, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const items = opts?.expand
        ? await hudu.assetPasswords.search(query, { limit, expand: true })
        : await hudu.assetPasswords.search(query, { limit });
      return listResult('asset_passwords', items, limit);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_asset_password',
    {
      title: 'Get Asset Password',
      description: 'Resolve a password record from an id, name or slug. Use when the identifier is a name or slug; asset_passwords.get returns the full record including the secret. Returns one record: a compact AssetPasswordSummary (passwordable_id, passwordable_type, description, … dropped); expand: true returns the full AssetPassword. Bounded: limit defaults to 25 with a hard maximum of 100, and the client scan stops at 500 records / 4 pages (it throws RESOLUTION_TRUNCATED rather than returning a partial answer). Do not use it for free-text discovery across many records: call hudu_search_asset_passwords (or hudu_search_across_resources when the resource type is unknown). Sensitive: it returns credential-shaped fields; the SDK redacts them from logs and audit payloads by default.',
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name or slug.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND.describe('Return the full record, including secrets. Off by default.') }).optional(),
      }),
      outputSchema: ONE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'asset_passwords.resolve', sensitive: true, requiresApproval: false },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const record = opts?.expand
        ? await hudu.assetPasswords.resolve(identifier, { limit, expand: true })
        : await hudu.assetPasswords.resolve(identifier, { limit });
      return oneResult('asset password', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_search_users',
    {
      title: 'Search Users',
      description: 'Search users by a free-text query. Preferred over users.listAll for any text search. Returns rows: a compact UserSummary (otp_required_for_login, phone_number, time_zone, … dropped); expand: true returns the full User. Bounded: limit defaults to 25 and is hard-capped at 100; a larger value throws CONFIG_ERROR and is never silently clamped. Do not use it when you already have an id, slug or domain: call hudu_get_user instead.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Partial user name or email address.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND, archived: z.boolean().optional().describe('Include or exclude archived users.') }).optional(),
      }),
      outputSchema: LIST_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'users.search', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { query, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const items = opts?.expand
        ? await hudu.users.search(query, { limit, expand: true })
        : await hudu.users.search(query, { limit });
      return listResult('users', items, limit);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_get_procedure_with_tasks',
    {
      title: 'Get Procedure With Tasks',
      description: 'Fetch a procedure together with its tasks in one call. Preferred over calling procedures.get and procedure_tasks.listAll yourself whenever the goal is to read or report on a process. Returns one record: a compact ProcedureWithTasks (limit, … dropped); expand: true returns the full ProcedureWithTasksFull. Bounded: every sub-list is fetched with limit, default 25, hard maximum 100 — no sub-fetch walks the account. Do not use it to page every procedure: it fetches one procedure plus its bounded task list.',
      inputSchema: z.object({
        id: z.number().int().describe('Numeric procedure id.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional(),
      }),
      outputSchema: CONTEXT_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'procedures.getWithTasks', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { id, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
      const procedure = opts?.expand
        ? await hudu.procedures.getWithTasks(id, { limit, expand: true })
        : await hudu.procedures.getWithTasks(id, { limit });
      return ok(`Procedure ${id} with at most ${limit} tasks.`, { context: procedure });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // =========================================================================================
  // MUTATING TOOLS - every one exposes dry_run and calls the SDK's { dryRun: true } path first
  // =========================================================================================
  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_create_company',
    {
      title: 'Create Company',
      description: 'Create a new company. Returns the written record, or the DryRunResult plan when dry_run is true. Impact: one record. Pass dry_run: true to validate without issuing the write (DryRunResult with simulated: true, the impact and the diff). Do not use it to change an existing record: call hudu_update_company.',
      inputSchema: z.object({
        data: z.object({
          name: z.string().min(1).describe('Company name (the vendor requires it).'),
          nickname: z.string().optional().describe('Short display name.'),
          website: z.string().optional().describe('Company website or domain.'),
          phone_number: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          id_number: z.string().optional().describe('Custom identification number.'),
        }).describe('The company to create; CompanyCreate accepts every other field as optional too.'),
        dry_run: DRY_RUN,
      }),
      outputSchema: WRITE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.create', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { data, dry_run } = args;
      try {
        const result = dry_run ? await hudu.companies.create(data, { dryRun: true }) : await hudu.companies.create(data);
      return ok(dry_run ? 'Dry run: nothing was written.' : 'Company created.', { simulated: dry_run, result });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_update_company',
    {
      title: 'Update Company',
      description: 'Update a specific company. Returns the written record, or the DryRunResult plan when dry_run is true. Impact: one record. Pass dry_run: true to validate without issuing the write (DryRunResult with simulated: true, the impact and the diff). Do not use it to create a record: call hudu_create_company.',
      inputSchema: z.object({
        id: z.number().int().describe('Numeric company id; resolve it first (hudu_get_company) if you only have a name.'),
        data: z.object({
          name: z.string().optional(),
          nickname: z.string().optional(),
          website: z.string().optional(),
          phone_number: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          id_number: z.string().optional(),
        }).describe('Fields to change; omitted fields are left alone.'),
        opts: z.object({ expectedUpdatedAt: z.string().optional().describe('Opt-in stale guard: the update fails with STALE_OBJECT when the record changed after this revision.') }).optional(),
        dry_run: DRY_RUN,
      }),
      outputSchema: WRITE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.update', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { id, data, opts, dry_run } = args;
      try {
        const expectedUpdatedAt = opts?.expectedUpdatedAt;
      const result = dry_run
        ? await hudu.companies.update(id, data, { dryRun: true, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) })
        : await hudu.companies.update(id, data, expectedUpdatedAt ? { expectedUpdatedAt } : undefined);
      return ok(dry_run ? 'Dry run: nothing was written.' : `Company ${id} updated.`, { simulated: dry_run, result });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_archive_company',
    {
      title: 'Archive Company',
      description: 'Archive a specific company. Returns the written record, or the DryRunResult plan when dry_run is true. Impact: one record. Pass dry_run: true to validate without issuing the write (DryRunResult with simulated: true, the impact and the diff). Do not use it to erase: hudu_delete_company is the destructive path.',
      inputSchema: z.object({
        id: z.number().int().describe('Numeric company id.'),
        dry_run: DRY_RUN,
      }),
      outputSchema: WRITE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.archive', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { id, dry_run } = args;
      try {
        const result = dry_run ? await hudu.companies.archive(id, { dryRun: true }) : await hudu.companies.archive(id);
      return ok(dry_run ? 'Dry run: nothing was written.' : `Company ${id} archived.`, { simulated: dry_run, result });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_delete_company',
    {
      title: 'Delete Company',
      description: 'Delete a specific company. Returns the written record, or the DryRunResult plan when dry_run is true. Impact: one record, permanently; there is no undo. Irreversible — dry-run first and prefer archive where the vendor offers it. requiresApproval: the MCP gateway must obtain explicit human approval before this tool runs; it is not safe to call autonomously. Pass dry_run: true to validate without issuing the write (DryRunResult with simulated: true, the impact and the diff). Do not use it to hide a record you may still need: hudu_archive_company keeps it.',
      inputSchema: z.object({
        id: z.number().int().describe('Numeric company id.'),
        dry_run: DRY_RUN,
      }),
      outputSchema: WRITE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'companies.delete', sensitive: false, requiresApproval: true },
    },
    async (args) => {
      const { id, dry_run } = args;
      try {
        // Approval gate: the manifest marks this tool requiresApproval. A gateway must obtain human
      // approval before it reaches this handler; the dry run below is how it previews the call.
      const result = dry_run ? await hudu.companies.delete(id, { dryRun: true }) : await hudu.companies.delete(id);
      return ok(dry_run ? 'Dry run: nothing was deleted.' : `Company ${id} deleted (irreversible).`, { simulated: dry_run, result: result ?? null });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ---------------------------------------------------------------------------------------
  server.registerTool(
    'hudu_delete_asset_password',
    {
      title: 'Delete Asset Password',
      description: 'Delete a Password. Returns the written record, or the DryRunResult plan when dry_run is true. Impact: one record, permanently; there is no undo. Irreversible — dry-run first and prefer archive where the vendor offers it. requiresApproval: the MCP gateway must obtain explicit human approval before this tool runs; it is not safe to call autonomously. Sensitive: it handles credential material — never echo a secret value into a log, a description or an error (the SDK redacts those fields by default). Pass dry_run: true to validate without issuing the write (DryRunResult with simulated: true, the impact and the diff). Do not use it to hide a record you may still need: hudu_archive_asset_password keeps it.',
      inputSchema: z.object({
        id: z.number().int().describe('Numeric asset-password id.'),
        dry_run: DRY_RUN,
      }),
      outputSchema: WRITE_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      // Not part of ToolAnnotations: the gateway-side flags the manifest also states in the
      // description. Keep them on the tool so a gateway can gate approval without reading prose.
      _meta: { backingOperation: 'asset_passwords.delete', sensitive: true, requiresApproval: true },
    },
    async (args) => {
      const { id, dry_run } = args;
      try {
        // Approval gate + sensitive: the manifest marks this tool requiresApproval and sensitive,
      // and its description carries both notices. Never log the value of a secret.
      const result = dry_run
        ? await hudu.assetPasswords.delete(id, { dryRun: true })
        : await hudu.assetPasswords.delete(id);
      return ok(dry_run ? 'Dry run: nothing was deleted.' : `Asset password ${id} deleted.`, { simulated: dry_run, result: result ?? null });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  return server;
});

process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err instanceof Error ? err.stack ?? err.message : err);
  void handle.close().finally(() => process.exit(1));
});

console.error('hudu MCP server running over stdio (MCP v2, protocol 2026-07-28)');
