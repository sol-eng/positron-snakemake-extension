// Workflow graphs as Mermaid, and the Viewer page that draws them. Kept free
// of `vscode` so it can be unit tested.

import { randomUUID } from "crypto";

import { summarize, type RunProgress, type RuleSummary } from "./model";

type RuleState = "done" | "running" | "failed" | "pending" | "planned";

function ruleState(summary: RuleSummary | undefined, dryRun: boolean): RuleState {
  if (dryRun) return "planned";
  if (!summary) return "done";
  if (summary.failed) return "failed";
  if (summary.running || summary.queued) return "running";
  if (summary.total && summary.succeeded === summary.total) return "done";
  return "pending";
}

/**
 * The run's rule graph, with each rule coloured by how far its jobs are.
 * Rules without jobs to run were up to date, and count as done.
 */
export function ruleGraphMermaid(progress: RunProgress, dryRun = false): string | undefined {
  const graph = progress.rulegraph;
  if (!graph?.nodes.length) return undefined;
  const summaries = new Map(summarize(progress).map((s) => [s.name, s]));
  const id = new Map(graph.nodes.map((n, i) => [n, `r${i}`]));
  const lines = ["flowchart TB"];
  for (const rule of graph.nodes) {
    const s = summaries.get(rule);
    const count = s && !dryRun ? ` ${s.succeeded}/${s.total}` : s ? ` ${s.total}` : "";
    lines.push(`  ${id.get(rule)}["${escapeLabel(rule)}${count}"]:::${ruleState(s, dryRun)}`);
  }
  for (const { source, target } of graph.links) {
    if (id.has(source) && id.has(target))
      lines.push(`  ${id.get(source)} --> ${id.get(target)}`);
  }
  lines.push(
    "  classDef done fill:#2e7d3233,stroke:#2e7d32",
    "  classDef running fill:#1565c033,stroke:#1565c0,stroke-width:3px",
    "  classDef failed fill:#c6282833,stroke:#c62828,stroke-width:3px",
    "  classDef pending fill:#9e9e9e22,stroke:#9e9e9e,stroke-dasharray:4 3",
    "  classDef planned fill:#9e9e9e22,stroke:#9e9e9e"
  );
  return lines.join("\n");
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;");
}

/** A page that draws a Mermaid graph with the bundled mermaid.js. */
export function graphHtml(
  mermaid: string,
  title: string,
  mermaidUri: string,
  cspSource: string
): string {
  const nonce = randomUUID();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    "img-src data:",
    `font-src ${cspSource}`
  ].join("; ");
  // JSON in a script element is inert; only `<` could end the element early
  const graph = JSON.stringify(mermaid).replace(/</g, "\\u003c");
  const heading = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${heading}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  h1 { font-size: 1.2em; margin: 0 0 12px; }
  .mermaid { overflow: auto; }
  pre.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style>
</head>
<body>
<h1>${heading}</h1>
<div id="graph" class="mermaid"></div>
<script nonce="${nonce}" id="data" type="application/json">${graph}</script>
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">
  const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", maxEdges: 5000, maxTextSize: 1000000 });
  const text = JSON.parse(document.getElementById("data").textContent);
  mermaid.render("snakemake-graph", text).then(({ svg }) => {
    document.getElementById("graph").innerHTML = svg;
  }).catch((e) => {
    const pre = document.createElement("pre");
    pre.className = "error";
    pre.textContent = "Could not draw the graph: " + e;
    document.body.appendChild(pre);
  });
</script>
</body>
</html>`;
}

/**
 * Snakemake prints graphs on stdout, after anything the Snakefile itself
 * prints there; the graph starts at its front matter or `flowchart`.
 */
export function mermaidOnly(stdout: string): string {
  const start = stdout.search(/^(---$|flowchart )/m);
  return start > 0 ? stdout.slice(start) : stdout;
}

/** The summary table, from its header on. */
export function tsvOnly(stdout: string): string {
  const start = stdout.search(/^output_file\t/m);
  return start > 0 ? stdout.slice(start) : stdout;
}
