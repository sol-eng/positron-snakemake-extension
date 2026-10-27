// Prepares an HTML file (Snakemake's report, or a job's HTML
// output) for a Viewer panel of the extension's own, with a button back to
// where it was opened from. Kept free of `vscode` so it can be unit tested.

/**
 * Undoes the default styles Positron puts into every webview (a
 * `vscode-default` cascade layer: body padding, theme colours and fonts,
 * link and `code` colours, image sizes), which pages written for a browser
 * do not expect. `revert` goes back to the browser's own styles. It comes
 * first in the head, so the page's own rules, which come later, still win.
 */
const REVERT_WEBVIEW_DEFAULTS = `<style id="snakemake-positron-reset">
html { scrollbar-color: revert; }
body { overscroll-behavior-x: revert; background-color: revert; color: revert; font-family: revert; font-weight: revert; font-size: revert; margin: revert; padding: revert; }
img, video { max-width: revert; max-height: revert; }
a, a code, a:hover { color: revert; }
p > a { text-decoration: revert; }
a:focus, input:focus, select:focus, textarea:focus { outline: revert; outline-offset: revert; }
code { font-family: revert; color: revert; background-color: revert; padding: revert; border-radius: revert; }
pre code { padding: revert; }
blockquote { background: revert; border-color: revert; }
kbd { background-color: revert; color: revert; border: revert; border-radius: revert; box-shadow: revert; vertical-align: revert; padding: revert; }
</style>`;

/** A page that loads mermaid from a CDN as an ES module (as Nextflow's DAG does). */
const CDN_MERMAID =
  /<script type="module">\s*import mermaid from ['"]https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid[^'"]*['"];?/;

/** A `src` or stylesheet `href` that names a file next to the page. */
const RELATIVE_RESOURCE =
  /(\bsrc=|<link\b[^>]*?\bhref=)(["'])(?!data:|blob:|[a-z][a-z0-9+.-]*:|\/\/|#)([^"']+)\2/gi;

export type PageOptions = {
  /** the back button's label, e.g. `← rnaseq-20261027-095753` */
  backLabel: string;
  /** turns a relative resource path into a URL the webview can load */
  resolve?: (relative: string) => string;
  /** the bundled mermaid.js, for such a page to draw without network access */
  mermaidSrc?: string;
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page with the style reset after the first `<head>`, a back button
 * before the last `</body>` (its scripts may contain both tags in strings,
 * after the real ones), relative resources made loadable, and a CDN mermaid
 * swapped for the bundled one. The button posts `{ type: "back" }`.
 */
export function pageWithBackButton(html: string, options: PageOptions): string {
  let page = html;
  if (options.resolve) {
    const resolve = options.resolve;
    page = page.replace(
      RELATIVE_RESOURCE,
      (_all, attr: string, quote: string, relative: string) =>
        `${attr}${quote}${resolve(relative)}${quote}`
    );
  }
  if (options.mermaidSrc) {
    page = page.replace(
      CDN_MERMAID,
      `<script src="${escapeHtml(options.mermaidSrc)}"></script>\n<script>`
    );
  }
  const button = `
<button id="snakemake-positron-back" type="button" title="Back to where this was opened from"
  style="position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;font:13px system-ui,sans-serif;color:#fff;background:#0e639c;box-shadow:0 1px 4px rgba(0,0,0,.3)">${escapeHtml(options.backLabel)}</button>
<script>
  (function () {
    const vscode = acquireVsCodeApi();
    document.getElementById("snakemake-positron-back").addEventListener("click", () => vscode.postMessage({ type: "back" }));
  })();
</script>
`;
  const body = page.lastIndexOf("</body>");
  page =
    body === -1
      ? page + button
      : page.slice(0, body) + button + page.slice(body);
  const head = page.search(/<head[^>]*>/i);
  if (head === -1) return REVERT_WEBVIEW_DEFAULTS + page;
  const after = page.indexOf(">", head) + 1;
  return page.slice(0, after) + REVERT_WEBVIEW_DEFAULTS + page.slice(after);
}
