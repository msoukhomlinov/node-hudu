#!/usr/bin/env node
/** Live seed + exercise harness: networks, vlans, vlan_zones, ip_addresses, rack_storages,
 *  rack_storage_items, relations. Creates real data, exercises every op, deletes everything again. */
import { writeFileSync } from 'node:fs';
import { HuduClient } from '../dist/index.js';

const BASE_URL = process.env.HUDU_BASE_URL;
const API_KEY = process.env.HUDU_API_KEY;
if (!BASE_URL || !API_KEY) { console.error('missing env'); process.exit(2); }
const h = new HuduClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 30000 });

const results = [];
const rec = (name, status, detail, extra) => {
  const row = { name, status, detail: String(detail ?? '').slice(0, 400) };
  if (extra !== undefined) row.extra = extra;
  results.push(row);
  console.log(status.padEnd(12), name.padEnd(40), row.detail);
  return row;
};
const codeOf = (e) => (e && (e.code || e.name)) || 'Error';
const short = (v) => { try { const s = JSON.stringify(v); return s.length > 300 ? s.slice(0, 297) + '...' : s; } catch { return String(v); } };
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e }; } };
const dr = (r) => (r.ok ? rec.keep : null);

// ---- fetch spy --------------------------------------------------------------------------------------
const urls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => { urls.push(String(u)); return realFetch(u, init); };
const drain = () => { const u = urls.slice(); urls.length = 0; return u; };

const spy = {};
const SPY_RESOURCES = ['networks','vlans','vlan_zones','ip_addresses','rack_storages','rack_storage_items','relations'];
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const out = { baseUrl: BASE_URL, results, spy, seeded: [], cleanup: [], guards: [], createdIds: {} };
const done = () => { writeFileSync('/tmp/live-seed-infrastructure.json', JSON.stringify(out, null, 2)); };

// == 1. baseline reads ==================================================================================
const baseline = {};
for (const res of SPY_RESOURCES) {
  drain();
  const r = await attempt(() => h[camel(res)].listAll());
  const us = drain();
  baseline[res] = r.ok ? r.value.length : null;
  rec(res + '.listAll', r.ok ? 'LIVE_OK' : 'THREW', r.ok ? r.value.length + ' row(s)' : codeOf(r.error) + ': ' + r.error.message, { urls: us.length });
  if (!r.ok) console.log('   ->', us.join(' | '));
}
out.baseline = baseline;
rec('companies.listAll (baseline)', 'LIVE_OK', String((await h.companies.listAll()).length) + ' rows');

// pre-seed reads with no data (the SKIP rows of the sweep)
const pre = {};
pre['ip_addresses.get'] = await attempt(() => h.ipAddresses.get(1));
rec('ip_addresses.get(pre-seed)', 'LIVE_OK', pre['ip_addresses.get'].ok ? 'read id 1' : 'REFUSED ' + codeOf(pre['ip_addresses.get'].error));
for (const g of ['rackStorages','rackStorageItems','vlanZones','vlans']) {
  const r = await attempt(() => h[g].get(1));
  console.log('  pre-seed', g + '.get(1):', r.ok ? 'FOUND' : codeOf(r.error));
}
// == 2. non-paginated proof (fetch spy) ===============================================================
for (const res of SPY_RESOURCES) {
  const t = h[camel(res)];
  drain(); await attempt(() => t.listAll());
  const bare = drain();
  drain(); const paged = await attempt(() => t.listAll({ page: 3, page_size: 2 }));
  const pagedUrls = drain();
  drain(); const streamed = await attempt(() => { const it = t.list({ page: 4, page_size: 2 }); return it.next(); });
  const streamUrls = drain();
  const joined = [...bare, ...pagedUrls, ...streamUrls].join(' ');
  spy[res] = {
    listAllUrls: bare, pagedListAllUrls: pagedUrls, listStreamUrls: streamUrls,
    pagedListAllError: paged.ok ? null : codeOf(paged.error) + ': ' + paged.error.message,
    streamError: streamed.ok ? null : codeOf(streamed.error) + ': ' + streamed.error.message,
    sawPageParam: /[?&]page=/.test(joined), sawPageSizeParam: /[?&]page_size=/.test(joined),
  };
  rec(res + ' pagination spy', 'LIVE_OK',
    'listAll url=' + (bare[0] || 'n/a') + ' | sawPage=' + spy[res].sawPageParam + ' sawPageSize=' + spy[res].sawPageSizeParam +
    (paged.ok ? '' : ' | paged listAll refused: ' + codeOf(paged.error)));
}
done();

// == 3. dry-runs for every write of my resources (pre-seed, where an id exists) ========================
const networks = await h.networks.listAll();
const net0 = networks[0];
const dry = async (label, fn) => {
  const r = await attempt(fn);
  if (r.ok) rec(label + ' [dry-run]', 'LIVE_OK', 'DryRunResult ' + short(r.value));
  else rec(label + ' [dry-run]', 'REFUSED(' + codeOf(r.error) + ')', r.error.message);
  return r;
};
await dry('networks.update', () => h.networks.update(net0.id, { name: net0.name }, { dryRun: true }));
await dry('networks.delete', () => h.networks.delete(net0.id, { dryRun: true }));

// == 4. seed (real creates) ============================================================================
const created = {};
const createdIds = out.createdIds;
const REAL = true;
const mk = (name, payload) => ({ name, payload });
const seedOrder = [
  mk('networks', { name: 'ZZ live-coverage network', address: '10.99.0.0/24', network_type: 1, company_id: 13, description: 'live-coverage seed' }),
  mk('vlan_zones', { name: 'ZZ live-coverage zone', vlan_id_ranges: '900-910', company_id: 13, description: 'live-coverage seed' }),
  mk('vlans', { name: 'ZZ live-coverage vlan', vlan_id: 905, company_id: 13, description: 'live-coverage seed', vlan_zone_id: null }),
  mk('ip_addresses', { address: '10.99.0.5', company_id: 13, description: 'live-coverage seed', skip_dns_validation: true, network_id: null }),
  mk('rack_storages', { name: 'ZZ live-coverage rack', company_id: 13, height: 12, width: 19, starting_unit: 1, max_wattage: 1000, description: 'live-coverage seed' }),
  mk('rack_storage_items', { start_unit: 1, end_unit: 2, status: 0, side: 0, max_wattage: 300, power_draw: 150, reserved_message: 'live-coverage seed', rack_storage_role_id: null, asset_id: null }),
  mk('relations', { fromable_type: 'Company', fromable_id: 13, toable_type: 'Company', toable_id: 3, description: 'ZZ live-coverage relation' }),
];

// dry-run every create first, then the real call, in dependency order.
for (const s of seedOrder) {
  const t = h[camel(s.name)];
  const d = await attempt(() => t.create(s.payload, { dryRun: true }));
  if (d.ok) rec(s.name + '.create [dry-run]', 'LIVE_OK', 'DryRunResult ' + short(d.value));
  else rec(s.name + '.create [dry-run]', 'REFUSED(' + codeOf(d.error) + ')', d.error.message);
}

const real = async (res, payload) => {
  const t = h[camel(res)];
  const r = await attempt(() => t.create(payload));
  if (!r.ok) { rec(res + '.create [REAL]', 'REFUSED(' + codeOf(r.error) + ')', r.error.message); return null; }
  rec(res + '.create [REAL]', 'LIVE_OK', 'created id=' + r.value.id + ' keys=' + Object.keys(r.value).length);
  out.seeded.push({ resource: res, id: r.value.id });
  return r.value;
};

created.networks = await real('networks', seedOrder[0].payload);
created.vlan_zones = await real('vlan_zones', seedOrder[1].payload);
const vlanPayload = { ...seedOrder[2].payload };
if (created.vlan_zones) vlanPayload.vlan_zone_id = created.vlan_zones.id;
created.vlans = await real('vlans', vlanPayload);
const ipPayload = { ...seedOrder[3].payload };
if (created.networks) ipPayload.network_id = created.networks.id;
created.ip_addresses = await real('ip_addresses', ipPayload);
created.rack_storages = await real('rack_storages', seedOrder[4].payload);

// rack_storage_items needs a real asset id (assets.list requires a company scope).
let assetId = null;
try {
  const scoped = await h.assets.listAll(13);
  if (scoped && scoped[0]) assetId = scoped[0].id;
} catch (e) { console.log('  assets.listAll(13) failed:', codeOf(e)); }
if (!assetId) { try { const all = await h.assets.listAllAcrossCompanies(); if (all && all[0]) assetId = all[0].id; } catch (e) { console.log('  listAllAcrossCompanies failed:', codeOf(e)); } }
console.log('  probe asset id =', assetId);
const rsiPayload = { ...seedOrder[5].payload };
if (created.rack_storages) rsiPayload.rack_storage_role_id = created.rack_storages.id;
if (assetId) rsiPayload.asset_id = assetId;
created.rack_storage_items = await real('rack_storage_items', rsiPayload);
created.relations = await real('relations', seedOrder[6].payload);

for (const k of Object.keys(created)) if (created[k]) createdIds[k] = created[k].id;
console.log('createdIds =', JSON.stringify(createdIds));
done();

// == 5. reads AFTER seeding ============================================================================
const idOf = (res) => createdIds[res];
for (const res of ['networks','vlans','vlan_zones','ip_addresses','rack_storages','rack_storage_items']) {
  const id = idOf(res);
  if (!id) { rec(res + '.get [post-seed]', 'UNVERIFIED', 'no seeded id'); continue; }
  const r = await attempt(() => h[camel(res)].get(id));
  rec(res + '.get [post-seed]', r.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(r.error) + ')', r.ok ? 'id=' + r.value.id + ' ' + short(r.value) : r.error.message);
}
for (const res of SPY_RESOURCES) {
  const r = await attempt(() => h[camel(res)].listAll());
  const n = r.ok ? r.value.length : null;
  rec(res + '.listAll [post-seed]', r.ok ? 'LIVE_OK' : 'THREW', r.ok ? n + ' row(s) (baseline ' + baseline[res] + ')' : codeOf(r.error) + ': ' + r.error.message);
  if (r.ok && n !== baseline[res] + 1 && res !== 'relations') console.log('   !! count delta != 1 for', res);
}
// filters on the seeded rows
const filt = async (label, fn) => { const r = await attempt(fn); rec(label, r.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(r.error) + ')', r.ok ? short(r.value) : r.error.message); return r; };
if (idOf('networks')) {
  await filt('networks.list {company_id:13} [post-seed]', async () => { const a = []; for await (const x of h.networks.list({ company_id: 13 })) a.push(x.id); return a.length + ' ids ' + JSON.stringify(a); });
  await filt('networks.list {name:seed} [post-seed]', async () => { const a = []; for await (const x of h.networks.list({ name: 'ZZ live-coverage network' })) a.push(x.id); return a.length + ' ids ' + JSON.stringify(a); });
}
if (idOf('vlans')) await filt('vlans.list {vlan_zone_id} [post-seed]', async () => { const a = []; for await (const x of h.vlans.list({ vlan_zone_id: idOf('vlan_zones') })) a.push(x.id); return a.length + ' ids'; });
if (idOf('ip_addresses')) await filt('ip_addresses.list {network_id} [post-seed]', async () => { const a = []; for await (const x of h.ipAddresses.list({ network_id: idOf('networks') })) a.push(x.id); return a.length + ' ids'; });
if (idOf('rack_storage_items')) await filt('rack_storage_items.list {asset_id} [post-seed]', async () => { const a = []; for await (const x of h.rackStorageItems.list({ asset_id: created.rack_storage_items.asset_id })) a.push(x.id); return a.length + ' ids'; });
await filt('relations.list [post-seed]', async () => { const a = []; for await (const x of h.relations.list({})) a.push(x.id); return a.length + ' ids'; });
await filt('relations.list {fromable_type:Company} [post-seed]', async () => { const a = []; for await (const x of h.relations.list({ fromable_type: 'Company', fromable_id: 13 })) a.push(x.id); return a.length + ' ids'; });

// == 6. helpers, post-seed =============================================================================
const helper = async (label, fn, opts) => {
  const r = await attempt(() => fn());
  rec(label, r.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(r.error) + ')', r.ok ? short(r.value) : r.error.message, opts);
  return r;
};
await helper('networks.resolve(name)', () => h.networks.resolve('ZZ live-coverage network'));
await helper('networks.resolve(id)', () => h.networks.resolve(idOf('networks')));
await helper('networks.findByAddress(10.99.0.0/24)', () => h.networks.findByAddress('10.99.0.0/24'));
await helper('networks.findByAddress(missing)', () => h.networks.findByAddress('192.0.2.0/24'));
await helper('vlans.resolve(name)', () => h.vlans.resolve('ZZ live-coverage vlan'));
await helper('vlans.resolve(id)', () => h.vlans.resolve(idOf('vlans')));
await helper('vlans.findByVlanId(905)', () => h.vlans.findByVlanId(905));
await helper('vlan_zones.resolve(name)', () => h.vlanZones.resolve('ZZ live-coverage zone'));
await helper('vlan_zones.resolve(id)', () => h.vlanZones.resolve(idOf('vlan_zones')));
await helper('ip_addresses.resolve(address)', () => h.ipAddresses.resolve('10.99.0.5'));
await helper('ip_addresses.resolve(id)', () => h.ipAddresses.resolve(idOf('ip_addresses')));
await helper('ip_addresses.findByAddress(10.99.0.5)', () => h.ipAddresses.findByAddress('10.99.0.5'));
await helper('ip_addresses.findByAddress(missing)', () => h.ipAddresses.findByAddress('10.99.0.250'));
await helper('rack_storages.resolve(name)', () => h.rackStorages.resolve('ZZ live-coverage rack'));
await helper('rack_storages.resolve(id)', () => h.rackStorages.resolve(idOf('rack_storages')));
await helper('rack_storage_items.resolve(id)', () => h.rackStorageItems.resolve(idOf('rack_storage_items')));
await helper('relations.resolve(id)', () => h.relations.resolve(idOf('relations')));
await helper('relations.findByEndpoints(Company13->Company3)', () => h.relations.findByEndpoints({ type: 'Company', id: 13 }, { type: 'Company', id: 3 }, { limit: 10 }));
done();

// == 7. write dry-runs + expectedUpdatedAt guards (per resource with an update) ========================
const GUARDED = [
  ['networks', (rec0, m) => ({ name: rec0.name, address: rec0.address, network_type: rec0.network_type, company_id: rec0.company_id, notes: m })],
  ['vlans', (rec0, m) => ({ name: rec0.name, vlan_id: rec0.vlan_id, company_id: rec0.company_id, vlan_zone_id: rec0.vlan_zone_id, notes: m })],
  ['vlan_zones', (rec0, m) => ({ name: rec0.name, vlan_id_ranges: rec0.vlan_id_ranges, company_id: rec0.company_id, description: m })],
  ['ip_addresses', (rec0, m) => ({ address: rec0.address, network_id: rec0.network_id, company_id: rec0.company_id, notes: m })],
  ['rack_storages', (rec0, m) => ({ name: rec0.name, company_id: rec0.company_id, height: rec0.height, width: rec0.width, starting_unit: rec0.starting_unit, max_wattage: rec0.max_wattage, description: m })],
];
for (const [res, patch] of GUARDED) {
  const id = idOf(res);
  const t = h[camel(res)];
  if (!id) { rec(res + '.update [dry-run]', 'UNVERIFIED', 'no seeded id'); continue; }
  const d = await attempt(() => t.update(id, patch(created[res], 'ZZ dry-run only'), { dryRun: true }));
  rec(res + '.update [dry-run]', d.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(d.error) + ')', d.ok ? 'DryRunResult ' + short(d.value) : d.error.message);

  const before = await t.get(id);
  const staleMarker = 'ZZ stale attempt ' + Date.now();
  const freshMarker = 'ZZ fresh landed ' + Date.now();
  const g = { resource: res, id, updated_at: before.updated_at };
  const stale = await attempt(() => t.update(id, patch(before, staleMarker), { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }));
  g.stale = stale.ok ? 'ACCEPTED(BUG)' : codeOf(stale.error) + ': ' + stale.error.message;
  const afterStale = await t.get(id);
  g.staleLanded = JSON.stringify(afterStale).includes(staleMarker);
  g.staleUpdatedAtChanged = afterStale.updated_at !== before.updated_at;
  const fresh = await attempt(() => t.update(id, patch(afterStale, freshMarker), { expectedUpdatedAt: before.updated_at }));
  g.fresh = fresh.ok ? 'ACCEPTED' : codeOf(fresh.error) + ': ' + fresh.error.message;
  const afterFresh = await t.get(id);
  g.freshLanded = JSON.stringify(afterFresh).includes(freshMarker);
  rec(res + ' GUARD stale expectedUpdatedAt', stale.ok ? 'THREW__landed' : (codeOf(stale.error) === 'STALE_OBJECT' ? 'LIVE_OK' : 'REFUSED(' + codeOf(stale.error) + ')'),
    g.stale + ' | landed=' + g.staleLanded + ' updatedAtChanged=' + g.staleUpdatedAtChanged);
  rec(res + ' GUARD fresh expectedUpdatedAt', fresh.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(fresh.error) + ')', g.fresh + ' | landed=' + g.freshLanded);
  out.guards.push(g);
}
// resources whose SDK deliberately has no guard
for (const res of ['rack_storage_items', 'relations']) {
  const id = idOf(res);
  if (!id) continue;
  const r = await attempt(() => h[camel(res)].update(id, { notes: 'ZZ' }, { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }));
  if (typeof h[camel(res)].update !== 'function') { rec(res + ' GUARD', 'N/A', 'resource exposes no update path'); continue; }
  rec(res + ' GUARD expectedUpdatedAt', r.ok ? 'THREW__landed' : 'REFUSED(' + codeOf(r.error) + ')', r.ok ? 'write landed without a guard' : r.error.message);
}
const rsi = await h.rackStorageItems.listAll();
if (rsi[0]) rec('rack_storage_items vendor revision field', 'LIVE_OK', 'record key set: ' + Object.keys(rsi[0]).join(',') + ' | has updated_at=' + ('updated_at' in rsi[0]));
done();

// == 8. cleanup ========================================================================================
const DELETE_ORDER = ['relations','rack_storage_items','ip_addresses','rack_storages','vlans','vlan_zones','networks'];
for (const res of DELETE_ORDER) {
  const id = idOf(res);
  const t = h[camel(res)];
  if (!id) { out.cleanup.push({ resource: res, id: null, status: 'NOT_CREATED' }); continue; }
  const d = await attempt(() => t.delete(id, { dryRun: true }));
  rec(res + '.delete [dry-run]', d.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(d.error) + ')', d.ok ? 'DryRunResult ' + short(d.value) : d.error.message);
  const r = await attempt(() => t.delete(id));
  const row = { resource: res, id, status: r.ok ? 'DELETED' : 'DELETE_FAILED', detail: r.ok ? short(r.value) : codeOf(r.error) + ': ' + r.error.message };
  out.cleanup.push(row);
  rec(res + '.delete [REAL]', r.ok ? 'LIVE_OK' : 'REFUSED(' + codeOf(r.error) + ')', r.ok ? 'deleted id=' + id + ' -> ' + short(r.value) : r.error.message);
  if (typeof t.get === 'function') {
    const g = await attempt(() => t.get(id));
    rec(res + '.get after delete', g.ok ? 'THREW__still_present' : (codeOf(g.error) === 'NOT_FOUND' ? 'LIVE_OK' : 'REFUSED(' + codeOf(g.error) + ')'), g.ok ? 'record still readable: ' + short(g.value) : codeOf(g.error) + ': ' + g.error.message);
  }
}
done();

// == 9. final inventory + residue scan =================================================================
const final = {};
for (const res of SPY_RESOURCES) {
  const r = await attempt(() => h[camel(res)].listAll());
  final[res] = r.ok ? r.value.length : 'ERR ' + codeOf(r.error);
  rec(res + '.listAll [final]', r.ok ? 'LIVE_OK' : 'THREW', r.ok ? r.value.length + ' row(s) (baseline ' + baseline[res] + ', expect equal)' : codeOf(r.error) + ': ' + r.error.message);
}
out.final = final;
// residue: does anything carrying the seed marker survive anywhere?
const leftovers = [];
for (const res of ['networks','vlans','vlan_zones','ip_addresses','rack_storages','rack_storage_items','relations']) {
  const r = await attempt(() => h[camel(res)].listAll());
  if (!r.ok) continue;
  for (const row of r.value) {
    const s = JSON.stringify(row);
    if (/ZZ live-coverage|ZZ stale attempt|ZZ fresh landed/.test(s)) leftovers.push(res + '#' + row.id);
  }
}
out.leftovers = leftovers;
rec('residue scan for seeded markers', leftovers.length === 0 ? 'LIVE_OK' : 'THREW', leftovers.length === 0 ? 'no seeded marker survives' : 'SURVIVORS: ' + leftovers.join(', '));
const companies = await h.companies.listAll();
rec('companies.listAll [final]', 'LIVE_OK', companies.length + ' rows (expect 21)');
out.companyCount = companies.length;
rec('spy on final sweep', 'LIVE_OK', 'total HTTP requests seen by the fetch spy: ' + urls.length);
done();
console.log('\n==== SUMMARY ====');
console.log(JSON.stringify({ created: createdIds, cleanup: out.cleanup.map((c) => c.resource + ':' + c.status), leftovers, final }, null, 1));
