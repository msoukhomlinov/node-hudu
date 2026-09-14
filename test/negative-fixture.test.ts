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
import fs from 'node:fs';
import os from 'node:os';
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

  it('the inputSchema-unresolved-item rule catches the DETAIL-LESS emission the defect produced', () => {
    // The reproduced defect emitted `items: {"type": "object"}` — the item projection dropped both
    // the resolution and the type name, so a rule that only looks for a name or `resolved: false`
    // cannot see it. This proves the rule has teeth for that exact shape: an authored parameter
    // position (outside the vendor `.data` payload) may never advertise an untyped object item.
    const source = fs.readFileSync(path.join(root, 'src', 'capabilities.ts'), 'utf8');
    const deployed = /"name":"resources","type":"array","items":\{"type":"string","enum":\[[^\]]*\]\}/.exec(source);
    expect(deployed, 'the resources parameter is no longer a string enum — re-point this test').not.toBeNull();
    const doctored = source.replace(deployed[0], '"name":"resources","type":"array","items":{"type":"object"}');
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hudu-registry-')), 'capabilities.ts');
    fs.writeFileSync(tmp, doctored);
    try {
      const r = spawnSync(process.execPath, ['scripts/check-capabilities.mjs', '--registry', tmp], {
        cwd: root,
        encoding: 'utf8',
      });
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(r.status, `the gate PASSED a registry carrying the defect shape:\n${out}`).not.toBe(0);
      expect(out).toContain('inputSchema-unresolved-item');
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });
});
