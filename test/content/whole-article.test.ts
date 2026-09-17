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

  it('does not let literal Markdown characters in prose turn into markup', () => {
    expect(htmlToText(rebuilt)).toContain('*not emphasis*');
    expect(htmlToText(rebuilt)).toContain('# not a heading');
    expect(rebuilt).not.toMatch(/<em>not emphasis<\/em>/);
  });

  it('keeps the table, the code fence and its language', () => {
    expect(rebuilt).toContain('<table>');
    expect(rebuilt).toMatch(/<code[^>]*class="[^"]*language-bash/);
  });

  it('reports exactly the structures Markdown cannot hold, and no others', () => {
    // These three are known, accepted losses -- a Markdown editor cannot express them.
    // The point of the assertion is that the list does not GROW when the engine is swapped.
    expect(new Set(findings.filter((f) => f.impact === 'content').map((f) => f.code))).toEqual(
      new Set(['ROUNDTRIP_CALLOUT_FLATTENED', 'ROUNDTRIP_ACCORDION_FLATTENED', 'ROUNDTRIP_TASK_STATE_LOST']),
    );
  });

  it('is therefore an article the SDK refuses to edit as Markdown by default', () => {
    expect(findings.some((f) => f.impact === 'content')).toBe(true);
  });
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
