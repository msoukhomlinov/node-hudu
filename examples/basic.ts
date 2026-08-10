/**
 * basic.ts — minimal node-hudu usage.
 *
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=xxx npx tsx examples/basic.ts
 */
import { HuduClient } from 'node-hudu';

const baseUrl = process.env.HUDU_BASE_URL;
const apiKey = process.env.HUDU_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error('HUDU_BASE_URL and HUDU_API_KEY must be set');
}

const hudu = new HuduClient({ baseUrl, apiKey });

async function main() {
  // 1. listAll — the MCP-preferred read: one call, a plain array.
  const companies = await hudu.companies.listAll({ search: 'acme', page_size: 100 });
  console.log(`found ${companies.length} company(ies)`);

  if (companies.length === 0) {
    // 2. create a company when none matched.
    const created = await hudu.companies.create({ name: 'Acme Corp' });
    console.log('created company', created.id, created.name);
    companies.push(created);
  }

  const companyId = companies[0]!.id;

  // 3. get a single record + create an asset inside the company.
  const company = await hudu.companies.get(companyId);
  console.log('company:', company.name, '| slug:', company.slug);

  // Look up an asset layout to target, then create an asset.
  const layouts = await hudu.assetLayouts.listAll();
  const layoutId = layouts[0]?.id;
  if (layoutId) {
    const asset = await hudu.assets.create(companyId, {
      name: 'Workstation-001',
      asset_layout_id: layoutId,
    });
    console.log('created asset', asset.id, asset.name);
  }

  // 4. search across all companies (account-wide) and stream via list().
  const accountWide = await hudu.assets.listAllAcrossCompanies({ search: 'workstation' });
  console.log(`account-wide matches: ${accountWide.length}`);

  // 5. API info.
  const info = await hudu.apiInfo.get();
  console.log(`Hudu API info: version=${info.version} date=${info.date}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
