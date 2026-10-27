import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dashboardHtml, scriptJson } from "../runs/dashboard/html";
import {
  findJobScript,
  formatBytes,
  isInside,
  parseBenchmark,
  readJobFiles,
  splitPreamble,
  stripAnnotation
} from "../runs/dashboard/jobFiles";
import { applyEvent } from "../runs/events";
import { mermaidOnly, reportWithBackButton, ruleGraphMermaid, tsvOnly } from "../runs/graph";
import { emptyProgress, type JobState } from "../runs/model";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "../src/positron/test/fixtures", name), "utf8");

test("benchmarks", () => {
  const [row] = parseBenchmark(fixture("benchmark.tsv"));
  assert.equal(row.seconds, 0.02);
  assert.equal(row.maxRssMb, undefined); // NA
  const [full] = parseBenchmark(
    "s\th:m:s\tmax_rss\tmax_vms\tmax_uss\tmax_pss\tio_in\tio_out\tmean_load\tcpu_time\n" +
      "12.5\t0:00:12\t300.1\t500\t1\t1\t2.5\t4\t95.0\t11.8\n"
  );
  assert.deepEqual(full, {
    seconds: 12.5, maxRssMb: 300.1, maxVmsMb: 500, ioInMb: 2.5, ioOutMb: 4, meanLoad: 95, cpuTimeSeconds: 11.8
  });
});

test("a job's files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smk-job-"));
  fs.mkdirSync(path.join(dir, "logs"));
  fs.writeFileSync(path.join(dir, "logs/a.log"), "making a\n");
  fs.writeFileSync(path.join(dir, "out.txt"), "ok");
  fs.writeFileSync(path.join(dir, "bench.tsv"), fixture("benchmark.tsv"));
  const job: JobState = {
    jobid: 1, rule: "make", wildcards: { s: "a" }, status: "COMPLETED", attempt: 1,
    log: ["logs/a.log (check log file(s) for error details)"],
    output: ["out.txt (temp)", "missing.txt"],
    input: [],
    benchmark: "bench.tsv"
  };
  const files = readJobFiles(job, dir);
  assert.equal(files.logs[0].text, "making a\n");
  assert.deepEqual(files.outputs.map((o) => [o.name, o.exists, o.size]), [
    ["out.txt", true, 2],
    ["missing.txt", false, undefined]
  ]);
  assert.equal(files.benchmark?.seconds, 0.02);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the kept script of a job, and its preamble", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smk-scripts-"));
  const a = path.join(dir, "tmp1.hello.py");
  const b = path.join(dir, "tmp2.hello.py");
  const preamble = "######## snakemake preamble start (automatically inserted, do not edit) ########\nsnakemake = load()\n######## snakemake preamble end #########";
  fs.writeFileSync(a, `${preamble.replace("load()", "load(b'out/a.txt')")}\nprint(1)\n`);
  fs.writeFileSync(b, `${preamble.replace("load()", "load(b'out/b.txt')")}\nprint(2)\n`);
  const job = { jobid: 2, rule: "py", wildcards: {}, status: "COMPLETED", attempt: 1, output: ["out/b.txt"] } as JobState;
  assert.equal(findJobScript(job, [a, b]), b);
  const split = splitPreamble(fs.readFileSync(b, "utf8"));
  assert.match(split.preamble, /snakemake = load/);
  assert.equal(split.body, "print(2)\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("paths and sizes", () => {
  assert.equal(stripAnnotation("x.txt (temp)"), "x.txt");
  assert.equal(stripAnnotation("x (1).txt"), "x (1).txt");
  assert.equal(isInside("/w", "/w/a/b"), true);
  assert.equal(isInside("/w", "/w/../etc/passwd"), false);
  assert.equal(isInside("/w", "/w"), false);
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(scriptJson({ a: "</script>" }), '{"a":"\\u003c/script>"}');
});

test("the live rule graph", () => {
  const progress = emptyProgress();
  applyEvent(progress, { event: "rulegraph", nodes: ["a", "all"], links: [{ source: "a", target: "all" }] });
  applyEvent(progress, { event: "run_info", stats: { a: 2, all: 1, total: 3 } });
  applyEvent(progress, { event: "job_info", jobid: 1, rule: "a", local: true });
  const mermaid = ruleGraphMermaid(progress)!;
  assert.match(mermaid, /r0\["a 0\/2"\]:::running/);
  assert.match(mermaid, /r1\["all 0\/1"\]:::pending/);
  assert.match(mermaid, /r0 --> r1/);
});

test("the dashboard page loads mermaid and keeps its data inert", () => {
  const data = { kind: "graph", graph: "rules", mermaid: 'flowchart TB\n  r0["</script><b>"]', runName: "r" };
  const html = dashboardHtml(data, "vscode-resource:", "https://media/mermaid.min.js");
  const csp = html.match(/content="(default-src[^"]*)"/)![1];
  assert.match(csp, /script-src 'nonce-[^']+' vscode-resource:/);
  assert.match(html, /<script nonce="[^"]+" src="https:\/\/media\/mermaid.min.js"><\/script>/);
  // the graph text is JSON in the page, not markup
  assert.ok(!html.includes("</script><b>"));
  assert.ok(html.includes(scriptJson(data)));
  assert.match(html, /function renderGraph/);
});

test("graph and summary output after other stdout", () => {
  assert.equal(mermaidOnly("hello from the Snakefile\n---\ntitle: DAG\n---\nflowchart TB\n"), "---\ntitle: DAG\n---\nflowchart TB\n");
  assert.equal(tsvOnly("noise\noutput_file\tdate\n"), "output_file\tdate\n");
});

test("the report gets a button back to its run", () => {
  const report = '<html><body><script>const s = "</body>";</script><main>report</main></body></html>';
  const html = reportWithBackButton(report, 'flow <"run">');
  // inserted before the last </body>, not the one in the script's string
  assert.ok(html.indexOf("snakemake-positron-back") > html.indexOf("<main>report</main>"));
  assert.ok(html.endsWith("</body></html>"));
  assert.match(html, /postMessage\(\{ type: "back" \}\)/);
  assert.ok(html.includes("flow &#60;&#34;run&#34;&#62;") && !html.includes('flow <"run">'));
});
