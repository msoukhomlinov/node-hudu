/**
 * HTML <-> Markdown conversion.
 *
 * These assert BEHAVIOUR, not turndown's exact formatting, wherever the difference is
 * cosmetic -- the converter is a swap unit (see src/content/turndown-engine.ts). Where a
 * test pins exact output, a comment says why that exact shape is load-bearing.
 */
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from '../../src/content/markdown.js';
import { DEFAULT_MAX_DOC_BYTES } from '../../src/search/html.js';
import { HuduConfigError } from '../../src/errors.js';

describe('htmlToMarkdown', () => {
  it('converts a GFM table with a header row', () => {
    const md = htmlToMarkdown('<table><thead><tr><th>Host</th><th>IP</th></tr></thead><tbody><tr><td>vpn1</td><td>10.0.0.1</td></tr></tbody></table>');
    // Cell content and the header separator are behaviour; column padding is not.
    expect(md).toMatch(/\|\s*Host\s*\|\s*IP\s*\|/);
    expect(md).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(md).toMatch(/\|\s*vpn1\s*\|\s*10\.0\.0\.1\s*\|/);
  });

  it('converts a wide table, which Hudu auto-wraps in a scroll div', () => {
    const cells = Array.from({ length: 12 }, (_, i) => `<th>Column ${i}</th>`).join('');
    const body = Array.from({ length: 12 }, (_, i) => `<td>v${i}</td>`).join('');
    const md = htmlToMarkdown(`<div class="table-scroll-wrapper"><table><thead><tr>${cells}</tr></thead><tbody><tr>${body}</tr></tbody></table></div>`);
    expect(md).toContain('Column 11');
    expect(md).toContain('v11');
  });

  it('converts nested lists four deep -- the SDK imposes no depth limit', () => {
    const html = '<ul><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li></ul>';
    const md = htmlToMarkdown(html);
    for (const item of ['a', 'b', 'c', 'd']) expect(md).toContain(item);
    // Depth is behaviour: 'd' must be indented further than 'a'.
    const indent = (t: string) => (md.split('\n').find((l) => l.includes(t)) ?? '').search(/\S/);
    expect(indent('d')).toBeGreaterThan(indent('a'));
  });

  it('keeps the language of a fenced code block', () => {
    const md = htmlToMarkdown('<pre><code class="language-bash">npm run build</code></pre>');
    // Exact shape IS load-bearing: the fence info string is the only place the language
    // survives in Markdown, and markdownToHtml must put it back on the <code> element.
    expect(md).toContain('```bash');
    expect(md).toContain('npm run build');
  });

  it('keeps links and images with their href, alt and public_photo src', () => {
    const md = htmlToMarkdown('<p><a href="https://example.com/kb">KB</a> <img src="/public_photo/abc-123" alt="Topology"></p>');
    expect(md).toContain('[KB](https://example.com/kb)');
    expect(md).toContain('![Topology](/public_photo/abc-123)');
  });

  it('survives malformed HTML without throwing', () => {
    for (const bad of [
      '<p>unclosed',
      '<p>stray</p></div>',
      '<a href="a>b.html">gt inside an attribute value</a>',
      '<table><tr><td>no tbody',
    ]) {
      expect(() => htmlToMarkdown(bad), bad).not.toThrow();
    }
  });

  it('refuses input over the shared 256 KiB document cap instead of truncating', () => {
    const huge = `<p>${'x'.repeat(DEFAULT_MAX_DOC_BYTES + 1)}</p>`;
    // The cap error keeps code CONFIG_ERROR (issue #43, Batch 2 fix-round N1): only the
    // empty-output refusal moved to CONVERSION_EMPTY_OUTPUT, so the articles.update
    // total-loss guard still lets this one propagate unchanged.
    let err: unknown;
    try {
      htmlToMarkdown(huge);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HuduConfigError);
    expect((err as HuduConfigError).code).toBe('CONFIG_ERROR');
  });

  it('refuses to turn non-empty input into empty output', () => {
    // A blank result would overwrite someone's documentation with nothing.
    // turndown drops comments entirely (unlike `<script>`, whose text content survives
    // as plain text), so a comment-only document is the case that genuinely empties.
    expect(() => htmlToMarkdown('<!-- just a comment -->')).toThrow(HuduConfigError);
  });

  it('tags the empty-output refusal with CONVERSION_EMPTY_OUTPUT, distinct from the cap code', () => {
    // issue #43, Batch 2 fix-round N1: articles.update matches on this code (not the
    // message text) to re-type total loss as CONTENT_LOSS. Both directions of the seam
    // share assertNotEmptied, so both must carry the code.
    let htmlErr: unknown;
    try {
      htmlToMarkdown('<!-- just a comment -->');
    } catch (e) {
      htmlErr = e;
    }
    expect(htmlErr).toBeInstanceOf(HuduConfigError);
    expect((htmlErr as HuduConfigError).code).toBe('CONVERSION_EMPTY_OUTPUT');
    let mdErr: unknown;
    try {
      markdownToHtml('[foo]: /url "title"');
    } catch (e) {
      mdErr = e;
    }
    expect(mdErr).toBeInstanceOf(HuduConfigError);
    expect((mdErr as HuduConfigError).code).toBe('CONVERSION_EMPTY_OUTPUT');
  });

  it('returns empty for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('markdownToHtml', () => {
  it('restores the language class on the <code> element, not just the <pre>', () => {
    // Hudu's rule CODE_LANGUAGE_CLASS_MISSING_ON_CODE is an error-severity content rule:
    // the class must sit on <code>. This is the exact shape that satisfies it.
    const html = markdownToHtml('```bash\nnpm run build\n```');
    expect(html).toMatch(/<code[^>]*class="[^"]*language-bash/);
  });

  it('builds a GFM table', () => {
    const html = markdownToHtml('| Host | IP |\n| --- | --- |\n| vpn1 | 10.0.0.1 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Host</th>');
    expect(html).toContain('<td>10.0.0.1</td>');
  });

  it('does not turn a single newline into a <br> (breaks: false)', () => {
    expect(markdownToHtml('one\ntwo')).not.toContain('<br');
  });

  it('accepts malformed markdown rather than erroring', () => {
    expect(() => markdownToHtml('| broken |\n| --')).not.toThrow();
  });

  it('refuses to turn non-empty markdown into empty HTML', () => {
    // A body of only link-reference definitions renders to nothing. Writing it would
    // replace a stored article with a blank body.
    expect(() => markdownToHtml('[foo]: /url "title"')).toThrow(HuduConfigError);
  });

  it('returns empty for empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });
});

describe('round trip', () => {
  it('is stable for content markdown can carry', () => {
    const original = '<h2>Setup</h2><p>Run <code>npm ci</code> first.</p><ul><li>one</li><li>two</li></ul>';
    const once = markdownToHtml(htmlToMarkdown(original));
    const twice = markdownToHtml(htmlToMarkdown(once));
    expect(htmlToMarkdown(twice)).toBe(htmlToMarkdown(once));
  });
});
