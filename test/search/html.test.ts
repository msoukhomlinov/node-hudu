/**
 * HTML -> text extraction tests.
 *
 * Proof obligations from the design (`.run/design/search/html-and-snippets.md` S2):
 *   - the naive-regex failures are regression cases, not decoration: raw-skip bodies must not
 *     leak, `if (1<2)` must not swallow the document, table cells must not glue, entities decode;
 *   - the output contract holds (separator alphabet, no double newline, no space next to a
 *     newline, trimmed, no markup, unknown entities literal);
 *   - truncation is reported, never silent;
 *   - a worst-case ~200 KB input is bounded (generous ceiling, measured value in the report).
 */
import { describe, it, expect } from 'vitest';
import {
  htmlToText, extractHtml, decodeEntities, decodeEntityBody, compactWhitespace, NAMED_ENTITIES,
  DEFAULT_MAX_DOC_BYTES,
} from '../../src/search/html.js';

/** Article 16's real shape: one newline-free line, entities, a bordered table with cells. */
const ARTICLE_16 =
  '<h1>Introduction</h1><p>This comprehensive guide provides the latest FortiOS software recommendations for optimal stability and deployment success.</p>' +
  '<p>The content is automatically synchronised from&nbsp;<a href="https://community.fortinet.com/t5/FortiGate/Technical-Tip-Recommended-Release-for-FortiOS/ta/p/227178" rel="noopener" target="_blank">https://community.fortinet.com/t5/FortiGate/Technical-Tip-Recommended-Release-for-FortiOS/ta/p/227178</a>.</p>' +
  '<p><strong>Current as of</strong>: Thu 10 July 2025, 10:20 am GMT+10</p><h1>Recommended releases</h1>' +
  '<table><thead><tr><th>Product Family</th><th>Product Details</th><th>Recommended Release</th></tr></thead><tbody>' +
  '<tr><td>Low End</td><td>FortiGateRugged-35D</td><td>6.2.16</td><td>Y</td></tr>' +
  '<tr><td>Low End</td><td>FortiGate-30E</td><td>6.2.16</td><td>Y</td></tr></tbody></table>';

/** Article 33's real shape (created through the API): awkward markup the extractor must survive. */
const SPECIMEN =
  '<!-- leading comment: should never appear in extracted text -->' +
  '<style>.x{color:red}</style><h2 style="color:#f00;font-weight:700">Awkward Markup</h2>' +
  '<p>Falcon zephirine cutover &amp; rollback notes &mdash; see &#8212; the &#x2014; table &lt;below&gt;.</p>' +
  '<p><img src="data:image/png;base64,iVBORw0KGgo" alt="tiny"></p>' +
  '<ul>\n<li>First bullet</li>\n<li>Second bullet with&nbsp;nbsp</li>\n</ul>' +
  '<table><thead><tr><th>Host</th><th>Serial</th></tr></thead><tbody>' +
  '<tr><td>ws-013</td><td>SER88N9X</td></tr><tr><td>ws-012</td><td>SER77M1P</td></tr></tbody></table>' +
  '<p>Unknown entity &foo; and numeric &#169; and hex &#xA9; stay literal.</p>' +
  '<pre><code>line one\nline two\tindented</code></pre>' +
  '<p><b>Unclosed paragraph with bold text<p>' +
  '<script>var secret = "zephirine"; if (1<2) { alert("\u00a0"); }</script></p>' +
  '<p>' + 'A'.repeat(220) + ' token then normal text resumes.</p>' +
  '<p>Final paragraph with a link&amp;more.</p>';

const MARKUP_LEAK = /<\/?(?:p|div|td|th|tr|table|thead|tbody|ul|ol|li|strong|b|i|em|h1|h2|h3|h4|h5|h6|script|style|img|a|pre|code|span|br)\b/i;

describe('htmlToText: separators are inserted, never inherited', () => {
  it('puts a space between table cells (the measured naive failure)', () => {
    const text = htmlToText('<tr><td>Low End</td><td>FortiGateRugged-35D</td></tr>');
    expect(text).toBe('Low End FortiGateRugged-35D');
    expect(text).not.toContain('Low EndFortiGateRugged-35D');
  });

  it('keeps article 16 readable: rows, headers and entities', () => {
    const text = htmlToText(ARTICLE_16);
    expect(text).toContain('Low End FortiGateRugged-35D 6.2.16 Y');
    expect(text).toContain('Product Family Product Details Recommended Release');
    expect(text).toContain('synchronised from https://community.fortinet.com/');
    expect(text).not.toContain('&nbsp;');
    expect(text).not.toContain('<a ');
    expect(MARKUP_LEAK.test(text)).toBe(false);
  });

  it('emits a newline at block boundaries and nothing at inline boundaries', () => {
    expect(htmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(htmlToText('foo<span>bar</span>baz')).toBe('foobarbaz');
    expect(htmlToText('<div>x<br>y</div>')).toBe('x\ny');
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb');
  });

  it('gives <br> a newline but a cell only a space', () => {
    expect(htmlToText('<td>a</td><br><td>b</td>')).toBe('a\nb');
  });

  it('collapses horizontal whitespace and trims', () => {
    expect(htmlToText('  <p>  spaced \n\t out  </p>  ')).toBe('spaced out');
  });

  it('folds Unicode spaces and drops controls', () => {
    expect(htmlToText('a\u00a0b\u2003c\u200bd\ufeffe')).toBe('a b c d e');
    expect(htmlToText('a\u0000b\u0007c\u0085d')).toBe('abc d');
    expect(htmlToText('x\u2028y\u2029z')).toBe('x y z');
  });

  it('never leaves a double newline or a space beside a newline', () => {
    const text = htmlToText('<p>a</p><p></p><p>   </p><div></div><p>\n b \n</p>');
    expect(text).toBe('a\nb');
    expect(/[ ]\n|\n /.test(text)).toBe(false);
  });

  it('is deterministic: the same bytes always produce the same text', () => {
    const once = htmlToText(SPECIMEN);
    expect(htmlToText(SPECIMEN)).toBe(once);
    expect(htmlToText(SPECIMEN)).toBe(once);
    // Re-extraction is NOT generally idempotent (a decoded `<below>` would become a tag), but
    // plain extracted text with no markup characters and no newlines is stable.
    const simple = htmlToText('<p>Plain   text here</p>');
    expect(htmlToText(simple)).toBe(simple);
  });
});

describe('htmlToText: raw-skip elements and markup removal', () => {
  it('drops script and style bodies (the vendor stores them verbatim)', () => {
    const text = htmlToText(SPECIMEN);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('zephirine";');
    expect(text).toContain('Awkward Markup');
  });

  it('does not let `if (1<2)` swallow the rest of the document', () => {
    const text = htmlToText('<p>before</p><script>if (1<2) { x(); }</script><p>after survives</p>');
    expect(text).toBe('before\nafter survives');
  });

  it('drops comments, head/svg/noscript/template bodies and declarations', () => {
    expect(htmlToText('a<!-- b <p>c</p> d -->e')).toBe('ae');
    expect(htmlToText('<head><title>t</title></head><body>b</body><svg><path d="M0"/></svg>')).toBe('b');
    expect(htmlToText('<noscript>ns</noscript><template>tpl</template>x')).toBe('x');
    expect(htmlToText('<?xml version="1.0"?><!DOCTYPE html>y')).toBe('y');
  });

  it('keeps CDATA inner text and drops the wrapper', () => {
    expect(htmlToText('<p>a</p><![CDATA[visible cdata]]><p>b</p>')).toBe('a\nvisible cdata\nb');
  });

  it('never leaks a tag name, even from article 16 and the specimen', () => {
    expect(MARKUP_LEAK.test(htmlToText(ARTICLE_16))).toBe(false);
    expect(MARKUP_LEAK.test(htmlToText(SPECIMEN))).toBe(false);
  });

  it('does not treat a decoded `<` in prose as markup', () => {
    const text = htmlToText('<p>table &lt;below&gt;.</p>');
    expect(text).toBe('table <below>.');
  });
});

describe('htmlToText: malformed and adversarial markup degrades locally', () => {
  it('survives unclosed inline and block tags', () => {
    expect(htmlToText('<p><b>bold text')).toBe('bold text');
    expect(htmlToText('<div><p>Unclosed')).toBe('Unclosed');
  });

  it('drops a tag left open at EOF without echoing it', () => {
    expect(htmlToText('text<a href="x')).toBe('text');
    expect(htmlToText('<a href="x')).toBe('');
  });

  it('ignores a stray close tag', () => {
    expect(htmlToText('a</script>b')).toBe('ab');
  });

  it('treats `>` inside a quoted attribute as part of the value', () => {
    expect(htmlToText('<a title="a>b>c">text</a>')).toBe('text');
  });

  it('drops an unterminated comment to EOF', () => {
    expect(htmlToText('<p>kept</p><!-- never closed ' + '<'.repeat(200))).toBe('kept');
  });

  it('keeps an unclosed raw-skip body out of the text (one bounded scan)', () => {
    expect(htmlToText('ok<script>' + 'if (1<2) {} '.repeat(50))).toBe('ok');
  });

  it('treats an unclosed <pre> as pre to EOF', () => {
    expect(htmlToText('a<pre>x\ny')).toBe('a\nx\ny');
  });

  it('respects a self-closing pre/raw tag', () => {
    expect(htmlToText('a<pre/>b')).toBe('a\nb');
    expect(htmlToText('a<br/>b')).toBe('a\nb');
  });

  it('handles nested pre and close-before-open', () => {
    expect(htmlToText('<pre>a\n<pre>b</pre></pre><p>c</p>')).toBe('a\nb\nc');
  });

  it('requires a real close tag for a raw-skip element', () => {
    expect(htmlToText('<script>x</scriptx>still script</script><p>after</p>')).toBe('after');
  });

  it('matches close tags case-insensitively', () => {
    expect(htmlToText('<SCRIPT>body</SCRIPT><p>after</p>')).toBe('after');
  });

  it('does not scan a `;` more than 12 characters away as an entity terminator', () => {
    expect(htmlToText('<p>a & b c d e f g h ; i</p>')).toBe('a & b c d e f g h ; i');
  });
});

describe('entity decoding', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;&mdash;&hellip;&copy;')).toBe('&<>"\'\u00a0\u2014\u2026\u00a9');
    expect(decodeEntities('&#169;&#8364;&#x2014;&#XA9;')).toBe('\u00a9\u20ac\u2014\u00a9');
    expect(decodeEntities('caf&eacute; &Eacute;tude &uuml;ber')).toBe('caf\u00e9 \u00c9tude \u00fcber');
  });

  it('treats the entity table as data with no duplicate spellings', () => {
    expect(NAMED_ENTITIES.amp).toBe('&');
    expect(NAMED_ENTITIES.nbsp).toBe('\u00a0');
    expect(Object.keys(NAMED_ENTITIES).length).toBeGreaterThan(140);
  });

  it('leaves an unknown named entity literal', () => {
    expect(decodeEntities('&foo; and &unknownentity; here')).toBe('&foo; and &unknownentity; here');
  });

  it('does not decode a missing-semicolon legacy entity', () => {
    expect(decodeEntities('a &amp b')).toBe('a &amp b');
  });

  it('maps invalid and out-of-range numeric references to U+FFFD', () => {
    expect(decodeEntityBody('#0')).toBe('\ufffd');
    expect(decodeEntityBody('#x0')).toBe('\ufffd');
    expect(decodeEntityBody('#55296')).toBe('\ufffd');
    expect(decodeEntityBody('#xD800')).toBe('\ufffd');
    expect(decodeEntityBody('#153')).toBe('\ufffd');
    expect(decodeEntityBody('#1114112')).toBe('\ufffd');
    expect(decodeEntityBody('#x110000')).toBe('\ufffd');
    expect(decodeEntityBody('#x1F600')).toBe('\u{1f600}');
    expect(decodeEntityBody('#')).toBeUndefined();
    expect(decodeEntityBody('#x')).toBeUndefined();
    expect(decodeEntityBody('#12z')).toBeUndefined();
    expect(decodeEntityBody('')).toBeUndefined();
    expect(decodeEntityBody('1abc')).toBeUndefined();
    expect(decodeEntityBody('foo-bar')).toBeUndefined();
    expect(decodeEntityBody('amp')).toBe('&');
    expect(decodeEntityBody('notanentity')).toBeUndefined();
  });

  it('keeps a bare `&` and a late `;` literal', () => {
    expect(decodeEntities('a & b')).toBe('a & b');
    expect(decodeEntities('&;')).toBe('&;');
    expect(decodeEntities('')).toBe('');
    expect(decodeEntities('no entities at all')).toBe('no entities at all');
  });
});

describe('img alt text', () => {
  it('keeps alt text and ignores src (never index a base64 blob)', () => {
    const text = htmlToText('<p><img src="data:image/png;base64,iVBORw0KGgo" alt="tiny"></p>');
    expect(text).toBe('tiny');
  });

  it('reads single-quoted, unquoted and entity-bearing alt values', () => {
    expect(htmlToText("<img alt='quoted here'>")).toBe('quoted here');
    expect(htmlToText('<img alt=bare>')).toBe('bare');
    expect(htmlToText('<img alt="a &amp; b">')).toBe('a & b');
    expect(htmlToText('<img alt="  spaced   out  ">')).toBe('spaced out');
  });

  it('emits nothing for an alt-less or empty-alt image', () => {
    expect(htmlToText('<p>a</p><img src="/public_photo/1478debd5740"><p>b</p>')).toBe('a\nb');
    expect(htmlToText('<img alt="">')).toBe('');
  });
});

describe('bounding: maxDocBytes and maxOutChars are reported, never silent', () => {
  it('reports the raw byte length and no truncation for a small document', () => {
    const r = extractHtml('<p>hello</p>');
    expect(r).toMatchObject({ text: 'hello', rawBytes: 12, scannedBytes: 12, bytesTruncated: false, charsTruncated: false });
  });

  it('cuts raw input at maxDocBytes measured in UTF-8 bytes', () => {
    const html = '<p>' + '\u00e9'.repeat(100) + '</p>'; // 3 bytes per char
    const r = extractHtml(html, { maxDocBytes: 30 });
    expect(r.bytesTruncated).toBe(true);
    expect(r.scannedBytes).toBeLessThanOrEqual(30);
    expect(r.rawBytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(r.text.length).toBeLessThan(100);
  });

  it('stops accumulating at maxOutChars and flags it', () => {
    const r = extractHtml('<p>' + 'abcd '.repeat(50) + '</p>', { maxOutChars: 10 });
    expect(r.charsTruncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(10);
    expect(r.text).toBe('abcd abcd');
  });

  it('flags truncation when the cap lands exactly on the output', () => {
    const r = extractHtml('<p>' + 'a'.repeat(50) + '</p>', { maxOutChars: 4 });
    expect(r.text).toBe('aaaa');
    expect(r.charsTruncated).toBe(true);
  });

  it('does not flag truncation when output fits exactly', () => {
    const r = extractHtml('abcd', { maxOutChars: 4 });
    expect(r).toMatchObject({ text: 'abcd', charsTruncated: false });
  });

  it('exposes the raw cap default', () => {
    expect(DEFAULT_MAX_DOC_BYTES).toBe(256 * 1024);
  });

  it('drops a further run once the cap was already reached by a separator', () => {
    const r = extractHtml('<p>ab</p><p>cd</p>', { maxOutChars: 2 });
    expect(r.text).toBe('ab');
    expect(r.charsTruncated).toBe(true);
  });

  it('ignores `<` followed by a non-name character', () => {
    expect(htmlToText('a< >b')).toBe('ab');
    expect(htmlToText('a<	>b')).toBe('ab');
  });

  it('never emits more than the output cap once multiple blocks are pending', () => {
    const r = extractHtml('<p>aa</p><p>bb</p><p>cc</p>', { maxOutChars: 5 });
    expect(r.text.length).toBeLessThanOrEqual(5);
    expect(r.charsTruncated).toBe(true);
  });
});

describe('public surface', () => {
  it('keeps the extractor and snippet builder OUT of the package root (additive-only surface)', async () => {
    const root = await import('../../src/index.js');
    for (const name of ['htmlToText', 'extractHtml', 'decodeEntities', 'buildSnippet', 'foldWithMap', 'foldText']) {
      expect(name in root).toBe(false);
    }
  });
});

describe('compactWhitespace', () => {
  it('collapses each whitepace run to one separator and trims', () => {
    expect(compactWhitespace('  a \n\n b  c ')).toBe('a\nb c');
    expect(compactWhitespace('')).toBe('');
    expect(compactWhitespace('   ')).toBe('');
    expect(compactWhitespace('a\n \nb')).toBe('a\nb');
  });
});

describe('perf bound: a worst-case ~200 KB input stays bounded', () => {
  const worst = (() => {
    const nested = '<div><p>'.repeat(20000) + 'deep' + '</p></div>'.repeat(20000);
    const script = '<script>' + 'if (1<2) { x(); } '.repeat(4000) + '</script>';
    const bare = '<'.repeat(200000);
    const amps = '&'.repeat(200000); // 100k bare `&` measured 3.75 ms after the bounded entity scan
    return { nested, script, bare, amps, specimen: SPECIMEN.repeat(120) };
  })();

  it('extracts each worst case (generous ceiling; measured ms are in the report)', () => {
    for (const html of [worst.nested, worst.script, worst.bare, worst.amps, worst.specimen]) {
      expect(html.length).toBeGreaterThan(50000);
      const started = performance.now();
      const text = htmlToText(html);
      const elapsed = performance.now() - started;
      expect(typeof text).toBe('string');
      expect(elapsed).toBeLessThan(250);
    }
  });

  it('bounds a 1 MB input truncated by the default raw cap', () => {
    const html = '<table>' + '<tr><td>Low End</td><td>FortiGateRugged-35D</td></tr>'.repeat(20000) + '</table>';
    expect(html.length).toBeGreaterThan(1000000);
    const started = performance.now();
    const r = extractHtml(html);
    const elapsed = performance.now() - started;
    expect(r.bytesTruncated).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });
});
