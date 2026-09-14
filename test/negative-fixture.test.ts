/**
 * The capability gate's negative fixture, wired into automated execution (F-L5).
 *
 * `test/fixtures/capabilities.plan.drifted.json` is committed so that "a committed negative
 * fixture proves the gate actually fails" has an automated carrier: without this test the
 * fixture is only ever run by hand. It runs `scripts/check-negative-fixture.mjs` (the shared
 * assertion surface), which requires the gate to exit non-zero on the fixture with rule-based
 * FAIL evidence at or above minimum failure counts — never an exact count, so legitimate rule
 * additions cannot break it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('capability gate negative fixture', () => {
  it('the committed drifted plan fails the gate (RC!=0, minimum rule-based failures)', () => {
    const r = spawnSync(process.execPath, ['scripts/check-negative-fixture.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(r.status, `check-negative-fixture exited ${r.status}:\n${out}`).toBe(0);
    expect(out).toContain('negative-fixture — PASS');
  });

  it('proves the inputSchema-unresolved-item rule has teeth for the defect shape', () => {
    // The plan fixture cannot exercise a REGISTRY rule, so the script carries a second negative
    // proof: it doctors a copy of the registry back to the shape the defect emitted and requires
    // the gate to refuse it, naming the rule. Asserted from the script's own output so there is one
    // implementation of the proof.
    const r = spawnSync(process.execPath, ['scripts/check-negative-fixture.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(r.status, `check-negative-fixture exited ${r.status}:\n${out}`).toBe(0);
    expect(out).toContain('registry shape: the gate refused the doctored registry and named inputSchema-unresolved-item');
  });
});
