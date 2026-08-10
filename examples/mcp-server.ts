/**
 * mcp-server.ts — a Model Context Protocol (MCP) server backed by node-hudu.
 *
 * Exposes two tools backed by this SDK's typed reads:
 *   - hudu_list_companies  -> hudu.companies.listAll()
 *   - hudu_search_articles -> hudu.articles.listAll({ search })
 *
 * Requires:  npm install @modelcontextprotocol/sdk
 *
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=xxx npx tsx examples/mcp-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HuduClient } from 'node-hudu';

const baseUrl = process.env.HUDU_BASE_URL;
const apiKey = process.env.HUDU_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error('HUDU_BASE_URL and HUDU_API_KEY must be set');
}

const hudu = new HuduClient({ baseUrl, apiKey });
const server = new McpServer({ name: 'hudu-mcp', version: '0.1.0' });

// listAll() is the MCP-preferred read: one call, a plain array — exactly what
// an MCP tool output schema wants.
server.registerTool(
  'hudu_list_companies',
  {
    description: 'List companies in Hudu. Use search for a partial name match.',
    inputSchema: {
      search: z.string().optional().describe('Partial company name match'),
    },
  },
  async ({ search }) => {
    const companies = await hudu.companies.listAll({ search, page_size: 100 });
    return {
      content: [{ type: 'text', text: JSON.stringify(companies) }],
    };
  },
);

server.registerTool(
  'hudu_search_articles',
  {
    description: 'Search articles by keyword. Returns plain article data.',
    inputSchema: {
      search: z.string().describe('Keyword to search article content/name'),
    },
  },
  async ({ search }) => {
    const articles = await hudu.articles.listAll({ search });
    return {
      content: [{ type: 'text', text: JSON.stringify(articles) }],
    };
  },
);

// Errors from node-hudu carry a machine-readable `code` MCP tools can surface.
process.on('uncaughtException', (err) => {
  console.error('uncaught', err instanceof Error ? err.message : err);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('hudu MCP server running over stdio');
