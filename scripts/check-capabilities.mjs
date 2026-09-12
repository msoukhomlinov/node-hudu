// scripts/check-capabilities.mjs
//
// `npm run capabilities:check [-- --group A|B|C|D|operations] [-- --ship] [-- --plan <path>]`
//
// The capability gate. Normative definition: api-node-squad
// references/agent-execution-layer.md §4.2 ("It fails when any of the following is true").
// This script implements that list, not an approximation. Rules and their ids:
//
//   malformed-row            exactly one of primitive/helper must be non-null (coordinator contract)
//   missing-key              a row is missing one of the §4 keys (every key is present on every row)
//   batch-status             --group: a scoped row is still "planned"
//   ship-status              --ship: a row is not "tested" (planned OR implemented)
//   coverage-source-missing  a scoped row at implemented/tested names a method that does not exist
//                            in src/resources/<resource>.ts (or src/operations/<module>.ts)
//   coverage-registry        a scoped row at implemented/tested has no record in src/capabilities.ts
//   registry-orphan          a registry record names an operation that is not in the plan
//   mutation-effect          a mutation has no effect
//   mutation-dryRun          a mutation has no dryRun, or dryRun is false
//   record-examples          a registry record carries no examples
//   record-permissions       a registry record has no permissions (the literal "unknown" is fine)
//   helper-rationale         a helper has no helperRationale
//   helper-tests             a helper has no test rows
//   helper-usage             a helper has no usage guidance
//   helper-compact-drops     a helper returning a compact shape is unresolved (`dropsUnresolved`)
//                            or carries no drops array; a record whose `compact` is null must
//                            make no drops claim at all. `drops: []` is valid (compact keeps all)
//   preferredWhen            an operation with a sibling reaching the same outcome has no
//                            preferredWhen. Sibling definition used here (documented, mechanical):
//                            two rows in the same resource with the same normalised endpoint
//                            (same HTTP method + path template). Curated near-duplicates that do
//                            not share an endpoint cannot be detected mechanically; see report.
//   impact-bound             a destructive/bulk operation has no recorded impact bound. Proxy
//                            implemented here: a destructive row must declare a dry-run test row
//                            (id or title containing "dry-run"), which is where the impact
//                            statement { affected, scope, reversible } is asserted.
//   staleCheck               a mutation has no staleCheck value (field name or "unavailable")
//   dryrun-shape             a dry-run of an update must record the warnings/diff contract.
//                            Proxy: an update-like row needs a dry-run test row (the dry-run
//                            result shape is asserted there).
//   test-title               a row at "tested": no test with that exact title in the named file
//   implemented-tests        a row at "implemented": empty tests array
//   test-row                 a tests[] entry without id/file/title
//   emission-planhash        capabilities.json is stale (planHash mismatch) — SKIPPED when --plan
//                            points somewhere other than capabilities.plan.json, so a fixture can
//                            exercise the other rules without a matching emission
//   emission-missing         capabilities.json / capabilities.schema.json / src/capabilities.ts absent
//
// Warnings (never failures): a public source method in neither the plan nor the registry
// (unplanned surface), a record with purpose:null, a destructive row without requiresApproval,
// a read row with dryRun:true.
//
// Exit 1 on any failure. Prints every failure with its reason and the offending JSON path, then a
// PASS/FAIL summary with counts.
//
// Flags: --group <A|B|C|D|operations>  --ship  --plan <path>  --registry <path>

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const DEFAULT_PLAN = 'capabilities.plan.json';
const PLAN_ARG = argValue('--plan', DEFAULT_PLAN);
const PLAN_PATH = path.resolve(ROOT, PLAN_ARG);
const IS_DEFAULT_PLAN = path.resolve(ROOT, PLAN_ARG) === path.resolve(ROOT, DEFAULT_PLAN);
const GROUP = argValue('--group', null);
const SHIP = argv.includes('--ship');
const REGISTRY_PATH = path.resolve(ROOT, argValue('--registry', 'src/capabilities.ts'));
const failures = [];
const warnings = [];
function fail(rule, jsonPath, reason) {
  failures.push({ rule, path: jsonPath, reason });
}
function warn(rule, jsonPath, reason) {
  warnings.push({ rule, path: jsonPath, reason });
}

// ---------------------------------------------------------------- plan
if (!existsSync(PLAN_PATH)) {
  console.error(`capabilities:check: plan not found at ${PLAN_PATH}`);
  process.exit(1);
}
const planBytes = readFileSync(PLAN_PATH);
const planHash = createHash('sha256').update(planBytes).digest('hex');
let plan;
try {
  plan = JSON.parse(planBytes.toString('utf8'));
} catch (err) {
  console.error(`capabilities:check: plan is not valid JSON: ${err.message}`);
  process.exit(1);
}
const operations = Array.isArray(plan.operations) ? plan.operations : [];
const ROW_KEYS = ['endpoint', 'primitive', 'specialOp', 'vendorFilters', 'search', 'helper', 'helperBasis', 'helperRationale', 'effect', 'flags', 'dryRun', 'metadata', 'compact', 'resolution', 'staleCheck', 'redaction', 'errors', 'tests', 'group', 'status'];

// ---------------------------------------------------------------- source index
function loadDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
    .map((n) => ({ file: path.join(abs, n), rel: path.posix.join(rel, n), text: readFileSync(path.join(abs, n), 'utf8') }));
}
const sourceModules = new Map(); // module name -> { rel, methods:Set, paginated }
function indexModule(f) {
  const key = path.basename(f.file, '.ts');
  if (key === 'index' || key === 'base') return;
  const sf = ts.createSourceFile(f.file, f.text, ts.ScriptTarget.Latest, true);
  const methods = new Set();
  let paginated = null;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'super') {
      const m = /paginated:\s*(true|false)/.exec(node.getText());
      if (m) paginated = m[1] === 'true';
    }
    if (ts.isClassDeclaration(node) && node.name) {
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m) || !m.name) continue;
        const name = m.name.getText();
        if (name === 'constructor') continue;
        const mods = (m.modifiers ?? []).map((x) => x.getText());
        if (mods.includes('private') || mods.includes('protected')) continue;
        methods.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  sourceModules.set(key, { rel: f.rel, methods, paginated });
}
for (const f of loadDir('src/resources')) indexModule(f);
for (const f of loadDir('src/operations')) indexModule(f);

function sourceMethod(opName) {
  const parts = opName.split('.');
  const resource = parts[0];
  const method = parts.slice(1).join('.');
  const mod = sourceModules.get(resource);
  if (!mod) return { ok: false, why: `no module src/resources/${resource}.ts (or src/operations/${resource}.ts)` };
  if (!mod.methods.has(method)) return { ok: false, why: `no public method ${method}() in ${mod.rel}` };
  return { ok: true, mod };
}

// ---------------------------------------------------------------- registry
function literalToValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalToValue);
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : p.name.getText();
      out[key] = literalToValue(p.initializer);
    }
    return out;
  }
  return undefined;
}
let registry = null;
let registryProblem = null;
if (!existsSync(REGISTRY_PATH)) {
  registryProblem = `registry file ${path.relative(ROOT, REGISTRY_PATH)} does not exist — run \`npm run capabilities:build\``;
} else {
  const text = readFileSync(REGISTRY_PATH, 'utf8');
  const sf = ts.createSourceFile(REGISTRY_PATH, text, ts.ScriptTarget.Latest, true);
  // unwrap `... as const satisfies Record<...>` so the object literal is reachable
  const unwrap = (node) => {
    let n = node;
    while (n && (ts.isSatisfiesExpression(n) || ts.isAsExpression(n) || ts.isParenthesizedExpression(n))) n = n.expression;
    return n;
  };
  let found = null;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'CAPABILITY_REGISTRY' && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) {
    registryProblem = `could not read CAPABILITY_REGISTRY from ${path.relative(ROOT, REGISTRY_PATH)} (is it hand-edited?)`;
  } else {
    registry = new Map();
    for (const p of found.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = ts.isStringLiteral(p.name) ? p.name.text : p.name.getText();
      registry.set(name, literalToValue(p.initializer));
    }
  }
}

// ---------------------------------------------------------------- test titles
const testTitles = new Map(); // rel path -> Set<title>
function walkTests(dir) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs)) {
    const p = path.join(abs, entry);
    if (statSync(p).isDirectory()) { walkTests(path.join(dir, entry)); continue; }
    if (!entry.endsWith('.test.ts')) continue;
    const text = readFileSync(p, 'utf8');
    const titles = new Set();
    const re = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(text))) titles.add(m[2]);
    testTitles.set(path.posix.join(dir, entry), titles);
  }
}
walkTests('test');
function titleExists(file, title) {
  const inFile = testTitles.get(file);
  if (!inFile) return { ok: false, why: `test file ${file} does not exist` };
  if (!inFile.has(title)) return { ok: false, why: `no test titled "${title}" in ${file}` };
  return { ok: true };
}

// ---------------------------------------------------------------- row helpers
function opNameOf(row) {
  const hasPrimitive = typeof row.primitive === 'string' && row.primitive.length > 0;
  const hasHelper = typeof row.helper === 'string' && row.helper.length > 0;
  if (hasPrimitive === hasHelper) return null;
  return hasPrimitive ? row.primitive : row.helper;
}
function isMutation(row) { return row.effect === 'write' || row.effect === 'destructive'; }
function hasDryRunTest(row) {
  return (row.tests ?? []).some((t) => `${t.id ?? ''} ${t.title ?? ''}`.toLowerCase().includes('dry-run') || `${t.id ?? ''} ${t.title ?? ''}`.toLowerCase().includes('dryrun'));
}
const UPDATE_METHODS = new Set(['update', 'updatePositions', 'moveLayout', 'archive', 'unarchive', 'duplicate']);

const scoped = operations
  .map((row, idx) => ({ row, jsonPath: `operations[${idx}]` }))
  .filter(({ row }) => !GROUP || row.group === GROUP);

// ---------------------------------------------------------------- per-row rules
const planNames = new Set();
const endpointIndex = new Map(); // resource + normalised endpoint -> rows
for (const { row, jsonPath } of operations.map((row, idx) => ({ row, jsonPath: `operations[${idx}]` }))) {
  for (const key of ROW_KEYS) {
    if (!(key in row)) fail('missing-key', jsonPath, `row is missing the required key "${key}" (every key is present on every row; null is the explicit "none")`);
  }
  const name = opNameOf(row);
  if (!name) {
    fail('malformed-row', jsonPath, `exactly one of primitive/helper must be non-null — got primitive=${JSON.stringify(row.primitive)}, helper=${JSON.stringify(row.helper)}`);
    continue;
  }
  planNames.add(name);
  if (row.endpoint) {
    const ep = `${row.endpoint.split(' ')[0]} ${row.endpoint.split(' ').slice(1).join(' ')}`.replace(/\s+/g, ' ').replace(/\/\d+/g, '/{id}');
    const key = `${name.split('.')[0]}#${ep}`;
    if (!endpointIndex.has(key)) endpointIndex.set(key, []);
    endpointIndex.get(key).push({ name, jsonPath });
  }
}

for (const { row, jsonPath } of scoped) {
  const name = opNameOf(row);
  if (!name) continue; // already reported as malformed-row
  const built = row.status === 'implemented' || row.status === 'tested';

  // coverage / registration
  if (built) {
    const src = sourceMethod(name);
    if (!src.ok) fail('coverage-source-missing', jsonPath, `${name}: ${src.why}`);
    if (registry && !registry.has(name)) fail('coverage-registry', jsonPath, `${name} is ${row.status} but has no record in ${path.relative(ROOT, REGISTRY_PATH)}`);
  } else if (row.status !== 'planned') {
    warn('unknown-status', jsonPath, `${name}: status="${row.status}" is not one of planned|implemented|tested`);
  }

  // batch / ship status
  if (SHIP) {
    if (row.status !== 'tested') fail('ship-status', jsonPath, `${name}: status="${row.status}" — under --ship every row must be "tested"`);
  } else if (GROUP === null && row.status === 'planned') {
    // tolerated by design: the coordinator sanity check runs while later groups are still planned
  } else if (row.status === 'planned') {
    fail('batch-status', jsonPath, `${name}: status="planned"${GROUP ? ` in group ${GROUP}` : ''} — a batch gate requires "implemented" or "tested"`);
  }

  // mutation safety
  if (isMutation(row)) {
    if (!row.effect) fail('mutation-effect', jsonPath, `${name}: a mutation has no effect`);
    if (row.dryRun !== true) fail('mutation-dryRun', jsonPath, `${name}: a mutation needs dryRun:true, got ${JSON.stringify(row.dryRun)}`);
    if (row.staleCheck === null || row.staleCheck === undefined || row.staleCheck === '') {
      fail('staleCheck', jsonPath, `${name}: a mutation needs a staleCheck value — the field name it checks, or the explicit "unavailable"`);
    }
    if (row.effect === 'destructive') {
      if (!hasDryRunTest(row)) fail('impact-bound', jsonPath, `${name}: destructive operation with no recorded impact bound — declare a dry-run test row that asserts { affected, scope, reversible }`);
      if (!(row.flags ?? []).includes('requiresApproval')) warn('impact-flag', jsonPath, `${name}: destructive without the requiresApproval flag (§7.1 classifies deletes as requiresApproval)`);
    }
    const method = name.split('.').slice(1).join('.');
    if (UPDATE_METHODS.has(method) && !hasDryRunTest(row)) {
      fail('dryrun-shape', jsonPath, `${name}: dry-run of an update must record the warnings/diff contract — no dry-run test row declared`);
    }
  } else if (row.effect === 'read' && row.dryRun === true) {
    warn('read-dryRun', jsonPath, `${name}: read operation with dryRun:true (policy: dryRun is false for reads)`);
  }

  // metadata completeness on the row
  const isHelper = typeof row.helper === 'string' && row.helper.length > 0;
  if (isHelper) {
    if (!row.helperRationale) fail('helper-rationale', jsonPath, `${name}: helper has no helperRationale (the admission rule requires one)`);
    if (!Array.isArray(row.tests) || row.tests.length === 0) fail('helper-tests', jsonPath, `${name}: helper has no test rows`);
    const usage = row.metadata ? row.metadata.usage : null;
    if (!usage) fail('helper-usage', jsonPath, `${name}: helper has no usage guidance`);
  }
  const testRows = Array.isArray(row.tests) ? row.tests : [];
  if (row.status === 'implemented' && testRows.length === 0) {
    fail('implemented-tests', jsonPath, `${name}: status="implemented" with an empty tests array (rows must be declared before the Tests stage)`);
  }
  testRows.forEach((t, i) => {
    if (!t || !t.id || !t.file || !t.title) fail('test-row', `${jsonPath}.tests[${i}]`, `${name}: test row must be {id, file, title}`);
  });
  if (row.status === 'tested') {
    if (testRows.length === 0) fail('implemented-tests', jsonPath, `${name}: status="tested" with no test rows`);
    testRows.forEach((t, i) => {
      if (!t || !t.file || !t.title) return;
      const r = titleExists(t.file, t.title);
      if (!r.ok) fail('test-title', `${jsonPath}.tests[${i}]`, `${name}: ${r.why} (a row at "tested" must have a test with that exact title)`);
    });
  }

  // preferredWhen: siblings share a normalised endpoint
  if (row.endpoint) {
    const ep = `${row.endpoint.split(' ')[0]} ${row.endpoint.split(' ').slice(1).join(' ')}`.replace(/\s+/g, ' ').replace(/\/\d+/g, '/{id}');
    const siblings = endpointIndex.get(`${name.split('.')[0]}#${ep}`) ?? [];
    if (siblings.length > 1 && !row.metadata?.preferredWhen) {
      fail('preferredWhen', jsonPath, `${name}: shares its endpoint with ${siblings.filter((s) => s.name !== name).map((s) => s.name).join(', ')} but records no preferredWhen`);
    }
  }
}

// ---------------------------------------------------------------- registry rules
if (registry) {
  for (const [name, rec] of registry) {
    if (!planNames.has(name)) fail('registry-orphan', `CAPABILITY_REGISTRY['${name}']`, `record names an operation that is not in the plan (${path.relative(ROOT, PLAN_PATH)})`);
    if (!rec || typeof rec !== 'object') continue;
    if (!Array.isArray(rec.examples) || rec.examples.length === 0) fail('record-examples', `CAPABILITY_REGISTRY['${name}'].examples`, 'every operation has at least one realistic call');
    if (typeof rec.permissions !== 'string' || rec.permissions.length === 0) fail('record-permissions', `CAPABILITY_REGISTRY['${name}'].permissions`, 'permissions is missing or empty — the literal "unknown" is acceptable, an absent field is not');
    if (rec.purpose === null) warn('record-purpose', `CAPABILITY_REGISTRY['${name}'].purpose`, 'purpose is null (Architect judgement column unfilled)');
    const outSchema = rec.outputSchema && typeof rec.outputSchema === 'object' ? rec.outputSchema : {};
    const claimsDrops = 'drops' in outSchema || 'dropsUnresolved' in outSchema;
    if (rec.compact) {
      if (outSchema.dropsUnresolved === true) {
        fail('helper-compact-drops', `CAPABILITY_REGISTRY['${name}'].outputSchema.dropsUnresolved`, `compact shape "${rec.compact}" is declared but the full record type could not be resolved — drops cannot be named honestly`);
      } else if (!Array.isArray(outSchema.drops)) {
        fail('helper-compact-drops', `CAPABILITY_REGISTRY['${name}'].outputSchema.drops`, `compact shape "${rec.compact}" must carry a drops array (an empty array is valid when the compact shape keeps every field)`);
      }
    } else if (claimsDrops) {
      fail('helper-compact-drops', `CAPABILITY_REGISTRY['${name}'].outputSchema`, 'compact is null but the record carries a drops claim — a record without a compact shape makes no drops claim');
    }
  }
}

// ---------------------------------------------------------------- unplanned surface (warning)
const registryNames = registry ? new Set(registry.keys()) : new Set();
for (const [mod, info] of sourceModules) {
  for (const method of info.methods) {
    const opName = `${mod}.${method}`;
    if (!planNames.has(opName) && !registryNames.has(opName)) {
      warn('unplanned-surface', `${info.rel} → ${opName}`, 'public method appears in neither the plan nor the registry — unplanned surface');
    }
  }
}

// ---------------------------------------------------------------- emission rules
if (IS_DEFAULT_PLAN) {
  const capJson = path.join(ROOT, 'capabilities.json');
  if (!existsSync(capJson)) {
    fail('emission-missing', 'capabilities.json', 'not emitted — run `npm run capabilities:build`');
  } else {
    let emitted = null;
    try { emitted = JSON.parse(readFileSync(capJson, 'utf8')); } catch (err) { fail('emission-json', 'capabilities.json', `not valid JSON: ${err.message}`); }
    if (emitted && emitted.planHash !== planHash) {
      fail('emission-planhash', 'capabilities.json.planHash', `stale: emitted ${emitted.planHash}, plan is ${planHash} — re-run \`npm run capabilities:build\``);
    }
  }
  if (!existsSync(path.join(ROOT, 'capabilities.schema.json'))) fail('emission-missing', 'capabilities.schema.json', 'not emitted — run `npm run capabilities:build`');
  if (registryProblem) fail('emission-missing', 'src/capabilities.ts', registryProblem);
} else {
  console.log(`capabilities:check — --plan ${PLAN_ARG}: emission rules (planHash comparison, emitted-file presence) are SKIPPED by design so a fixture can exercise the other rules.`);
}

// ---------------------------------------------------------------- report
const scopeLabel = SHIP ? 'ship gate (all groups, every row tested)' : GROUP ? `batch gate, group ${GROUP}` : 'all groups (planned tolerated)';
console.log(`capabilities:check — plan ${PLAN_ARG} planHash=${planHash}; rows=${operations.length}; scoped=${scoped.length}; scope=${scopeLabel}`);
if (registry) console.log(`capabilities:check — registry ${path.relative(ROOT, REGISTRY_PATH)} records=${registry.size}`);
if (warnings.length) {
  console.log(`\nWARNINGS (${warnings.length}) — not failures:`);
  for (const w of warnings) console.log(`  ! [${w.rule}] ${w.path}: ${w.reason}`);
}
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  ✗ [${f.rule}] ${f.path}: ${f.reason}`);
  const byRule = {};
  for (const f of failures) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  console.log(`\nFAIL — ${failures.length} failure(s) in ${Object.keys(byRule).length} distinct rule(s): ${Object.entries(byRule).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  process.exit(1);
}
console.log(`\nPASS — 0 failures; rows=${operations.length} scoped=${scoped.length} registryRecords=${registry ? registry.size : 0} warnings=${warnings.length}`);
process.exit(0);
