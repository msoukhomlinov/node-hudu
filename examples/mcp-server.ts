/**
 * mcp-server.ts — a Model Context Protocol (MCP) server backed by node-hudu.
 *
 * Demonstrates the MCP tool-manifest standard (api-node-squad
 * references/mcp-tool-manifest.md): one `list_<resource>` read per represented
 * resource via listAll (the single read entry point) - a small representative
 * subset (3 of the SDK's resources) plus one targeted get, uniform verb_scope naming, optional
 * `search` listed before exact-match `name`, consistent page_size guidance, and
 * handlers that surface HuduError.code for LLM self-correction.
 *
 * Requires:  npm install @modelcontextprotocol/sdk zod
 *
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=xxx npx tsx examples/mcp-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HuduClient, HuduError } from 'node-hudu';

const baseUrl = process.env.HUDU_BASE_URL;
const apiKey = process.env.HUDU_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error('HUDU_BASE_URL and HUDU_API_KEY must be set');
}

const hudu = new HuduClient({ baseUrl, apiKey });
const server = new McpServer({ name: 'hudu-mcp', version: '0.1.0' });

/**
 * Surface a HuduError.code (plus status/retryAfter) as a structured content block so
 * the model can self-correct — never let the error vanish into an uncaughtException.
 */
function huduContent(data: unknown, err?: unknown): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (err instanceof HuduError) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: true,
          code: err.code,
          status: err.status,
          message: err.message,
          retryAfter: 'retryAfter' in err ? (err as { retryAfter?: number }).retryAfter : undefined,
        }),
      }],
      isError: true,
    };
  }
  if (err !== undefined) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: true,
          message: err instanceof Error ? err.message : String(err),
        }),
      }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
}

// -- Read-only core tier ------------------------------------------------
// One list_<resource> per represented resource (a representative subset, not all 35).
// `search` is OPTIONAL and listed first — so "list all" is always possible.

server.registerTool(
  'hudu_list_companies',
  {
    description: 'List/search companies. Returns Company[] with a numeric id to pass to later calls; search is a partial name match.',
    inputSchema: {
      search: z.string().optional().describe('Partial company name match (prefer over exact name)'),
      page_size: z.number().int().min(1).max(100).optional().describe('Records per page; 1-100 (raise to 100 for many records)'),
    },
  },
  async ({ search, page_size }) => {
    try {
      const companies = await hudu.companies.listAll({ search, page_size: page_size ?? 25 });
      return huduContent(companies);
    } catch (err) {
      return huduContent(null, err);
    }
  },
);

server.registerTool(
  'hudu_list_articles',
  {
    description: 'List/search articles. Returns Article[] with a numeric id; search matches name/content.',
    inputSchema: {
      search: z.string().optional().describe('Partial article name/content match (prefer over exact name)'),
      page_size: z.number().int().min(1).max(100).optional().describe('Records per page; 1-100 (raise to 100 for many records)'),
    },
  },
  async ({ search, page_size }) => {
    try {
      const articles = await hudu.articles.listAll({ search, page_size: page_size ?? 25 });
      return huduContent(articles);
    } catch (err) {
      return huduContent(null, err);
    }
  },
);

server.registerTool(
  'hudu_list_asset_layouts',
  {
    description: 'List asset layouts. Returns AssetLayout[] with numeric id; call this first to find asset_layout_id for creating assets.',
    inputSchema: {
      name: z.string().optional().describe('Exact asset layout name match'),
      active: z.boolean().optional().describe('Filter to active layouts only'),
      slug: z.string().optional().describe('Exact asset layout slug match'),
    },
  },
  async ({ name, active, slug }) => {
    try {
      const layouts = await hudu.assetLayouts.listAll({ name, active, slug });
      return huduContent(layouts);
    } catch (err) {
      return huduContent(null, err);
    }
  },
);

// -- A targeted get: only when you already hold a numeric id ------------
server.registerTool(
  'hudu_get_company',
  {
    description: 'Get one Company by its numeric id. Only call when you have the id (e.g. from hudu_list_companies); otherwise call hudu_list_companies first.',
    inputSchema: {
      id: z.number().int().describe('The numeric Company id'),
    },
  },
  async ({ id }) => {
    try {
      return huduContent(await hudu.companies.get(id));
    } catch (err) {
      return huduContent(null, err);
    }
  },
);

process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err instanceof Error ? err.stack ?? err.message : err);
  // Avoid a hard process.exit(1), which can drop buffered stdout. Close the
  // transport so pending I/O drains, then exit with a non-zero status.
  void transport.close().finally(() => process.exit(1));
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('hudu MCP server running over stdio');
