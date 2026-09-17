/**
 * One representative Hudu article through the full round trip.
 *
 * The per-family fixtures catch a bad converter. THIS one catches a bad SWAP: a
 * replacement engine can get tables and code right and still flatten a callout. When
 * src/content/turndown-engine.ts is replaced, this test is the gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { htmlToMarkdown, markdownToHtml } from '../../src/content/markdown.js';
import { diffArticleRoundTrip } from '../../src/resources/article-html.js';
import { htmlToText } from '../../src/search/html.js';

const original = readFileSync(new URL('../fixtures/hudu-article.html', import.meta.url), 'utf8');

/**
 * Set-equality that itemises the diff on failure. A bare `expect(set).toEqual(set)` prints
 * both Sets compressed -- at this size that does not say WHICH code is missing or which is
 * extra (issue #43 #20b).
 */
function expectSameCodes(actual: Set<string>, expected: Set<string>, label: string): void {
  const missing = [...expected].filter((c) => !actual.has(c));
  const extra = [...actual].filter((c) => !expected.has(c));
  expect(
    { missing, extra },
    `${label}: expected exactly { ${[...expected].sort().join(', ')} } -- missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]`,
  ).toEqual({ missing: [], extra: [] });
}

describe('a whole Hudu article', () => {
  const md = htmlToMarkdown(original);
  const rebuilt = markdownToHtml(md);
  const findings = diffArticleRoundTrip(original, rebuilt);

  it('keeps every piece of prose a reader can see', () => {
    for (const phrase of [
      'VPN rollout', 'Back up the config before you start.', 'Export the current profile',
      'Push the new profile', 'Advanced options', 'vpn1', '10.0.0.2',
      'sudo systemctl restart openvpn', 'runbook', 'Topology',
    ]) {
      expect(htmlToText(rebuilt), `lost: ${phrase}`).toContain(phrase);
    }
  });

  it('keeps each piece of prose in the structure the round trip preserves (collapse-sensitive)', () => {
    // issue #43 #20c: the phrase test above normalises whitespace, so flattening every
    // element into a single <p> would still pass it. Probed 2026-09-17 (HTML -> MD ->
    // HTML of this fixture): the heading, list, table, fence, link and image survive as
    // structure; the callout, the accordion and the task check-state are the KNOWN
    // accepted losses, so those phrases legitimately sit in plain <p>/<li> here --
    // pinned as the collapsed form, not the lost wrapper. Flattening the article
    // further into one <p> fails this test.
    expect(rebuilt).toMatch(/<h2[^>]*>[^<]*VPN rollout/); // title stays a heading
    expect(rebuilt).toMatch(/<li[^>]*>Export the current profile<\/li>/); // items stay list items
    expect(rebuilt).toMatch(/<li[^>]*>Push the new profile<\/li>/);
    expect(rebuilt).toMatch(/<td[^>]*>\s*vpn1\s*<\/td>/); // table cells stay cells
    expect(rebuilt).toMatch(/<td[^>]*>\s*10\.0\.0\.2\s*<\/td>/);
    expect(rebuilt).toMatch(/<pre>\s*<code[^>]*language-bash[^>]*>sudo systemctl restart openvpn/); // fence stays a fence
    expect(rebuilt).toMatch(/<a[^>]*>[^<]*runbook[^<]*<\/a>/); // link stays a link
    expect(rebuilt).toMatch(/<img[^>]*alt="Topology"/); // image + alt stay
    // The known losses flatten to exactly this form -- prose kept, wrapper gone...
    expect(rebuilt).toMatch(/<p>Back up the config before you start\.<\/p>/);
    expect(rebuilt).toMatch(/<p>Advanced options<\/p>/);
    expect(rebuilt).toMatch(/<p>Set MTU to 1400\.<\/p>/);
    // ...and no lost wrapper survives in any form.
    expect(rebuilt).not.toContain('callout-warning');
    expect(rebuilt).not.toContain('mce-accordion');
    expect(rebuilt).not.toContain('data-type="taskList"');
  });

  it('does not let literal Markdown characters in prose turn into markup', () => {
    expect(htmlToText(rebuilt)).toContain('*not emphasis*');
    expect(htmlToText(rebuilt)).toContain('_not italic_');
    expect(htmlToText(rebuilt)).toContain('# not a heading');
    expect(htmlToText(rebuilt)).toContain('a pipe | in prose');
    expect(rebuilt).not.toMatch(/<em>not emphasis<\/em>/);
    expect(rebuilt).not.toMatch(/<em>not italic<\/em>/);
  });

  it('keeps the table, the code fence and its language', () => {
    // Presence of the element is what matters here, not its attributes -- a replacement
    // engine emitting <table class="..."> or <table role="table"> loses nothing.
    expect(rebuilt).toMatch(/<table[\s>]/);
    // Exact shape IS load-bearing (mirrors test/content/markdown.test.ts:83-87): Hudu's
    // CODE_LANGUAGE_CLASS_MISSING_ON_CODE is an error-severity content rule that requires
    // the language-X class to sit on <code> itself, not only on <pre>.
    expect(rebuilt).toMatch(/<code[^>]*class="[^"]*language-bash/);
  });

  it('reports exactly the structures Markdown cannot hold, and no others', () => {
    // These three are known, accepted losses -- a Markdown editor cannot express them.
    // The point of the assertion is that the list does not GROW when the engine is swapped.
    // expectSameCodes itemises missing/extra on failure (issue #43 #20b).
    const gotCodes = new Set(findings.filter((f) => f.impact === 'content').map((f) => f.code));
    expectSameCodes(
      gotCodes,
      new Set(['ROUNDTRIP_CALLOUT_FLATTENED', 'ROUNDTRIP_ACCORDION_FLATTENED', 'ROUNDTRIP_TASK_STATE_LOST']),
      'content-impact findings',
    );
  });

  // issue #43 #20a: the former test "is therefore an article the SDK refuses to edit as
  // Markdown by default" (asserting findings.some(f.impact === 'content')) was logically
  // subsumed by the findings-set test above -- that exact non-empty three-code set implies
  // it -- and was dropped 2026-09-17. The refusal itself is pinned in
  // test/resources/articles.test.ts ("refuses an update when the STORED article would
  // lose content").
});

describe('the semantic-stability property', () => {
  /**
   * For any fixture the differ reports NO content-impact finding on, HTML -> MD -> HTML
   * must be semantically stable. "Semantically stable" is defined concretely as: both the
   * original and the rebuilt HTML fed through htmlToText yield identical strings. That
   * function already normalises whitespace, decodes entities and inserts block/cell
   * boundaries, so it compares the text a reader sees while ignoring the presentation
   * markup we have agreed to drop.
   *
   * Only HTML -> MD -> HTML is guaranteed. MD -> HTML -> MD is NOT identity -- marked and
   * turndown disagree at the edges -- and nothing here depends on it.
   */
  const stable = [
    '<h2>Setup</h2><p>Run <code>npm ci</code> first.</p>',
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '<pre><code class="language-bash">echo hi</code></pre>',
    '<p><a href="https://example.com">link</a> and <strong>bold</strong> and <em>italic</em>.</p>',
    '<blockquote><p>Quoted.</p></blockquote>',
    '<h3 class="text-left">Styled heading</h3><p style="color:#333">Styled prose.</p>',
    '<p>Entities: &amp; &lt; &gt; &quot; and &nbsp; space.</p>',
  ];

  for (const html of stable) {
    it(`is stable for: ${html.slice(0, 48)}...`, () => {
      const out = markdownToHtml(htmlToMarkdown(html));
      const lossy = diffArticleRoundTrip(html, out).filter((f) => f.impact === 'content');
      // Guard the guard: if a fixture DOES report content loss it does not belong in this
      // list, and silently skipping it would make the property vacuously true.
      expect(lossy.map((f) => f.code), 'fixture must be loss-free to test stability').toEqual([]);
      expect(htmlToText(out)).toBe(htmlToText(html));
    });
  }
});
