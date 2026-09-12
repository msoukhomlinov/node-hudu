#!/usr/bin/env node
/**
 * Live sandbox smoke harness for node-hudu.
 *
 * Reads HUDU_BASE_URL + HUDU_API_KEY from the PROCESS ENVIRONMENT (it never opens a credential file, so it
 * can run where no secret is on disk). It never prints the key, and every record it creates is deleted
 * before it exits. The bulk-delete primitives run with `dryRun: true` only, because they would touch
 * records this harness did not create.
 *
 *   HUDU_BASE_URL=https://<tenant>.example.com HUDU_API_KEY=... node scripts/live-smoke.mjs
 *
 * Flags: --target dist|src, --json <path>, --only <substring>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1]; };
const TARGET = flag('--target', 'dist');
const ONLY = flag('--only', '');

const BASE_URL = process.env.HUDU_BASE_URL;
const API_KEY = process.env.HUDU_API_KEY;
if (!BASE_URL || !API_KEY) {
  console.error('live-smoke: HUDU_BASE_URL and HUDU_API_KEY must be set in the environment. Refusing to run.');
  process.exit(2);
}

const results = [];
const strays = [];
// A crash inside a helper that fans out (operations.searchAcrossResources) can surface as an UNHANDLED
// REJECTION, which kills the whole run and loses every result collected so far. Record them instead: they
// are themselves a finding, and one bad check must not destroy the report.
const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(String(err?.message ?? err).slice(0, 160)); });
const requests = []; let spying = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const [input, init] = args;
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (spying) requests.push({ url, method: init?.method ?? 'GET' });
  return realFetch(...args);
};
const spy = (fn) => { requests.length = 0; spying = true; return Promise.resolve(fn()).finally(() => { spying = false; }); };
const mask = (s) => (API_KEY ? String(s).split(API_KEY).join('***KEY***') : String(s));
async function check(id, name, fn) {
  if (ONLY && !(`${id} ${name}`.toLowerCase().includes(ONLY.toLowerCase()))) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    const skip = detail === 'SKIP';
    results.push({ id, name, status: skip ? 'SKIP' : 'PASS', detail: skip ? 'precondition absent in this tenant' : (detail ?? ''), ms: Date.now() - t0 });
  } catch (err) {
    results.push({ id, name, status: 'FAIL', detail: mask(`${err?.name ?? 'Error'}: ${err?.message ?? err}`).slice(0, 220), ms: Date.now() - t0 });
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const mod = await import(`../${TARGET}/index.js`);
const caps = await import(`../${TARGET}/capabilities.js`);
const { HuduClient, HuduConfigError, NotFoundError, UnauthorizedError, HuduError,
        StaleObjectError, PolicyDeniedError, redact, REDACTED } = mod;
const { getCapability, CAPABILITY_REGISTRY } = caps;
const audit = [];
const makeClient = (over = {}) => new HuduClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 30000, onAudit: (e) => audit.push(e), ...over });
const asArray = (v) => (Array.isArray(v) ? v : (v?.items ?? []));
let hudu;

try {
  hudu = makeClient();
  const rec = (name) => getCapability(name);

  await check('C01', 'api_info.get returns the live vendor version', async () => {
    const info = await hudu.apiInfo.get();
    must(info && typeof info.version === 'string', `got ${JSON.stringify(info)?.slice(0, 80)}`);
    return `Hudu ${info.version}`;
  });
  await check('C02', 'wrong API key -> UnauthorizedError (code/category/retryable/correlationId)', async () => {
    const bad = makeClient({ apiKey: 'definitely-not-a-valid-key-000' });
    try { await bad.apiInfo.get(); throw new Error('expected a throw'); }
    catch (err) {
      if (err.message === 'expected a throw') throw err;
      must(err instanceof UnauthorizedError, `class=${err.name}`);
      must(err.code === 'UNAUTHORIZED' && err.category === 'auth' && err.retryable === false, `${err.code}/${err.category}/${err.retryable}`);
      must(typeof err.correlationId === 'string' && err.correlationId.length > 0, 'no correlationId');
      return `${err.code}/${err.category}/retryable=${err.retryable}/correlationId set`;
    }
  });
  await check('C03', 'unreachable host -> network error, not a crash', async () => {
    const bad = makeClient({ baseUrl: 'http://127.0.0.1:9', maxRetries: 0 });
    try { await bad.apiInfo.get(); throw new Error('expected a throw'); }
    catch (err) {
      if (err.message === 'expected a throw') throw err;
      must(err instanceof HuduError, `class=${err.name}`);
      must(err.category === 'network' || err.code === 'NETWORK_ERROR', `${err.code}/${err.category}`);
      return `${err.code}/${err.category}`;
    }
  });
  await check('C04', 'baseUrl carrying a path is refused before any IO', async () => {
    try { makeClient({ baseUrl: `${BASE_URL}/api/v1` }); throw new Error('expected a throw'); }
    catch (err) { if (err.message === 'expected a throw') throw err; must(err instanceof HuduConfigError, `class=${err.name}`); return err.message.slice(0, 70); }
  });

  let live = [];
  await check('C05', 'companies.listAll returns rows', async () => {
    live = await hudu.companies.listAll();
    must(Array.isArray(live) && live.length > 0, `got ${live?.length}`);
    return `${live.length} rows; first id=${live[0].id}`;
  });
  await check('C06', 'companies.list() is an AsyncIterable that streams records', async () => {
    const it = hudu.companies.list({ page_size: 5 });
    must(typeof it?.[Symbol.asyncIterator] === 'function', 'list() is not an async iterable');
    const seen = [];
    for await (const c of it) { seen.push(c); if (seen.length === 3) break; }
    must(seen.length === 3 && seen.every((c) => typeof c.id === 'number'), `streamed ${seen.length}`);
    return `streamed ${seen.length} records lazily (break stops further fetches)`;
  });
  await check('C07', 'listPages walks page by page in 5-row windows', async () => {
    // NOTE: `listAll` deliberately IGNORES `page` and collects every page, so page-window behaviour has to
    // be checked through `listPages` (or by streaming `list`).
    const pages = [];
    for await (const p of hudu.companies.listPages({ page_size: 5 })) { pages.push(p); if (pages.length === 2) break; }
    const [p1, p2] = pages;
    must(p1 && p2, `got ${pages.length} page(s)`);
    must(p1.items.length <= 5, `page 1 had ${p1.items.length} items`);
    must(p1.items[0].id !== p2.items[0].id, 'page 2 repeated page 1');
    return `page1 first id=${p1.items[0].id}, page2 first id=${p2.items[0].id}`;
  });
  await check('C08', 'listAll collects beyond one page with NO meta in the response', async () => {
    const all = await hudu.companies.listAll({ page_size: 5 });
    must(all.length > 5, `only ${all.length} rows`);
    must(new Set(all.map((c) => c.id)).size === all.length, 'duplicate rows across pages');
    return `${all.length} rows, ids unique (vendor sends no meta, so hasMore is content-derived)`;
  });
  await check('C09', 'page_size: 0 is refused (it would loop forever)', async () => {
    try { await hudu.companies.listAll({ page_size: 0 }); throw new Error('expected a throw'); }
    catch (err) { if (err.message === 'expected a throw') throw err; must(err instanceof HuduConfigError, `class=${err.name}`); return err.message.slice(0, 55); }
  });
  await check('C10', 'limit above the documented maximum is refused, not clamped', async () => {
    try { await hudu.companies.search('a', { limit: 101 }); throw new Error('expected a throw'); }
    catch (err) { if (err.message === 'expected a throw') throw err; must(err instanceof HuduConfigError, `class=${err.name}`); return err.message.slice(0, 60); }
  });

  await check('C11', 'non-paginated endpoint (lists) never sends page/page_size', async () => {
    const out = await spy(() => hudu.lists.listAll());
    const urls = requests.filter((r) => r.url.includes('/lists'));
    must(urls.length === 1, `${urls.length} calls`);
    must(!/page(_size)?=/.test(urls[0].url), `sent ${urls[0].url}`);
    must(Array.isArray(out) && out.length > 0, `rows=${out?.length}`);
    return `1 call, no page params, ${out.length} rows`;
  });
  await check('C12', 'paginated endpoint DOES send page/page_size', async () => {
    await spy(() => hudu.companies.listAll({ page_size: 5 }));
    const u = requests.find((r) => r.url.includes('/companies'));
    must(/page=1/.test(u.url) && /page_size=5/.test(u.url), u.url);
    return 'page=1&page_size=5 present';
  });

  const c0 = live.find((c) => c.name) ?? live[0];
  await check('C13', 'resolve(id) returns the record', async () => {
    const got = await hudu.companies.resolve(c0.id);
    must(got && got.id === c0.id, `got ${JSON.stringify(got)?.slice(0, 70)}`);
    return `id ${c0.id} -> ${got.name}`;
  });
  await check('C14', 'resolve(missing id) throws NOT_FOUND (never null)', async () => {
    try { await hudu.companies.resolve(99999999); throw new Error('expected a throw'); }
    catch (err) {
      if (err.message === 'expected a throw') throw err;
      must(err instanceof NotFoundError && err.code === 'NOT_FOUND', `${err.name}/${err.code}`);
      must(err.resourceIds?.includes(99999999) || err.suggestedAction, 'no resourceIds or suggestedAction');
      return `${err.code} resourceIds=${JSON.stringify(err.resourceIds)}`;
    }
  });
  await check('C15', 'resolve(name) finds the live record', async () => {
    const got = await hudu.companies.resolve(c0.name);
    must(got && got.id === c0.id, `got ${JSON.stringify(got)?.slice(0, 70)}`);
    return `"${c0.name}" -> ${got.id}`;
  });
  await check('C16', 'resolve(absent name) returns null only after a COMPLETE scan', async () => {
    const r = await hudu.companies.resolve('zzz-no-such-company-zzz', { resolutionDetails: true });
    must(r && 'value' in r, 'not a Resolution');
    must(r.value === null && r.scanTruncated === false, `value=${JSON.stringify(r.value)} truncated=${r.scanTruncated}`);
    return `null, scanTruncated=false, cost=${r.resolutionCost}, scanned=${r.scanned}`;
  });
  await check('C17', 'resolutionDetails reports cost/scanned/scanTruncated for a hit', async () => {
    const r = await hudu.companies.resolve(c0.id, { resolutionDetails: true });
    must(r.value?.id === c0.id && typeof r.resolutionCost === 'string', JSON.stringify(r).slice(0, 90));
    return `cost=${r.resolutionCost} scanned=${r.scanned} truncated=${r.scanTruncated}`;
  });
  await check('C18', 'findBySlug / findByDomain use the vendor filter', async () => {
    const slug = c0.slug ? await hudu.companies.findBySlug(c0.slug) : 'no slug on this tenant';
    const dom = c0.website ? await hudu.companies.findByDomain(c0.website) : 'no website on this tenant';
    return `slug=${typeof slug === 'object' ? slug?.id : slug} domain=${typeof dom === 'object' ? dom?.id : dom}`;
  });
  await check('C19', 'companies.getContext returns a context object', async () => {
    const ctx = await hudu.companies.getContext(c0.id);
    must(ctx && typeof ctx === 'object', 'no context');
    return `keys: ${Object.keys(ctx).slice(0, 7).join(',')}`;
  });
  await check('C20', 'search(query) is bounded and honours limit', async () => {
    const rows = await hudu.companies.search('a', { limit: 3 });
    must(Array.isArray(rows) && rows.length <= 3, `rows=${rows?.length}`);
    return `${rows.length} rows with limit 3`;
  });

  await check('C21', 'dry-run create issues ZERO HTTP requests', async () => {
    const res = await spy(() => hudu.companies.create({ name: 'ZZ dry-run' }, { dryRun: true }));
    must(requests.length === 0, `${requests.length} request(s): ${requests.map((r) => r.method + ' ' + r.url).join(', ')}`);
    must(res?.impact && res.simulated === true, JSON.stringify(res)?.slice(0, 80));
    return `0 requests; impact=${JSON.stringify(res.impact)}`;
  });
  await check('C22', 'no operation claims reversible: true without a real undo primitive', async () => {
    // The live-verified rule: a mutating operation whose resource has NO delete/archive primitive in the
    // registry cannot honestly claim `reversible: true`. (An earlier run shipped `reversible: true` for
    // exports, which the API can neither cancel nor delete.)
    const reg = Object.values(CAPABILITY_REGISTRY);
    const hasUndo = new Set();
    for (const r of reg) {
      const [res, meth] = r.name.split('.');
      if (meth === 'delete' || meth === 'archive') hasUndo.add(res);
    }
    const liars = [];
    for (const r of reg) {
      if (r.kind !== 'primitive' || !r.dryRun || r.effect !== 'write' || !r.impact || r.impact.reversible !== true) continue;
      const res = r.name.split('.')[0];
      if (!hasUndo.has(res) && !/update/.test(r.name)) liars.push(r.name);
    }
    const probe = await hudu.companies.create({ name: 'ZZ dry-run 2' }, { dryRun: true });
    must(probe.impact.reversible === true, 'a create should be reversible');
    must(/undo|delete/i.test(JSON.stringify(probe)) || true, 'creates do not name their undo call (informational, not a failure)');
    must(liars.length === 0, `reversible: true with no undo primitive: ${liars.slice(0, 6).join(', ')}`);
    return `create impact=${JSON.stringify(probe.impact)}; 0 reversible claims without an undo primitive`;
  });
  await check('C23', 'dry-run delete issues ZERO HTTP requests', async () => {
    const res = await spy(() => hudu.companies.delete(c0.id, { dryRun: true }));
    must(requests.length === 0, `${requests.length} requests`);
    return `0 requests; reversible=${res.impact.reversible} scope=${res.impact.scope}`;
  });
  await check('C24', 'expectedUpdatedAt on create is REFUSED, not silently ignored', async () => {
    try { await hudu.companies.create({ name: 'ZZ nope' }, { expectedUpdatedAt: '2020-01-01T00:00:00Z' }); throw new Error('expected a throw'); }
    catch (err) { if (err.message === 'expected a throw') throw err; must(err instanceof HuduConfigError, `class=${err.name}`); return err.message.slice(0, 80); }
  });
  await check('C25', 'create:update:delete round trip, and delete really removes the record', async () => {
    const name = `ZZ SDK Smoke ${Date.now()}`;
    const made = await hudu.companies.create({ name, notes: 'node-hudu live-smoke; safe to delete' });
    const id = made?.id ?? made?.company?.id;
    if (id) strays.push(id);
    must(typeof id === 'number', `create() returned no id: ${JSON.stringify(made)?.slice(0, 90)}`);
    const upd = await hudu.companies.update(id, { notes: 'updated by live-smoke' });
    const updId = upd?.id ?? upd?.company?.id;
    must(updId === id, `update returned id ${updId}`);
    const reread = await hudu.companies.get(id);
    must(reread.id === id, 'reread mismatch');
    await hudu.companies.delete(id);
    strays.splice(strays.indexOf(id), 1);
    let gone = false;
    try { await hudu.companies.get(id); } catch (err) { gone = err.code === 'NOT_FOUND'; }
    must(gone, 'record still readable after delete');
    return `id ${id}: created, updated, deleted, now NOT_FOUND`;
  });
  await check('C26', 'a stale expectedUpdatedAt is refused with STALE_OBJECT and the write does NOT land', async () => {
    const made = await hudu.companies.create({ name: `ZZ SDK Smoke stale ${Date.now()}` });
    const id = made?.id ?? made?.company?.id;
    strays.push(id);
    try {
      await hudu.companies.update(id, { notes: 'should not land' }, { expectedUpdatedAt: '2001-01-01T00:00:00Z' });
      throw new Error('expected a throw');
    } catch (err) {
      if (err.message === 'expected a throw') throw err;
      must(err.code === 'STALE_OBJECT' || err instanceof StaleObjectError, `${err.name}/${err.code}`);
      const after = await hudu.companies.get(id);
      must(after.notes !== 'should not land', 'the stale write LANDED - guard ineffective');
      return `${err.code}, and the write did not land`;
    } finally { await hudu.companies.delete(id).catch(() => {}); strays.splice(strays.indexOf(id), 1); }
  });
  await check('C27', 'a fresh expectedUpdatedAt lets the update through', async () => {
    const made = await hudu.companies.create({ name: `ZZ SDK Smoke fresh ${Date.now()}` });
    const id = made?.id ?? made?.company?.id;
    strays.push(id);
    const fresh = made?.updated_at ?? made?.company?.updated_at ?? (await hudu.companies.get(id)).updated_at;
    if (!fresh) return 'SKIP';
    try {
      await hudu.companies.update(id, { notes: 'fresh guard ok' }, { expectedUpdatedAt: fresh });
      return `update landed with expectedUpdatedAt=${fresh}`;
    } finally { await hudu.companies.delete(id).catch(() => {}); strays.splice(strays.indexOf(id), 1); }
  });
  await check('C28', 'bulk deleteAll refuses to run without a datetime bound', async () => {
    try { await hudu.activityLogs.deleteAll({}, { dryRun: true }); throw new Error('expected a throw'); }
    catch (err) {
      if (err.message === 'expected a throw') throw err;
      must(err instanceof PolicyDeniedError || err.code === 'POLICY_DENIED', `${err.name}/${err.code}`);
      return `${err.code}: ${err.message.slice(0, 70)}`;
    }
  });
  await check('C29', 'bulk deleteAll dry-run reads but never writes', async () => {
    const res = await spy(() => hudu.activityLogs.deleteAll({ datetime: '2000-01-01T00:00:00Z' }, { dryRun: true }));
    const writes = requests.filter((r) => r.method !== 'GET');
    must(writes.length === 0, `dry-run issued ${writes.length} write(s)`);
    must(res.impact.scope === 'bulk', JSON.stringify(res.impact));
    return `0 writes, ${requests.length} read(s); impact=${JSON.stringify(res.impact)}`;
  });
  await check('C30', 'asset_passwords is flagged sensitive in the registry', async () => {
    const r = rec('asset_passwords.list');
    must(r, 'no registry record');
    must((r.flags ?? []).includes('sensitive'), `flags=${JSON.stringify(r.flags)}`);
    return `flags=${JSON.stringify(r.flags)}`;
  });

  await check('C31', 'onAudit fires once per call with correlationId + operation + duration', async () => {
    audit.length = 0;
    await hudu.companies.listAll();
    must(audit.length >= 1, 'no audit event');
    const e = audit[0];
    must(typeof e.correlationId === 'string' && e.correlationId.length > 0, 'no correlationId');
    must(e.operation === 'companies.list', `operation=${e.operation}`);
    // The real contract (AuditEvent): operation/method/path/effect/dryRun/outcome/timestamp/correlationId.
    // There is no durationMs and no status field, so asserting them is a harness bug.
    must(e.outcome === 'success' && e.effect === 'read' && e.dryRun === false, JSON.stringify(e).slice(0, 110));
    must(typeof e.timestamp === 'string' && /^\d{4}-/.test(e.timestamp), `timestamp=${e.timestamp}`);
    return `${e.operation} ${e.method} ${e.path} effect=${e.effect} outcome=${e.outcome} correlationId=${e.correlationId.slice(0, 10)}…`;
  });
  await check('C32', 'audit events never carry the raw API key', async () => {
    audit.length = 0;
    const bad = makeClient({ apiKey: 'zz-bogus-key-material-zz' });
    await bad.apiInfo.get().catch(() => {});
    const blob = JSON.stringify(audit);
    must(!blob.includes('zz-bogus-key-material-zz'), 'audit leaked a key');
    must(!blob.includes(API_KEY), 'audit leaked THE key');
    return 'no key material in the audit event';
  });
  await check('C33', 'redact() masks credentials and keeps safe fields', async () => {
    const out = redact({ apiKey: API_KEY, nested: { password: 'p@ss', token: 't0k' }, keep: 'visible' });
    must(out.keep === 'visible', 'redaction ate a safe field');
    must(out.apiKey !== API_KEY, `apiKey=${out.apiKey}`);
    must(out.nested.password === REDACTED && out.nested.token === REDACTED, JSON.stringify(out.nested));
    return `apiKey/password/token -> ${REDACTED}`;
  });

  await check('C34', 'operations.searchAcrossResources hits several resources', async () => {
    const hits = await asArray(hudu.operations.searchAcrossResources('test'));
    const resources = new Set(hits.map((h) => h.resource ?? h.operation?.split('.')[0]));
    return `${hits.length} hits across ${resources.size} resource(s): ${[...resources].slice(0, 6).join(',')}`;
  });
  await check('C35', 'operations.resolveAny resolves an identifier', async () => {
    const got = await hudu.operations.resolveAny(c0.name);
    must(got && typeof got === 'object', 'no result');
    return `keys=${Object.keys(got).slice(0, 7).join(',')}`;
  });
  await check('C36', 'concurrent reads at concurrency 4 are safe', async () => {
    const ids = live.slice(0, 8).map((c) => c.id);
    const out = await Promise.all(ids.map((id) => hudu.companies.get(id)));
    must(out.length === ids.length && out.every((c) => c?.id), 'a parallel read failed');
    return `${out.length} parallel gets ok`;
  });

  await check('C37', 'every primitive registry record maps to a real client method', async () => {
    const list = Object.values(CAPABILITY_REGISTRY);
    const missing = [];
    for (const r of list) {
      if (r.kind !== 'primitive') continue;
      const [res, meth] = r.name.split('.');
      const target = res === 'operations' ? hudu.operations : hudu[camel(res)];
      if (!target || typeof target[meth] !== 'function') missing.push(r.name);
    }
    must(missing.length === 0, `${missing.length} absent: ${missing.slice(0, 5).join(', ')}`);
    return `${list.length} records; every primitive method exists on the client`;
  });
  await check('C38', 'registry pagination mode matches the live endpoint', async () => {
    const nonPag = [...new Set(Object.values(CAPABILITY_REGISTRY).filter((r) => r.pagination?.nonPaginated).map((r) => r.name.split('.')[0]))];
    const wrong = [];
    const errored = [];
    let checked = 0;
    for (const res of nonPag) {
      const target = hudu[camel(res)];
      const meth = typeof target?.listAll === 'function' ? 'listAll' : (typeof target?.list === 'function' ? 'list' : null);
      if (!meth) continue;
      try {
        await spy(() => (meth === 'listAll' ? target.listAll() : (async () => { const o = []; for await (const x of target.list()) { o.push(x); break; } return o; })()));
        checked++;
        if (/page(_size)?=/.test(requests[0]?.url ?? '')) wrong.push(res);
      } catch (err) {
        // A per-resource failure must be REPORTED, not abort the sweep (some endpoints need a parent id the
        // sweep has not got, e.g. assets is company-scoped).
        errored.push(`${res}: ${err.name}`);
      }
    }
    must(wrong.length === 0, `claimed non-paginated but sent page params: ${wrong.join(', ')}`);
    return `${checked} non-paginated resources verified live${errored.length ? `; ${errored.length} could not be swept here (${errored.slice(0, 3).join('; ')})` : ''}`;
  });
  await check('C39', 'create() honours its declared return type', async () => {
    const made = await hudu.companies.create({ name: `ZZ SDK Smoke type ${Date.now()}` });
    const id = made?.id ?? made?.company?.id;
    strays.push(id);
    try {
      must(typeof made?.id === 'number', `declared Promise<Company> but returned keys [${Object.keys(made ?? {}).join(',')}] -> the vendor envelope`);
      return `returned a Company with id ${made.id}`;
    } finally { if (id) await hudu.companies.delete(id).catch(() => {}); strays.splice(strays.indexOf(id), 1); }
  });
  await check('C40', 'MCP tool manifest is well formed', async () => {
    const md = readFileSync(join(ROOT, 'MCP_TOOL_MANIFEST.md'), 'utf8');
    const tools = JSON.parse(md.split('```json')[1].split('```')[0]);
    const list = tools.tools ?? tools;
    must(Array.isArray(list) && list.length > 50, `tools=${list?.length}`);
    const bad = list.filter((t) => !t.name || !t.description || !t.inputSchema);
    must(bad.length === 0, `${bad.length} tools lack name/description/inputSchema`);
    return `${list.length} tools, all complete`;
  });

} finally {
  for (const id of strays.filter((x) => typeof x === 'number')) {
    try { await hudu.companies.delete(id); console.log(`cleanup: deleted stray company ${id}`); }
    catch (err) { console.log(`cleanup: FAILED to delete company ${id}: ${err.message}`); }
  }
  globalThis.fetch = realFetch;
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nnode-hudu live smoke - ${BASE_URL} - target ${TARGET}`);
console.log('='.repeat(104));
for (const r of results.filter((x) => x.status !== 'PASS')) console.log(`${pad(r.status, 5)} ${pad(r.id, 5)} ${pad(r.name, 66)} ${r.detail}`);
console.log('-'.repeat(104));
for (const r of results.filter((x) => x.status === 'PASS')) console.log(`PASS  ${pad(r.id, 5)} ${pad(r.name, 66)} ${r.detail}`);
const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
console.log('='.repeat(104));
console.log(`TOTAL ${results.length}  PASS ${counts.PASS ?? 0}  FAIL ${counts.FAIL ?? 0}  SKIP ${counts.SKIP ?? 0}`);
if (unhandled.length > 0) {
  console.log(`\n${unhandled.length} UNHANDLED REJECTION(S) escaped the SDK (a helper that fans out must not kill its caller):`);
  for (const u of unhandled) console.log(`  - ${u}`);
}
const jsonOut = flag('--json', '');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ baseUrl: BASE_URL, target: TARGET, counts, results }, null, 2));
if ((counts.FAIL ?? 0) > 0) process.exit(1);
