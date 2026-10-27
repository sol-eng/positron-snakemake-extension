// Shows the run and job dashboards, and the workflow graphs, in one page in
// Positron's Viewer, keeps it up to date while the run is active, and handles
// what the page asks for.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi, PreviewPanel } from "@posit-dev/positron";

import { jobOutput } from "../driverJob";
import { runEnvironment, snakemake } from "../env";
import { mermaidOnly, ruleGraphMermaid } from "../graph";
import { describeRun } from "../index";
import { workflowArgs } from "../launchArgs";
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
import type { HtmlViewer } from "../htmlViewer";
import { dashboardHtml } from "./html";
import { isInside, readJobFiles, readTail, stripAnnotation } from "./jobFiles";

type GraphKind = "rules" | "jobs";

type View =
  | { kind: "run"; dir: string }
  | { kind: "job"; dir: string; jobid: number }
  | { kind: "graph"; dir: string; graph: GraphKind };

/** A graph Snakemake draws, by run directory and kind. */
type DrawnGraph = { mermaid?: string; error?: string; drawing?: boolean };

const REFRESH_MS = 2000;
const LOG_LINES = 8;
const DATA_EXPLORER_EXTENSIONS = [".csv", ".tsv", ".parquet", ".parq", ".xlsx"];

export class Dashboard implements vscode.Disposable {
  private panel: PreviewPanel | undefined;
  private view: View | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private readonly subscription: vscode.Disposable;
  private readonly graphs = new Map<string, DrawnGraph>();

  constructor(
    private readonly api: PositronApi,
    private readonly store: RunStore,
    private readonly media: vscode.Uri,
    private readonly viewer: HtmlViewer
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

  showGraph(run: Run, graph: GraphKind) {
    this.show({ kind: "graph", dir: run.files.dir, graph });
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
        { enableScripts: true, localResourceRoots: [this.media] }
      );
      const mermaidUri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.media, "mermaid.min.js")
      );
      this.panel.webview.html = dashboardHtml(
        data,
        this.panel.webview.cspSource,
        mermaidUri.toString()
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
    if (this.view.kind !== "job") return { run };
    return { run, job: run.progress.jobs[this.view.jobid] };
  }

  private data() {
    const found = this.current();
    if (!found) return undefined;
    const { run, job } = found;
    if (this.view?.kind === "job") return job ? jobData(run, job) : undefined;
    if (this.view?.kind === "graph") return this.graphData(run, this.view.graph);
    return runData(run);
  }

  /**
   * The rule graph comes from the run's own events, coloured by progress and
   * live while it runs; without them, and for the job graph, Snakemake draws
   * it, in the background: the page says so meanwhile, and is updated when
   * it is done.
   */
  private graphData(run: Run, graph: GraphKind) {
    const live =
      graph === "rules"
        ? ruleGraphMermaid(run.progress, run.record.config.dryRun)
        : undefined;
    const key = `${run.files.dir}#${graph}`;
    let drawn = this.graphs.get(key);
    if (!live && !drawn) {
      drawn = { drawing: true };
      this.graphs.set(key, drawn);
      this.draw(run, graph, drawn);
    }
    return {
      kind: "graph" as const,
      id: key,
      title: `${graph === "jobs" ? "Jobs" : "Rules"}: ${runTitle(run)}`,
      runName: runTitle(run),
      status: run.status,
      graph,
      mermaid: live ?? drawn?.mermaid,
      error: live ? undefined : drawn?.error,
      colored: !!live,
      live: !!live && isActive(run)
    };
  }

  private async draw(run: Run, graph: GraphKind, into: DrawnGraph) {
    const { config } = run.record;
    try {
      const environment = await runEnvironment();
      const stdout = await snakemake(environment, config.cwd, [
        ...config.targets,
        ...workflowArgs(config),
        graph === "jobs" ? "--dag" : "--rulegraph",
        "mermaid-js"
      ]);
      into.mermaid = mermaidOnly(stdout);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      into.error = `Snakemake could not draw the ${graph === "jobs" ? "job" : "rule"} graph:\n\n${message.trim().split("\n").slice(-12).join("\n")}`;
    }
    into.drawing = false;
    // the page may show another view by now; refresh shows whatever it shows
    this.refresh();
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
      // e.g. a MultiQC report, with a way back to the job or the run
      const job = this.current()?.job;
      this.viewer.show({
        file: fs.realpathSync(file),
        title: path.basename(file),
        backLabel: `\u2190 ${job ? `${job.rule} (${jobLabel(job)})` : runTitle(run)}`,
        onBack: () => (job ? this.showJob(run, job) : this.showRun(run))
      });
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
      case "rules":
        return this.showGraph(run, "rules");
      case "dag":
      case "jobs":
        return this.showGraph(run, "jobs");
      case "back":
        return this.showRun(run);
      case "redraw":
        if (this.view?.kind === "graph") {
          this.graphs.delete(`${run.files.dir}#${this.view.graph}`);
          this.refresh();
        }
        return;
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
  store: RunStore,
  viewer: HtmlViewer
) {
  const dashboard = new Dashboard(
    api,
    store,
    vscode.Uri.joinPath(context.extensionUri, "dist", "media"),
    viewer
  );
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
    ),
    registerCommand("snakemake.positron.runs.openRulegraph", (node?: unknown) =>
      withRun(store, node, (run) => dashboard.showGraph(run, "rules"))
    ),
    registerCommand("snakemake.positron.runs.openDag", (node?: unknown) =>
      withRun(store, node, (run) => dashboard.showGraph(run, "jobs"))
    )
  );
}
