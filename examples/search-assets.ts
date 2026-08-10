/**
 * search-assets.ts — server-side full-text search across resources.
 *
 * The Hudu API filters server-side via query params. `search` is a partial,
 * case-insensitive substring match on the resource's searchable fields.
 *
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=xxx npx tsx examples/search-assets.ts "firewall"
 */
import { HuduClient } from 'node-hudu';

const baseUrl = process.env.HUDU_BASE_URL;
const apiKey = process.env.HUDU_API_KEY;
const term = process.argv[2] ?? 'server';

if (!baseUrl || !apiKey) {
  throw new Error('HUDU_BASE_URL and HUDU_API_KEY must be set');
}

const hudu = new HuduClient({ baseUrl, apiKey });

async function main() {
  // Articles support `search` plus other filters (e.g. company_id, draft).
  const articles = await hudu.articles.listAll({ search: term, page_size: 100 });
  console.log(`Articles matching "${term}": ${articles.length}`);
  for (const a of articles.slice(0, 10)) {
    console.log(`  #${a.id} [${a.company_id}] ${a.name}`);
  }

  // Companies support `search` (partial) and `name` (which the API treats as
  // EXACT match — prefer `search` for fuzzy lookups).
  const companies = await hudu.companies.listAll({ search: term });
  console.log(`Companies matching "${term}": ${companies.length}`);

  // Account-wide asset search.
  const accountAssets = await hudu.assets.listAllAcrossCompanies({ search: term });
  console.log(`Account-wide assets matching "${term}": ${accountAssets.length}`);

  // Stream instead of buffering for large result sets with list().
  console.log('Streaming companies (first 5):');
  let shown = 0;
  for await (const company of hudu.companies.list({ search: term })) {
    if (shown++ >= 5) break;
    console.log('  ', company.name);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
