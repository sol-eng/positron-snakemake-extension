// Shows the job and run dashboards in Positron's Viewer, keeps them up to
// date while the run is active, and handles what the page asks for.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi, PreviewPanel } from "@posit-dev/positron";

import { jobOutput } from "../driverJob";
import { runEnvironment } from "../env";
import { describeRun } from "../index";
import { registerCommand } from "../log";
import {
  formatWildcards,
  isTerminal,
  jobLabel,
  type JobState
} from "../model";
import { resolveJob, withRun } from "../select";
import { isActive, type Run, type RunStore } from "../store";
import { driverLabel, executorLabel, runDuration, runTitle } from "../tree";
import { dashboardHtml } from "./html";
import { isInside, readJobFiles, readTail, stripAnnotation } from "./jobFiles";

type View =
  | { kind: "run"; dir: string }
  | { kind: "job"; dir: string; jobid: number };

const REFRESH_MS = 2000;
const LOG_LINES = 8;
const DATA_EXPLORER_EXTENSIONS = [".csv", ".tsv", ".parquet", ".parq", ".xlsx"];

export class Dashboard implements vscode.Disposable {
  private panel: PreviewPanel | undefined;
  private view: View | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly api: PositronApi,
    private readonly store: RunStore
  ) {
    this.subscription = store.onDidChange((run) => {
      if (this.view && (!run || run.files.dir === this.view.dir))
        this.refresh();
    });
  }

  showRun(run: Run) {
    this.show({ kind: "run", dir: run.files.dir });
  }

  showJob(run: Run, job: JobState) {
    this.show({ kind: "job", dir: run.files.dir, jobid: job.jobid });
  }

  dispose() {
    this.subscription.dispose();
    clearInterval(this.timer);
    this.panel?.dispose();
  }

  private show(view: View) {
    this.view = view;
    const data = this.data();
    if (!data) return;
    if (!this.panel) {
      this.panel = this.api.window.createPreviewPanel(
        "snakemake.dashboard",
        data.title,
        true,
        { enableScripts: true, localResourceRoots: [] }
      );
      this.panel.webview.html = dashboardHtml(
        data,
        this.panel.webview.cspSource
      );
      this.panel.webview.onDidReceiveMessage((message) => this.handle(message));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.view = undefined;
        clearInterval(this.timer);
        this.timer = undefined;
      });
    } else {
      this.panel.title = data.title;
      this.panel.webview.postMessage({ type: "update", data });
      this.panel.reveal(true);
    }
    // logs grow without events, so re-read them while something is running
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  private refresh() {
    if (!this.panel || !this.view || this.refreshing) return;
    this.refreshing = true;
    try {
      const data = this.data();
      if (data) this.panel.webview.postMessage({ type: "update", data });
      if (!data?.live) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    } finally {
      this.refreshing = false;
    }
  }

  private current(): { run: Run; job?: JobState } | undefined {
    if (!this.view) return undefined;
    const run = this.store.get(this.view.dir);
    if (!run) return undefined;
    if (this.view.kind === "run") return { run };
    return { run, job: run.progress.jobs[this.view.jobid] };
  }

  private data() {
    const found = this.current();
    if (!found) return undefined;
    const { run, job } = found;
    if (this.view?.kind === "job") return job ? jobData(run, job) : undefined;
    return runData(run);
  }

  private async handle(message: any) {
    const found = this.current();
    if (!found || typeof message?.type !== "string") return;
    const { run, job } = found;
    switch (message.type) {
      case "open":
        return this.open(run, String(message.path ?? ""));
      case "job": {
        const target = run.progress.jobs[Number(message.jobid)];
        if (target) this.showJob(run, target);
        return;
      }
      case "action":
        return this.action(run, job, String(message.action ?? ""));
    }
  }

  /** Open a file the page links to: only the workflow's or the run's. */
  private async open(run: Run, file: string) {
    const { cwd } = run.record.config;
    const allowed = isInside(cwd, file) || isInside(run.files.dir, file);
    if (!allowed || !fs.existsSync(file)) return;
    const ext = path.extname(file).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      this.api.window.previewHtml(fs.realpathSync(file));
    } else if (
      DATA_EXPLORER_EXTENSIONS.includes(ext) ||
      /benchmark/i.test(file)
    ) {
      await vscode.commands.executeCommand(
        "snakemake.positron.openInDataExplorer",
        vscode.Uri.file(fs.realpathSync(file))
      );
    } else {
      await vscode.window.showTextDocument(vscode.Uri.file(file), {
        preview: true
      });
    }
  }

  private async action(run: Run, job: JobState | undefined, action: string) {
    const runNode = { kind: "run", run };
    const jobNode = job && { kind: "job", run, job };
    const command = (id: string, node: unknown) =>
      node && vscode.commands.executeCommand(`snakemake.positron.runs.${id}`, node);
    switch (action) {
      case "run":
        return this.showRun(run);
      case "debug":
        return command("debugJob", jobNode);
      case "cancel":
        return command("cancelJob", jobNode);
      case "copy":
        return command("copyJobId", jobNode);
      case "stdout":
      case "stderr":
        return job && showWorkbenchOutput(job, action === "stderr");
      case "terminal":
        vscode.window
          .createTerminal({
            name: `Snakemake: ${run.record.runName}`,
            cwd: job?.cwd ?? run.record.config.cwd
          })
          .show();
        return;
      case "output":
        return command("showOutput", runNode);
      case "log":
        return command("openLog", runNode);
      case "report":
        return command("openReport", runNode);
      case "rulegraph":
        return command("openRulegraph", runNode);
      case "dag":
        return command("openDag", runNode);
      case "summary":
        return command("openSummary", runNode);
    }
  }
}

/** A Workbench job's stdout or stderr, in an editor. */
async function showWorkbenchOutput(job: JobState, stderr: boolean) {
  if (!job.externalJobId) return;
  const text = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Fetching the output of Workbench job ${job.externalJobId}...`
    },
    async () => jobOutput(await runEnvironment(), job.externalJobId!, stderr)
  ).then(
    (t) => t,
    (e) => {
      vscode.window.showErrorMessage(`Could not fetch the job's output: ${e}`);
      return undefined;
    }
  );
  if (text === undefined) return;
  const document = await vscode.workspace.openTextDocument({
    content: text || `(Workbench job ${job.externalJobId} wrote nothing to ${stderr ? "stderr" : "stdout"})`,
    language: "log"
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

function jobData(run: Run, job: JobState) {
  const cwd = job.cwd ?? run.record.config.cwd;
  return {
    kind: "job" as const,
    id: `${run.files.dir}#job${job.jobid}`,
    title: `Job: ${job.rule} ${formatWildcards(job.wildcards) || job.jobid}`,
    runName: runTitle(run),
    runDir: run.files.dir,
    job,
    files: readJobFiles(job, cwd),
    dryRun: !!run.record.config.dryRun,
    canDebug: !job.shellcmd && !!job.output?.length && !run.record.config.dryRun,
    canCancel: !!job.externalJobId && !isTerminal(job.status),
    now: Date.now(),
    live: isActive(run) && !isTerminal(job.status)
  };
}

function runData(run: Run) {
  const { jobs, ...summary } = describeRun(run);
  const cwd = run.record.config.cwd;
  const failed = jobs
    .filter((j) => j.status === "FAILED")
    .map((j) => ({
      jobid: j.jobid,
      label: `${j.rule} (${jobLabel(j)})`,
      externalJobId: j.externalJobId,
      log: logTail(j, j.cwd ?? cwd) ?? j.error
    }));
  const running = jobs
    .filter((j) => j.status === "RUNNING")
    .map((j) => ({ jobid: j.jobid, label: `${j.rule} (${jobLabel(j)})` }));
  return {
    kind: "run" as const,
    id: run.files.dir,
    title: `Run: ${runTitle(run)}`,
    run: summary,
    errors: run.progress.errors.map((e) => e.message),
    failed,
    running,
    duration: runDuration(run),
    executor: executorLabel(run),
    driver: driverLabel(run),
    live: isActive(run)
  };
}

/** The last lines of a failed job's first log file. */
export function logTail(job: JobState, cwd: string): string | undefined {
  for (const log of job.log ?? []) {
    try {
      const { text } = readTail(path.resolve(cwd, stripAnnotation(log)), 16 * 1024);
      const tail = text.trimEnd().split("\n").slice(-LOG_LINES).join("\n");
      if (tail) return tail;
    } catch {
      // not written
    }
  }
  return undefined;
}

export function activateDashboard(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  const dashboard = new Dashboard(api, store);
  context.subscriptions.push(
    dashboard,
    registerCommand("snakemake.positron.runs.showJob", (node?: unknown) => {
      const found = resolveJob(store, node);
      if (!found) {
        vscode.window.showWarningMessage(
          "Could not find that job; refresh the Pipeline Runs view and try again."
        );
        return;
      }
      dashboard.showJob(found.run, found.job);
    }),
    registerCommand(
      "snakemake.positron.runs.showRunDashboard",
      (node?: unknown) => withRun(store, node, (run) => dashboard.showRun(run))
    )
  );
}
