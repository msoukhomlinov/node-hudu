#!/usr/bin/env node
/**
 * Live coverage sweep: invoke EVERY registry operation against the live tenant where it is safe, and report
 * which ones were really exercised, dry-run verified, or skipped (with the reason).
 *
 * Primitives   : reads are called for real; writes/destructive ops are called with { dryRun: true } only, so
 *                nothing on the tenant is mutated.
 * Helpers      : called with a live identifier taken from the tenant.
 * MCP layer    : every manifest tool is checked against the registry, and its backing operation is counted as
 *                covered when that operation was exercised (a tool is a projection of an operation).
 *
 * Env-gated: HUDU_BASE_URL + HUDU_API_KEY. Never prints the key. Writes nothing except its JSON report.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const BASE_URL = process.env.HUDU_BASE_URL;
const API_KEY = process.env.HUDU_API_KEY;
if (!BASE_URL || !API_KEY) { console.error('live-coverage: HUDU_BASE_URL and HUDU_API_KEY are required.'); process.exit(2); }

const { HuduClient } = await import('../dist/index.js');
const { CAPABILITY_REGISTRY } = await import('../dist/capabilities.js');
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const hudu = new HuduClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 30000 });

const results = [];
const record = (name, kind, status, detail) => results.push({ name, kind, status, detail: String(detail ?? '').slice(0, 150) });
const code = (e) => e?.code ?? e?.name ?? 'Error';

// ---- live inventory: a real id per resource, so reads and dry-runs get valid targets -------------------
const ids = {};
const inventory = {};
for (const rec of Object.values(CAPABILITY_REGISTRY)) {
  const [res, meth] = rec.name.split('.');
  if (meth !== 'list' || rec.kind !== 'primitive') continue;
  const target = hudu[camel(res)];
  if (!target || typeof target.listAll !== 'function') continue;
  try {
    const rows = await target.listAll();
    inventory[res] = Array.isArray(rows) ? rows : [];
    if (inventory[res][0] && typeof inventory[res][0].id === 'number') ids[res] = inventory[res][0].id;
  } catch (e) { inventory[res] = null; ids.__err = ids.__err ?? {}; (ids.__err ??= {})[res] = code(e); }
}
const companyId = ids.companies ?? inventory.companies?.[0]?.id;
// Account-wide asset ids are needed for the company-scoped asset operations.
let assetRef = null;
try {
  const all = await hudu.assets.listAllAcrossCompanies();
  if (Array.isArray(all) && all[0]) assetRef = { id: all[0].id, company_id: all[0].company_id };
} catch { /* none */ }
// Prefer the numeric ID: every helper accepts one, while several (`getContext`, `resolve({id})`) treat a
// bare non-numeric string as an id and read `/resource/<string>`. Passing a record NAME here made the sweep
// report two false failures - the SDK was right to refuse them.
/** The first id-ish required field of a schema, resolved against live data. */
const firstId = (fields) => {
  for (const f of fields ?? []) {
    if (!f.required) continue;
    if (f.name === 'company_id' || f.name === 'companyId') return companyId;
    if (f.name === 'id') return ids[FIELD_ID_RESOURCE] ?? companyId ?? assetRef?.id;
  }
  return undefined;
};
const FIELD_ID_RESOURCE = 'companies';
const identifierFor = (res) => {
  const row = inventory[res]?.[0];
  if (!row) return undefined;
  if (typeof row.id === 'number') return row.id;
  if (row.name) return row.name;
  return undefined;
};

// ---- primitives ---------------------------------------------------------------------------------------
for (const rec of Object.values(CAPABILITY_REGISTRY)) {
  if (rec.kind !== 'primitive') continue;
  const [res, meth] = rec.name.split('.');
  const target = hudu[camel(res)];
  if (!target || typeof target[meth] !== 'function') { record(rec.name, 'primitive', 'MISSING', 'no such method on the client'); continue; }
  const reqFields = (rec.inputSchema?.params?.fields ?? []).filter((f) => f.required).map((f) => f.name);
  const needsCompany = reqFields.includes('companyId') || reqFields.includes('company_id');
  const isScoped = res === 'assets';
  const id = isScoped ? (assetRef?.id ?? ids[res]) : ids[res];
  const parentCompany = isScoped ? (assetRef?.company_id ?? companyId) : companyId;
  const isWrite = rec.effect && rec.effect !== 'read';
  try {
    if (meth === 'list' || meth === 'listAll' || meth === 'listPages') {
      const params = {};
      if (needsCompany && parentCompany !== undefined) params.company_id = parentCompany;
      const out = isScoped ? await target[meth](parentCompany, params) : await target[meth](params);
      let n = 0;
      if (Array.isArray(out)) n = out.length;
      else if (out && typeof out[Symbol.asyncIterator] === 'function') { for await (const _ of out) { n += 1; if (n >= 3) break; } }
      record(rec.name, 'primitive', 'LIVE_OK', `${n} row(s)`);
    } else if (meth === 'get' || meth === 'getContext') {
      if (id === undefined) { record(rec.name, 'primitive', 'SKIP', 'no live row of this resource to read'); continue; }
      await (isScoped ? target[meth](parentCompany, id) : target[meth](id));
      record(rec.name, 'primitive', 'LIVE_OK', `read id ${id}`);
    } else if (isWrite) {
      if (!rec.dryRun) { record(rec.name, 'primitive', 'SKIP', 'mutating with no dry-run affordance - not executed against the tenant'); continue; }
      const opts = { dryRun: true };
      const payload = {};
      for (const f of reqFields) {
        if (f === 'company_id' || f === 'companyId') payload[f] = parentCompany;
        else if (f === 'name') payload[f] = 'ZZ coverage probe (dry-run only)';
        else if (f === 'data') payload[f] = {};
        else if (f === 'datetime') payload[f] = '2000-01-01T00:00:00Z';
      }
      if (meth === 'delete' || meth === 'archive' || meth === 'unarchive') {
        if (id === undefined) { record(rec.name, 'primitive', 'SKIP', 'no live row to target'); continue; }
        await (isScoped ? target[meth](parentCompany, id, opts) : target[meth](id, opts));
      } else if (meth === 'update' || meth === 'moveLayout') {
        if (id === undefined) { record(rec.name, 'primitive', 'SKIP', 'no live row to target'); continue; }
        await (isScoped ? target[meth](parentCompany, id, {}, opts) : target[meth](id, {}, opts));
      } else if (needsCompany && isScoped) {
        await target[meth](parentCompany, payload, opts);
      } else if (rec.inputSchema?.params?.fields?.some((f) => f.name === 'id')) {
        // An action shaped `(id, payload, opts)` - duplicate / kickoff / createFromTemplate / deleteById.
        // Passing the payload first is what made the sweep offer `dryRun` in the payload slot.
        const actionId = firstId(rec.inputSchema.params.fields);
        if (actionId === undefined) { record(rec.name, 'primitive', 'SKIP', 'no live row to target'); continue; }
        await target[meth](actionId, payload, opts);
      } else if (meth === 'upload') {
        record(rec.name, 'primitive', 'SKIP', 'multipart upload: needs a real file part, not exercised here');
        continue;
      } else {
        await target[meth](payload, opts);
      }
      record(rec.name, 'primitive', 'DRY_OK', 'dry-run issued, no write');
    } else {
      record(rec.name, 'primitive', 'SKIP', 'unclassified method shape');
    }
  } catch (e) {
    // A structured refusal is a valid live outcome for a guard, not a coverage hole.
    const benign = ['POLICY_DENIED', 'CONFIG_ERROR', 'RESOLUTION_TRUNCATED', 'RESOLUTION_AMBIGUOUS', 'NOT_FOUND', 'STALE_OBJECT'];
    record(rec.name, 'primitive', benign.includes(code(e)) ? 'LIVE_REFUSED' : 'THREW', `${code(e)}: ${e.message}`);
  }
}

// ---- helpers ------------------------------------------------------------------------------------------
for (const rec of Object.values(CAPABILITY_REGISTRY)) {
  if (rec.kind !== 'helper') continue;
  const [res, meth] = rec.name.split('.');
  const target = res === 'operations' ? hudu.operations : hudu[camel(res)];
  if (!target || typeof target[meth] !== 'function') { record(rec.name, 'helper', 'MISSING', 'no such method'); continue; }
  const ident = res === 'operations' ? (identifierFor('companies') ?? 'test') : identifierFor(res);
  if (ident === undefined) { record(rec.name, 'helper', 'SKIP', 'no live row of this resource to resolve'); continue; }
  try {
    if (res === 'operations') { await target[meth](ident); }
    else {
      try { await target[meth](ident, { limit: 3 }); }
      catch (err) {
        // Not every helper takes `limit` (a helper over a record with no list column refuses it): retry bare.
        if (code(err) === 'CONFIG_ERROR' && /limit/.test(err.message)) await target[meth](ident);
        else throw err;
      }
    }
    record(rec.name, 'helper', 'LIVE_OK', `called with ${JSON.stringify(ident).slice(0, 40)}`);
  } catch (e) {
    const benign = ['POLICY_DENIED', 'CONFIG_ERROR', 'RESOLUTION_TRUNCATED', 'RESOLUTION_AMBIGUOUS'];
    record(rec.name, 'helper', benign.includes(code(e)) ? 'LIVE_REFUSED' : 'THREW', `${code(e)}: ${e.message}`);
  }
}

// ---- MCP layer: every projected tool mapped to the operation behind it --------------------------------
// The tool list comes from `node scripts/project-mcp-tools.mjs --list-tools <path>` (147 tools). The manifest's
// own tool table lists only the curated EXCLUSIONS, so parsing it under-counted the surface to 56.
const toolsPath = flag('--tools', '');
const toolOps = [];
if (toolsPath && existsSync(toolsPath)) {
  for (const t of JSON.parse(readFileSync(toolsPath, 'utf8'))) {
    toolOps.push({ tool: t.name, operation: t.backingOperation });
  }
}
// A tool counts as covered when the operation behind it produced a live outcome (called for real or
// dry-run verified). LIVE_REFUSED is reported separately: the SDK answered, but the operation did not run.
const covered = new Set(results.filter((r) => r.status === 'LIVE_OK' || r.status === 'DRY_OK').map((r) => r.name));
const refusedOps = new Set(results.filter((r) => r.status === 'LIVE_REFUSED').map((r) => r.name));
const mcpRows = toolOps.map((t) => ({
  ...t,
  covered: covered.has(t.operation),
  refused: refusedOps.has(t.operation),
  status: results.find((r) => r.name === t.operation)?.status ?? 'NOT_IN_REGISTRY',
}));
const mcpUncovered = mcpRows.filter((t) => !t.covered);

const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nLIVE COVERAGE SWEEP - ${BASE_URL}`);
console.log('='.repeat(104));
for (const r of results.filter((x) => x.status !== 'LIVE_OK')) console.log(`${pad(r.status, 13)} ${pad(r.name, 38)} ${r.detail}`);
console.log('='.repeat(104));
console.log(`operations: ${results.length}  ` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  '));
console.log(`MCP tools projected: ${toolOps.length}; whose backing operation was exercised live: ${mcpRows.filter((t) => t.covered).length}; refused (SDK answered, operation did not run): ${mcpRows.filter((t) => t.refused).length}; not exercised: ${mcpUncovered.length}`);
if (mcpUncovered.length) console.log(`  not exercised: ${mcpUncovered.slice(0, 12).map((t) => t.tool).join(', ')}${mcpUncovered.length > 12 ? ', ...' : ''}`);
const out = flag('--json', '');
if (out) writeFileSync(out, JSON.stringify({ baseUrl: BASE_URL, counts, results, mcp: { total: toolOps.length, covered: mcpRows.filter((t) => t.covered).length, uncovered: mcpUncovered } }, null, 2));
