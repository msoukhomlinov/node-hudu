/**
 * @joplin/turndown-plugin-gfm ships no type declarations. This ambient module covers
 * only the `gfm` export used by turndown-engine.ts. The plugin parameter is typed
 * `unknown` rather than TurndownService.Plugin so this file has no reason to import
 * turndown itself.
 */
declare module '@joplin/turndown-plugin-gfm' {
  export function gfm(service: unknown): void;
}
