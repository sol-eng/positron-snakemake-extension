// The dashboard page shown in the Viewer. One page renders a run, a job, or
// a workflow graph from JSON data, and re-renders in place when the extension
// posts an update, so moving between them stays in one Viewer page with a way
// back. Everything is rendered client-side and escaped there; graphs are
// drawn with the bundled mermaid.js.

import { randomUUID } from "crypto";

/**
 * JSON that is safe inside a <script type="application/json"> element: only a
 * `</script>` in the data could end it early, so `<` is escaped.
 */
export function scriptJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function dashboardHtml(
  data: unknown,
  cspSource: string,
  mermaidUri: string
): string {
  const nonce = randomUUID();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    "img-src data:",
    `font-src ${cspSource}`
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${STYLE}</style>
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}" id="data" type="application/json">${scriptJson(data)}</script>
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0 12px 24px;
    line-height: 1.4;
  }
  h1 { font-size: 1.3em; margin: 14px 0 2px; word-break: break-word; }
  h2 { font-size: 1.05em; margin: 18px 0 6px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 10px; word-break: break-all; }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 0.85em;
    color: var(--vscode-editor-background); font-weight: 600; vertical-align: middle;
  }
  .ok { background: var(--vscode-testing-iconPassed, #3fb950); }
  .bad { background: var(--vscode-testing-iconFailed, #f85149); }
  .run { background: var(--vscode-charts-blue, #388bfd); }
  .wait { background: var(--vscode-charts-yellow, #d29922); }
  .off { background: var(--vscode-disabledForeground, #8b949e); }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0; }
  .facts dt { color: var(--vscode-descriptionForeground); }
  .facts dd { margin: 0; word-break: break-all; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  button, .link {
    border: none; padding: 4px 10px; cursor: pointer; font: inherit;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  a, .linkish { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover, .linkish:hover { text-decoration: underline; }
  details { border: 1px solid var(--vscode-panel-border, #8884); margin: 8px 0; }
  summary { padding: 6px 8px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  summary .title { font-weight: 600; }
  summary .meta { color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  summary .open { margin-left: auto; }
  pre {
    margin: 0; padding: 8px; overflow: auto; max-height: 420px;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
    background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-all;
  }
  .note { color: var(--vscode-descriptionForeground); padding: 4px 8px; font-style: italic; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; }
  td.num { text-align: right; white-space: nowrap; }
  .bar { height: 6px; background: var(--vscode-progressBar-background, #388bfd33); opacity: 0.25; position: relative; min-width: 80px; }
  .bar span { position: absolute; top: 0; bottom: 0; left: 0; }
  .fail-item { margin: 8px 0; }
  .empty { color: var(--vscode-descriptionForeground); }
  .toggle button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .graph { overflow: auto; margin-top: 8px; }
  .graph svg { max-width: none; }
  pre.error { color: var(--vscode-errorForeground); }
`;

// Runs in the webview. Kept as plain JavaScript in a string.
const SCRIPT = String.raw`
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let data = JSON.parse(document.getElementById("data").textContent);
  const opened = new Map();

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const post = (message) => vscode.postMessage(message);
  const bytes = (n) => {
    if (n === undefined || n === null) return undefined;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)) + " " + units[u];
  };
  const mb = (n) => (n === undefined || n === null ? undefined : bytes(n * 1024 * 1024));
  const duration = (ms) => {
    if (ms === undefined || ms === null) return undefined;
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m < 60 ? m + "m " + (s % 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  };
  const badgeClass = (status) => ({
    COMPLETED: "ok", succeeded: "ok",
    FAILED: "bad", ABORTED: "off", failed: "bad", stopped: "off", lost: "off",
    RUNNING: "run", running: "run", starting: "wait", queued: "wait", QUEUED: "wait", SUBMITTED: "wait", NEW: "wait", planned: "wait"
  }[status] || "off");
  const badge = (status) => '<span class="badge ' + badgeClass(status) + '">' + esc(String(status).toLowerCase()) + "</span>";
  const facts = (rows) => '<dl class="facts">' + rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== "")
    .map((r) => "<dt>" + esc(r[0]) + "</dt><dd>" + (r[2] ? r[1] : esc(r[1])) + "</dd>").join("") + "</dl>";
  const wildcards = (w) => Object.entries(w || {}).map(([k, v]) => k + "=" + v).join(", ");

  function section(key, title, meta, file, body, open) {
    const isOpen = opened.has(key) ? opened.get(key) : open;
    return '<details data-key="' + esc(key) + '"' + (isOpen ? " open" : "") + "><summary>" +
      '<span class="title">' + esc(title) + "</span>" +
      '<span class="meta">' + esc(meta) + "</span>" +
      (file ? '<span class="open linkish" data-open="' + esc(file) + '">Open in editor</span>' : "") +
      "</summary>" + body + "</details>";
  }

  function renderJob(d) {
    const j = d.job, f = d.files;
    const failed = j.status === "FAILED" || j.status === "ABORTED";
    const status = d.dryRun ? "planned" : j.status;
    const actions = [
      '<button data-msg="run">← ' + esc(d.runName) + "</button>",
      d.canDebug ? '<button class="primary" data-msg="debug">Debug in Console</button>' : "",
      d.canCancel ? '<button data-msg="cancel">Cancel Workbench Job</button>' : "",
      j.externalJobId ? '<button data-msg="stdout">Workbench Output</button><button data-msg="stderr">Workbench Errors</button><button data-msg="copy">Copy Job ID</button>' : "",
      '<button data-msg="terminal">Terminal in Working Dir</button>'
    ].join("");
    const resources = Object.entries(j.resources || {}).filter(([k]) => k !== "tmpdir").map(([k, v]) => k + "=" + v).join(", ");
    const b = f.benchmark;
    let html = "<h1>" + esc(j.rule) + (Object.keys(j.wildcards || {}).length ? " (" + esc(wildcards(j.wildcards)) + ")" : "") + " " + badge(status) + "</h1>" +
      '<div class="sub">job ' + esc(j.jobid) + (j.local ? " · ran in the Snakemake process" : "") + (j.message ? " · " + esc(j.message) : "") + "</div>" +
      '<div class="actions">' + actions + "</div>" +
      facts([
        ["Reason", j.reason],
        ["Attempt", j.attempt > 1 ? j.attempt : undefined],
        ["Duration", duration(j.start ? (j.complete || d.now) - j.start : undefined)],
        ["Workbench job", j.externalJobId ? j.externalJobId + (j.workbenchStatus ? " (" + j.workbenchStatus + ")" : "") : undefined],
        ["Threads", j.threads],
        ["Resources", resources],
        ["Benchmark", b ? [b.seconds !== undefined && duration(b.seconds * 1000), b.maxRssMb !== undefined && "peak memory " + mb(b.maxRssMb), b.cpuTimeSeconds !== undefined && "CPU time " + duration(b.cpuTimeSeconds * 1000), b.meanLoad !== undefined && "mean load " + b.meanLoad.toFixed(0) + "%", b.ioInMb !== undefined && "read " + mb(b.ioInMb) + ", written " + mb(b.ioOutMb)].filter(Boolean).join(" · ") + (b.runs > 1 ? " (last of " + b.runs + " repeats)" : "") + ' <span class="linkish" data-open="' + esc(b.path) + '">open</span>' : undefined, true]
      ]);
    if (j.error) html += "<h2>Error</h2><pre>" + esc(j.error) + "</pre>";
    if (j.shellcmd) html += section("shell", "Shell command", "as Snakemake ran it", undefined, "<pre>" + esc(j.shellcmd) + "</pre>", true);
    if (!f.logs.length && (j.log || []).length) html += '<div class="note">The job\'s log files are not written yet.</div>';
    for (const log of f.logs) {
      const body = log.size === 0 ? '<div class="note">Empty.</div>' :
        (log.truncated ? '<div class="note">Showing the last ' + esc(bytes(log.text.length)) + " of " + esc(bytes(log.size)) + ".</div>" : "") +
        "<pre>" + esc(log.text) + "</pre>";
      html += section("log:" + log.name, "Log", log.name + " · " + bytes(log.size), log.path, body, failed || f.logs.length === 1);
    }
    html += "<h2>Outputs</h2>" + entries(f.outputs, "No outputs.");
    html += "<h2>Inputs</h2>" + entries(f.inputs, "No inputs.");
    return html;
  }

  function entries(list, empty) {
    if (!list.length) return '<div class="empty">' + esc(empty) + "</div>";
    return "<table><tr><th>File</th><th>Size</th></tr>" + list.map((e) =>
      "<tr><td>" + (e.exists && !e.isDirectory ? '<span class="linkish" data-open="' + esc(e.path) + '">' + esc(e.name) + "</span>" : esc(e.name) + (e.isDirectory ? "/" : "")) +
      '</td><td class="num">' + (e.exists ? (e.isDirectory ? "folder" : esc(bytes(e.size))) : '<span class="empty">missing</span>') + "</td></tr>").join("") + "</table>";
  }

  function renderRun(d) {
    const r = d.run;
    const status = r.status;
    const t = r.totals;
    let html = "<h1>" + esc(d.title.replace(/^Run: /, "")) + " " + badge(status) + "</h1>" +
      '<div class="sub">' + esc(r.snakefile) + "</div>" +
      '<div class="actions">' +
        '<button data-msg="rulegraph">Rule Graph</button><button data-msg="dag">Job Graph</button>' +
        (d.live ? "" : '<button data-msg="report">Report</button>') +
        '<button data-msg="summary">Output Summary</button><button data-msg="output">Output</button><button data-msg="log">Snakemake Log</button>' +
      "</div>" +
      facts([
        ["Jobs", r.dryRun ? t.total + " planned" : t.total ? t.done + " of " + t.total + " done" + (t.failed ? ", " + t.failed + " failed" : "") + (t.running ? ", " + t.running + " running" : "") : r.nothingToDo ? "nothing to be done" : "none yet"],
        ["Duration", d.duration],
        ["Targets", (r.targets || []).join(" ")],
        ["Profile", r.profile],
        ["Working dir", r.workingDirectory],
        ["Jobs run", d.executor],
        ["Snakemake runs", d.driver],
        ["Exit code", r.exitCode],
        ["Started", r.startedAt && new Date(r.startedAt).toLocaleString()]
      ]);
    if (!r.liveStatus) html += '<div class="note">Job status comes from Snakemake\'s output: the workbench logger plugin is not installed.</div>';
    if (d.errors.length && status === "failed") {
      html += "<h2>Errors</h2>" + d.errors.map((e) => "<pre>" + esc(e) + "</pre>").join("");
    }
    html += "<h2>Rules</h2>";
    if (!r.rules.length) {
      html += '<div class="empty">' + (r.nothingToDo ? "All requested outputs are up to date." : "No jobs yet.") + "</div>";
    } else {
      html += "<table><tr><th>Rule</th><th>Progress</th><th>Done</th><th>Running</th><th>Queued</th><th>Failed</th><th>Retried</th></tr>" +
        r.rules.map((p) => {
          const pct = p.total ? Math.round((p.succeeded / p.total) * 100) : 0;
          return "<tr><td>" + esc(p.name) + '</td><td><div class="bar" style="opacity:1;background:var(--vscode-panel-border,#8884)"><span style="width:' + pct + '%;background:' + (p.failed ? "var(--vscode-testing-iconFailed,#f85149)" : "var(--vscode-testing-iconPassed,#3fb950)") + '"></span></div></td>' +
            '<td class="num">' + p.succeeded + " / " + p.total + '</td><td class="num">' + (p.running || "") + '</td><td class="num">' + (p.queued || "") + '</td><td class="num">' + (p.failed || "") + '</td><td class="num">' + (p.retried || "") + "</td></tr>";
        }).join("") + "</table>";
    }
    if (d.failed.length) {
      html += "<h2>Failed jobs</h2>" + d.failed.map((f) =>
        '<div class="fail-item"><span class="linkish" data-job="' + f.jobid + '">' + esc(f.label) + "</span>" +
        (f.externalJobId ? " · Workbench job " + esc(f.externalJobId) : "") + (f.log ? "<pre>" + esc(f.log) + "</pre>" : "") + "</div>").join("");
    }
    if (d.running.length) {
      html += "<h2>Running</h2><div>" + d.running.map((f) => '<span class="linkish" data-job="' + f.jobid + '">' + esc(f.label) + "</span>").join(" · ") + "</div>";
    }
    return html;
  }

  function renderGraph(d) {
    const kind = d.graph === "jobs" ? "Job" : "Rule";
    let html = "<h1>" + kind + " graph " + badge(d.status) + "</h1>" +
      '<div class="sub">' + esc(d.runName) + (d.graph === "rules" && d.live ? " · updates as the run progresses" : "") + "</div>" +
      '<div class="actions">' +
        '<button data-msg="back">← ' + esc(d.runName) + "</button>" +
        '<span class="toggle"><button data-msg="rules"' + (d.graph === "rules" ? ' class="on"' : "") + ">Rules</button>" +
        '<button data-msg="jobs"' + (d.graph === "jobs" ? ' class="on"' : "") + ">Jobs</button></span>" +
        (d.mermaid || d.error ? '<button data-msg="redraw">Redraw</button>' : "") +
      "</div>";
    if (d.error) return html + '<pre class="error">' + esc(d.error) + "</pre>";
    if (!d.mermaid) return html + '<div class="note">Drawing the ' + kind.toLowerCase() + " graph...</div>";
    if (d.graph === "rules" && d.colored) html += '<div class="note">Green: done, blue: running, red: failed, dashed: still to run.</div>';
    return html + '<div id="graph" class="graph"></div>';
  }

  // mermaid draws asynchronously; keep the last drawing, so re-rendering the
  // page for a live update does not flicker
  let drawn = { text: undefined, svg: "" };
  let drawCount = 0;
  if (window.mermaid) {
    const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", maxEdges: 5000, maxTextSize: 1000000 });
  }
  function drawGraph(d) {
    const el = document.getElementById("graph");
    if (!el) return;
    if (drawn.text === d.mermaid) { el.innerHTML = drawn.svg; return; }
    if (drawn.svg) el.innerHTML = drawn.svg;
    if (!window.mermaid) { el.innerHTML = '<pre class="error">Could not load mermaid.js to draw the graph.</pre>'; return; }
    const text = d.mermaid;
    window.mermaid.render("snakemake-graph-" + ++drawCount, text).then(({ svg }) => {
      drawn = { text, svg };
      const current = document.getElementById("graph");
      if (current && data.kind === "graph" && data.mermaid === text) current.innerHTML = svg;
    }).catch((e) => {
      const current = document.getElementById("graph");
      if (current) current.innerHTML = '<pre class="error">' + esc("Could not draw the graph: " + e) + "</pre>";
    });
  }

  function render() {
    const scroll = window.scrollY;
    root.innerHTML = data.kind === "job" ? renderJob(data) : data.kind === "graph" ? renderGraph(data) : renderRun(data);
    if (data.kind === "graph" && data.mermaid) drawGraph(data);
    window.scrollTo(0, scroll);
  }

  root.addEventListener("toggle", (event) => {
    const el = event.target;
    if (el.tagName === "DETAILS" && el.dataset.key) opened.set(el.dataset.key, el.open);
  }, true);
  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-open],[data-job],[data-msg]");
    if (!el) return;
    if (el.dataset.open) { event.preventDefault(); post({ type: "open", path: el.dataset.open }); }
    else if (el.dataset.job) post({ type: "job", jobid: Number(el.dataset.job) });
    else post({ type: "action", action: el.dataset.msg });
  });
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "update") {
      if (event.data.data.kind !== data.kind || event.data.data.id !== data.id) { opened.clear(); drawn = { text: undefined, svg: "" }; }
      data = event.data.data;
      render();
    }
  });
  render();
})();
`;
