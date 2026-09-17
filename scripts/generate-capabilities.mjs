// MACHINE-GENERATED ARTIFACT GENERATOR — scripts/generate-capabilities.mjs
//
// `npm run capabilities:build`
//
// Reads capabilities.plan.json (the authored source) plus the TypeScript sources, and emits:
//   - src/capabilities.ts        the runtime registry (plain object literals, ZERO runtime deps,
//                                no zod, no imports, importable with no side effects)
//   - capabilities.json          machine-readable data for non-TS consumers
//   - capabilities.schema.json   JSON Schema for the above
// All three carry header fields: generatedAt + planHash (sha256 of the exact bytes of the plan).
//
// Policy: api-node-squad references/agent-execution-layer.md §4.1 (registry fields) and §4.2
// (emission rules). Judgement columns (helper, helperBasis, helperRationale, flags, metadata,
// compact, resolution, staleCheck, redaction) belong to the Architect: this script copies them
// and tolerates null. It NEVER fills or rewrites them.
//
// Row shapes handled (both are normative; every row has EXACTLY ONE of primitive/helper set):
//   (a) primitive rows: endpoint/primitive non-null, helper null
//   (b) helper rows:    endpoint null, primitive null, helper "<resource>.<name>" non-null
//
// A record is emitted only when the row's status is "implemented" or "tested" AND the named
// method really exists in src/resources/<resource>.ts (or src/operations/<module>.ts for
// group "operations"). Planned rows and helper rows whose method is absent from the source are
// reported on stdout as coverage gaps; the registry never claims a method the SDK does not have.
//
// Flags:
//   --plan <path>   plan to read          (default: capabilities.plan.json)
//   --out <dir>     output directory      (default: repo root; src/capabilities.ts always src/)
//   --no-src        do not write src/capabilities.ts (verification aid)
//
// Exit codes: 0 ok, 1 plan missing/unreadable or emission failed, 2 malformed plan.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const PLAN_PATH = path.resolve(ROOT, argValue('--plan', 'capabilities.plan.json'));
const OUT_DIR = path.resolve(ROOT, argValue('--out', '.'));
const WRITE_SRC = !argv.includes('--no-src');

// ---------------------------------------------------------------- plan
if (!existsSync(PLAN_PATH)) {
  console.error(`capabilities:build: plan not found at ${PLAN_PATH}`);
  console.error('capabilities:build: run `npm run plan:derive` first (it is not this script\'s job).');
  process.exit(1);
}
const planBytes = readFileSync(PLAN_PATH);
const planHash = createHash('sha256').update(planBytes).digest('hex');
let plan;
try {
  plan = JSON.parse(planBytes.toString('utf8'));
} catch (err) {
  console.error(`capabilities:build: plan is not valid JSON: ${err.message}`);
  process.exit(2);
}
const operations = Array.isArray(plan.operations) ? plan.operations : [];
if (!operations.length) {
  console.error('capabilities:build: plan has no operations[] rows');
  process.exit(2);
}
const generatedAt = new Date().toISOString();

// ---------------------------------------------------------------- TS source index
// Parse src/types/*.ts, src/resources/*.ts and (when present) src/operations/*.ts with the
// TypeScript compiler API (typescript is a devDependency; nothing here is a runtime dep).
const sfByFile = new Map();
function loadDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const file = path.join(abs, name);
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sfByFile.set(file, sf);
    out.push({ file, rel: path.posix.join(rel, name), sf, text });
  }
  return out;
}
const typeFiles = loadDir('src/types');
// src/pagination.ts declares ListParams/Page, which resource param interfaces extend. Without it
// those interfaces resolve to nothing and their schemas come out opaque.
const sharedFiles = existsSync(path.join(ROOT, 'src/pagination.ts'))
  ? [{ file: path.join(ROOT, 'src/pagination.ts'), rel: 'src/pagination.ts', sf: ts.createSourceFile(path.join(ROOT, 'src/pagination.ts'), readFileSync(path.join(ROOT, 'src/pagination.ts'), 'utf8'), ts.ScriptTarget.Latest, true), text: readFileSync(path.join(ROOT, 'src/pagination.ts'), 'utf8') }]
  : [];
const resourceFiles = loadDir('src/resources');
const operationFiles = loadDir('src/operations');
const allFiles = [...typeFiles, ...sharedFiles, ...resourceFiles, ...operationFiles];

// interface / type-alias property tables, by type name
const typeProps = new Map();   // name -> [{name, type, optional, enumValues}]
const typeDeclKind = new Map();// name -> 'interface' | 'alias'
const aliasText = new Map();   // name -> underlying type text, for wrapped aliases

function propRecord(member) {
  if (!ts.isPropertySignature(member) || !member.name) return null;
  const name = member.name.getText();
  if (name.startsWith('[')) return null; // index signature: not a field
  const optional = !!member.questionToken;
  const t = member.type;
  const out = { name, type: t ? t.getText() : 'unknown', optional, enumValues: null };
  if (t && ts.isUnionTypeNode(t)) {
    const lits = t.types.filter((x) => ts.isLiteralTypeNode(x));
    if (lits.length === t.types.length && lits.length) out.enumValues = lits.map((x) => x.literal.getText());
  }
  return out;
}
function propsOfNode(node) {
  const out = [];
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
    for (const m of node.members) {
      const p = propRecord(m);
      if (p) out.push(p);
    }
  } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    for (const m of node.type.members) {
      const p = propRecord(m);
      if (p) out.push(p);
    }
  }
  return out;
}
const interfaceHeritage = new Map(); // interface name -> [base type texts from `extends`
for (const f of allFiles) {
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      typeProps.set(node.name.text, propsOfNode(node));
      typeDeclKind.set(node.name.text, 'interface');
      const bases = [];
      for (const clause of node.heritageClauses ?? []) {
        if (ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const t of clause.types) bases.push(t.getText());
        }
      }
      if (bases.length) interfaceHeritage.set(node.name.text, bases);
    } else if (ts.isTypeAliasDeclaration(node)) {
      const p = propsOfNode(node);
      if (p.length) {
        typeProps.set(node.name.text, p);
        typeDeclKind.set(node.name.text, 'alias');
      } else {
        // a wrapped alias, e.g. `type CompanyCreate = Partial<Omit<Company, ...>>`
        aliasText.set(node.name.text, node.type.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(f.sf);
}

// public methods of exported classes, by module
// moduleKey -> { file, rel, className, paginated(boolean|null), methods: Map }
function basePaginated(sf) {
  // find `super(http, {... paginated: X ...})`
  let val = null;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'super') {
      const text = node.getText();
      const m = /paginated:\s*(true|false)/.exec(text);
      if (m) val = m[1] === 'true';
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return val;
}
const modules = new Map();
for (const f of [...resourceFiles, ...operationFiles]) {
  const key = path.basename(f.file, '.ts');
  if (key === 'index' || key === 'base') continue;
  const methods = new Map();
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m) || !m.name) continue;
        const name = m.name.getText();
        if (name === 'constructor') continue;
        // skip private/protected members: they are not the public surface
        const mods = (m.modifiers ?? []).map((x) => x.getText());
        if (mods.includes('private') || mods.includes('protected')) continue;
        const params = m.parameters.map((p) => ({
          name: p.name.getText(),
          type: p.type ? p.type.getText() : 'unknown',
          optional: !!p.questionToken || !!p.initializer,
        }));
        let ret = m.type ? m.type.getText() : 'unknown';
        let stream = false;
        const am = /^AsyncIterable<(.+)>$/.exec(ret);
        if (am) { ret = am[1]; stream = true; }
        const pm = /^Promise<(.+)>$/.exec(ret);
        if (pm) { ret = pm[1]; }
        const jsdoc = (m.jsDoc ?? []).map((d) => (typeof d.comment === 'string' ? d.comment : '')).join(' ').trim();
        // Keep EVERY declaration: the mandated helper pattern is an overload set, and the
        // caller-facing parameters live in the overloads while the implementation signature is the
        // one that must (TS 2394) return the union. Input schemas read all declarations; the return
        // type reads the implementation (last) declaration.
        const decls = methods.get(name)?.decls ?? [];
        decls.push({ params, returnType: ret.trim(), stream, jsdoc });
        methods.set(name, { name, decls, params, returnType: ret.trim(), stream, jsdoc });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(f.sf);
  modules.set(key, { file: f.file, rel: f.rel, className: null, paginated: basePaginated(f.sf), methods });
}

// ---------------------------------------------------------------- schema derivation
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'unknown', 'any', 'void', 'null']);
// The item projection keeps only {type, enum?} — resolvable and inline object items are
// intentionally detail-less (the historical reduction the registry is byte-diffed on). ONE
// exception: an item whose type the generator could not resolve keeps its NAME. A named
// unresolvable item is then visible — and gate-failable by inputSchema-unresolved-item —
// instead of a bare {"type":"object"} nobody can explain. `resolved` itself is not part of
// the inputSchema vocabulary the invoke validator audits, so the name is the marker.
function projectItems(it) {
  const items = { type: it.type, ...(it.enum ? { enum: it.enum } : {}) };
  if (it.type === 'object' && it.resolved === false && typeof it.typeName === 'string') items.typeName = it.typeName;
  return items;
}
function jsonType(typeText) {
  let t = typeText.replace(/\s+/g, ' ');
  // TypeScript's `readonly` array modifier (`readonly string[]`) carries no JSON-Schema-relevant
  // information — it is a mutability annotation, not part of the element type. Left in place it
  // defeats the `[]`/`Array<>` branches below (the element text becomes "readonly string", which
  // resolves to nothing) and the field falls to the unresolved-name fallback instead of being
  // recognised as an array. Stripping it here, before every other branch, is what lets a
  // `readonly T[]` parameter (e.g. assets.ts's `include?: readonly string[]`) resolve the same as
  // `T[]` would.
  t = t.replace(/^readonly\s+/, '');
  // A single pair of wrapping parens carries no type information: `("A" | "B")` is the same type
  // as "A" | "B", but the wrapped form defeats every branch below and falls to the unresolved
  // fallback (label_types' `("Article" | ...)` union items). Strip the wrap and re-enter the
  // branches; only the OUTER pair is stripped, so `Record<("A"|"B"), T>` members are untouched.
  if (/^\(.*\)$/.test(t)) t = t.slice(1, -1).trim();
  // A single string literal has no top-level `|`; a union of literals (`'a' | 'b'`) must fall
  // through to the union branch so each member is surfaced, not the whole text as one value.
  const m = /^['"`]([^'"`|]*)['"`]$/.exec(t);
  if (m) return { type: 'string', enum: [m[1]] };
  if (t === 'true' || t === 'false') return { type: 'boolean', enum: [t === 'true'] };
  // `keyof X` — the property keys of a resolvable shape are a string enum (the only JSON form a
  // string key can take). `SearchableResource = keyof SearchableSummaryMap` is the case that
  // motivated this branch: without it the alias reaches the unresolved fallback and every
  // array-of-it item projects to a bare {"type":"object"} the invoke validator refuses in both
  // directions (F5/SEC-1). An unresolvable target falls through to the unresolved fallback,
  // where the marker stays visible to the gate.
  const keyof = /^keyof\s+(.+)$/.exec(t);
  if (keyof) {
    const keys = resolveProps(keyof[1]);
    if (keys && keys.length) return { type: 'string', enum: keys.map((p) => p.name) };
  }
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2);
    return { type: 'array', items: projectItems(jsonType(inner)) };
  }
  const arr = /^Array<(.+)>$/.exec(t);
  if (arr) {
    return { type: 'array', items: projectItems(jsonType(arr[1])) };
  }
  const rec = /^Record<(.+),\s*(.+)>$/.exec(t);
  if (rec) return { type: 'object', additionalProperties: { type: jsonType(rec[2]).type }, keyType: jsonType(rec[1]).type };
  const unionParts = splitTopLevel(t);
  if (unionParts.length > 1) {
    if (unionParts.every((x) => /^['"`].*['"`]$/.test(x))) {
      return { type: 'string', enum: unionParts.map((x) => x.replace(/^['"`]|['"`]$/g, '')) };
    }
    // A union member that resolves to a declared shape keeps its fields, so a caller can see what
    // the object form accepts instead of reading an opaque type name.
    const variants = unionParts.map((part) => {
      const jt = jsonType(part);
      const fields = fieldsForType(part);
      return { type: jt.type, ...(jt.typeName ? { typeName: jt.typeName } : {}), ...(fields ? { fields } : {}) };
    });
    return { type: 'union', anyOf: variants.map((v) => v.type), variants };
  }
  if (PRIMITIVES.has(t)) return { type: t === 'any' ? 'unknown' : t };
  if (t === 'Date') return { type: 'string', format: 'date-time' };
  // A named alias whose underlying text is itself a union/intersection (e.g.
  // `type Identifier = number | string | {...}`) keeps its name but exposes the members, so the
  // caller sees the accepted object form instead of an opaque type name.
  if (!typeProps.has(t) && aliasText.has(t) && aliasText.get(t) !== t) {
    const inner = jsonType(aliasText.get(t));
    // `Record<string, unknown>` is a free-form bag, not an opaque name: carry `additionalProperties`.
    if (inner.type !== 'object' || inner.variants || inner.anyOf || inner.additionalProperties) return { ...inner, typeName: t };
  }
  if (resolveProps(t)) return { type: 'object', typeName: t, resolved: true };
  return { type: 'object', typeName: t, resolved: false };
}
// Resolve a named type, including the utility wrappers the SDK uses
// (Partial<T>, Omit<T, keys>, Pick<T, keys>, Required<T>). Returns null when the
// declaration is not in the sources — the caller then emits an explicit
// `{ type: name, resolved: false }` instead of omitting the field.
function resolveProps(typeText) {
  const t = typeText.replace(/\s+/g, ' ').trim();
  // `A & B` — an intersection merges the resolvable members' fields (rightmost wins per field).
  // This is how the helper options are declared: `HelperOptions & { company_id?: number }`.
  const parts = splitTopLevel(t, '&');
  if (parts.length > 1) {
    const merged = [];
    for (const part of parts) {
      // An inline object literal (`{ company_id?: number }`) is not a declaration, so it is parsed
      // directly; a named part that cannot be resolved still fails the whole intersection.
      const ps = resolveProps(part) ?? inlineProps(part);
      if (!ps) return null;
      for (const prop of ps) {
        const at = merged.findIndex((x) => x.name === prop.name);
        if (at === -1) merged.push(prop);
        else merged[at] = prop;
      }
    }
    return merged.length ? merged : null;
  }
  const simple = /^(Partial|Required)<(.+)>$/.exec(t);
  if (simple) {
    const inner = resolveProps(simple[2]);
    if (!inner) return null;
    return inner.map((p) => ({ ...p, optional: simple[1] === 'Partial' ? true : false }));
  }
  const omit = /^(Omit|Pick)<(.+),\s*(.+)>$/.exec(t);
  if (omit) {
    const inner = resolveProps(omit[2].trim());
    if (!inner) return null;
    const keys = omit[3].split('|').map((k) => k.trim().replace(/^['"`]|['"`]$/g, ''));
    return inner.filter((p) => (omit[1] === 'Omit' ? !keys.includes(p.name) : keys.includes(p.name)));
  }
  if (typeProps.has(t)) {
    const own = typeProps.get(t);
    const bases = interfaceHeritage.get(t);
    if (!bases) return own;
    // `interface X extends HelperOptions` — a caller can pass the inherited fields too.
    const merged = [];
    for (const base of bases) {
      const ps = resolveProps(base);
      if (ps) for (const prop of ps) if (!merged.some((x) => x.name === prop.name)) merged.push(prop);
    }
    for (const prop of own) {
      const at = merged.findIndex((x) => x.name === prop.name);
      if (at === -1) merged.push(prop);
      else merged[at] = prop;
    }
    return merged;
  }
  if (aliasText.has(t) && aliasText.get(t) !== t) {
    const inner = resolveProps(aliasText.get(t));
    if (inner) return inner;
  }
  // A union type has no single property set; the first member that resolves is used so the caller
  // still sees the object form (`Identifier` = number | string | { type, id }). The union itself is
  // reported by jsonType(), which keeps every member in `variants`.
  const members = splitTopLevel(t);
  if (members.length > 1) {
    for (const member of members) {
      const ps = resolveProps(member) ?? inlineProps(member);
      if (ps) return ps;
    }
  }
  return null;
}
// Parse an inline type literal / object shape straight from its text (no declaration exists).
function inlineProps(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t.startsWith('{')) return null;
  const sf = ts.createSourceFile('inline.ts', `type __T = ${t};`, ts.ScriptTarget.Latest, true);
  let out = null;
  sf.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n)) {
      const p = propsOfNode(n);
      if (p.length) out = p;
    }
  });
  return out;
}
function fieldsForType(typeText, namedItems = false) {
  const t = typeText.replace(/\s+/g, ' ');
  const resolved = resolveProps(t);
  if (resolved) {
    return resolved.map((p) => {
      const base = jsonType(p.type);
      // Variant context (namedItems): an array of a NAMED type keeps the item's name and its
      // fields on `items` — jsonType()'s array branch reduces items to `{ type }` (G1), which
      // hides the ExpirationSummary/RelationSummary/PhotoSummary fields behind the include
      // groups. Only the variant emission passes namedItems, so base (non-variant) schemas
      // keep the historical reduction byte-for-byte. An unresolvable name keeps its name
      // (resolved:false), mirroring jsonType()'s other unresolvable-name emission; an inline
      // literal item has no name and stays `{ type: 'object' }`.
      if (namedItems && base.type === 'array' && base.items && typeof base.items === 'object') {
        const inner = unwrapArrayMember(p.type);
        const it = inner !== p.type ? jsonType(inner) : null;
        if (it && it.typeName && !it.enum && !it.typeName.startsWith('{') && !it.typeName.startsWith('(')) {
          const itemFields = fieldsForType(it.typeName, namedItems);
          base.items = { ...it, ...(itemFields ? { fields: itemFields } : {}) };
        }
      }
      const node = { name: p.name, ...base, required: !p.optional, ...(p.enumValues ? { enum: p.enumValues.map((e) => e.replace(/^['"`]|['"`]$/g, '')) } : {}) };
      // Nested union members carry the field's `name` too (CapabilityField declares name).
      if (Array.isArray(node.variants)) node.variants = node.variants.map((v) => ({ name: p.name, ...v }));
      return node;
    });
  }
  return null;
}
function paramFields(text) {
  // a type literal seen inline in the signature, e.g. { integration_slug: string; ... }
  const sf = ts.createSourceFile('inline.ts', `type __T = ${text};`, ts.ScriptTarget.Latest, true);
  let out = null;
  sf.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n)) {
      const p = propsOfNode(n);
      if (p.length) {
        out = p.map((x) => ({ name: x.name, ...jsonType(x.type), required: !x.optional, ...(x.enumValues ? { enum: x.enumValues.map((e) => e.replace(/^['"`]|['"`]$/g, '')) } : {}) }));
      }
    }
  });
  return out;
}
// Caller-facing parameters: an overload set advertises more parameters than the implementation
// signature does in some cases and fewer in others, so every declaration is considered and, per
// position, the declaration whose parameter resolves to the MOST fields wins. The implementation
// (last) declaration is the fallback. This is what stops a helper emitting a bare opaque `opts`.
// A field whose validity depends on the operation must not be projected for an operation that
// cannot honour it. `expectedUpdatedAt` guards `updateOne` only — base.ts
// assertNoExpectedUpdatedAt throws CONFIG_ERROR on create/delete/archive/setArchived — so only an
// update-shaped operation may advertise it.
function isUpdateShaped(row) {
  const opName = String(row.primitive ?? row.helper ?? '');
  const method = opName.split('.').slice(1).join('.');
  const isHelper = typeof row.helper === 'string' && row.helper.length > 0;
  return isHelper ? /^(update|set|patch|move)[A-Za-z0-9_]*$/.test(method) : method === 'update';
}
function fieldAllowed(row, fieldName) {
  if (fieldName === 'expectedUpdatedAt') return isUpdateShaped(row);
  // A plan row may also declare `inputSchemaOmit`: fields the operation cannot honour, e.g.
  // magic_dash's `company_id`, a GET-only filter the vendor answers with HTTP 500 on a write
  // (live-verified on Hudu 2.45.1). The list lives on the PLAN row — the registry's source of
  // truth — so the derived schema never advertises a field the SDK refuses at runtime; the same
  // list is re-verified against the emitted record by check-capabilities.mjs
  // (rule `inputSchema-conditional-field`).
  const omitted = Array.isArray(row.inputSchemaOmit) ? row.inputSchemaOmit : [];
  if (omitted.includes(fieldName)) return false;
  return true;
}

function paramInfo(method) {
  const decls = method.decls ?? [{ params: method.params }];
  const impl = decls[decls.length - 1];
  const count = decls.reduce((n, d) => Math.max(n, d.params.length), 0);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let best = null;
    for (const d of decls) {
      const cand = d.params[i];
      if (!cand) continue;
      const fields = fieldsForType(cand.type) ?? paramFields(cand.type);
      // `>=` prefers the later declaration on a tie: the implementation advertises the wide type
      // (`{ expand?: boolean }`), while an overload advertises the narrowed literal (`{ expand: true }`).
      if (fields && fields.length && (!best || fields.length >= best.fields.length)) best = { param: cand, fields };
    }
    const param = best ? best.param : (impl.params[i] ?? decls.flatMap((d) => d.params)[i]);
    if (!param) continue;
    const fields = best ? best.fields : (fieldsForType(param.type) ?? paramFields(param.type));
    out.push({ name: param.name, type: param.type, required: !param.optional, fields: fields ?? null });
  }
  return out;
}
function inputSchema(method, row) {
  const infos = paramInfo(method).map((p) => ({
    ...p,
    fields: p.fields ? p.fields.filter((f) => fieldAllowed(row, f.name)) : p.fields,
  }));
  const schema = {};
  // One parameter: flatten it, so `create(data)` and `companies.list(params)` expose the callable
  // fields at the top level (the shape the policy's own example uses for findByDomain(domain)).
  if (infos.length === 1) {
    const p = infos[0];
    if (p.fields && p.fields.length) {
      for (const f of p.fields) schema[f.name] = f;
      return schema;
    }
    schema[p.name] = { name: p.name, ...jsonType(p.type), required: p.required };
    return schema;
  }
  // Several parameters: keep the parameter names, and nest each object parameter's declared fields.
  // Flattening here would merge `fromable` and `toable` into one set of keys, which is a lie.
  for (const p of infos) {
    const jt = jsonType(p.type);
    const expandable = p.fields && p.fields.length && !jt.variants && !jt.anyOf;
    const node = { name: p.name, ...jt, required: p.required, ...(expandable ? { fields: p.fields } : {}) };
    // An inline type literal has no type NAME worth printing: the fields are the whole story.
    if (p.type.trim().startsWith('{') || expandable) { delete node.typeName; delete node.resolved; }
    // Every field node carries the `name` key its CapabilityField interface declares, including
    // the union variants (they describe the same parameter).
    if (Array.isArray(node.variants)) node.variants = node.variants.map((v) => ({ name: p.name, ...v }));
    schema[p.name] = node;
  }
  return schema;
}
// A schema node is "opaque" when it names a type but exposes no fields: a caller cannot see what to
// pass. The build reports the count, so an opaque schema is visible instead of silent.
function opaqueSchemaNodes(node, path = [], acc = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => opaqueSchemaNodes(v, [...path, String(i)], acc));
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;
  const PLATFORM_OPAQUE = new Set(['Blob', 'File', 'Buffer', 'ArrayBuffer', 'ReadableStream', 'Uint8Array', 'Date']);
  if (
    typeof node.typeName === 'string'
    && !Array.isArray(node.fields)
    && !node.variants
    && !node.anyOf
    && node.type !== 'array'
    && !node.additionalProperties
    && !PLATFORM_OPAQUE.has(node.typeName)
    && !node.typeName.startsWith('{')
  ) {
    acc.push({ path: path.join('.'), typeName: node.typeName });
  }
  for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') opaqueSchemaNodes(v, [...path, k], acc);
  return acc;
}
function sampleValue(field) {
  if (field.enum && field.enum.length) return JSON.stringify(field.enum[0]);
  if (field.type === 'number') return '1';
  if (field.type === 'boolean') return 'true';
  if (field.type === 'array') return '[]';
  if (field.type === 'object') return '{}';
  return "'example'";
}
function exampleFor(row, method, resource) {
  if (!method) return `await hudu.${resource}.<method>()`;
  const opName = String(row.primitive ?? row.helper ?? '');
  // Only an update row that actually checks staleness may show expectedUpdatedAt: every other
  // mutation (and every update without a stale guard) throws CONFIG_ERROR before reaching the wire.
  const isUpdateRow = isUpdateShaped(row) && row.staleCheck === 'updated_at';
  const isMutation = row.effect === 'write' || row.effect === 'destructive';
  const args = paramInfo(method).map((p) => {
    if (!p.fields || !p.fields.length) {
      return p.required ? sampleValue({ type: jsonType(p.type).type }) : undefined;
    }
    const isOptionsBag = isMutation && (p.name === 'opts' || p.name === 'options');
    // A mutation example must be a call that WORKS. BaseResource.assertNoExpectedUpdatedAt runs
    // before the dry-run branch, so only an update row may pass expectedUpdatedAt; every other
    // mutation shows the plain `{ dryRun: true }` form it actually accepts.
    if (isOptionsBag) {
      return isUpdateRow ? "{ dryRun: true, expectedUpdatedAt: '2026-01-01T00:00:00Z' }" : '{ dryRun: true }';
    }
    const fields = p.fields.filter((f) => fieldAllowed(row, f.name));
    const shown = fields.slice(0, 4).map((f) => `${f.name}: ${sampleValue(f)}`);
    const rest = fields.length > 4 ? ', /* ... */' : '';
    return `{ ${shown.join(', ')}${rest} }`;
  }).filter((a) => a !== undefined);
  return `await hudu.${resource}.${method.name}(${args.join(', ')})`;
}
// Split a union type on TOP-LEVEL '|' only — nested <>, (), [], {} are respected, so
// `Resolution<A | B>` stays one member. The mandated helper pattern is an overload set whose
// IMPLEMENTATION signature returns the union of the public returns (TS 2394 forbids a narrower
// implementation return type), so the compact shape's `drops` must be derived from the union's
// full-record member, not from the raw union text.
function splitTopLevel(typeText, sep = '|') {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of typeText) {
    if ('<([{'.includes(ch)) depth += 1;
    else if ('>)]}'.includes(ch)) depth -= 1;
    if (ch === sep && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((x) => x.trim()).filter(Boolean);
}
function unwrapArrayMember(member) {
  const t = member.trim();
  if (t.endsWith('[]')) return t.slice(0, -2).trim();
  const arr = /^Array<(.+)>$/.exec(t);
  if (arr) return arr[1].trim();
  return t;
}
function isResolutionMember(member) { return /^Resolution<.+>$/.test(member.trim()); }

// A union member that is itself a PROJECTION of the compact shape — e.g.
// `type AssetSummaryWithIncludes = AssetSummary & AssetIncludes` — is not the full record: it
// adds fields to the compact shape, so it is a TIGHTER superset of the compact props than the
// real full record and would steal the "tightest superset" pick (which is exactly what made
// `assets.search` advertise `AssetSummaryWithIncludes` with the include fields as `drops`).
// A wrapped alias whose source names the compact type as a whole identifier is such a
// projection; a full record like `Asset & AssetIncludes` names `Asset`, never the compact.
function isCompactProjection(name, compactName) {
  const alias = aliasText.get(name);
  if (!alias) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${compactName}(?![A-Za-z0-9_])`).test(alias);
}

// Pick the full-record member of a union return type for a compact-shape helper:
//   1. skip null/undefined and the Resolution<...> (resolutionDetails) member,
//   2. resolve the remaining members,
//   3. prefer the tightest STRICT superset of the compact shape's fields that is NOT itself a
//      projection of the compact shape (the full record: `Asset` without include, not
//      `AssetSummaryWithIncludes`),
//   4. if only the compact shape itself resolves, keep it — `drops: []` is then the correct,
//      honest answer (the compact shape keeps every field, e.g. `type ExportSummary = Export`).
function pickFullMember(returnType, compactProps, compactName) {
  const candidates = [];
  for (const member of splitTopLevel(returnType)) {
    const m = unwrapArrayMember(member);
    if (m === 'null' || m === 'undefined' || m === 'void') continue;
    if (isResolutionMember(m)) continue;
    const props = resolveProps(m);
    if (!props) continue;
    candidates.push({ name: m, props: props.map((x) => x.name) });
  }
  if (!compactProps) return candidates.length === 1 ? candidates[0] : null;
  const supersets = candidates.filter(
    (c) => c.name !== compactName && !isCompactProjection(c.name, compactName) && compactProps.every((n) => c.props.includes(n)),
  );
  if (supersets.length) return supersets.reduce((a, b) => (a.props.length <= b.props.length ? a : b));
  return candidates.length === 1 ? candidates[0] : null;
}

function outputSchema(row, method) {
  const rt = method ? method.returnType : 'unknown';
  if (!method) return { type: rt, unresolved: true };
  if (method.stream) {
    const item = jsonType(rt);
    const schema = { type: 'AsyncIterable', itemType: item.typeName ?? item.type, note: 'streams items one page at a time' };
    if (item.variants) {
      // The implementation signature (TS 2394) returns the UNION of the public returns — e.g.
      // `list` with optional `include` is `AsyncIterable<Asset | AssetWithIncludes>`. A bare
      // `itemType: "union"` strips the prior item contract, so keep the concrete variants
      // (name + fields) so schema-driven callers can discover the included output shape.
      // Re-serialize each variant's fields with named array items (G1): the generic union path
      // above reduces `ExpirationSummary[]` items to `{ type: 'object' }`, hiding the summary
      // fields a registry-driven consumer needs.
      schema.itemVariants = item.variants.map((v) =>
        (v.typeName && Array.isArray(v.fields) ? { ...v, fields: fieldsForType(v.typeName, true) } : v));
    }
    return schema;
  }
  const jt = jsonType(rt);
  if (row.compact) {
    const compactName = String(row.compact);
    const compactProps = resolveProps(compactName) ? resolveProps(compactName).map((p) => p.name) : null;
    const full = pickFullMember(rt, compactProps, compactName);
    const fullProps = full ? full.props : null;
    // drops is (fields of the full record type) minus (fields of the compact shape). An empty
    // drops array is the correct answer when the compact shape keeps every field; dropsUnresolved
    // stays true only when the full record type cannot be resolved at all, so the checker fails
    // loudly instead of the registry lying.
    const drops = compactProps && fullProps ? fullProps.filter((n) => !compactProps.includes(n)) : [];
    const dropsUnresolved = !(compactProps && fullProps);
    // include-aware variants (F1): a helper whose options advertise `include` returns the compact
    // and full shapes WITH the named include groups — e.g. assets.search resolves to
    // `AssetSummary | Asset | AssetSummaryWithIncludes | AssetWithIncludes`. The base modeling
    // above keeps the compact projection (`type`) and the plain full record (`fullType`), so the
    // remaining concrete named variants (name + fields) are preserved next to them — the same
    // mechanism as the stream `itemVariants` (D1), adapted to this record model. A union holding
    // only the base shapes (every other helper) emits nothing, so this is a no-op outside the
    // include rows and the base `fullType` pick (C3) is untouched. Variant fields are serialized
    // with named array items (G1): the include-group arrays keep their item type name + fields.
    const includeVariants = compactProps
      ? splitTopLevel(rt)
          .map(unwrapArrayMember)
          .filter((m) => m && !['null', 'undefined', 'void'].includes(m) && !isResolutionMember(m) && m !== compactName && (!full || m !== full.name) && resolveProps(m))
          .map((m) => ({ type: 'object', typeName: m, fields: fieldsForType(m, true) }))
      : [];
    return {
      type: compactName,
      drops,
      dropsUnresolved,
      fields: compactProps ? fieldsForType(compactName) : null,
      fullType: full ? full.name : rt,
      expand: 'expand: true returns the full typed record',
      ...(includeVariants.length ? { includeVariants } : {}),
    };
  }
  const fields = fieldsForType(rt);
  return { type: jt.typeName ?? jt.type, ...(fields ? { fields } : {}) };
}

// pagination — policy §4.1 plus the coordinator's contract:
//   non-list primitives      -> { mode: 'none', nonPaginated: true }
//   list primitives          -> { mode: 'page', defaultPageSize: 25, maxPageSize, nonPaginated }
// defaultPageSize comes from src/config.ts DEFAULT_PAGE_SIZE; nonPaginated is derived from the
// resource source (BaseResource `paginated: false`) and cross-checked against the spec list.
// The vendor's documented page-size maximum lives in the `page_size` query parameter description
// (e.g. /groups: "The number of results to return per page (max 1000)"). Where the spec states no
// maximum, the MCP bound (100) is used, so a MAX bound always exists somewhere.
const API_DOCS = existsSync(path.join(ROOT, 'api-docs.json')) ? JSON.parse(readFileSync(path.join(ROOT, 'api-docs.json'), 'utf8')) : null;
const MCP_MAX_PAGE_SIZE = 100;
function documentedMaxPageSize(endpoint) {
  if (!API_DOCS || !endpoint) return null;
  const [method, template] = String(endpoint).split(' ');
  const item = API_DOCS.paths ? API_DOCS.paths[template] : null;
  if (!item) return null;
  const op = item[String(method).toLowerCase()];
  if (!op || !Array.isArray(op.parameters)) return null;
  const p = op.parameters.find((x) => x && x.name === 'page_size');
  // The vendor phrases this several ways: "max 1000", "max: 1000", "max of 1000", "maximum 1000".
  const m = p && typeof p.description === 'string'
    ? /\bmax(?:imum)?\b\s*(?:of\s*)?(?::)?\s*(\d+)/i.exec(p.description)
    : null;
  return m ? Number(m[1]) : null;
}

const CONFIG_TEXT = existsSync(path.join(ROOT, 'src/config.ts')) ? readFileSync(path.join(ROOT, 'src/config.ts'), 'utf8') : '';
const DEFAULT_PAGE_SIZE = Number((/DEFAULT_PAGE_SIZE\s*=\s*(\d+)/.exec(CONFIG_TEXT) ?? []) [1] ?? 25);
const SPEC_NON_PAGINATED = ['/ip_addresses', '/lists', '/networks', '/procedure_tasks', '/rack_storage_items', '/rack_storages', '/vlan_zones', '/vlans', '/exports'];
const LIST_METHODS = new Set(['list', 'listAll', 'listPages']);
function paginationFor(row, method, mod) {
  const isList = row.primitive && LIST_METHODS.has(String(row.primitive).split('.').slice(1).join('.')) ;
  if (!isList) return { mode: 'none', defaultPageSize: null, maxPageSize: null, nonPaginated: true };
  const sourceSays = mod ? mod.paginated : null;
  const specSays = row.endpoint ? SPEC_NON_PAGINATED.includes('/' + String(row.endpoint).split(' ')[1].replace(/^\//, '').split('/')[0]) : false;
  // `nonPaginated: true` and `mode: "page"` cannot both be true — a mode of "page" means the
  // endpoint takes page/page_size, which is exactly what a non-paginated endpoint does not do.
  // When nonPaginated, mode is "none" and both page-size fields are null; otherwise mode is
  // "page" with the SDK's default page size (maxPageSize stays null: the vendor spec declares no
  // enforced maximum, and a fabricated bound would be worse than an explicit null).
  const nonPaginated = sourceSays === false || (sourceSays === null && specSays);
  const documentedMax = documentedMaxPageSize(row.endpoint);
  return {
    mode: nonPaginated ? 'none' : 'page',
    defaultPageSize: nonPaginated ? null : DEFAULT_PAGE_SIZE,
    maxPageSize: nonPaginated ? null : (documentedMax ?? MCP_MAX_PAGE_SIZE),
    maxPageSizeSource: nonPaginated ? null : (documentedMax ? 'api-docs' : 'default'),
    nonPaginated,
    sourcePaginated: sourceSays,
    specSaysNonPaginated: specSays,
    crossCheck: sourceSays === null ? 'unresolved' : (sourceSays === !specSays ? 'agrees' : 'DISAGREES: source vs spec list'),
  };
}

// ---------------------------------------------------------------- emit records
const records = [];
const gaps = [];
const warnings = [];
for (const [idx, row] of operations.entries()) {
  const jsonPath = `operations[${idx}]`;
  const hasPrimitive = typeof row.primitive === 'string' && row.primitive.length > 0;
  const hasHelper = typeof row.helper === 'string' && row.helper.length > 0;
  if (hasPrimitive === hasHelper) {
    warnings.push(`${jsonPath}: malformed row — exactly one of primitive/helper must be non-null (primitive=${JSON.stringify(row.primitive)}, helper=${JSON.stringify(row.helper)})`);
    continue;
  }
  const name = hasPrimitive ? row.primitive : row.helper;
  const resource = name.split('.')[0];
  const methodName = name.split('.').slice(1).join('.');
  const mod = modules.get(resource);
  const method = mod ? mod.methods.get(methodName) : undefined;
  const status = row.status;
  const built = status === 'implemented' || status === 'tested';
  if (!built) {
    gaps.push(`${name} (${jsonPath}) not emitted: status="${status}" — coverage gap, no registry record`);
    continue;
  }
  if (!mod) {
    gaps.push(`${name} (${jsonPath}) not emitted: no module src/resources/${resource}.ts (or src/operations/${resource}.ts) — coverage gap`);
    continue;
  }
  if (!method) {
    gaps.push(`${name} (${jsonPath}) not emitted: no public method ${methodName}() in ${mod.rel} — ${hasHelper ? 'helper planned but not implemented' : 'primitive planned but not implemented'}`);
    continue;
  }
  const effects = row.effect;
  if (!effects) warnings.push(`${jsonPath} (${name}): effect is null — the Architect judgement column is unfilled`);
  const flags = Array.isArray(row.flags) ? row.flags : [];
  const isMutation = effects === 'write' || effects === 'destructive';
  const retry = {
    retryableStatuses: [429, 500, 502, 503, 504],
    backoff: 'exponential',
    baseDelayMs: 200,
    maxDelayMs: 30000,
    jitter: 'up-to-25%-of-delay',
    idempotencySupport: flags.includes('idempotent') ? 'vendor-native' : 'none',
  };
  const record = {
    name,
    kind: hasHelper ? 'helper' : 'primitive',
    resource,
    purpose: row.metadata && typeof row.metadata.purpose === 'string' ? row.metadata.purpose : null,
    inputSchema: inputSchema(method, row),
    outputSchema: outputSchema(row, method),
    // A row may AUTHOR its example (`metadata.example`) when the synthesised one would be a call the
    // SDK does not accept — the composite dispatcher `operations.invoke` takes a registry KEY as its
    // first argument, so a sampled `'example'` would be refused at resolve time. An authored example
    // is emitted verbatim and must be a call the SDK accepts (same path the G4 test covers).
    examples: [typeof row.metadata?.example === 'string' ? row.metadata.example : exampleFor(row, method, resource)],
    effect: effects ?? null,
    flags,
    dryRun: isMutation,
    permissions: 'unknown',
    pagination: paginationFor(row, method, mod),
    resolution: row.resolution ?? null,
    retry,
    errors: Array.isArray(row.errors) ? row.errors : [],
    related: row.metadata && Array.isArray(row.metadata.related) ? row.metadata.related : [],
    preferredWhen: row.metadata ? row.metadata.preferredWhen ?? null : null,
    usage: row.metadata && typeof row.metadata.usage === 'string' ? row.metadata.usage : null,
    compact: row.compact ?? null,
  };
  if (record.purpose === null) warnings.push(`${jsonPath} (${name}): metadata.purpose is null — record emitted with purpose:null (Architect column unfilled)`);
  if (record.compact && record.outputSchema.dropsUnresolved) {
    gaps.push(`${name}: compact shape "${record.compact}" is not declared in src/types — outputSchema.drops emitted as [] with dropsUnresolved:true (checker will fail this helper rule until the compact type exists)`);
  }
  records.push(record);
}
records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// ---------------------------------------------------------------- emissions
const headerComment = `// MACHINE-GENERATED by scripts/generate-capabilities.mjs — DO NOT HAND-EDIT.
// Regenerate with: npm run capabilities:build
// Source of truth: capabilities.plan.json (planHash ${planHash})
// generatedAt: ${generatedAt}
// spec: ${plan.spec ? `${plan.spec.source} v${plan.spec.version}` : 'unknown'}`;

const registryTs = `${headerComment}
//
// The runtime registry: plain object literals, no imports, no zod, no side effects.
// Tree-shakeable: consumers import { CAPABILITY_REGISTRY } and bundlers drop unused records.
// One record per operation the SDK actually implements (plan status implemented|tested).

export interface CapabilityField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly [key: string]: unknown;
}

export interface CapabilityRecord {
  readonly name: string;
  readonly kind: 'primitive' | 'helper';
  readonly resource: string;
  readonly purpose: string | null;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly examples: readonly string[];
  readonly effect: 'read' | 'write' | 'destructive' | null;
  readonly flags: readonly string[];
  readonly dryRun: boolean;
  readonly permissions: string;
  readonly pagination: Readonly<Record<string, unknown>>;
  readonly resolution: Readonly<Record<string, unknown>> | null;
  readonly retry: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
  readonly related: readonly string[];
  readonly preferredWhen: string | null;
  readonly usage: string | null;
  readonly compact: string | null;
}

export const CAPABILITIES_PLAN_HASH = '${planHash}';

export const CAPABILITIES_GENERATED_AT = '${generatedAt}';

export const CAPABILITY_REGISTRY = {
${records.map((r) => `  '${r.name}': ${JSON.stringify(r)},`).join('\n')}
} as const satisfies Record<string, CapabilityRecord>;

export type CapabilityName = keyof typeof CAPABILITY_REGISTRY;

export const CAPABILITY_NAMES = Object.keys(CAPABILITY_REGISTRY) as CapabilityName[];

/** Look up one operation's metadata, or undefined when the SDK does not implement it. */
export function getCapability(name: string): CapabilityRecord | undefined {
  return (CAPABILITY_REGISTRY as Record<string, CapabilityRecord>)[name];
}
`;

const dataDoc = {
  generatedAt,
  planHash,
  spec: plan.spec ?? null,
  operationCount: records.length,
  operations: records,
};
const schemaDoc = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/msoukhomlinov/node-hudu/capabilities.schema.json',
  title: 'node-hudu capability registry (generated)',
  type: 'object',
  required: ['generatedAt', 'planHash', 'operations'],
  properties: {
    generatedAt: { type: 'string', format: 'date-time' },
    planHash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'sha256 of the exact bytes of capabilities.plan.json' },
    spec: { type: ['object', 'null'], properties: { source: { type: 'string' }, version: { type: 'string' } } },
    operationCount: { type: 'integer', minimum: 0 },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'resource', 'purpose', 'inputSchema', 'outputSchema', 'examples', 'effect', 'flags', 'dryRun', 'permissions', 'pagination', 'resolution', 'retry', 'errors', 'related', 'preferredWhen', 'usage', 'compact'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9_]+\\.[A-Za-z0-9_]+$' },
          kind: { enum: ['primitive', 'helper'] },
          resource: { type: 'string' },
          purpose: { type: ['string', 'null'] },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          examples: { type: 'array', minItems: 1, items: { type: 'string' } },
          effect: { enum: ['read', 'write', 'destructive', null] },
          flags: { type: 'array', items: { enum: ['sensitive', 'idempotent', 'requiresApproval'] } },
          dryRun: { type: 'boolean' },
          permissions: { type: 'string', minLength: 1, description: 'scope names, or the literal "unknown"' },
          pagination: { type: 'object' },
          resolution: { type: ['object', 'null'] },
          retry: { type: 'object' },
          errors: { type: 'array', items: { type: 'string' } },
          related: { type: 'array', items: { type: 'string' } },
          preferredWhen: { type: ['string', 'null'] },
          usage: { type: ['string', 'null'] },
          compact: { type: ['string', 'null'] },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- write
function writeJson(file, doc) {
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}
// capabilities.json keeps the header readable and writes one operation per line: the file is
// machine-generated and diffed by hash, and full pretty-printing triples it for no reader gain.
function writeDataJson(file, doc) {
  const head = JSON.stringify({ ...doc, operations: [] }, null, 2).replace(/\n\}$/, ',\n');
  const body = doc.operations.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  writeFileSync(file, head + '  "operations": [\n' + body + '\n  ]\n}\n');
}
if (WRITE_SRC) {
  writeFileSync(path.join(ROOT, 'src', 'capabilities.ts'), registryTs);
}
mkdirSync(OUT_DIR, { recursive: true });
writeDataJson(path.join(OUT_DIR, 'capabilities.json'), dataDoc);
writeJson(path.join(OUT_DIR, 'capabilities.schema.json'), schemaDoc);

console.log(`capabilities:build — plan ${path.relative(ROOT, PLAN_PATH)} planHash=${planHash}`);
console.log(`capabilities:build — spec ${plan.spec ? plan.spec.source + ' v' + plan.spec.version : 'unknown'}; rows=${operations.length}; records emitted=${records.length}`);
console.log(`capabilities:build — wrote ${WRITE_SRC ? 'src/capabilities.ts, ' : ''}${path.relative(ROOT, path.join(OUT_DIR, 'capabilities.json'))}, ${path.relative(ROOT, path.join(OUT_DIR, 'capabilities.schema.json'))}`);
// Evidence line for the operation-conditional field rule (F1): a record may advertise
// expectedUpdatedAt only when the operation is update-shaped.
const advertisesExpected = (rec) => JSON.stringify(rec.inputSchema ?? {}).includes('expectedUpdatedAt');
const withExpected = records.filter(advertisesExpected);
const badExpected = withExpected.filter((r) => {
  const method = r.name.split('.').slice(1).join('.');
  return r.kind === 'helper' ? !/^(update|set|patch|move)[A-Za-z0-9_]*$/.test(method) : method !== 'update';
});
console.log(`capabilities:build — records advertising expectedUpdatedAt: ${withExpected.length} (non-update offenders: ${badExpected.length}${badExpected.length ? ' — ' + badExpected.map((r) => r.name).join(', ') : ''})`);
const opaqueInputs = records
  .map((r) => ({ name: r.name, nodes: opaqueSchemaNodes(r.inputSchema) }))
  .filter((x) => x.nodes.length);
console.log(`capabilities:build — records with an opaque inputSchema (type name, no fields): ${opaqueInputs.length}${opaqueInputs.length ? ' (' + opaqueInputs.map((x) => x.name).join(', ') + ')' : ''}`);
const unresolvedDrops = records.filter((r) => r.outputSchema && r.outputSchema.dropsUnresolved === true);
console.log(`capabilities:build — records with dropsUnresolved=true: ${unresolvedDrops.length}${unresolvedDrops.length ? ' (' + unresolvedDrops.map((r) => r.name).join(', ') + ')' : ''}`);
if (gaps.length) {
  console.log(`coverage gaps (${gaps.length}) — no registry record emitted:`);
  for (const g of gaps) console.log('  - ' + g);
} else {
  console.log('coverage gaps: none');
}
if (warnings.length) {
  console.log(`warnings (${warnings.length}):`);
  for (const w of warnings) console.log('  ! ' + w);
}
