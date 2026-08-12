/**
 * mcp-server.ts — a Model Context Protocol (MCP) v2 server backed by node-hudu.
 *
 * Aligns with the MCP v2 standard (2026-07-28):
 * - Official SDK v2: @modelcontextprotocol/server
 * - Zod v4: import * as z from "zod/v4"
 * - structuredContent + outputSchema for typed responses
 * - Tool annotations (readOnlyHint, idempotentHint)
 * - Search-first tool naming (hudu_search_* not hudu_list_*)
 * - Server metadata (websiteUrl, title)
 * - Bounded pagination (respects limit without fetching all pages)
 * - Error handling with HuduError.code surfaced for LLM self-correction
 *
 * Note: MCP SDK v2 requires Node >= 20. The SDK itself supports Node >= 18.
 *
 * Requires:  npm install @modelcontextprotocol/server zod
 *
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=xxx npx tsx examples/mcp-server.ts
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { HuduClient, HuduError } from 'node-hudu';

const baseUrl = process.env.HUDU_BASE_URL;
const apiKey = process.env.HUDU_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error('HUDU_BASE_URL and HUDU_API_KEY must be set');
}

const handle = serveStdio(() => {
  const hudu = new HuduClient({ baseUrl, apiKey });

  const server = new McpServer({
    name: 'hudu-mcp',
    version: '0.2.0',
    title: 'Hudu MCP Server',
    websiteUrl: 'https://github.com/msoukhomlinov/node-hudu',
  });

  /**
   * Return a structured error response that surfaces HuduError.code
   * so the model can self-correct — never let the error vanish.
   */
  function errorContent(err: unknown) {
    const code = (err as { code?: string })?.code;
    const status = (err as { status?: number })?.status;
    const retryAfter = (err as { retryAfter?: number })?.retryAfter;
    const message = err instanceof Error ? err.message : String(err);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: true,
            code,
            status,
            message,
            retryAfter,
          }),
        },
      ],
      isError: true,
    };
  }

  // =========================================================================
  // Read-only core tier — search-first pattern
  // =========================================================================

  // Note: handlers typed as any due to MCP SDK v2 union type complexity between
  // success (structuredContent + content) and error (isError) result shapes when
  // outputSchema is set. Runtime behaviour is correct: isError=true skips
  // outputSchema validation.

  server.registerTool(
    'hudu_search_companies',
    {
      title: 'Search Companies',
      description:
        'Search companies by name. Returns compact Company[] with numeric id for subsequent hudu_get_company calls. ' +
        'Use search for partial matches; leave empty to list companies.',
      inputSchema: z.object({
        search: z.string().optional().describe('Partial company name match (prefer over exact name)'),
        limit: z.number().int().min(1).max(100).default(25).describe('Max results (1-100, default 25)'),
      }),
      outputSchema: z.object({
        companies: z.array(
          z.object({
            id: z.number().describe('Company id for hudu_get_company'),
            name: z.string(),
          }),
        ),
        total: z.number().describe('Number of companies returned'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async function handler({ search, limit }: { search?: string; limit: number }) {
      try {
        // Bounded fetch: get first page only with page_size=limit
        const pages = hudu.companies.listPages({
          search: search || undefined,
          page_size: limit,
        });
        const firstPage = await pages[Symbol.asyncIterator]().next();
        if (firstPage.done) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ companies: [], total: 0 }) }],
            structuredContent: { companies: [], total: 0 },
          };
        }
        const items = firstPage.value.items.slice(0, limit);
        const compact = items.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ companies: compact, total: compact.length }) }],
          structuredContent: { companies: compact, total: compact.length },
        };
      } catch (err) {
        return errorContent(err);
      }
    } as any,
  );

  server.registerTool(
    'hudu_get_company',
    {
      title: 'Get Company',
      description:
        'Get a full Company record by its numeric id. Only call when you have the id (e.g. from hudu_search_companies); ' +
        'otherwise call hudu_search_companies first.',
      inputSchema: z.object({
        id: z.number().int().describe('The numeric Company id'),
      }),
      outputSchema: z.object({
        id: z.number(),
        name: z.string(),
        description: z.string().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      }).passthrough(),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async function handler({ id }: { id: number }) {
      try {
        const company = await hudu.companies.get(id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(company) }],
          structuredContent: company,
        };
      } catch (err) {
        return errorContent(err);
      }
    } as any,
  );

  server.registerTool(
    'hudu_search_articles',
    {
      title: 'Search Articles',
      description:
        'Search articles by name or content. Returns Article[] with id and content preview for subsequent hudu_get_article calls. ' +
        'Use search for partial matches; leave empty to list articles.',
      inputSchema: z.object({
        search: z.string().optional().describe('Partial article name/content match (prefer over exact name)'),
        limit: z.number().int().min(1).max(100).default(25).describe('Max results (1-100, default 25)'),
      }),
      outputSchema: z.object({
        articles: z.array(
          z.object({
            id: z.number().describe('Article id for hudu_get_article'),
            name: z.string(),
            content: z.string().describe('Article content'),
          }),
        ),
        total: z.number().describe('Number of articles returned'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async function handler({ search, limit }: { search?: string; limit: number }) {
      try {
        // Bounded fetch: get first page only with page_size=limit
        const pages = hudu.articles.listPages({
          search: search || undefined,
          page_size: limit,
        });
        const firstPage = await pages[Symbol.asyncIterator]().next();
        if (firstPage.done) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ articles: [], total: 0 }) }],
            structuredContent: { articles: [], total: 0 },
          };
        }
        const items = firstPage.value.items.slice(0, limit);
        // Truncate content to preview (full content via hudu_get_article)
        const previewMax = 500;
        const compact = items.map((a: { id: number; name: string; content?: string }) => ({
          id: a.id,
          name: a.name,
          content: a.content ? (a.content.length > previewMax ? a.content.slice(0, previewMax) + '...' : a.content) : '',
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ articles: compact, total: compact.length }) }],
          structuredContent: { articles: compact, total: compact.length },
        };
      } catch (err) {
        return errorContent(err);
      }
    } as any,
  );

  server.registerTool(
    'hudu_get_article',
    {
      title: 'Get Article',
      description:
        'Get a full Article record by its numeric id. Only call when you have the id (e.g. from hudu_search_articles); ' +
        'otherwise call hudu_search_articles first.',
      inputSchema: z.object({
        id: z.number().int().describe('The numeric Article id'),
      }),
      outputSchema: z.object({
        id: z.number(),
        name: z.string(),
        content: z.string(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      }).passthrough(),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async function handler({ id }: { id: number }) {
      try {
        const article = await hudu.articles.get(id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(article) }],
          structuredContent: article,
        };
      } catch (err) {
        return errorContent(err);
      }
    } as any,
  );

  server.registerTool(
    'hudu_search_asset_layouts',
    {
      title: 'Search Asset Layouts',
      description:
        'List asset layouts. Returns AssetLayout[] with numeric id; call this first to find asset_layout_id for creating assets.',
      inputSchema: z.object({
        name: z.string().optional().describe('Exact asset layout name match'),
        slug: z.string().optional().describe('Exact asset layout slug match'),
        active: z.boolean().optional().describe('Filter to active layouts only'),
        limit: z.number().int().min(1).max(100).default(25).describe('Max results (1-100, default 25)'),
      }),
      outputSchema: z.object({
        layouts: z.array(
          z.object({
            id: z.number().describe('Asset layout id for creating/updating assets'),
            name: z.string(),
            slug: z.string(),
          }),
        ),
        total: z.number().describe('Number of layouts returned'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async function handler({ name, slug, active, limit }: { name?: string; slug?: string; active?: boolean; limit: number }) {
      try {
        // Iterate pages until limit is collected (assetLayouts doesn't support page_size)
        const pages = hudu.assetLayouts.listPages({
          name: name || undefined,
          slug: slug || undefined,
          active: active ?? undefined,
        });
        const compact = [];
        for await (const page of pages) {
          for (const l of page.items) {
            if (compact.length >= limit) break;
            compact.push({ id: l.id, name: l.name, slug: l.slug });
          }
          if (compact.length >= limit) break;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ layouts: compact, total: compact.length }) }],
          structuredContent: { layouts: compact, total: compact.length },
        };
      } catch (err) {
        return errorContent(err);
      }
    } as any,
  );

  return server;
});

process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err instanceof Error ? err.stack ?? err.message : err);
  void handle.close().finally(() => process.exit(1));
});

console.error('hudu MCP server running over stdio (MCP v2)');
