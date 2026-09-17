/**
 * Hudu article HTML rules — validate / normalize / round-trip diff.
 *
 * Every rule gets a violating AND a conforming fixture, plus malformed-input cases.
 * The rules themselves (and their evidence) are documented in src/resources/article-html.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  validateArticleHtml,
  normalizeArticleHtml,
  diffArticleRoundTrip,
  ARTICLE_HTML_CODES,
  ARTICLE_HTML_RULES,
  ARTICLE_HTML_ADVISORY_CODES,
  ARTICLE_HTML_PROVENANCE,
  HUDU_CALLOUT_TYPES,
} from '../../src/resources/article-html.js';
import type { ArticleHtmlFinding } from '../../src/resources/article-html.js';
import { htmlToMarkdown, markdownToHtml } from '../../src/content/markdown.js';

const codes = (findings: readonly ArticleHtmlFinding[]): string[] => findings.map((f) => f.code);
const has = (findings: readonly ArticleHtmlFinding[], code: string): boolean => codes(findings).includes(code);
const find = (findings: readonly ArticleHtmlFinding[], code: string): ArticleHtmlFinding | undefined =>
  findings.find((f) => f.code === code);

describe('the rule table and its provenance', () => {
  it('classifies every code with severity, content-vs-presentation impact, element and an audit date', () => {
    for (const code of ARTICLE_HTML_CODES) {
      const rule = ARTICLE_HTML_RULES[code];
      expect(rule, `no rule row for ${code}`).toBeDefined();
      expect(['error', 'warning']).toContain(rule.severity);
      expect(['content', 'presentation']).toContain(rule.impact);
      expect(typeof rule.element).toBe('string');
      expect(rule.verifiedOn, `${code} has no verifiedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(Object.keys(ARTICLE_HTML_RULES).sort()).toEqual([...ARTICLE_HTML_CODES].sort());
  });

  it('declares the audit the rules came from, and the editor generation they assume', () => {
    expect(ARTICLE_HTML_PROVENANCE.auditedOn).toBe('2026-09-16');
    expect(ARTICLE_HTML_PROVENANCE.editorGeneration).toMatch(/Tiptap/i);
    expect(ARTICLE_HTML_PROVENANCE.supersededEditor).toMatch(/TinyMCE/i);
    expect(ARTICLE_HTML_PROVENANCE.sources.length).toBeGreaterThanOrEqual(2);
    expect(ARTICLE_HTML_PROVENANCE.caveat).toMatch(/invalidate|re-audit/i);
  });

  it('records a rule-specific date where it differs from the main audit', () => {
    // <kbd> was first verified under TinyMCE and re-verified against Tiptap.
    expect(ARTICLE_HTML_RULES.KBD_RENDERS_UNSTYLED.firstVerifiedOn).toBe('2026-05-12');
    expect(ARTICLE_HTML_RULES.KBD_RENDERS_UNSTYLED.verifiedOn).toBe('2026-09-16');
    // The Markdown rule is a property of the content field, not of the editor audit.
    expect(ARTICLE_HTML_RULES.MARKDOWN_SYNTAX.verifiedOn).toBe('2026-04-27');
  });

  it('calls cosmetic losses presentation and semantic losses content', () => {
    for (const code of ['ALIGN_CLASS_ON_HEADING', 'ALIGN_CLASS_ON_IMAGE', 'TABLE_SCROLL_WRAPPER', 'ROUNDTRIP_THEAD_DROPPED', 'KBD_RENDERS_UNSTYLED'] as const) {
      expect(ARTICLE_HTML_RULES[code].impact, code).toBe('presentation');
    }
    for (const code of ['CALLOUT_NOT_DIV', 'ROUNDTRIP_CODE_LANGUAGE_LOST', 'ROUNDTRIP_LINK_LOST', 'ROUNDTRIP_IMG_ALT_LOST', 'ROUNDTRIP_TABLE_STRUCTURE_LOST'] as const) {
      expect(ARTICLE_HTML_RULES[code].impact, code).toBe('content');
    }
  });
});

describe('validateArticleHtml — finding shape', () => {
  it('returns an array of findings with stable code, severity, impact, element and message', () => {
    const findings = validateArticleHtml('<p class="callout callout-info">nope</p>');
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(ARTICLE_HTML_CODES).toContain(f.code);
      expect(['error', 'warning']).toContain(f.severity);
      expect(['content', 'presentation']).toContain(f.impact);
      expect(f.severity).toBe(ARTICLE_HTML_RULES[f.code].severity);
      expect(f.impact).toBe(ARTICLE_HTML_RULES[f.code].impact);
      expect(f.element).toBe(ARTICLE_HTML_RULES[f.code].element);
      expect(typeof f.message).toBe('string');
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it('lists the advisory codes so a caller can mute them wholesale', () => {
    const html = '<p>Press <kbd>Tab</kbd>.</p><ul data-type="taskList"></ul>';
    expect(validateArticleHtml(html, { ignore: ARTICLE_HTML_ADVISORY_CODES })).toEqual([]);
  });

  it('gives a location hint (index + snippet) where the offending markup starts', () => {
    const html = '<p>intro</p><img src="/x.png">';
    const alt = find(validateArticleHtml(html), 'IMG_ALT_MISSING');
    expect(alt).toBeDefined();
    expect(alt?.index).toBe(html.indexOf('<img'));
    expect(alt?.snippet).toContain('<img');
  });

  it('never mutates its input', () => {
    const html = '<pre class="language-yaml"><code>key: value</code></pre>';
    const before = html;
    validateArticleHtml(html);
    expect(html).toBe(before);
  });

  it('honours opts.ignore for advisory codes', () => {
    const html = '<p>Press <kbd>Tab</kbd>.</p>';
    expect(has(validateArticleHtml(html), 'KBD_RENDERS_UNSTYLED')).toBe(true);
    expect(has(validateArticleHtml(html, { ignore: ['KBD_RENDERS_UNSTYLED'] }), 'KBD_RENDERS_UNSTYLED')).toBe(false);
  });
});

describe('rule 1 — content must be HTML, Hudu strips or escapes Markdown', () => {
  it('flags a Markdown ATX heading', () => {
    expect(has(validateArticleHtml('# Introduction\n<p>body</p>'), 'MARKDOWN_SYNTAX')).toBe(true);
  });

  it('flags a Markdown fenced code block', () => {
    expect(has(validateArticleHtml('<p>run</p>\n```bash\nls -la\n```'), 'MARKDOWN_SYNTAX')).toBe(true);
  });

  it('flags a Markdown link', () => {
    expect(has(validateArticleHtml('<p>See [the docs](https://example.com) for more.</p>'), 'MARKDOWN_SYNTAX')).toBe(true);
  });

  it('flags a Markdown bullet list', () => {
    expect(has(validateArticleHtml('<p>Prerequisites</p>\n- PowerShell 7\n- Admin rights'), 'MARKDOWN_SYNTAX')).toBe(true);
  });

  it('does not flag Markdown-looking text that lives inside a code block', () => {
    const html =
      '<pre class="language-markdown"><code class="language-markdown"># Heading\n- bullet\n[link](https://example.com)</code></pre>';
    expect(has(validateArticleHtml(html), 'MARKDOWN_SYNTAX')).toBe(false);
  });

  it('does not flag conforming HTML', () => {
    expect(has(validateArticleHtml('<h1>Introduction</h1><p>Body text.</p>'), 'MARKDOWN_SYNTAX')).toBe(false);
  });

  it('flags non-empty content that carries no HTML element at all', () => {
    expect(has(validateArticleHtml('Just some prose with no markup.'), 'CONTENT_NOT_HTML')).toBe(true);
    expect(has(validateArticleHtml('<p>Just some prose.</p>'), 'CONTENT_NOT_HTML')).toBe(false);
  });
});

describe('rule 2 — the language class must be on <code>, not only on <pre>', () => {
  it('flags a language class present only on <pre>', () => {
    const f = find(validateArticleHtml('<pre class="language-yaml"><code>key: value</code></pre>'), 'CODE_LANGUAGE_CLASS_MISSING_ON_CODE');
    expect(f?.severity).toBe('error');
  });

  it('accepts the class on both elements', () => {
    const html = '<pre class="language-yaml"><code class="language-yaml">key: value</code></pre>';
    expect(has(validateArticleHtml(html), 'CODE_LANGUAGE_CLASS_MISSING_ON_CODE')).toBe(false);
    expect(has(validateArticleHtml(html), 'CODE_LANGUAGE_CLASS_ABSENT')).toBe(false);
  });

  it('warns when neither element carries a language class', () => {
    expect(has(validateArticleHtml('<pre><code>ls -la</code></pre>'), 'CODE_LANGUAGE_CLASS_ABSENT')).toBe(true);
  });

  it('warns (and does not auto-pick) when the two classes disagree', () => {
    const html = '<pre class="language-bash"><code class="language-powershell">Get-Service</code></pre>';
    expect(has(validateArticleHtml(html), 'CODE_LANGUAGE_CLASS_MISMATCH')).toBe(true);
    expect(normalizeArticleHtml(html)).toBe(html);
  });

  it('is quiet when only <code> carries the class (the highlighter keys off <code>)', () => {
    const html = '<pre><code class="language-json">{}</code></pre>';
    expect(validateArticleHtml(html).filter((f) => f.code.startsWith('CODE_LANGUAGE'))).toEqual([]);
  });
});

describe('rule 3 — callouts must be <div class="callout callout-X">', () => {
  it('flags a <p> carrying callout classes', () => {
    const f = find(validateArticleHtml('<p class="callout callout-info">Note</p>'), 'CALLOUT_NOT_DIV');
    expect(f?.severity).toBe('error');
  });

  it('flags a modifier class with no callout base class', () => {
    expect(has(validateArticleHtml('<div class="callout-warning"><p>Careful</p></div>'), 'CALLOUT_BASE_CLASS_MISSING')).toBe(true);
  });

  it('warns on an unknown callout type', () => {
    expect(has(validateArticleHtml('<div class="callout callout-purple"><p>Hm</p></div>'), 'CALLOUT_TYPE_UNKNOWN')).toBe(true);
  });

  it('accepts every documented callout type', () => {
    expect([...HUDU_CALLOUT_TYPES].sort()).toEqual(['danger', 'info', 'success', 'warning']);
    for (const type of HUDU_CALLOUT_TYPES) {
      const html = `<div class="callout callout-${type}"><p>Text</p></div>`;
      expect(validateArticleHtml(html).filter((f) => f.code.startsWith('CALLOUT'))).toEqual([]);
    }
  });
});

describe('rule 4 — accordion bodies need <div class="mce-accordion-body">', () => {
  const body =
    '<details class="mce-accordion"><summary class="mce-accordion-summary">Optional</summary><div class="mce-accordion-body"><p>Steps</p></div></details>';

  it('flags body content that is not wrapped', () => {
    const html = '<details class="mce-accordion"><summary class="mce-accordion-summary">Optional</summary><p>Steps</p></details>';
    const f = find(validateArticleHtml(html), 'ACCORDION_BODY_MISSING');
    expect(f?.severity).toBe('error');
  });

  it('accepts a wrapped body', () => {
    expect(validateArticleHtml(body).filter((f) => f.code.startsWith('ACCORDION'))).toEqual([]);
  });

  it('warns when <details> is missing the mce-accordion class', () => {
    const html = '<details><summary>Optional</summary><div class="mce-accordion-body"><p>Steps</p></div></details>';
    expect(has(validateArticleHtml(html), 'ACCORDION_CLASS_MISSING')).toBe(true);
  });

  it('warns about a heading inside <summary> (Tiptap strips the heading on save)', () => {
    const html =
      '<details class="mce-accordion"><summary class="mce-accordion-summary"><h2>Optional</h2></summary><div class="mce-accordion-body"><p>Steps</p></div></details>';
    expect(has(validateArticleHtml(html), 'ACCORDION_SUMMARY_BLOCK_CONTENT')).toBe(true);
  });

  it('does not flag an accordion with an empty body', () => {
    expect(has(validateArticleHtml('<details class="mce-accordion"><summary>Optional</summary></details>'), 'ACCORDION_BODY_MISSING')).toBe(false);
  });
});

describe('rule 5 — class="align-*" does not survive a resave on headings or images', () => {
  it('flags an alignment class on a heading', () => {
    expect(has(validateArticleHtml('<h2 class="align-center">Topology</h2>'), 'ALIGN_CLASS_ON_HEADING')).toBe(true);
  });

  it('flags an alignment class on an image', () => {
    expect(has(validateArticleHtml('<img class="align-center" src="/x.png" alt="Diagram">'), 'ALIGN_CLASS_ON_IMAGE')).toBe(true);
  });

  it('accepts data-align on an image and a plain heading', () => {
    const html = '<h2>Topology</h2><img data-align="center" src="/x.png" alt="Diagram">';
    expect(validateArticleHtml(html).filter((f) => f.code.startsWith('ALIGN'))).toEqual([]);
  });

  it('leaves alignment classes on non-heading blocks alone', () => {
    expect(validateArticleHtml('<p class="align-right">Last reviewed</p>').filter((f) => f.code.startsWith('ALIGN'))).toEqual([]);
  });
});

describe('rule 6 — do not hand-add a table-scroll wrapper', () => {
  it('flags the hand-added wrapper', () => {
    const html = '<div class="rich_text_content__table-scroll"><table><tr><td>a</td></tr></table></div>';
    expect(has(validateArticleHtml(html), 'TABLE_SCROLL_WRAPPER')).toBe(true);
  });

  it('accepts a plain table', () => {
    expect(has(validateArticleHtml('<table><tr><td>a</td></tr></table>'), 'TABLE_SCROLL_WRAPPER')).toBe(false);
  });
});

describe('rule 7 — task lists render display-only', () => {
  const item =
    '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Check</p></div></li>';

  it('reports the display-only advisory on a task list', () => {
    expect(has(validateArticleHtml(`<ul data-type="taskList">${item}</ul>`), 'TASK_LIST_NOT_INTERACTIVE')).toBe(true);
  });

  it('says nothing about task lists for an ordinary list', () => {
    expect(has(validateArticleHtml('<ul><li>Item</li></ul>'), 'TASK_LIST_NOT_INTERACTIVE')).toBe(false);
  });

  it('flags a task item missing the structure Hudu needs to render it', () => {
    const html = '<ul data-type="taskList"><li>Check the backup</li></ul>';
    expect(find(validateArticleHtml(html), 'TASK_ITEM_MALFORMED')?.severity).toBe('error');
  });

  it('accepts a fully-formed task item', () => {
    expect(has(validateArticleHtml(`<ul data-type="taskList">${item}</ul>`), 'TASK_ITEM_MALFORMED')).toBe(false);
  });

  it('accepts a task item whose content div holds a nested list (the nested <li>s are not task items)', () => {
    const nested =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
      '<label><input type="checkbox"><span></span></label>' +
      '<div><p>Check the backup</p><ul><li>nightly</li><li>weekly</li></ul></div>' +
      '</li></ul>';
    expect(has(validateArticleHtml(nested), 'TASK_ITEM_MALFORMED')).toBe(false);
  });

  it('checks each item once when task lists are nested', () => {
    const inner = `<ul data-type="taskList">${item}</ul>`;
    const outer =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
      `<label><input type="checkbox"><span></span></label><div><p>Parent</p>${inner}</div>` +
      '</li></ul>';
    const findings = validateArticleHtml(outer);
    expect(has(findings, 'TASK_ITEM_MALFORMED')).toBe(false);
    expect(codes(findings).filter((c) => c === 'TASK_LIST_NOT_INTERACTIVE')).toHaveLength(2);
  });

  it('still flags a malformed item that follows a well-formed one', () => {
    const html = `<ul data-type="taskList">${item}<li>bare</li></ul>`;
    expect(codes(validateArticleHtml(html)).filter((c) => c === 'TASK_ITEM_MALFORMED')).toHaveLength(1);
  });

  it('does not impose a nesting-depth limit (deep nesting is valid in Hudu)', () => {
    const deep = '<ul><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li></ul>';
    expect(validateArticleHtml(deep)).toEqual([]);
  });
});

describe('rule 8 — <img> needs a descriptive alt', () => {
  it('flags a missing alt', () => {
    expect(find(validateArticleHtml('<img src="/x.png">'), 'IMG_ALT_MISSING')?.severity).toBe('error');
  });

  it('flags an empty alt', () => {
    expect(has(validateArticleHtml('<img src="/x.png" alt="">'), 'IMG_ALT_MISSING')).toBe(true);
    expect(has(validateArticleHtml('<img src="/x.png" alt="   ">'), 'IMG_ALT_MISSING')).toBe(true);
  });

  it('accepts a descriptive alt, including on a /public_photo src', () => {
    expect(has(validateArticleHtml('<img src="/public_photo/abc123" alt="Admin console">'), 'IMG_ALT_MISSING')).toBe(false);
  });
});

describe('rule 9 — <kbd> survives the round-trip but renders unstyled', () => {
  it('reports the advisory when <kbd> is used', () => {
    const f = find(validateArticleHtml('<p>Press <kbd>Tab</kbd>.</p>'), 'KBD_RENDERS_UNSTYLED');
    expect(f?.severity).toBe('warning');
  });

  it('says nothing when <kbd> is absent', () => {
    expect(has(validateArticleHtml('<p>Press Tab.</p>'), 'KBD_RENDERS_UNSTYLED')).toBe(false);
  });
});

describe('a ">" inside an attribute value (legal, and common in Hudu screenshots)', () => {
  it('does not claim a missing alt on an image that has one', () => {
    for (const html of [
      '<img src="/public_photo/abc" alt="Settings > Users > Roles">',
      `<img src='/x.png' alt='Cost > $100'>`,
    ]) {
      expect(validateArticleHtml(html), `false IMG_ALT_MISSING for: ${html}`).toEqual([]);
    }
  });

  it('reads the whole tag, so a class after the ">" is still seen', () => {
    // `<code title="a > b" class="hljs">` has no language class; the report is a fact, not a
    // guess, because the attributes are read quote-aware rather than cut at the first ">".
    const html = '<pre class="language-js"><code title="a > b" class="hljs">x</code></pre>';
    expect(codes(validateArticleHtml(html))).toEqual(['CODE_LANGUAGE_CLASS_MISSING_ON_CODE']);
    // And one that DOES carry the class after the ">" is correctly left alone.
    const ok = '<pre class="language-js"><code title="a > b" class="language-js">x</code></pre>';
    expect(validateArticleHtml(ok).filter((f) => f.code.startsWith('CODE_LANGUAGE'))).toEqual([]);
  });

  it('extends the existing class in place — never a second class attribute', () => {
    const out = normalizeArticleHtml('<pre class="language-js"><code title="a > b" class="hljs">x</code></pre>');
    expect(out).toBe('<pre class="language-js"><code title="a > b" class="hljs language-js">x</code></pre>');
    expect((out.match(/class\s*=/gi) ?? []).length).toBe(2); // one on <pre>, one on <code>
    expect(normalizeArticleHtml(out)).toBe(out);
  });

  it('mirrors the language when the ">" is in the <pre> tag instead', () => {
    const out = normalizeArticleHtml('<pre class="language-js" title="a > b"><code>x</code></pre>');
    expect(out).toBe('<pre class="language-js" title="a > b"><code class="language-js">x</code></pre>');
    expect(normalizeArticleHtml(out)).toBe(out);
  });

  it('unwraps a table-scroll wrapper whose attribute contains a ">", without stray text', () => {
    const html =
      '<p>Intro.</p><div class="rich_text_content__table-scroll" aria-label="Costs > $100"><table><tr><td>x</td></tr></table></div><p>Outro.</p>';
    const out = normalizeArticleHtml(html);
    expect(out).toBe('<p>Intro.</p><table><tr><td>x</td></tr></table><p>Outro.</p>');
    expect(out).not.toContain('$100');
    expect(normalizeArticleHtml(out)).toBe(out);
  });

  it('still refuses a tag that is never closed at all', () => {
    for (const html of [
      '<pre class="language-bash"><code class="x">truncated',
      '<pre class="language-bash"><code class="x',
      '<div class="rich_text_content__table-scroll"><table><tr><td>a</td></tr>',
    ]) {
      expect(normalizeArticleHtml(html), `rewrote an unterminated tag: ${html}`).toBe(html);
    }
  });

  it('does not let an unterminated <code swallow the closing </pre>', () => {
    // The attribute read is bounded by the </pre>; without that bound it consumed the `>` of
    // the closing tag, which deleted the </pre> from the body. The case the sibling test above
    // misses, because every input there truncates at the END of the document.
    const html = '<pre class="language-js"><code</pre>';
    expect(normalizeArticleHtml(html)).toBe(html);
  });

  it('does not emit the <code> tag twice when a <pre> is nested', () => {
    // openTags yields the nested <pre> as well, and the </pre> search is not depth-matched, so
    // both resolve to the same <code>. Re-emitting it duplicated the opening tag.
    const html = '<pre class="language-js">outer <pre class="language-py">inner <code>x</code></pre></pre>';
    const out = normalizeArticleHtml(html);
    expect((out.match(/<code/g) ?? []).length, `duplicated the <code> tag: ${out}`).toBe(1);
    expect(normalizeArticleHtml(out)).toBe(out);
  });

  it('never extends an attribute that merely contains the text "class="', () => {
    // The read path walks attributes in order; the write path must splice where it read. When
    // the two disagreed, `data-class` grew by one `language-js` on EVERY call and never reached
    // a fixed point, while the <code> still ended up with no language class.
    for (const html of [
      '<pre class="language-js"><code data-class="foo">x</code></pre>',
      `<pre class="language-js"><code title='class="x"'>y</code></pre>`,
    ]) {
      const once = normalizeArticleHtml(html);
      expect(normalizeArticleHtml(once), `not idempotent: ${once}`).toBe(once);
      expect(once).toContain('class="language-js"');
      expect(once).not.toMatch(/language-js language-js/);
    }
  });

  it('does not treat markup written inside an attribute value as a tag', () => {
    const html = '<p title="<div class=\'callout callout-info\'>">Body.</p>';
    expect(validateArticleHtml(html).filter((f) => f.code.startsWith('CALLOUT'))).toEqual([]);
  });

  it('still reports the tags it CAN read in the same document', () => {
    const html = '<img src="/a.png" alt="Settings > Users"><img src="/b.png">';
    expect(codes(validateArticleHtml(html))).toEqual(['IMG_ALT_MISSING']);
  });

  it('REPORTS a genuinely missing alt on a tag whose other attribute contains ">"', () => {
    // The defect this parser fixes: skipping such a tag hid real faults. The alt is absent
    // here, and the `>` lives in title/aria-label — the finding must still be made.
    for (const html of [
      '<img src="/a.png" title="Settings > Users">',
      '<img src="/a.png" aria-label="Cost > $100" alt="">',
      `<img src='/a.png' title='a > b'>`,
    ]) {
      expect(codes(validateArticleHtml(html)), `missed a real fault: ${html}`).toEqual(['IMG_ALT_MISSING']);
    }
  });

  it('reads an attribute that sits AFTER the one containing ">"', () => {
    // data-align follows the `>`-bearing attribute, so an attribute-order-sensitive scan
    // would miss it; the alignment class here must still be the thing reported.
    const html = '<img title="a > b" class="align-center" src="/x.png" alt="Diagram">';
    expect(codes(validateArticleHtml(html))).toEqual(['ALIGN_CLASS_ON_IMAGE']);
  });
});

describe('Markdown detection ignores everything that is not prose', () => {
  it('ignores Markdown inside an HTML comment', () => {
    expect(has(validateArticleHtml('<p>Body.</p><!-- # TODO\n- item -->'), 'MARKDOWN_SYNTAX')).toBe(false);
  });

  it('ignores Markdown inside an attribute value', () => {
    expect(has(validateArticleHtml('<p title="[text](url)">Body.</p>'), 'MARKDOWN_SYNTAX')).toBe(false);
    expect(has(validateArticleHtml('<a href="/x" title="**bold**">link</a>'), 'MARKDOWN_SYNTAX')).toBe(false);
  });

  it('ignores Markdown inside <script> and <style> bodies', () => {
    const script = '<p>Body.</p><script>\n// # heading\nconst s = "**bold**";\n</script>';
    const style = '<p>Body.</p><style>\n/* # heading */\n.a { content: "**bold**"; }\n</style>';
    expect(has(validateArticleHtml(script), 'MARKDOWN_SYNTAX')).toBe(false);
    expect(has(validateArticleHtml(style), 'MARKDOWN_SYNTAX')).toBe(false);
  });

  it('still reports Markdown in the prose itself', () => {
    expect(has(validateArticleHtml('<!-- a note -->\n# Introduction\n<p>Body.</p>'), 'MARKDOWN_SYNTAX')).toBe(true);
  });
});

describe('validateArticleHtml — malformed input never throws', () => {
  const inputs: unknown[] = [
    '',
    '   ',
    '<p>unclosed',
    '<pre class="language-bash"><code>truncated',
    '<div class="callout callout-info"><p>nested <div class="callout callout-warning"><p>inner</p></div></p></div>',
    '<details class="mce-accordion"><summary>No end tag',
    'plain text, not html at all',
    '<<<>>>',
    '<img',
    '<p>' + 'a'.repeat(50_000) + '</p>',
    null,
    undefined,
    42,
    {},
    [],
  ];

  for (const [i, input] of inputs.entries()) {
    it(`survives input #${i}`, () => {
      const findings = validateArticleHtml(input as string);
      expect(Array.isArray(findings)).toBe(true);
    });
  }

  it('returns no findings for empty or whitespace-only content', () => {
    expect(validateArticleHtml('')).toEqual([]);
    expect(validateArticleHtml('   \n  ')).toEqual([]);
  });

  it('returns no findings for a non-string input', () => {
    expect(validateArticleHtml(undefined as unknown as string)).toEqual([]);
    expect(validateArticleHtml(123 as unknown as string)).toEqual([]);
  });
});

describe('normalizeArticleHtml', () => {
  it('mirrors a language class from <pre> onto <code>', () => {
    expect(normalizeArticleHtml('<pre class="language-yaml"><code>key: value</code></pre>')).toBe(
      '<pre class="language-yaml"><code class="language-yaml">key: value</code></pre>',
    );
  });

  it('keeps other classes on <code> when adding the language class', () => {
    expect(normalizeArticleHtml('<pre class="language-bash"><code class="hljs">ls</code></pre>')).toBe(
      '<pre class="language-bash"><code class="hljs language-bash">ls</code></pre>',
    );
  });

  it('unwraps a hand-added table-scroll div', () => {
    expect(normalizeArticleHtml('<div class="rich_text_content__table-scroll"><table><tr><td>a</td></tr></table></div>')).toBe(
      '<table><tr><td>a</td></tr></table>',
    );
  });

  it('never emits a second class attribute — a class it cannot extend is left alone', () => {
    // A parser keeps the FIRST class attribute and discards the rest, so prepending one
    // would silently delete the caller's classes. Report only.
    for (const html of [
      `<pre class="language-yaml"><code class='hljs mine'>k: v</code></pre>`,
      '<pre class="language-yaml"><code class=hljs>k: v</code></pre>',
      `<pre class="language-yaml"><code class='' >k: v</code></pre>`,
    ]) {
      const out = normalizeArticleHtml(html);
      expect(out, `rewrote a non-double-quoted class: ${html}`).toBe(html);
      expect((out.match(/class\s*=/gi) ?? []).length).toBe(2); // one on <pre>, one on <code>
    }
  });

  it('still reports the unfixable case through validate', () => {
    expect(
      has(validateArticleHtml(`<pre class="language-yaml"><code class='hljs'>k: v</code></pre>`), 'CODE_LANGUAGE_CLASS_MISSING_ON_CODE'),
    ).toBe(true);
  });

  it('refuses the table-scroll unwrap when a literal </div> may sit in a comment or attribute', () => {
    for (const html of [
      '<div class="rich_text_content__table-scroll"><table><tr><td>a</td></tr></table><!-- </div> --></div><p>after</p>',
      '<div class="rich_text_content__table-scroll"><p title="close with </div> here">x</p></div><p>after</p>',
    ]) {
      expect(normalizeArticleHtml(html), `mis-sliced: ${html}`).toBe(html);
    }
  });

  it('drops the wrapper div\'s own attributes along with the wrapper', () => {
    expect(normalizeArticleHtml('<div class="rich_text_content__table-scroll keepme" id="t1"><table><tr><td>a</td></tr></table></div>')).toBe(
      '<table><tr><td>a</td></tr></table>',
    );
  });

  it('leaves ambiguous problems alone (callouts, accordions, alignment)', () => {
    const html =
      '<p class="callout callout-info">Note</p><h2 class="align-center">T</h2><img class="align-center" src="/x.png" alt="D">';
    expect(normalizeArticleHtml(html)).toBe(html);
  });

  it('is idempotent', () => {
    const inputs = [
      '<pre class="language-yaml"><code>key: value</code></pre>',
      '<div class="rich_text_content__table-scroll"><table><tr><td>a</td></tr></table></div>',
      '<pre class="language-bash"><code class="hljs">ls</code></pre>',
      '<p>already fine</p>',
      '',
      '<pre class="language-bash"><code>truncated',
      '<div class="rich_text_content__table-scroll"><table><tr><td>a</td></tr>',
    ];
    for (const html of inputs) {
      const once = normalizeArticleHtml(html);
      expect(normalizeArticleHtml(once), `not idempotent for: ${html}`).toBe(once);
    }
  });

  it('fixes what it claims to fix — validate is quiet afterwards', () => {
    const findings = validateArticleHtml(normalizeArticleHtml('<pre class="language-yaml"><code>key: value</code></pre>'));
    expect(has(findings, 'CODE_LANGUAGE_CLASS_MISSING_ON_CODE')).toBe(false);
  });

  it('never throws on malformed or non-string input', () => {
    expect(normalizeArticleHtml('<pre class="language-bash"><code>oops')).toBe('<pre class="language-bash"><code>oops');
    expect(normalizeArticleHtml(null as unknown as string)).toBe('');
    expect(normalizeArticleHtml(undefined as unknown as string)).toBe('');
    expect(normalizeArticleHtml(7 as unknown as string)).toBe('');
  });
});

describe('diffArticleRoundTrip — the result is an enumerable, classified list', () => {
  const sent =
    '<p>See <a href="https://a.test">a</a></p><pre class="language-yaml"><code class="language-yaml">a: 1</code></pre>' +
    '<img src="/x.png" alt="Console"><h2 class="align-center">T</h2>';
  const readBack = '<p>See a</p><pre><code>a: 1</code></pre><img src="/public_photo/abc">';

  it('identifies element family, change kind, impact and the values involved for each entry', () => {
    const findings = diffArticleRoundTrip(sent, readBack);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    for (const f of findings) {
      expect(ARTICLE_HTML_CODES).toContain(f.code);
      expect(['content', 'presentation']).toContain(f.impact);
      expect(['stripped', 'escaped', 'attribute-lost', 'restructured', 'malformed']).toContain(f.change);
      expect(typeof f.element).toBe('string');
    }
    const link = find(findings, 'ROUNDTRIP_LINK_LOST');
    expect(link?.element).toBe('link');
    expect(link?.change).toBe('stripped'); // the whole <a> went, not just its href
    expect(link?.detail).toEqual(['https://a.test']);
    expect(link?.index).toBe(sent.indexOf('<a href'));
    expect(find(findings, 'ROUNDTRIP_CODE_LANGUAGE_LOST')?.detail).toEqual(['yaml']);
    expect(find(findings, 'ROUNDTRIP_IMG_ALT_LOST')?.change).toBe('attribute-lost');
  });

  it('lets a caller gate on content loss and ignore presentation loss', () => {
    const theadOnly = diffArticleRoundTrip(
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>',
      '<table><tbody><tr><th>A</th></tr><tr><td>b</td></tr></tbody></table>',
    );
    expect(theadOnly.length).toBe(1);
    expect(theadOnly.some((f) => f.impact === 'content')).toBe(false);
    expect(diffArticleRoundTrip(sent, readBack).some((f) => f.impact === 'content')).toBe(true);
  });

  it('reports an anchor that kept its text but lost its href as attribute-lost', () => {
    const f = find(diffArticleRoundTrip('<p><a href="https://a.test">a</a></p>', '<p><a>a</a></p>'), 'ROUNDTRIP_LINK_LOST');
    expect(f?.change).toBe('attribute-lost');
  });
});

describe('diffArticleRoundTrip', () => {
  it('reports nothing when Hudu returned what was sent', () => {
    const html = '<h1>Intro</h1><table><tbody><tr><th>A</th><td>b</td></tr></tbody></table>';
    expect(diffArticleRoundTrip(html, html)).toEqual([]);
  });

  it('does NOT flag the /public_photo/<slug> src rewrite', () => {
    const sent = '<p>x</p><img src="https://example.com/console.png" alt="Admin console">';
    const readBack = '<p>x</p><img src="/public_photo/9f8e7d6c" alt="Admin console">';
    expect(diffArticleRoundTrip(sent, readBack)).toEqual([]);
  });

  it('flags a dropped image alt', () => {
    const sent = '<img src="/a.png" alt="Admin console">';
    const readBack = '<img src="/public_photo/abc">';
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_IMG_ALT_LOST')).toBe(true);
  });

  it('flags a dropped image', () => {
    expect(has(diffArticleRoundTrip('<img src="/a.png" alt="A"><img src="/b.png" alt="B">', '<img src="/public_photo/a" alt="A">'), 'ROUNDTRIP_IMG_LOST')).toBe(true);
  });

  it('flags a lost code-block language class', () => {
    const sent = '<pre class="language-yaml"><code class="language-yaml">a: 1</code></pre>';
    const readBack = '<pre><code>a: 1</code></pre>';
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CODE_LANGUAGE_LOST')).toBe(true);
  });

  it('flags a lost code block', () => {
    const sent = '<pre><code class="language-bash">ls</code></pre>';
    expect(has(diffArticleRoundTrip(sent, '<p>ls</p>'), 'ROUNDTRIP_CODE_BLOCK_LOST')).toBe(true);
  });

  it('flags a dropped link href', () => {
    const sent = '<p>See <a href="https://learn.microsoft.com/x">the docs</a>.</p>';
    const readBack = '<p>See the docs.</p>';
    const f = find(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_LINK_LOST');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('https://learn.microsoft.com/x');
  });

  it('accepts links that came back unchanged in a different order', () => {
    const sent = '<a href="https://a.test">a</a><a href="https://b.test">b</a>';
    const readBack = '<a href="https://b.test">b</a><a href="https://a.test">a</a>';
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_LINK_LOST')).toBe(false);
  });

  it('flags table structure that lost rows or cells', () => {
    const sent = '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>';
    const readBack = '<table><tbody><tr><td>a</td></tr></tbody></table>';
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_TABLE_STRUCTURE_LOST')).toBe(true);
  });

  it('reports a dropped <thead> as a known-editor warning, not an error', () => {
    const sent = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>';
    const readBack = '<table><tbody><tr><th>A</th></tr><tr><td>b</td></tr></tbody></table>';
    const f = find(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_THEAD_DROPPED');
    expect(f?.severity).toBe('warning');
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_TABLE_STRUCTURE_LOST')).toBe(false);
  });

  it('reports nothing for an article that documents HTML (escaped samples beside real markup)', () => {
    // An article ABOUT Hudu callouts contains an escaped sample of the element it also uses
    // for real. A byte-identical round trip must be clean.
    const html =
      '<h1>Callouts</h1><div class="callout callout-info"><p>Like this one.</p></div>' +
      '<pre class="language-html"><code class="language-html">&lt;div class="callout callout-info"&gt;&lt;p&gt;x&lt;/p&gt;&lt;/div&gt;</code></pre>' +
      '<p>Inline sample outside a code block: &lt;div class="callout"&gt;.</p>';
    expect(diffArticleRoundTrip(html, html)).toEqual([]);
  });

  it('still flags escaping when the escaped count actually grows', () => {
    const sent = '<p>Sample: &lt;div&gt;</p><div class="callout callout-info"><p>real</p></div>';
    const readBack = '<p>Sample: &lt;div&gt;</p>&lt;div class="callout callout-info"&gt;&lt;p&gt;real&lt;/p&gt;&lt;/div&gt;';
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CONTENT_ESCAPED')).toBe(true);
    // F2 regression pin: the increase-direction message must stay byte-for-byte the pre-fix text.
    expect(find(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CONTENT_ESCAPED')?.message).toBe(
      'Hudu returned escaped text where markup was submitted: <div>, <p>. The body was stored as text, not HTML.',
    );
  });
  it('flags an escaped prose sample that re-materialises as a live <div> (issue #40, probe escaped_missed_div)', () => {
    // The materialisation direction the pre-flip guard missed: turndown un-escapes the sample
    // in the text node and marked re-materialises the raw tag, so the sample the reader is
    // meant to read and copy becomes live (unclosed) markup — escaped 1->0 while the real
    // <div> count goes 0->1.
    const html = '<p>Use &lt;div class="x"&gt; for layout.</p><p>more text</p>';
    const readBack = markdownToHtml(htmlToMarkdown(html));
    expect(readBack).toMatch(/<div\b/); // the pipeline premise the guard is closing
    const finding = find(diffArticleRoundTrip(html, readBack), 'ROUNDTRIP_CONTENT_ESCAPED');
    expect(finding?.impact).toBe('content');
  });

  it('flags an escaped table sample that re-materialises as a live table (issue #40, probe escaped_missed_table)', () => {
    // Sharpest case: the escaped sample now RENDERS as a live table — escaped 2->0 while the
    // real <table> count goes 0->1.
    const html = '<p>Example:</p><p>&lt;table&gt;&lt;tr&gt;&lt;td&gt;1&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</p>';
    const readBack = markdownToHtml(htmlToMarkdown(html));
    expect(readBack).toMatch(/<table\b/);
    const finding = find(diffArticleRoundTrip(html, readBack), 'ROUNDTRIP_CONTENT_ESCAPED');
    expect(finding?.impact).toBe('content');
  });

  it('reports nothing when the escaped sample sits inside a <pre>/<code> fence (probe escaped_in_pre)', () => {
    // The fence keeps the raw text and marked re-escapes it inside the code: the escaped
    // count round-trips identity, so the materialisation flip must not fire here.
    const html = '<pre><code>&lt;div&gt;</code></pre>';
    const readBack = markdownToHtml(htmlToMarkdown(html));
    expect(diffArticleRoundTrip(html, readBack)).toEqual([]);
  });

  it('does not flag an escaped sample lost from a dropped attribute while the real tag count is unchanged (issue #40 gate pin)', () => {
    // The flip fires on a decrease only WITH a real-tag count increase for the same name.
    // An escaped sample sitting in a non-essential attribute the converter drops is churn,
    // not loss: the real <div> survives with the same count, so the widened gate must not
    // turn this into a spurious CONTENT_ESCAPED.
    const sent = '<p>note</p><div class="callout callout-info" data-note="&lt;div&gt;">body</div>';
    const readBack = '<p>note</p><div class="callout callout-info">body</div>';
    expect(diffArticleRoundTrip(sent, readBack)).toEqual([]);
  });

  it('pins the materialisation finding at the escaped sample in the sent body (issue #40, F3 index)', () => {
    // F3: on the new (materialisation) direction no real tag exists in the sent body, so the
    // finding is positioned at the escaped entity there (first `&lt;/?div` match) instead of
    // carrying no index at all.
    const html = '<p>Use &lt;div class="x"&gt; for layout.</p><p>more text</p>';
    const readBack = markdownToHtml(htmlToMarkdown(html));
    const finding = find(diffArticleRoundTrip(html, readBack), 'ROUNDTRIP_CONTENT_ESCAPED');
    expect(finding?.index).toBeGreaterThanOrEqual(0);
    expect(finding?.index).toBe(html.indexOf('&lt;div'));
  });

  it('states observed counts without a mechanism claim for a conflated synthetic pair (issue #40, F2; synthetic)', () => {
    // F2 count-honesty (F4 absorption): the escaped sample is DROPPED — not materialised — while
    // an unrelated real <div> appears in the read-back. Counts alone cannot attribute which
    // happened, so the message must state only the observed counts. Not constructible through
    // the real md path (turndown un-escapes a prose sample rather than dropping it, so the same
    // shape materialises instead) — hence a synthetic before/after pair against diffArticleRoundTrip.
    const sent = '<p>Sample: &lt;div&gt; dropped here</p>';
    const readBack = '<p>Sample: dropped here</p><div>unrelated live tag</div>';
    const finding = find(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CONTENT_ESCAPED');
    expect(finding?.impact).toBe('content');
    expect(finding?.message).toContain('escaped count 1->0');
    expect(finding?.message).toContain('real tag count 0->1');
    expect(finding?.message.toLowerCase()).not.toMatch(/re-materialis|stored as text/);
  });

  // T4 #25 (issue #43 deferred item 25) — the escaped path's `\b` boundary had the same
  // custom-element misattribution shape as finding #13 (fixed in the RAW_ELEMENTS count in
  // batch 1): `&lt;form-row` matches `&lt;form\b`, and `<form-row` matches `<form\b`,
  // because `-` is a non-word character. Both contract directions pinned — increase and
  // materialisation (per the per-code direction policy: symmetric).
  it('increase direction names the correct element, not a custom name sharing its word prefix (T4 #25)', () => {
    // The <form-row> escaped sample churns 0->1 (markup stored as escaped text); its own
    // <form> sample is unchanged. Pre-fix the form-row sample leaked into the `form` count
    // (`&lt;form\b`), so `form` fired too and the message named the prefix element:
    // detail ['form', 'form-row'], message '<form>, <form-row>'. Post-fix only the correct
    // element is named. (This pin fails pre-fix: that is the regression proof.)
    const sent = '<p>doc &lt;form&gt;s&lt;/form&gt;</p><form-row>a</form-row>';
    const readBack = '<p>doc &lt;form&gt;s&lt;/form&gt; &lt;form-row&gt;r&lt;/form-row&gt;</p><form-row>a</form-row>';
    const finding = find(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CONTENT_ESCAPED');
    expect(finding !== undefined).toBe(true);
    expect(finding?.detail).toEqual(['form-row']);
    expect(finding?.message).toContain('<form-row>');
    expect(finding?.message).not.toContain('<form>');
    expect(finding?.index).toBe(sent.indexOf('<form-row>'));
  });

  it('materialisation direction names the correct element, not a custom name sharing its word prefix (T4 #25)', () => {
    // The <form-row> escaped sample churns 2->0 (open + close matches) while real
    // <form-row> tags go 1->2; the <form> samples are unchanged. Pre-fix the form-row
    // samples leaked into the `form` count (`&lt;form\b`), so `form` fired with an apparent
    // 3->2 decrease and was named in the message; the index also pointed at the <form>
    // sample instead of the form-row one. Post-fix only `form-row` is named, and the index
    // sits at the form-row sample. (Fails pre-fix: the regression proof.)
    const sent = '<p>doc &lt;form&gt;s&lt;/form&gt; &lt;form-row&gt;r&lt;/form-row&gt;</p><form-row>a</form-row>';
    const readBack = '<p>doc &lt;form&gt;s&lt;/form&gt;</p><form-row>a</form-row><form-row>r</form-row>';
    const finding = find(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CONTENT_ESCAPED');
    expect(finding !== undefined).toBe(true);
    expect(finding?.detail).toEqual(['form-row']);
    expect(finding?.message).toContain('<form-row> (escaped count 2->0, real tag count 1->2)');
    expect(finding?.message).not.toContain('<form> (');
    expect(finding?.index).toBe(sent.indexOf('&lt;form-row'));
  });

  it('is clean for any byte-identical round trip', () => {
    for (const html of [
      '<p>plain</p>',
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>',
      '<pre class="language-bash"><code class="language-bash">ls</code></pre><a href="https://a.test">a</a><img src="/a.png" alt="A">',
      '<p>&lt;table&gt; is written like this</p><table><tr><td>a</td></tr></table>',
    ]) {
      expect(diffArticleRoundTrip(html, html), `not clean: ${html}`).toEqual([]);
    }
  });

  it('is usable as a self-check on a local lossy transform (no Hudu involved)', () => {
    // The supported non-Hudu caller: a converter checking its own round trip before a write.
    const original = '<p>See <a href="https://a.test">docs</a>.</p><pre class="language-yaml"><code class="language-yaml">a: 1</code></pre>';
    const lossyConverted = '<p>See docs.</p><pre><code>a: 1</code></pre>';
    const lost = diffArticleRoundTrip(original, lossyConverted);
    expect(lost.some((f) => f.impact === 'content')).toBe(true);
    expect(codes(lost).sort()).toEqual(['ROUNDTRIP_CODE_LANGUAGE_LOST', 'ROUNDTRIP_LINK_LOST']);
  });

  it('flags markup that came back escaped as text', () => {
    const sent = '<table><tr><td>a</td></tr></table>';
    const readBack = '<p>&lt;table&gt;&lt;tr&gt;&lt;td&gt;a&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</p>';
    expect(has(diffArticleRoundTrip(sent, readBack), 'ROUNDTRIP_CONTENT_ESCAPED')).toBe(true);
  });

  it('flags a body that came back empty', () => {
    expect(has(diffArticleRoundTrip('<p>content</p>', ''), 'ROUNDTRIP_BODY_EMPTY')).toBe(true);
  });

  it('never throws on malformed or non-string input', () => {
    expect(Array.isArray(diffArticleRoundTrip('', ''))).toBe(true);
    expect(Array.isArray(diffArticleRoundTrip('<p>x', '<p'))).toBe(true);
    expect(diffArticleRoundTrip(null as unknown as string, undefined as unknown as string)).toEqual([]);
    expect(Array.isArray(diffArticleRoundTrip(42 as unknown as string, {} as unknown as string))).toBe(true);
  });
});

describe('round-trip diff: the families a Markdown converter destroys', () => {
  it('reports a raw element that vanished', () => {
    const sent = '<p>Watch this</p><iframe src="https://video.example.com/1"></iframe>';
    const f = diffArticleRoundTrip(sent, '<p>Watch this</p>');
    expect(has(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(true);
    expect(find(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')?.impact).toBe('content');
    expect(find(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')?.detail).toContain('iframe');
  });

  it('is symmetric: a raw element appearing from nowhere is also reported', () => {
    // The contract forbids assuming which side came from Hudu. Both directions are loss.
    const f = diffArticleRoundTrip('<p>Watch this</p>', '<p>Watch this</p><script>x()</script>');
    expect(has(f, 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(true);
  });

  it('does not report a raw element that survived', () => {
    const html = '<p>a</p><iframe src="https://video.example.com/1"></iframe>';
    expect(has(diffArticleRoundTrip(html, html), 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(false);
  });

  it('reports a callout flattened to plain prose', () => {
    const sent = '<div class="callout callout-warning"><p>Back up first.</p></div>';
    const f = diffArticleRoundTrip(sent, '<p>Back up first.</p>');
    expect(has(f, 'ROUNDTRIP_CALLOUT_FLATTENED')).toBe(true);
    expect(find(f, 'ROUNDTRIP_CALLOUT_FLATTENED')?.impact).toBe('content');
  });

  it('tolerates a callout Hudu reordered or restyled', () => {
    // Hudu legitimately reorders attributes and rewrites class order; that is not loss.
    const sent = '<div class="callout callout-info"><p>FYI</p></div>';
    const back = '<div data-type="callout" class="callout-info callout"><p>FYI</p></div>';
    expect(has(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_CALLOUT_FLATTENED')).toBe(false);
  });

  it('reports an accordion flattened away', () => {
    const sent = '<div class="mce-accordion"><summary>More</summary><div class="mce-accordion-body"><p>Detail</p></div></div>';
    const f = diffArticleRoundTrip(sent, '<p>More</p><p>Detail</p>');
    expect(has(f, 'ROUNDTRIP_ACCORDION_FLATTENED')).toBe(true);
    expect(find(f, 'ROUNDTRIP_ACCORDION_FLATTENED')?.impact).toBe('content');
  });

  it('reports task-list check state that did not survive', () => {
    const sent = '<ul data-type="taskList"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>';
    const f = diffArticleRoundTrip(sent, '<ul><li>done</li><li>todo</li></ul>');
    expect(has(f, 'ROUNDTRIP_TASK_STATE_LOST')).toBe(true);
    expect(find(f, 'ROUNDTRIP_TASK_STATE_LOST')?.impact).toBe('content');
  });

  it('does not report a task list whose checked count survived', () => {
    const sent = '<ul data-type="taskList"><li data-checked="true">done</li></ul>';
    const back = '<ul data-type="taskList"><li data-checked="true">done</li></ul>';
    expect(has(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_TASK_STATE_LOST')).toBe(false);
  });

  it('leaves an ordinary article with only class and style attributes clean', () => {
    // The load-bearing calibration case: if ordinary articles report content loss, every
    // Markdown update refuses and the feature is useless.
    const sent = '<h2 class="text-left">Setup</h2><p style="color:#333">Run it.</p>';
    const back = '<h2>Setup</h2><p>Run it.</p>';
    expect(diffArticleRoundTrip(sent, back).filter((f) => f.impact === 'content')).toEqual([]);
  });

  // Regression coverage: these three fixtures are chosen specifically to trip on the
  // `[^>]*`-spanning regexes the brief itself proposed and this file discarded in favour of
  // the quote-aware `openTags`/`classOf`/`hasClass` helpers. Confirmed by executing the
  // brief's original regex-based `countCallouts`/`countAccordions` against these exact
  // fixtures: the first two silently count 0 callouts in both `sent` and `readBack` (so no
  // finding would fire), and the third double-counts the accordion to 2 instead of 1 (so the
  // finding's `detail` would read "accordion: 2 -> 0", not "accordion: 1 -> 0").
  it('reports a callout dropped even when a preceding attribute contains ">"', () => {
    const sent = '<div title="a > b" class="callout"><p>Back up first.</p></div>';
    expect(has(diffArticleRoundTrip(sent, '<p>Back up first.</p>'), 'ROUNDTRIP_CALLOUT_FLATTENED')).toBe(true);
  });

  it('reports a callout dropped when its class attribute is single-quoted', () => {
    const sent = "<div class='callout'><p>Back up first.</p></div>";
    expect(has(diffArticleRoundTrip(sent, '<p>Back up first.</p>'), 'ROUNDTRIP_CALLOUT_FLATTENED')).toBe(true);
  });

  it('counts an accordion once, not twice, for its own body wrapper', () => {
    const sent = '<div class="mce-accordion"><summary>More<div class="mce-accordion-body"><p>Detail</p></div></div>';
    const f = find(diffArticleRoundTrip(sent, '<p>More</p><p>Detail</p>'), 'ROUNDTRIP_ACCORDION_FLATTENED');
    expect(f?.detail).toEqual(['accordion: 1 -> 0']);
  });

  // issue #43 F11 — the input/checkbox landmine: `input` sits in RAW_ELEMENTS while
  // countTaskItems already treats <input type="checkbox"> as a valid task representation.
  // Role note (2026-09-17 fix-round, B1-F3): this real-Markdown-path test PASSES on the
  // pre-fix baseline (reviewer-measured on pristine 80f9e0c), so it is a REGRESSION GUARD
  // for the full chain, not the #11 pin — the pin is the synthetic churn test below, which
  // does fail pre-fix.
  it('regression guard (passes pre-fix, not the #11 pin): a GFM task list whose <li><input type="checkbox"> form round-trips the real Markdown path', () => {
    // Constructed through the real converter path: turndown emits a GFM task list and
    // marked re-emits <input … type="checkbox"> for it, so the representation churns but no
    // raw element is lost (T2 memo probe `task_input`).
    const sent = '<ul data-type="taskList"><li><input type="checkbox" checked="">a</li><li><input type="checkbox">b</li></ul>';
    const back = markdownToHtml(htmlToMarkdown(sent));
    expect(has(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(false);
  });

  it('does not flag a task representation churn (synthetic pair: <li><input type="checkbox"> <-> <li data-checked="true">)', () => {
    // The live-Hudu direction the real Markdown path cannot produce (the memo's landmine):
    // the editor stores the task in the OTHER representation. Synthetic before/after pair
    // through diffArticleRoundTrip, both directions; the state is preserved, so no
    // task-state finding is expected either.
    const inputForm = '<ul data-type="taskList"><li><input type="checkbox" checked="">a</li></ul>';
    const dataCheckedForm = '<ul data-type="taskList"><li data-checked="true">a</li></ul>';
    expect(has(diffArticleRoundTrip(inputForm, dataCheckedForm), 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(false);
    expect(has(diffArticleRoundTrip(dataCheckedForm, inputForm), 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(false);
    expect(has(diffArticleRoundTrip(inputForm, dataCheckedForm), 'ROUNDTRIP_TASK_STATE_LOST')).toBe(false);
  });

  it('still flags a standalone checkbox (outside any list item) lost by the real Markdown path', () => {
    // The precision control: the F11 exclusion is task-context only — a lone
    // <input type="checkbox"> is not a task item and its loss must still fire (T2 memo
    // probe `raw_input`).
    const sent = '<p>Watch this</p><input type="checkbox">';
    const back = markdownToHtml(htmlToMarkdown(sent));
    const f = find(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_RAW_ELEMENT_LOST');
    expect(f !== undefined).toBe(true);
    expect(f?.detail).toContain('input');
  });

  it('still flags a checkbox lost after an implicitly-closed <li> ends the list (post-list pin, B1-F1)', () => {
    // Pre-fix, countTaskContextCheckboxes kept one document-wide liDepth that neither
    // </ul> nor an implicitly-closed <li> reset, so a checkbox AFTER the list's end was
    // still excluded from the raw count and its loss stayed silent (reviewer probe F2).
    // This pin fails against the pre-fix-ROUND code (checkpoint f48a168cc6 = 80f9e0c +
    // the Batch-1 tree; verified in the fix-round report). On pristine 80f9e0c the
    // exclusion itself did not exist, so the loss already fired there.
    const sent = '<ul><li>a<li>b</ul><input type="checkbox">';
    const back = '<ul><li>a<li>b</ul>';
    const f = find(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_RAW_ELEMENT_LOST');
    expect(f !== undefined).toBe(true);
    expect(f?.detail).toContain('input');
  });

  it('points the RAW_ELEMENTS finding at the real element, not a custom name sharing its prefix (B1-F2)', () => {
    // The count moved to the exact <name(?![\w-]) boundary; the index/snippet hint must
    // use the SAME one, or a lost real <form> next to a <form-row> points the caller at
    // the custom element (pre-fix probe K: index 8 = <form-row>).
    const sent = '<p>t</p><form-row>a</form-row><form>b</form>';
    const back = '<p>t</p><form-row>a</form-row>';
    const f = find(diffArticleRoundTrip(sent, back), 'ROUNDTRIP_RAW_ELEMENT_LOST');
    expect(f !== undefined).toBe(true);
    expect(f?.detail).toEqual(['form']);
    expect(f?.index).toBe(sent.indexOf('<form>'));
    expect(f?.snippet?.startsWith('<form>')).toBe(true);
  });

  // issue #43 F13 — the shared `\b` boundary counted <form-row> as a <form>, <input-group>
  // as an <input> and <audio-note> as an <audio>.
  it('does not count custom-element names as raw elements (<form-row>, <input-group>, <audio-note>)', () => {
    const sent = '<p>t</p><form-row>a</form-row><input-group>b</input-group><audio-note>c</audio-note>';
    expect(has(diffArticleRoundTrip(sent, '<p>t</p>'), 'ROUNDTRIP_RAW_ELEMENT_LOST')).toBe(false);
  });

  it('still flags a real <form>/<input>/<audio> loss (F13 control)', () => {
    const f = diffArticleRoundTrip('<p>t</p><form><input type="text"><audio src="a.mp3"></form>', '<p>t</p>');
    const lost = f.filter((x) => x.code === 'ROUNDTRIP_RAW_ELEMENT_LOST').map((x) => x.detail?.[0]).sort();
    expect(lost).toEqual(['audio', 'form', 'input']);
  });

  // issue #43 F16 — a non-canonical <div class="mce-accordion"> wrapping a <details>
  // counted 2; normalising it to the canonical single element then fired a false
  // ROUNDTRIP_ACCORDION_FLATTENED (pre-fix probe: "accordion: 2 -> 1").
  it('does not flag a non-canonical <div.mce-accordion> wrapping <details> canonicalised to one element', () => {
    const sent = '<div class="mce-accordion"><details class="mce-accordion"><summary>More</summary><p>Detail</p></details></div>';
    const back = '<details class="mce-accordion"><summary>More</summary><p>Detail</p></details>';
    expect(diffArticleRoundTrip(sent, back).filter((x) => x.code === 'ROUNDTRIP_ACCORDION_FLATTENED')).toEqual([]);
  });
});

describe('the module is reachable from the package barrels', () => {
  it('is exported from the root barrel and the resources barrel', async () => {
    const root = await import('../../src/index.js');
    const resources = await import('../../src/resources/index.js');
    for (const name of ['validateArticleHtml', 'normalizeArticleHtml', 'diffArticleRoundTrip'] as const) {
      expect(typeof (root as Record<string, unknown>)[name]).toBe('function');
      expect(typeof (resources as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
