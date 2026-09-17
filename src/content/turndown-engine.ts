/**
 * The ONLY file that may import turndown.
 *
 * HTML->Markdown sits behind this one function so the converter stays swappable:
 * `@xberg-io/html-to-markdown` produced byte-identical output on a tables/code/list
 * fixture at 2000 conversions in 16ms, and is on a maturity watchlist for mid-2027
 * (created 2026-06-26, one maintainer, native .node binaries in an otherwise pure-JS SDK).
 * Swapping means rewriting this file. No turndown type escapes it.
 */
import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

export function convertHtmlToMarkdown(html: string): string {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  service.use(gfm);
  return service.turndown(html);
}
