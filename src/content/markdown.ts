/**
 * HTML <-> Markdown for article bodies.
 *
 * Pure: no knowledge of resources, HTTP or auth. This module is the seam -- the
 * converters themselves live in ./turndown-engine and ./marked-engine, one file each,
 * so either can be replaced without touching anything that calls these functions.
 *
 * There is deliberately NO loss reporting here. `diffArticleRoundTrip` in
 * src/resources/article-html.ts already classifies content-vs-presentation loss against
 * an audited rule table, and it is a documented supported caller pattern to run it as
 * `diffArticleRoundTrip(original, markdownToHtml(htmlToMarkdown(original)))`. One
 * vocabulary, one severity table.
 */
import { DEFAULT_MAX_DOC_BYTES } from '../search/html.js';
import { HuduConfigError } from '../errors.js';
import { convertHtmlToMarkdown } from './turndown-engine.js';
import { convertMarkdownToHtml } from './marked-engine.js';

export interface HtmlToMarkdownOptions {
  /** Raw-input cap in UTF-8 bytes. Default {@link DEFAULT_MAX_DOC_BYTES} (256 KiB). */
  maxBytes?: number;
}

function assertWithinCap(op: string, input: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > maxBytes) {
    throw new HuduConfigError(
      `${op}: input is ${bytes} bytes, over the ${maxBytes}-byte document cap. It is refused, never truncated.`,
      {
        operation: op,
        suggestedAction: 'Split the article, or raise maxBytes knowing the whole document is held in memory.',
      },
    );
  }
}

function assertNotEmptied(op: string, input: string, output: string): void {
  if (input.trim().length > 0 && output.trim().length === 0) {
    throw new HuduConfigError(
      `${op}: non-empty input converted to empty output. Writing this would replace the stored body with nothing.`,
      {
        operation: op,
        suggestedAction: 'Send the content as HTML instead; it holds nothing this converter can represent.',
      },
    );
  }
}

/** Convert article HTML to Markdown. Throws rather than truncating or emptying. */
export function htmlToMarkdown(html: string, opts?: HtmlToMarkdownOptions): string {
  if (typeof html !== 'string' || html.trim().length === 0) return '';
  assertWithinCap('content.htmlToMarkdown', html, opts?.maxBytes ?? DEFAULT_MAX_DOC_BYTES);
  const markdown = convertHtmlToMarkdown(html).trim();
  assertNotEmptied('content.htmlToMarkdown', html, markdown);
  return markdown;
}

/** Convert Markdown to article HTML. Throws rather than emptying. */
export function markdownToHtml(md: string, opts?: HtmlToMarkdownOptions): string {
  if (typeof md !== 'string' || md.trim().length === 0) return '';
  assertWithinCap('content.markdownToHtml', md, opts?.maxBytes ?? DEFAULT_MAX_DOC_BYTES);
  const html = convertMarkdownToHtml(md).trim();
  assertNotEmptied('content.markdownToHtml', md, html);
  return html;
}
