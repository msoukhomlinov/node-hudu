/**
 * The ONLY file that may import marked.
 *
 * marked >=16 is ESM-only; this package's CJS build reaches it through Node's
 * require(esm) support, which is why the Node floor is >=24. There is no sanitizer
 * knob: marked removed `sanitize`/`sanitizer` in v8.0.0. That introduces no new
 * vector -- `articles.update` already accepts arbitrary HTML in `content` by design,
 * so a Markdown caller reaches exactly the surface an HTML caller already had, and
 * Hudu remains the trust boundary for what its own renderer will execute.
 */
import { marked } from 'marked';

export function convertMarkdownToHtml(md: string): string {
  return marked.parse(md, { gfm: true, breaks: false, async: false });
}
