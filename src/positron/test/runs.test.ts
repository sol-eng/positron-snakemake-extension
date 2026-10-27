import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { applyEvent, parseEventChunk } from "../runs/events";
import {
  buildRunArgs,
  buildRunScript,
  defaultCwd,
  detectPlugins,
  formatConfig,
  launchDirOf,
  makeRunName,
  parseConfig,
  profileExecutor,
  resolveDriverMode,
  runFiles,
  shellQuote,
  versionAtLeast,
  workflowArgs,
  type LaunchConfig
} from "../runs/launchArgs";
import {
  emptyProgress,
  errorKinds,
  mainError,
  settleUnfinished,
  summarize,
  totals,
  unfinishedJobIds,
  updateJob
} from "../runs/model";
import { parseTextLog } from "../runs/textLog";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "../src/positron/test/fixtures", name), "utf8");

function progressFrom(name: string) {
  const progress = emptyProgress();
  const { events } = parseEventChunk("", fixture(name));
  events.forEach((e) => applyEvent(progress, e));
  return progress;
}

test("a successful run's events", () => {
  const progress = progressFrom("succeeded.events.ndjson");
  assert.equal(progress.finished, true);
  assert.deepEqual(progress.stats, { generate: 1, square: 1, sum: 1, all: 1, total: 4 });
  assert.deepEqual(totals(progress), { total: 4, done: 4, failed: 0, running: 0 });
  assert.deepEqual(progress.rulegraph?.links[0], { source: "generate", target: "square" });
  assert.equal(progress.jobs[3].rule, "generate");
  assert.equal(progress.jobs[3].local, true);
  assert.deepEqual(progress.jobs[3].resources?.mem_mb, 512);
  assert.match(progress.logfile ?? "", /\.snakemake\/log\/.*\.snakemake\.log$/);
  assert.equal(progress.errors.length, 0);
});

test("a failed run's events", () => {
  const progress = progressFrom("failed.events.ndjson");
  const failed = Object.values(progress.jobs).filter((j) => j.status === "FAILED");
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].wildcards, { s: "b" });
  assert.deepEqual(failed[0].log, ["logs/b.log"]);
  // the specific error, not "At least one job did not complete successfully"
  assert.equal(mainError(progress)?.exception, "RuleException");
  const [make] = summarize(progress).filter((s) => s.name === "make");
  assert.equal(make.total, 2);
  assert.equal(make.succeeded, 1);
  assert.equal(make.failed, 1);
  assert.equal(errorKinds(progress).locked, false);
});

test("Workbench jobs: queued, running, finished", () => {
  const progress = progressFrom("workbench.events.ndjson");
  assert.equal(progress.jobs[1].status, "COMPLETED");
  assert.equal(progress.jobs[1].externalJobId, "wb-1");
  assert.equal(progress.jobs[2].status, "QUEUED");
  assert.equal(progress.jobs[2].workbenchStatus, "Pending");
  const [align] = summarize(progress);
  assert.deepEqual(
    [align.total, align.succeeded, align.queued, align.pending],
    [2, 1, 1, 0]
  );
  // `all` is planned but not reported yet
  assert.equal(summarize(progress)[1].pending, 1);
  assert.deepEqual(unfinishedJobIds(Object.values(progress.jobs)), ["wb-2"]);
  settleUnfinished(progress);
  assert.equal(progress.jobs[2].status, "ABORTED");
});

test("status only moves forward, except when a failed job is retried", () => {
  const progress = emptyProgress();
  updateJob(progress, { jobid: 1, status: "COMPLETED" });
  updateJob(progress, { jobid: 1, status: "RUNNING" });
  assert.equal(progress.jobs[1].status, "COMPLETED");
  applyEvent(progress, { event: "job_error", jobid: 2, rule: "r" });
  applyEvent(progress, { event: "job_info", jobid: 2, rule: "r", local: false });
  assert.equal(progress.jobs[2].status, "SUBMITTED");
  assert.equal(progress.jobs[2].attempt, 2);
  assert.equal(summarize(progress).find((s) => s.name === "r")?.retried, 1);
});

test("a dry run's jobs stay planned", () => {
  const progress = emptyProgress();
  applyEvent(progress, { event: "job_info", jobid: 1, rule: "r", local: false });
  settleUnfinished(progress, true);
  assert.equal(progress.jobs[1].status, "NEW");
});

test("lock and incomplete errors offer actions", () => {
  const progress = emptyProgress();
  applyEvent(progress, { event: "error", exception: "LockException", message: "Directory cannot be locked." });
  applyEvent(progress, { event: "error", exception: "IncompleteFilesException", message: "x" });
  assert.deepEqual(errorKinds(progress), { locked: true, incomplete: true });
});

test("kept scripts are collected from warnings", () => {
  const progress = emptyProgress();
  applyEvent(progress, { event: "log", level: "WARNING", msg: "Not cleaning up /w/.snakemake/scripts/tmpab.hello.py" });
  assert.deepEqual(progress.scripts, ["/w/.snakemake/scripts/tmpab.hello.py"]);
});

test("partial lines are carried to the next chunk", () => {
  const first = parseEventChunk("", '{"event":"progress","done":1}\n{"event":"pro');
  assert.equal(first.events.length, 1);
  const second = parseEventChunk(first.rest, 'gress","done":2}\nnot json\n');
  assert.deepEqual(second.events, [{ event: "progress", done: 2 }]);
});

test("the text log fallback", () => {
  const progress = parseTextLog(fixture("failed.output.log"));
  assert.deepEqual(progress.stats, { make: 2, all: 1, total: 3 });
  assert.equal(progress.jobs[2].status, "FAILED");
  assert.deepEqual(progress.jobs[2].wildcards, { s: "b" });
  assert.deepEqual(progress.jobs[2].log, ["logs/b.log"]);
  assert.equal(progress.jobs[1].status, "COMPLETED");
  assert.equal(progress.jobs[1].benchmark, "bench/a.tsv");
  assert.ok(progress.errors.some((e) => e.exception === "WorkflowError"));
});

const config = (overrides: Partial<LaunchConfig> = {}): LaunchConfig => ({
  snakefile: "/w/workflow/Snakefile",
  cwd: "/w",
  targets: [],
  configfiles: [],
  config: [],
  extraArgs: [],
  ...overrides
});

test("run arguments: targets first, list options last", () => {
  const files = runFiles("/w", "run1");
  const args = buildRunArgs(
    config({
      targets: ["all"],
      configfiles: ["/w/config.yaml"],
      config: [["samples", "s.tsv"]],
      executor: "local",
      cores: "4",
      keepGoing: true
    }),
    files,
    { withLogger: true, printShellCommands: true, keepScripts: true }
  );
  assert.deepEqual(args, [
    "all",
    "--snakefile", "/w/workflow/Snakefile",
    "--executor", "local",
    "--cores", "4",
    "--keep-going",
    "--printshellcmds",
    "--skip-script-cleanup",
    "--logger", "workbench",
    "--logger-workbench-events-file", "/w/.snakemake/positron/run1/events.ndjson",
    "--configfile", "/w/config.yaml",
    "--config", "samples=s.tsv"
  ]);
});

test("run arguments for Workbench jobs", () => {
  const args = buildRunArgs(
    config({
      executor: "workbench",
      workbench: { cluster: "Kubernetes", resourceProfile: "large" },
      jobs: 10,
      cores: "all",
      dryRun: true
    }),
    runFiles("/w", "r"),
    { withLogger: false, keepScripts: true }
  );
  assert.deepEqual(args.slice(2), [
    "--executor", "workbench",
    "--workbench-cluster", "Kubernetes",
    "--workbench-resource-profile", "large",
    "--jobs", "10",
    "--dry-run"
  ]);
});

test("without an executor, the profiles decide", () => {
  const args = buildRunArgs(config({ cores: "all" }), runFiles("/w", "r"), { withLogger: false });
  assert.ok(!args.includes("--executor"));
  assert.deepEqual(args.slice(-2), ["--cores", "all"]);
});

test("workflow arguments for unlock, report and summary", () => {
  assert.deepEqual(workflowArgs(config({ profile: "/w/profiles/wb" })), [
    "--snakefile", "/w/workflow/Snakefile", "--profile", "/w/profiles/wb"
  ]);
});

test("run names and directories", () => {
  const now = new Date(2026, 9, 26, 9, 5, 7);
  assert.equal(makeRunName("/x/rna-seq/workflow/Snakefile", now), "rna-seq-20261026-090507");
  assert.equal(makeRunName("/x/flow/Snakefile", now, "1"), "flow-20261026-090507-1");
  assert.equal(makeRunName("/x/flow/align.smk", now), "align-20261026-090507");
  assert.equal(defaultCwd("/x/rna-seq/workflow/Snakefile"), "/x/rna-seq");
  assert.equal(defaultCwd("/x/flow/Snakefile"), "/x/flow");
  const files = runFiles("/x/flow", "r");
  assert.equal(launchDirOf(files.dir), "/x/flow");
});

test("config overrides", () => {
  const parsed = parseConfig('samples=s.tsv title="two words" n=3');
  assert.deepEqual(parsed, [["samples", "s.tsv"], ["title", "two words"], ["n", "3"]]);
  assert.equal(formatConfig(parsed), 'samples=s.tsv title="two words" n=3');
});

test("versions, plugins and profiles", () => {
  assert.equal(versionAtLeast("9.26.1", "9.0.0"), true);
  assert.equal(versionAtLeast("8.30.0", "9.0.0"), false);
  assert.equal(versionAtLeast("10.0", "9.26.1"), true);
  assert.deepEqual(detectPlugins("--workbench-cluster VALUE\n--logger-workbench-events-file VALUE"), {
    logger: true,
    executor: true
  });
  assert.equal(profileExecutor("jobs: 10\nexecutor: workbench\n"), "workbench");
  assert.equal(profileExecutor("jobs: 10\n"), undefined);
});

test("driver mode", () => {
  assert.deepEqual(resolveDriverMode("auto", true), { mode: "job", ask: true });
  assert.deepEqual(resolveDriverMode("job", true), { mode: "job", ask: false });
  assert.deepEqual(resolveDriverMode("job", false), { mode: "local", ask: false });
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("the run script forwards signals and records the exit code", () => {
  const files = runFiles("/w", "r");
  const script = buildRunScript({
    snakemake: "/opt/venv/bin/snakemake",
    args: ["--cores", "1"],
    cwd: "/w",
    files,
    runId: "r",
    identity: { home: "/home/u", user: "u", path: "/opt/venv/bin" }
  });
  assert.match(script, /^set -m$/m);
  assert.match(script, /export SNAKEMAKE_WORKBENCH_RUN_ID=r/);
  assert.match(script, /export HOME=\/home\/u USER=u LOGNAME=u/);
  assert.match(script, /trap 'stop=INT; \[ -n "\$pid" \] && kill -INT -- -"\$pid" 2>\/dev\/null' INT TERM/);
  // the traps come before Snakemake starts
  assert.ok(script.indexOf("trap ") < script.indexOf("/opt/venv/bin/snakemake"));
  assert.match(script, /echo "\$code" >\/w\/.snakemake\/positron\/r\/exitcode/);
});

test("a stop right after the start leaves nothing running", { skip: process.platform === "win32" }, async () => {
  // either the wrapper ends before it starts Snakemake, or it forwards the
  // stop as soon as Snakemake has started; Snakemake is never left behind
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smk-run-"));
  const fake = path.join(dir, "fake-snakemake");
  fs.writeFileSync(fake, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
  const files = runFiles(dir, "r");
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.script, buildRunScript({ snakemake: fake, args: [], cwd: dir, files, runId: "r" }));
  const cp = await import("node:child_process");
  for (const delayMs of [0, 5, 20]) {
    fs.rmSync(files.exitcode, { force: true });
    const child = cp.spawn("/bin/bash", ["-c", 'set -m; "$@" </dev/null >/dev/null 2>&1 & echo $!', "sh", "/bin/bash", files.script], { stdio: ["ignore", "pipe", "ignore"] });
    const pid = Number(await new Promise<string>((resolve) => child.stdout.on("data", (d) => resolve(String(d)))));
    await new Promise((r) => setTimeout(r, delayMs));
    process.kill(pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    const running = cp.execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" });
    assert.ok(!running.includes(fake), `Snakemake left running after a stop ${delayMs}ms in`);
    if (fs.existsSync(files.exitcode))
      assert.equal(fs.readFileSync(files.exitcode, "utf8").trim(), "130");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the run script stops Snakemake and records its exit code", { skip: process.platform === "win32" }, async () => {
  // a stand-in for snakemake that waits until it is interrupted
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smk-run-"));
  const fake = path.join(dir, "fake-snakemake");
  fs.writeFileSync(fake, "#!/bin/bash\ntrap 'echo interrupted; exit 130' INT\necho ready\nsleep 30 & wait\n", { mode: 0o755 });
  const files = runFiles(dir, "r");
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.script, buildRunScript({ snakemake: fake, args: [], cwd: dir, files, runId: "r" }));
  const cp = await import("node:child_process");
  const child = cp.spawn("/bin/bash", ["-c", 'set -m; "$@" </dev/null >/dev/null 2>&1 & echo $!', "sh", "/bin/bash", files.script], { stdio: ["ignore", "pipe", "ignore"] });
  const pid = Number(await new Promise<string>((resolve) => child.stdout.on("data", (d) => resolve(String(d)))));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  // signal once the stand-in has set up its handler, as Snakemake would have
  await until(() => fs.existsSync(files.output) && fs.readFileSync(files.output, "utf8").includes("ready"));
  process.kill(pid, "SIGTERM");
  await until(() => fs.existsSync(files.exitcode));
  assert.equal(fs.readFileSync(files.exitcode, "utf8").trim(), "130");
  assert.match(fs.readFileSync(files.output, "utf8"), /interrupted/);
  fs.rmSync(dir, { recursive: true, force: true });
});
