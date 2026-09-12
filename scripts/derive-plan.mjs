#!/usr/bin/env node
/**
 * scripts/derive-plan.mjs — derive capabilities.plan.json from api-docs.json + the source tree.
 *
 * DERIVABLE COLUMNS ONLY. Judgement columns (helper, helperBasis, helperRationale, flags,
 * metadata.preferredWhen/related, compact, resolution, staleCheck, redaction) are owned by the
 * Architect/coordinator and are PRESERVED verbatim on every re-run.
 *
 * Idempotent: re-running with unchanged inputs produces byte-identical output (generatedAt is
 * only advanced when the derived content actually changes), and never wipes a judgement column.
 *
 * Usage:
 *   node scripts/derive-plan.mjs                    # whole plan
 *   node scripts/derive-plan.mjs --resource companies --resource assets
 *                                                   # rewrite only those resources' rows,
 *                                                   # all other rows copied through verbatim
 *
 * Policy: ~/.prime/agent/skills/api-node-squad/references/agent-execution-layer.md §4 / §4.2
 * (plan shape is normative there). Column semantics: plan §4 table; encoding rules: plan §4
 * "Encoding rules" table — every key is present on every row, a missing key is a defect.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(ROOT, 'api-docs.json');
const PLAN_PATH = join(ROOT, 'capabilities.plan.json');
const RES_DIR = join(ROOT, 'src', 'resources');

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

/* ------------------------------------------------------------------ *
 * 1. Endpoint -> owning SDK resource + primitive + specialOp.
 *    The generic rule covers the uniform CRUD shapes; the table below
 *    lists every endpoint whose SDK method name is NOT uniform.
 * ------------------------------------------------------------------ */
const OVERRIDES = {
  'GET /activity_logs':                        ['activity_logs', 'list', null],
  'DELETE /activity_logs':                     ['activity_logs', 'deleteAll', 'delete-all'],
  'GET /api_info':                             ['api_info', 'get', null],
  'GET /assets':                               ['assets', 'listAcrossCompanies', null],
  'GET /cards/jump':                           ['cards', 'jump', 'jump'],
  'GET /cards/lookup':                         ['cards', 'lookup', 'lookup'],
  'GET /companies/{company_id}/assets':        ['assets', 'list', null],
  'GET /companies/{company_id}/assets/{id}':    ['assets', 'get', null],
  'POST /companies/{company_id}/assets':       ['assets', 'create', null],
  'PUT /companies/{company_id}/assets/{id}':    ['assets', 'update', null],
  'DELETE /companies/{company_id}/assets/{id}': ['assets', 'delete', null],
  'PUT /companies/{company_id}/assets/{id}/archive':   ['assets', 'archive', 'archive'],
  'PUT /companies/{company_id}/assets/{id}/unarchive': ['assets', 'unarchive', 'unarchive'],
  'PUT /companies/{company_id}/assets/{id}/move_layout': ['assets', 'moveLayout', 'move-layout'],
  'GET /companies/jump':                       ['companies', 'jump', 'jump'],
  'DELETE /magic_dash':                        ['magic_dash', 'delete', 'delete-by-title'],
  'DELETE /magic_dash/{id}':                   ['magic_dash', 'deleteById', null],
  'PUT /magic_dash/update_positions':          ['magic_dash', 'updatePositions', 'update-positions'],
  'POST /procedures/{id}/duplicate':           ['procedures', 'duplicate', 'duplicate'],
  'POST /procedures/{id}/create_from_template': ['procedures', 'createFromTemplate', 'create-from-template'],
  'POST /procedures/{id}/kickoff':             ['procedures', 'kickoff', 'kickoff'],
  'POST /uploads':                             ['uploads', 'upload', 'upload'],
  'POST /s3_exports':                          ['s3_exports', 'create', null],
};

function genericMethod(method, path) {
  const segs = path.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  const hasId = segs.some((s) => s.startsWith('{'));
  if (last === 'archive') return ['archive', 'archive'];
  if (last === 'unarchive') return ['unarchive', 'unarchive'];
  if (method === 'GET') return hasId ? ['get', null] : ['list', null];
  if (method === 'POST') return ['create', null];
  if (method === 'PUT') return ['update', null];
  if (method === 'DELETE') return ['delete', null];
  throw new Error(`no generic rule for ${method} ${path}`);
}

/* ------------------------------------------------------------------ *
 * 2. Resource groups (A-D) and the workflow resources.
 * ------------------------------------------------------------------ */
const GROUPS = {
  A: ['companies', 'articles', 'assets', 'asset_layouts', 'asset_passwords', 'websites', 'folders', 'password_folders', 'groups'],
  B: ['networks', 'vlans', 'vlan_zones', 'ip_addresses', 'rack_storages', 'rack_storage_items', 'relations', 'flags', 'flag_types'],
  C: ['procedures', 'procedure_tasks', 'cards', 'activity_logs', 'expirations', 'matchers', 'magic_dash', 'api_info'],
  D: ['uploads', 'photos', 'public_photos', 'exports', 's3_exports', 'lists', 'label_types', 'labels', 'users'],
};
const GROUP_OF = {};
const RES_ORDER = [];
for (const [g, list] of Object.entries(GROUPS)) for (const r of list) { GROUP_OF[r] = g; RES_ORDER.push(r); }

/** Endpoints the vendor does NOT paginate — must never receive page/page_size (handover §2). */
const NON_PAGINATED = ['/ip_addresses', '/lists', '/networks', '/procedure_tasks', '/rack_storage_items', '/rack_storages', '/vlan_zones', '/vlans', '/exports'];

/* ------------------------------------------------------------------ *
 * 3. Errors: the SCREAMING_SNAKE codes the SDK actually throws for a
 *    documented HTTP status. Mirrors src/errors.ts (errorFromStatus).
 * ------------------------------------------------------------------ */
const STATUS_CODES = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED', 406: 'NOT_ACCEPTABLE', 409: 'CONFLICT', 412: 'STALE_OBJECT',
  422: 'UNPROCESSABLE_ENTITY', 429: 'RATE_LIMIT',
};
function errorsFor(op) {
  const out = new Set(['NETWORK_ERROR']);
  for (const st of Object.keys(op.responses || {})) {
    const n = Number(st);
    if (Number.isNaN(n)) continue;
    if (STATUS_CODES[n]) out.add(STATUS_CODES[n]);
    else if (n >= 500) out.add('SERVER_ERROR');
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------ *
 * 4. Tests skeleton — the normative rows of agent-execution-layer.md §11,
 *    expressed as {id, file, title} so the Tests stage can assert them by
 *    exact title. Preserved verbatim once non-empty (see preserve()).
 * ------------------------------------------------------------------ */
function testsSkeleton(resource, primitive, shape, file) {
  const t = (c, title) => ({ id: `${primitive}.${c}`, file, title });
  const out = [];
  if (shape === 'list') {
    if (NON_PAGINATED.some((p) => primitive === `${resource}.list` && p === `/${resource}`)) {
      out.push(t('success', `returns the unwrapped ${resource} list`));
      out.push(t('non-paginated', 'never sends page/page_size to the non-paginated endpoint'));
    } else {
      out.push(t('success', `returns the unwrapped ${resource} list`));
      out.push(t('pagination', 'sends page/page_size and stops on a short page'));
    }
  } else if (shape === 'get') {
    out.push(t('success', `returns the unwrapped ${resource} record`));
    out.push(t('not-found', 'normalises a 404 into NOT_FOUND'));
  } else if (shape === 'create') {
    out.push(t('success', `returns the created ${resource} record`));
    out.push(t('dry-run', 'dry-run issues no mutating request and returns simulated: true'));
  } else if (shape === 'update') {
    out.push(t('success', `returns the updated ${resource} record`));
    out.push(t('dry-run', 'dry-run issues no PUT request and returns simulated: true'));
    out.push(t('unwraps-by-singleKey', 'unwraps the PUT response by singleKey'));
  } else if (shape === 'delete') {
    out.push(t('success', 'resolves void after a successful delete'));
    out.push(t('dry-run', 'dry-run issues no DELETE request and returns simulated: true'));
  } else if (shape === 'write-special') {
    out.push(t('success', `calls the ${primitive} endpoint and normalises the result`));
    out.push(t('dry-run', 'dry-run issues no mutating request and returns simulated: true'));
  } else {
    out.push(t('success', `calls the ${primitive} endpoint and returns the documented shape`));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. Existing primitives in the source tree -> status "implemented".
 * ------------------------------------------------------------------ */
function sourceMethods(resource) {
  const p = join(RES_DIR, `${resource}.ts`);
  if (!existsSync(p)) return new Set();
  const src = readFileSync(p, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/gm)) out.add(m[1]);
  return out;
}
const METHODS = {};
for (const r of RES_ORDER) METHODS[r] = sourceMethods(r);

/* ------------------------------------------------------------------ *
 * 6. Derive rows.
 * ------------------------------------------------------------------ */
const SPEC_VERSION = '2.45.1';
const derived = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [rawMethod, op] of Object.entries(item)) {
    const method = rawMethod.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) continue;
    const key = `${method} ${path}`;
    let resource, primitive, specialOp;
    if (OVERRIDES[key]) [resource, primitive, specialOp] = OVERRIDES[key];
    else {
      resource = path.split('/').filter(Boolean)[0];
      const [m, sp] = genericMethod(method, path);
      primitive = m; specialOp = sp;
    }
    const params = (op.parameters || []).filter((p) => p.in === 'query');
    const names = params.map((p) => p.name);
    const vendorFilters = names.filter((n) => !['page', 'page_size', 'download'].includes(n)).sort();
    const search = names.includes('search') ? 'search' : null;
    const effect = method === 'GET' ? 'read' : method === 'DELETE' ? 'destructive' : 'write';
    const shape = specialOp === 'jump' || specialOp === 'lookup' ? 'read-special'
      : specialOp !== null ? (method === 'GET' ? 'read-special' : 'write-special')
        : primitive;
    const file = `test/resources/${resource}.test.ts`;
    const purpose = (op.summary || op.description || `${method} ${path}`).split('\n')[0].trim().replace(/\.$/, '') + '.';
    derived.push({
      endpoint: key,
      primitive: `${resource}.${primitive}`,
      specialOp,
      vendorFilters,
      search,
      helper: null,
      helperBasis: null,
      helperRationale: null,
      effect,
      flags: [],
      dryRun: effect !== 'read',
      metadata: {
        purpose,
        usage: method === 'GET'
          ? `Read path for ${resource}. Primitives return the full typed record.`
          : `Mutating path for ${resource}; supports { dryRun: true }, which validates without issuing the write.`,
        preferredWhen: null,
        related: [],
      },
      compact: null,
      resolution: null,
      staleCheck: null,
      redaction: 'none',
      errors: errorsFor(op),
      tests: testsSkeleton(resource, `${resource}.${primitive}`, shape, file),
      group: GROUP_OF[resource] ?? null,
      status: METHODS[resource].has(primitive) ? 'implemented' : 'planned',
      _resource: resource,
      _method: primitive,
      _path: path,
      _verb: method,
      _nonPaginated: NON_PAGINATED.includes(path),
    });
  }
}

derived.sort((a, b) => {
  const g = String(a.group).localeCompare(String(b.group));
  if (g !== 0) return g;
  const r = RES_ORDER.indexOf(a._resource) - RES_ORDER.indexOf(b._resource);
  if (r !== 0) return r;
  return a.endpoint.localeCompare(b.endpoint);
});

/* ------------------------------------------------------------------ *
 * 7. Preserve: never wipe a judgement column, never downgrade a status,
 *    never regenerate test rows the Tests stage has refined.
 * ------------------------------------------------------------------ */
const STATUS_RANK = { planned: 0, implemented: 1, tested: 2 };
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const JUDGEMENT = ['helper', 'helperBasis', 'helperRationale', 'flags', 'compact', 'resolution', 'staleCheck', 'redaction'];

function preserve(row) {
  const before = row._before;
  delete row._before;
  for (const k of ['_resource', '_method', '_path', '_verb', '_nonPaginated']) delete row[k];
  if (!before) return row;
  for (const k of JUDGEMENT) if (!isEmpty(before[k])) row[k] = before[k];
  if (before.metadata && typeof before.metadata === 'object') {
    const m = before.metadata;
    row.metadata = {
      purpose: isEmpty(m.purpose) ? row.metadata.purpose : m.purpose,
      usage: isEmpty(m.usage) ? row.metadata.usage : m.usage,
      preferredWhen: m.preferredWhen ?? null,
      related: Array.isArray(m.related) ? m.related : [],
    };
  }
  if (Array.isArray(before.tests) && before.tests.length > 0) row.tests = before.tests;
  if ((STATUS_RANK[before.status] ?? 0) > (STATUS_RANK[row.status] ?? 0)) row.status = before.status;
  return row;
}

/* ------------------------------------------------------------------ *
 * 8. Main
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const only = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--resource') only.push(args[++i]);

let prior = null;
if (existsSync(PLAN_PATH)) prior = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const priorByEndpoint = new Map((prior?.operations ?? []).map((r) => [r.endpoint, r]));

const selected = derived.filter((r) => only.length === 0 || only.includes(r._resource));
for (const r of selected) r._before = priorByEndpoint.get(r.endpoint);
const preservedCount = selected.filter((r) => r._before).length;
const rows = selected.map(preserve);

/** Helper rows (endpoint: null) are AUTHORED by the coordinator, never derived: keep them. */
const priorHelpers = (prior?.operations ?? []).filter((r) => r.endpoint === null || r.endpoint === undefined);
const sortRows = (list) => list.sort((a, b) => {
  const g = String(a.group).localeCompare(String(b.group));
  if (g !== 0) return g;
  const ra = RES_ORDER.indexOf(((a.primitive ?? a.helper) ?? '').split('.')[0]);
  const rb = RES_ORDER.indexOf(((b.primitive ?? b.helper) ?? '').split('.')[0]);
  if (ra !== rb) return ra - rb;
  const ha = a.helper ? 1 : 0, hb = b.helper ? 1 : 0;
  if (ha !== hb) return ha - hb;
  return String(a.endpoint ?? '').localeCompare(String(b.endpoint ?? ''));
});

let operations;
if (only.length === 0) operations = [...rows, ...priorHelpers];
else {
  const rewritten = new Map(rows.map((r) => [r.endpoint, r]));
  operations = (prior?.operations ?? []).map((r) => rewritten.get(r.endpoint) ?? r);
  for (const r of rows) if (!operations.some((o) => o.endpoint === r.endpoint)) operations.push(r);
}
operations = sortRows(operations);

const resources = {};
for (const r of RES_ORDER) {
  const prev = prior?.resources?.[r];
  resources[r] = {
    helperCap: prev?.helperCap ?? 4,
    compact: prev?.compact ?? null,
    workflowResource: prev?.workflowResource ?? false,
    group: GROUP_OF[r],
  };
}

const head = { spec: { source: 'api-docs.json', version: SPEC_VERSION }, generatedAt: null, resources, operations };
const contentHash = createHash('sha256').update(JSON.stringify(head)).digest('hex');
const priorHash = prior
  ? createHash('sha256').update(JSON.stringify({ ...head, generatedAt: prior.generatedAt })).digest('hex')
  : null;
// Keep generatedAt stable when nothing else changed: a re-run must be a no-op in git.
head.generatedAt = contentHash === priorHash && prior?.generatedAt ? prior.generatedAt : new Date().toISOString();
const out = `${JSON.stringify(head, null, 2)}\n`;
writeFileSync(PLAN_PATH, out);

/* ------------------------------------------------------------------ *
 * 9. Report
 * ------------------------------------------------------------------ */
const notFound = derived.filter((r) => r.status !== 'implemented');
const perGroup = {};
for (const r of derived) perGroup[r.group] = (perGroup[r.group] ?? 0) + 1;
const preserved = preservedCount;
console.log(`plan:derive -> capabilities.plan.json`);
console.log(`  spec                 : ${SPEC_PATH} (swagger ${spec.swagger}, ${Object.keys(spec.paths).length} paths)`);
console.log(`  operations           : ${operations.length} rows (${derived.length} derived from the spec, ${operations.filter((r) => r.helper).length} authored helper rows preserved)`);
console.log(`  per group           : ${Object.entries(perGroup).map(([g, n]) => `${g}=${n}`).join(' ')}`);
console.log(`  resources           : ${RES_ORDER.length}`);
console.log(`  status implemented  : ${derived.length - notFound.length}`);
console.log(`  status planned      : ${notFound.length}${notFound.length ? ' -> ' + notFound.map((r) => r.primitive).join(', ') : ''}`);
console.log(`  rows re-derived     : ${selected.length} (judgement columns preserved on ${preserved})`);
console.log(`  plan bytes          : ${Buffer.byteLength(out)}  sha256 ${createHash('sha256').update(out).digest('hex').slice(0, 16)}`);
const dupes = derived.map((r) => r.primitive).filter((p, i, a) => a.indexOf(p) !== i);
if (dupes.length) console.log(`  WARNING duplicate primitives: ${[...new Set(dupes)].join(', ')}`);
const grouped = derived.filter((r) => !r.group);
if (grouped.length) console.log(`  WARNING rows with no group: ${grouped.map((r) => r.endpoint).join(', ')}`);
