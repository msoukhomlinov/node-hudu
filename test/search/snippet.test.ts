/**
 * Snippet honesty tests: verbatim slices, absolute spans, no invented highlights.
 *
 * The property test is the deliverable's proof (design `.run/design/search/html-and-snippets.md` S3):
 * over a corpus of realistic + adversarial Hudu markup and MANY query terms, the returned `text`
 * is exactly `extracted.slice(textStart, textEnd)`, and every span reads back characters that
 * belong to the matched term (never a paraphrase, never a different string).
 */
import { describe, it, expect } from 'vitest';
import { htmlToText } from '../../src/search/html.js';
import {
  buildSnippet, foldWithMap, foldText, MAX_SNIPPET_CHARS, DEFAULT_SNIPPET_CHARS,
  DEFAULT_MAX_SPANS, DEFAULT_MAX_OCC_PER_TERM,
} from '../../src/search/snippet.js';

// ---------------------------------------------------------------------------------------------
// Corpus: real Hudu markup shapes + adversarial ones.
// ---------------------------------------------------------------------------------------------

const ARTICLE_16 =
  '<h1>Introduction</h1><p>This comprehensive guide provides the latest FortiOS software recommendations for optimal stability and deployment success.</p>' +
  '<p>The content is automatically synchronised from&nbsp;<a href="https://community.fortinet.com/t5/FortiGate/Technical-Tip" rel="noopener" target="_blank">https://community.fortinet.com/t5/FortiGate/Technical-Tip</a>.</p>' +
  '<p><strong>Current as of</strong>: Thu 10 July 2025, 10:20 am GMT+10</p><h1>Recommended releases</h1>' +
  '<table><thead><tr><th>Product Family</th><th>Product Details</th><th>Recommended Release</th><th>End of Engineering Support Passed (Y/N)</th></tr></thead><tbody>' +
  '<tr><td>Low End</td><td>FortiGateRugged-35D</td><td>6.2.16</td><td>Y</td></tr>' +
  '<tr><td>Mid Range</td><td>FortiGate-200F</td><td>7.4.7</td><td>N</td></tr></tbody></table>';

const SPECIMEN =
  '<!-- leading comment --><style>.x{color:red}</style><h2 style="color:#f00">Awkward Markup</h2>' +
  '<p>Falcon zephirine cutover &amp; rollback notes &mdash; see &#8212; the &#x2014; table &lt;below&gt;.</p>' +
  '<ul>\n<li>First bullet</li>\n<li>Second bullet with&nbsp;nbsp</li>\n</ul>' +
  '<table><thead><tr><th>Host</th><th>Serial</th></tr></thead><tbody><tr><td>ws-013</td><td>SER88N9X</td></tr><tr><td>ws-012</td><td>SER77M1P</td></tr></tbody></table>' +
  '<p>Unknown entity &foo; and numeric &#169; stay literal.</p>' +
  '<pre><code>line one\nline two\tindented</code></pre>' +
  '<p><b>Unclosed paragraph with bold text<p><script>var secret = "zephirine"; if (1<2) { alert(" "); }</script></p>' +
  '<p>' + 'A'.repeat(220) + ' token then normal text resumes.</p><p>Final paragraph with a link&amp;more.</p>';

const CORPUS: readonly string[] = [
  ARTICLE_16,
  SPECIMEN,
  '<p>caf\u00e9 est l\u00e0. Un autre caf\u00e9 ici.</p>',
  '<div><p>Onboarding checklist</p><p>caf\u00e9 Z\u00c9PHIRINE caf\u00e9</p></div>',
  '<table><tr><td>Alpine</td><td>AP-2000</td><td>Y</td></tr><tr><td>Alpine</td><td>AP-3000</td><td>N</td></tr></table>',
  '<p>Short body.</p>',
  '<p>' + 'word '.repeat(200) + '</p>',
  '<h1>Title only bodyless</h1>',
  '<p>emoji \u{1f600} and \u00c9\u00c9 name</p>',
  '<p>' + 'x'.repeat(500) + ' ' + 'Sentinel tail text here.' + '</p>',
];

/** Terms derived from the extracted text, so a strict read-back expectation is well defined. */
function derivedTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[^0-9A-Za-z\u00c0-\u024f_-]+/)) {
    if (raw.length < 2) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= 60) break;
  }
  return out;
}

describe('foldWithMap / foldText', () => {
  it('is length-preserving and maps every folded unit back', () => {
    for (const text of ['Z\u00c9PHIRINE', 'caf\u00e9', 'plain ascii', 'emoji \u{1f600} here', '\u0130stanbul', '\u00bd cup', '']) {
      const { folded, map } = foldWithMap(text);
      expect(folded.length).toBe(text.length);
      expect(map.length).toBe(folded.length + 1);
      for (let i = 0; i < folded.length; i++) {
        expect(map[i]).toBeGreaterThanOrEqual(0);
        expect(map[i]).toBeLessThanOrEqual(i);
      }
      expect(map[folded.length]).toBe(text.length);
    }
  });

  it('lowercases and strips accents, and keeps code points that have no safe 1:1 fold', () => {
    expect(foldText('Z\u00c9PHIRINE')).toBe('zephirine');
    expect(foldText('caf\u00e9')).toBe('cafe');
    expect(foldText('\u0130stanbul')).toBe('istanbul');
    expect(foldText('\u00bd cup')).toBe('\u00bd cup'); // NFKD expands to 3 chars: unsafe, kept as is
    expect(foldText('stra\u00dfe')).toBe('stra\u00dfe');
    expect(foldText('\u{1f600}')).toBe('\u{1f600}');
  });

  it('maps an astral character to both of its UTF-16 units', () => {
    const text = 'a\u{1f600}b';
    const { folded, map } = foldWithMap(text);
    expect(folded).toBe(text);
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(2);
    expect(map[3]).toBe(3);
  });

  it('lets a folded term locate a different spelling in the text', () => {
    const text = htmlToText('<p>caf\u00e9 est l\u00e0. Un autre caf\u00e9 ici.</p>');
    const sn = buildSnippet(text, ['CAFE'], { snippetChars: DEFAULT_SNIPPET_CHARS });
    expect(sn.available).toBe(true);
    expect(sn.spans.length).toBe(2);
    for (const span of sn.spans) expect(text.slice(span.start, span.end)).toBe('caf\u00e9');
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
  });
});

describe('buildSnippet: the verbatim-slice contract', () => {
  const text = htmlToText(ARTICLE_16);

  it('returns a real slice and a span that reads back the term', () => {
    const sn = buildSnippet(text, ['Rugged-35D']);
    expect(sn.available).toBe(true);
    expect(sn.source).toBe('body');
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    expect(sn.text.length).toBeLessThanOrEqual(DEFAULT_SNIPPET_CHARS);
    expect(sn.spans.length).toBe(1);
    const span = sn.spans[0];
    if (span === undefined) throw new Error('expected one span');
    expect(text.slice(span.start, span.end)).toBe('Rugged-35D');
    expect(span.terms).toEqual(['Rugged-35D']);
    expect(sn.textStart).toBeLessThanOrEqual(span.start);
    expect(sn.textEnd).toBeGreaterThanOrEqual(span.end);
    expect(sn.truncated).toEqual({ before: sn.textStart > 0, after: sn.textEnd < text.length });
    expect(sn.omittedSpans).toBe(0);
    expect(sn.text).not.toContain('\u2026');
    expect(sn.text).not.toContain('...');
  });

  it('never injects an ellipsis: truncation lives in the flags', () => {
    const sn = buildSnippet(text, ['FortiOS']);
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    expect(sn.truncated.before).toBe(sn.textStart > 0);
    expect(sn.truncated.after).toBe(sn.textEnd < text.length);
  });

  it('reports the whole document when it fits', () => {
    const short = htmlToText('<p>Short body.</p>');
    const sn = buildSnippet(short, ['Short']);
    expect(sn.available).toBe(true);
    expect(sn.text).toBe(short);
    expect(sn.textStart).toBe(0);
    expect(sn.textEnd).toBe(short.length);
    expect(sn.truncated).toEqual({ before: false, after: false });
  });

  it('is case-insensitive when locating and exact when emitting', () => {
    const sn = buildSnippet(htmlToText('<p>FortiGateRugged-35D</p>'), ['fortigaterugged-35d']);
    expect(sn.available).toBe(true);
    expect(sn.text).toBe('FortiGateRugged-35D');
  });
});

describe('buildSnippet: nothing to show is stated, never paraphrased', () => {
  it('reports a term absent from the text as unavailable with empty spans', () => {
    const text = htmlToText('<p>Falcon cutover notes.</p>');
    const sn = buildSnippet(text, ['Specimen']);
    expect(sn).toMatchObject({
      available: false,
      reason: 'no-match-in-body',
      text: '',
      textStart: 0,
      textEnd: 0,
      spans: [],
      omittedSpans: 0,
      occurrencesCapped: false,
      truncated: { before: false, after: false },
    });
  });

  it('lets the caller name the reason (title-only match, eviction, budget)', () => {
    const text = 'body text only';
    expect(buildSnippet(text, ['Specimen'], { noMatchReason: 'matched-title-only' }).reason).toBe('matched-title-only');
    expect(buildSnippet(text, ['Specimen'], { noMatchReason: 'evicted' }).reason).toBe('evicted');
    expect(buildSnippet(text, ['Specimen'], { noMatchReason: 'snippet-budget' }).reason).toBe('snippet-budget');
  });

  it('uses the caller-supplied source label', () => {
    const sn = buildSnippet('Service tag 7GH2K83', ['7GH2K83'], { source: 'field:Service tag' });
    expect(sn.source).toBe('field:Service tag');
    expect(sn.text).toBe('Service tag 7GH2K83');
    expect(sn.text.slice(sn.spans[0]?.start as number, sn.spans[0]?.end as number)).toBe('7GH2K83');
  });

  it('returns unavailable for empty text or empty/absent terms', () => {
    expect(buildSnippet('', ['x']).available).toBe(false);
    expect(buildSnippet('text', []).available).toBe(false);
    expect(buildSnippet('text', ['']).available).toBe(false);
    expect(buildSnippet('text', [undefined as unknown as string]).available).toBe(false);
  });

  it('reports no span in the shown text when the caller asks for zero spans', () => {
    const sn = buildSnippet('alpha beta', ['alpha'], { maxSpans: 0 });
    expect(sn).toMatchObject({ available: false, reason: 'no-span-in-shown-text', spans: [] });
  });
});

describe('buildSnippet: multi-term windows and omission counts', () => {
  const text = htmlToText(SPECIMEN);

  it('prefers a window covering more distinct terms', () => {
    const sn = buildSnippet(text, ['zephirine', 'SER88N9X'], { snippetChars: 120 });
    expect(sn.available).toBe(true);
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    const covered = new Set(sn.spans.flatMap((s) => s.terms));
    expect(covered.has('zephirine')).toBe(true);
  });

  it('counts occurrences that are not represented by a span', () => {
    const twoFar = 'alpha ' + 'x'.repeat(400) + ' omega';
    const sn = buildSnippet(twoFar, ['alpha', 'omega'], { snippetChars: 40 });
    expect(sn.available).toBe(true);
    expect(sn.spans.length).toBe(1);
    expect(sn.omittedSpans).toBe(1);
    expect(sn.text).toBe(twoFar.slice(sn.textStart, sn.textEnd));
  });

  it('merges overlapping occurrences of one term into a single span', () => {
    const sn = buildSnippet('x' + 'A'.repeat(220) + 'y', ['AAAA'], { snippetChars: 120 });
    expect(sn.available).toBe(true);
    expect(sn.spans.length).toBe(1);
    expect(sn.omittedSpans).toBeGreaterThan(0);
    // The measured design case reports 15 omitted spans for this document shape.
    expect(sn.omittedSpans).toBe(15);
    expect(sn.text).toBe(mustText('x' + 'A'.repeat(220) + 'y').slice(sn.textStart, sn.textEnd));
  });

  function mustText(html: string): string {
    return htmlToText(html);
  }

  it('caps the reported spans and says so through omittedSpans', () => {
    const doc = 'one two three four five six seven eight nine ten eleven twelve';
    const terms = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const sn = buildSnippet(doc, terms, { snippetChars: 400, maxSpans: 2 });
    expect(sn.spans.length).toBe(2);
    expect(sn.omittedSpans).toBe(8);
    for (const span of sn.spans) {
      expect(doc.slice(span.start, span.end).length).toBeGreaterThan(0);
    }
  });

  it('flags the occurrence cap instead of silently truncating the list', () => {
    const sn = buildSnippet('AAAA ' + 'AAAA '.repeat(30), ['AAAA'], { snippetChars: 400 });
    expect(sn.occurrencesCapped).toBe(true);
  });

  it('does not flag the occurrence cap when the term is rare', () => {
    const sn = buildSnippet('only once here', ['once']);
    expect(sn.occurrencesCapped).toBe(false);
  });

  it('exposes the documented defaults', () => {
    expect(DEFAULT_SNIPPET_CHARS).toBe(200);
    expect(MAX_SNIPPET_CHARS).toBe(400);
    expect(DEFAULT_MAX_SPANS).toBe(8);
    expect(DEFAULT_MAX_OCC_PER_TERM).toBe(16);
  });
});

describe('buildSnippet: windowing, clipping and word-boundary expansion', () => {
  it('clamps snippetChars to the documented maximum', () => {
    const text = 'word '.repeat(300);
    const sn = buildSnippet(text, ['word'], { snippetChars: 10000 });
    expect(sn.text.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
  });

  it('expands to a word boundary rather than slicing through a word', () => {
    const text = 'aa ' + 'b'.repeat(40) + ' needled ' + 'c'.repeat(80) + ' zz';
    const sn = buildSnippet(text, ['needled'], { snippetChars: 20 });
    expect(sn.available).toBe(true);
    // Expansion walks back to the start of the long token (index 3) rather than starting
    // mid-word at index 35.
    expect(sn.textStart).toBe(3);
    expect(text.charAt(sn.textStart - 1)).toBe(' ');
    expect(sn.text).toContain('needled');
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    expect(sn.text.length).toBeLessThanOrEqual(20 + 2 * 64);
  });

  it('clips an over-long match at its head and still returns a usable span', () => {
    const long = 'A'.repeat(300);
    const text = 'prefix ' + long + ' suffix';
    const sn = buildSnippet(text, [long], { snippetChars: 50 });
    expect(sn.available).toBe(true);
    expect(sn.text.length).toBe(50);
    expect(sn.text).toBe('A'.repeat(50));
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    expect(sn.spans.length).toBe(1);
    const span = sn.spans[0];
    if (span === undefined) throw new Error('expected one span');
    expect(span.start).toBeGreaterThanOrEqual(sn.textStart);
    expect(span.end).toBeLessThanOrEqual(sn.textEnd);
    expect(text.slice(span.start, span.end)).toBe('A'.repeat(span.end - span.start));
  });

  it('caps word-boundary expansion at 64 characters per side', () => {
    const text = 'z'.repeat(200) + ' | ' + 'y'.repeat(200) + ' | ';
    const sn = buildSnippet(text, ['|'], { snippetChars: 30 });
    expect(sn.available).toBe(true);
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    expect(sn.text.length).toBeLessThanOrEqual(30 + 2 * 64);
  });

  it('handles a match at the very start and very end', () => {
    const text = 'start middle end';
    const first = buildSnippet(text, ['start'], { snippetChars: 10 });
    expect(first.textStart).toBe(0);
    expect(first.truncated.before).toBe(false);
    const last = buildSnippet(text, ['end'], { snippetChars: 10 });
    expect(last.textEnd).toBe(text.length);
    expect(last.truncated.after).toBe(false);
  });

  it('accepts a snippetChars of 1 without breaking the invariants', () => {
    const sn = buildSnippet('alpha beta', ['beta'], { snippetChars: 1 });
    expect(sn.available).toBe(true);
    expect(sn.text.length).toBe(1);
    expect(sn.text).toBe('alpha beta'.slice(sn.textStart, sn.textEnd));
    expect(sn.spans.length).toBe(1);
  });
});

describe('property: slice equality and span read-back over the corpus', () => {
  const WINDOWS = [12, 40, 120, 200, 400];

  it('holds for every derived term, every window size and every document', () => {
    let checked = 0;
    for (const html of CORPUS) {
      const text = htmlToText(html);
      for (const term of derivedTerms(text)) {
        for (const snippetChars of WINDOWS) {
          const sn = buildSnippet(text, [term], { snippetChars });
          expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
          expect(sn.text.length).toBeLessThanOrEqual(snippetChars + 2 * 64);
          expect(sn.textStart).toBeGreaterThanOrEqual(0);
          expect(sn.textEnd).toBeLessThanOrEqual(text.length);
          expect(sn.truncated.before).toBe(sn.textStart > 0);
          expect(sn.truncated.after).toBe(sn.textEnd < text.length);
          if (!sn.available) {
            expect(sn.spans).toEqual([]);
            continue;
          }
          expect(sn.spans.length).toBeGreaterThan(0);
          for (const span of sn.spans) {
            expect(span.start).toBeGreaterThanOrEqual(sn.textStart);
            expect(span.end).toBeLessThanOrEqual(sn.textEnd);
            expect(span.end).toBeGreaterThan(span.start);
            const readBack = text.slice(span.start, span.end);
            expect(readBack.length).toBeGreaterThan(0);
            // The span must read back characters OF the term (never a different string).
            expect(foldText(term).includes(foldText(readBack))).toBe(true);
            expect(span.terms.length).toBeGreaterThan(0);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('holds for multi-term queries (every term has a chance to be covered)', () => {
    for (const html of CORPUS) {
      const text = htmlToText(html);
      const terms = derivedTerms(text);
      for (let i = 0; i + 2 < terms.length; i += 3) {
        const group = [terms[i], terms[i + 1], terms[i + 2]] as string[];
        const sn = buildSnippet(text, group, { snippetChars: 200 });
        expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
        for (const span of sn.spans) {
          expect(text.slice(span.start, span.end).length).toBeGreaterThan(0);
          for (const t of span.terms) expect(group).toContain(t);
        }
      }
    }
  });

  it('strict read-back equality for a term match that sits inside the window', () => {
    const text = htmlToText(ARTICLE_16);
    for (const term of ['FortiOS', 'Low End', 'FortiGate-200F', '7.4.7', 'Recommended releases']) {
      const sn = buildSnippet(text, [term], { snippetChars: 200 });
      expect(sn.available).toBe(true);
      expect(sn.spans.length).toBe(1);
      const span = sn.spans[0];
      if (span === undefined) throw new Error('expected one span');
      expect(text.slice(span.start, span.end).toLowerCase()).toBe(term.toLowerCase());
    }
  });
});

describe('perf bound: snippet building on a large document stays bounded', () => {
  it('builds a snippet over ~100 KB in well under the ceiling', () => {
    const text = htmlToText('<p>' + 'alpha beta gamma delta needled epsilon '.repeat(2500) + '</p>');
    expect(text.length).toBeGreaterThan(50000);
    const started = performance.now();
    const sn = buildSnippet(text, ['needled', 'epsilon', 'gamma'], { snippetChars: 200 });
    const elapsed = performance.now() - started;
    expect(sn.available).toBe(true);
    expect(sn.text).toBe(text.slice(sn.textStart, sn.textEnd));
    expect(elapsed).toBeLessThan(250);
  });

  it('folds a large document without breaking the length invariant', () => {
    const text = 'caf\u00e9 \u00c9t\u00e9 Z\u00c9PHIRINE '.repeat(5000);
    const { folded, map } = foldWithMap(text);
    expect(folded.length).toBe(text.length);
    expect(map.length).toBe(text.length + 1);
  });
});
