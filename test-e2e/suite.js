// Runs inside Positron's extension host (--extensionTestsPath): drives the
// extension through its commands against test-e2e/workflow, and writes what
// it saw to $E2E_RESULT. See test-e2e/run.sh.
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

async function runOf(runName) {
  const runs = await vscode.commands.executeCommand("snakemake.positron.runs.list");
  return runs.find((r) => r.runName === runName);
}

async function waitFor(runName, done, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await runOf(runName);
    if (run && done(run)) return run;
    if (Date.now() > until) return run;
    await sleep(500);
  }
}

const node = (run) => ({ kind: "run", run: { files: { dir: run.dir } } });

exports.run = async function () {
  const workflow = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const snakefile = path.join(workflow, "Snakefile");
  try {
    const ext = vscode.extensions.getExtension("posit.positron-snakemake");
    check("extension found", ext);
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["run", "stop", "showRunDashboard", "openRulegraph", "debugJob"])
      check(`command ${id} registered`, commands.includes(`snakemake.positron.runs.${id}`));
    check("positron api", typeof acquirePositronApi === "function");

    // a run that succeeds
    const started = await vscode.commands.executeCommand("snakemake.positron.runs.launchConfig", {
      snakefile, executor: "local", cores: "1"
    });
    check("launch returned a run", started, started);
    const done = await waitFor(started.runName, (r) => !["queued", "starting", "running"].includes(r.status), 60000);
    check("run succeeded", done.status === "succeeded", { status: done.status, totals: done.totals, error: done.errorMessage });
    check("live status from the logger", done.liveStatus);
    check("all jobs done", done.totals.total === 3 && done.totals.done === 3, done.totals);
    const make = done.rules.find((r) => r.name === "make");
    check("per-rule summary", make && make.succeeded === 2, done.rules);
    const job = done.jobs.find((j) => j.rule === "make");
    check("job details", job && job.wildcards.s && job.log.length === 1 && job.benchmark, job);

    // dashboards and graph open without errors
    await vscode.commands.executeCommand("snakemake.positron.runs.showRunDashboard", node(done));
    await vscode.commands.executeCommand("snakemake.positron.runs.showJob", { kind: "job", run: { files: { dir: done.dir } }, job });
    await vscode.commands.executeCommand("snakemake.positron.runs.openRulegraph", node(done));
    check("dashboards opened", true);

    // run again: nothing to be done
    const again = await vscode.commands.executeCommand("snakemake.positron.runs.launchConfig", {
      snakefile, executor: "local", cores: "1"
    });
    const noop = await waitFor(again.runName, (r) => !["queued", "starting", "running"].includes(r.status), 60000);
    check("second run has nothing to do", noop.status === "succeeded" && noop.nothingToDo, { status: noop.status, nothingToDo: noop.nothingToDo });

    // a run that is stopped while a job runs
    const slow = await vscode.commands.executeCommand("snakemake.positron.runs.launchConfig", {
      snakefile, targets: ["slow"], executor: "local", cores: "1"
    });
    const running = await waitFor(slow.runName, (r) => r.jobs.some((j) => j.status === "RUNNING"), 30000);
    check("slow job running", running.jobs.some((j) => j.status === "RUNNING"), running.status);
    // reloading the runs from disk (as after a window reload) keeps following it
    await vscode.commands.executeCommand("snakemake.positron.runs.refresh");
    const reloaded = await runOf(slow.runName);
    check("an active run survives a reload", reloaded.status === "running" && reloaded.jobs.some((j) => j.status === "RUNNING"), { status: reloaded.status });
    const stopAt = Date.now();
    await vscode.commands.executeCommand("snakemake.positron.runs.stop", node(running));
    const stopped = await waitFor(slow.runName, (r) => !["queued", "starting", "running"].includes(r.status), 30000);
    const took = Date.now() - stopAt;
    check("stop ends the run quickly", stopped.status === "stopped" && took < 15000, { status: stopped.status, ms: took });
    check("stopped job is not left running", stopped.jobs.every((j) => j.status !== "RUNNING"), stopped.jobs.map((j) => j.status));

    // a dry run plans jobs without running them
    const dry = await vscode.commands.executeCommand("snakemake.positron.runs.launchConfig", {
      snakefile, targets: ["slow"], executor: "local", cores: "1", dryRun: true
    });
    const planned = await waitFor(dry.runName, (r) => !["queued", "starting", "running"].includes(r.status), 30000);
    check("dry run plans the slow job", planned.status === "succeeded" && planned.totals.total === 1, { status: planned.status, totals: planned.totals });

    // graphs open as views of the dashboard
    await vscode.commands.executeCommand("snakemake.positron.runs.openRulegraph", node(done));
    await vscode.commands.executeCommand("snakemake.positron.runs.openDag", node(done));
    check("graphs opened", true);

    // Posit Assistant: the skill and the agent commands, the way it reaches them
    const ai = acquirePositronApi().ai;
    const roots = typeof ai.getAgentSkillRoots === "function" ? await ai.getAgentSkillRoots() : [];
    const root = roots.find((r) => r.endsWith("assistant-skills"));
    check("skill root registered", root && fs.existsSync(path.join(root, "snakemake-runs", "SKILL.md")), roots);
    const allowed = await ai.getAgentAllowedCommands();
    const ours = Object.fromEntries(allowed.filter((c) => c.id.startsWith("snakemake.positron.assistant.")).map((c) => [c.id.split(".").pop(), c]));
    check("agent commands listed", ["listRuns", "runStatus", "launchPipeline", "stopRun"].every((n) => ours[n]), Object.keys(ours));
    check("read-only flags", ours.listRuns?.readOnly === true && ours.runStatus?.readOnly === true && !ours.launchPipeline?.readOnly && !ours.stopRun?.readOnly);
    const launched = await ai.validateAndExecuteCommand("snakemake.positron.assistant.launchPipeline", [{ snakefile: "Snakefile", targets: ["broken"] }]);
    const brokenRun = launched.ok && JSON.parse(launched.result);
    check("assistant launches a run", brokenRun && brokenRun.runName, launched);
    await waitFor(brokenRun.runName, (r) => !["queued", "starting", "running"].includes(r.status), 60000);
    const status = await ai.validateAndExecuteCommand("snakemake.positron.assistant.runStatus", [brokenRun.runName]);
    const parsed = status.ok && JSON.parse(status.result);
    const failedJob = parsed && parsed.failedJobs && parsed.failedJobs[0];
    check("assistant sees why it failed", parsed.status === "failed" && failedJob && failedJob.rule === "broken" &&
      failedJob.logs[0].tail.includes("reference genome not found"), parsed && { status: parsed.status, failedJobs: parsed.failedJobs });
    check("result fits the assistant", status.result.length < 32000, status.result.length);
    const listed = await ai.validateAndExecuteCommand("snakemake.positron.assistant.listRuns", []);
    check("assistant lists runs", listed.ok && JSON.parse(listed.result).some((r) => r.runName === brokenRun.runName));
  } catch (e) {
    check("no exception", false, String(e && e.stack || e));
  }
  fs.writeFileSync(process.env.E2E_RESULT, JSON.stringify(results, null, 2));
};
