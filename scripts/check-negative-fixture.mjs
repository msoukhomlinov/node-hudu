#!/usr/bin/env node
// scripts/check-negative-fixture.mjs
//
// Wires the committed negative fixture into automated execution (F-L5). The claim "a committed
// negative fixture proves the gate actually fails" has no backing unless something RUNS the
// fixture, so this is that something.
//
// It carries TWO negative proofs, because one fixture cannot cover both kinds of rule:
//   1. the committed DIFFERENT-PLAN fixture must fail the plan-reading rules with rule-based
//      evidence, not a crash;
//   2. a DOCTORED REGISTRY (the F5 defect shape restored: a detail-less `items: {"type":"object"}`
//      outside the vendor payload) must fail the inputSchema-unresolved-item rule specifically.
//      The plan fixture can never exercise a registry rule, so without this the new rule could be
//      vacuous and still look green.
//
// Asserts (RC != 0 AND a MINIMUM failure count — never an exact count, so legitimate rule
// additions cannot break this):
//   1. the gate exits non-zero on the fixture;
//   2. the failure output is the gate's rule-based FAIL summary (a crash or a plan-missing bail
//      is not the fixture failing the rules);
//   3. at least MIN_FAILURES failures across at least MIN_RULES distinct rules — a fixture that
//      one rule deletion could satisfy is a fixture with no teeth.
//
// Run: node scripts/check-negative-fixture.mjs   (also wired into `npm test` through
//      test/negative-fixture.test.ts, which spawns this same script)
//
// Exit codes: 0 the fixture fails the gate as intended, 1 the gate passed or the failure evidence
// is too thin (the fixture is orphaned or has lost its teeth).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'test/fixtures/capabilities.plan.drifted.json';
// Measured at the fix round: 136 failures in 11 rules. The minimums leave margin for legitimate
// rule additions; a future change must not drop the fixture below them.
const MIN_FAILURES = 100;
const MIN_RULES = 8;

const r = spawnSync(process.execPath, ['scripts/check-capabilities.mjs', '--plan', FIXTURE], {
  cwd: ROOT,
  encoding: 'utf8',
});
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const problems = [];
if (r.status === 0) problems.push('the gate exited 0 on the negative fixture — it should FAIL (RC!=0)');
const m = /FAIL — (\d+) failure\(s\) in (\d+) distinct rule\(s\)/.exec(out);
if (!m) {
  if (r.status !== 0) problems.push('the gate exited non-zero without its rule-based FAIL summary — a crash or an early bail is not the fixture failing the rules');
} else {
  const failures = Number(m[1]);
  const rules = Number(m[2]);
  if (failures < MIN_FAILURES) problems.push(`${failures} failures < minimum ${MIN_FAILURES} — the fixture has lost its teeth`);
  if (rules < MIN_RULES) problems.push(`${rules} distinct rules < minimum ${MIN_RULES} — a fixture one rule deletion could satisfy`);
  console.log(`negative-fixture — gate failed as intended: ${failures} failure(s) in ${rules} distinct rule(s) (minimums: ${MIN_FAILURES} failures / ${MIN_RULES} rules), RC=${r.status}`);
  console.log(out.slice(m.index, m.index + 420).trim());
}
// ---------------------------------------------------------------- registry-shape negative proof
// The plan fixture cannot exercise a REGISTRY rule (it is plan-only), so the rule that closes the
// F5 class needs its own negative case: doctor a copy of the registry back to the shape the defect
// emitted (`items: {"type": "object"}` for the cross-resource `resources` parameter, outside the
// vendor `.data` payload) and require the gate to FAIL on it, naming the rule. Without this the
// rule could be vacuously green forever.
const REGISTRY_SOURCE = path.join(ROOT, 'src', 'capabilities.ts');
const DEPLOYED_PARAM = /"name":"resources","type":"array","items":\{"type":"string","enum":\[[^\]]*\]\}/;
const source = readFileSync(REGISTRY_SOURCE, 'utf8');
const deployed = DEPLOYED_PARAM.exec(source);
if (deployed === null) {
  // The parameter changed shape: re-point this proof rather than let it pass vacuously.
  problems.push('the cross-resource `resources` parameter is no longer the deployed string enum — re-point the registry-shape proof at its replacement');
} else {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'hudu-negative-registry-'));
  const doctored = path.join(tmpDir, 'capabilities.ts');
  writeFileSync(doctored, source.replace(deployed[0], '"name":"resources","type":"array","items":{"type":"object"}'));
  try {
    const rr = spawnSync(process.execPath, ['scripts/check-capabilities.mjs', '--registry', doctored], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const rout = `${rr.stdout ?? ''}\n${rr.stderr ?? ''}`;
    if (rr.status === 0) {
      problems.push('the gate PASSED a registry carrying the defect shape (bare items:{"type":"object"} outside .data) — inputSchema-unresolved-item has no teeth');
    } else if (!rout.includes('inputSchema-unresolved-item')) {
      problems.push(`the gate failed the doctored registry (RC=${rr.status}) but did not name inputSchema-unresolved-item — the refusal came from another rule`);
    } else {
      console.log('negative-fixture — registry shape: the gate refused the doctored registry and named inputSchema-unresolved-item');
      console.log(rout.trim().split('\n').filter((line) => line.includes('inputSchema-unresolved-item') || line.includes('FAIL —')).slice(0, 3).join('\n'));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (problems.length) {
  for (const p of problems) console.error(`negative-fixture: FAIL — ${p}`);
  process.exit(1);
}
console.log('negative-fixture — PASS — the committed drifted plan fails the gate with rule-based evidence, and the inputSchema-unresolved-item rule fails a doctored registry that carries the defect shape.');
process.exit(0);
