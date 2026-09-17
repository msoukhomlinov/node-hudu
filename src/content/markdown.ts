import { convertHtmlToMarkdown } from './turndown-engine.js';
import { convertMarkdownToHtml } from './marked-engine.js';

export function htmlToMarkdown(html: string): string {
  return convertHtmlToMarkdown(html);
}

export function markdownToHtml(md: string): string {
  return convertMarkdownToHtml(md);
}
