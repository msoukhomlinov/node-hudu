#!/usr/bin/env node
// scripts/check-negative-fixture.mjs
//
// Wires the committed negative fixture into automated execution (F-L5). The claim "a committed
// negative fixture proves the gate actually fails" has no backing unless something RUNS the
// fixture, so this is that something — and it is the proof vehicle for the
// inputSchema-unresolved-item rule as well: the fixture run must fail with rule-based evidence,
// not a crash.
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
if (problems.length) {
  for (const p of problems) console.error(`negative-fixture: FAIL — ${p}`);
  process.exit(1);
}
console.log('negative-fixture — PASS — the committed drifted plan fails the gate with rule-based evidence.');
process.exit(0);
