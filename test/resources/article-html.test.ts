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
