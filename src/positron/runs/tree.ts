import * as path from "path";
import * as vscode from "vscode";

import {
  errorKinds,
  formatWildcards,
  jobLabel,
  mainError,
  summarize,
  totals,
  type JobState,
  type RuleSummary
} from "./model";
import { isActive, type Run, type RunStatus, type RunStore } from "./store";

export type RunNode =
  | { kind: "run"; run: Run }
  | { kind: "rule"; run: Run; summary: RuleSummary }
  | { kind: "job"; run: Run; job: JobState }
  | { kind: "note"; run: Run; text: string; command?: vscode.Command };

const RUN_ICONS: Record<RunStatus, [string, string?]> = {
  queued: ["clock", "testing.iconQueued"],
  starting: ["loading~spin"],
  running: ["sync~spin", "charts.blue"],
  succeeded: ["pass", "testing.iconPassed"],
  failed: ["error", "testing.iconFailed"],
  stopped: ["circle-slash", "testing.iconSkipped"],
  lost: ["question", "testing.iconQueued"]
};

const JOB_ICONS: Record<JobState["status"], [string, string?]> = {
  NEW: ["circle-outline"],
  SUBMITTED: ["clock", "testing.iconQueued"],
  QUEUED: ["clock", "testing.iconQueued"],
  RUNNING: ["sync~spin", "charts.blue"],
  COMPLETED: ["pass", "testing.iconPassed"],
  FAILED: ["error", "testing.iconFailed"],
  ABORTED: ["circle-slash", "testing.iconSkipped"]
};

function icon([id, color]: [string, string?]) {
  return new vscode.ThemeIcon(
    id,
    color ? new vscode.ThemeColor(color) : undefined
  );
}

/** Where a run's Snakemake runs, e.g. "Workbench job 123 on Kubernetes". */
export function driverLabel(run: Run): string {
  const { mode, jobId, driver } = run.record;
  if (mode !== "job") return "in the session that started it";
  return `Workbench job ${jobId ?? "?"}${driver?.cluster ? ` on ${driver.cluster}` : ""}`;
}

/** Where a run's jobs run, e.g. "Workbench jobs on Kubernetes". */
export function executorLabel(run: Run): string {
  const { config } = run.record;
  if (config.executor === "workbench")
    return `Workbench jobs${config.workbench?.cluster ? ` on ${config.workbench.cluster}` : ""}`;
  if (config.executor === "local") return "locally";
  return "as the profiles say";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function runDuration(run: Run): string {
  const start = Date.parse(run.record.startedAt);
  const end = run.record.finishedAt
    ? Date.parse(run.record.finishedAt)
    : Date.now();
  return formatDuration(end - start);
}

/** The run's label: its name, marked when it was only a dry run. */
export function runTitle(run: Run): string {
  return run.record.config.dryRun
    ? `${run.record.runName} (dry run)`
    : run.record.runName;
}

const JOB_ORDER: Record<JobState["status"], number> = {
  FAILED: 0,
  ABORTED: 1,
  RUNNING: 2,
  QUEUED: 3,
  SUBMITTED: 4,
  NEW: 5,
  COMPLETED: 6
};

export class RunsTreeProvider implements vscode.TreeDataProvider<RunNode> {
  private readonly changed = new vscode.EventEmitter<RunNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: RunStore) {
    // the run node identity changes on every refresh, so redraw everything
    store.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: RunNode): RunNode[] {
    if (!node) return this.store.all().map((run) => ({ kind: "run", run }));
    if (node.kind === "run") return runChildren(node.run);
    if (node.kind === "rule") {
      return Object.values(node.run.progress.jobs)
        .filter((job) => job.rule === node.summary.name)
        .sort(
          (a, b) =>
            JOB_ORDER[a.status] - JOB_ORDER[b.status] || a.jobid - b.jobid
        )
        .map((job) => ({ kind: "job", run: node.run, job }));
    }
    return [];
  }

  getTreeItem(node: RunNode): vscode.TreeItem {
    switch (node.kind) {
      case "run":
        return runItem(node.run);
      case "rule":
        return ruleItem(node.run, node.summary);
      case "job":
        return jobItem(node.run, node.job);
      case "note": {
        const [first] = node.text.trim().split("\n");
        const item = new vscode.TreeItem(first);
        item.iconPath = new vscode.ThemeIcon(node.command ? "lightbulb" : "info");
        item.tooltip = new vscode.MarkdownString().appendCodeblock(node.text);
        item.command = node.command;
        return item;
      }
    }
  }

  getParent(node: RunNode): RunNode | undefined {
    if (node.kind === "run") return undefined;
    return { kind: "run", run: node.run };
  }
}

function runChildren(run: Run): RunNode[] {
  const notes: RunNode[] = [];
  const note = (text: string, command?: vscode.Command) =>
    notes.push({ kind: "note", run, text, command });
  const arg = [{ kind: "run", run }];
  if (!run.record.withLogger) {
    note(
      "Job status comes from Snakemake's output. Install the workbench logger plugin for live status."
    );
  }
  if (run.record.driverError) note(run.record.driverError);
  if (run.status === "failed") {
    const error = mainError(run.progress);
    if (error) note(error.message);
    const kinds = errorKinds(run.progress);
    if (kinds.locked)
      note("The working directory is locked: unlock it, then run again.", {
        command: "snakemake.positron.runs.unlock",
        title: "Unlock",
        arguments: arg
      });
    if (kinds.incomplete)
      note("Some outputs are incomplete: run again, rerunning them.", {
        command: "snakemake.positron.runs.rerunIncomplete",
        title: "Rerun Incomplete",
        arguments: arg
      });
  }
  if (run.progress.nothingToDo && !Object.keys(run.progress.jobs).length)
    note("Nothing to be done: all requested outputs are up to date.");
  const rules: RunNode[] = summarize(run.progress).map((summary) => ({
    kind: "rule",
    run,
    summary
  }));
  return [...notes, ...rules];
}

function runItem(run: Run): vscode.TreeItem {
  const { total, done, failed } = totals(run.progress);
  const item = new vscode.TreeItem(
    runTitle(run),
    isActive(run)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
  );
  item.id = run.files.dir;
  const parts = [
    run.status,
    total && !run.record.config.dryRun ? `${done}/${total}` : undefined,
    run.record.config.dryRun && total ? `${total} jobs planned` : undefined,
    failed ? `${failed} failed` : undefined,
    runDuration(run)
  ];
  item.description = parts.filter(Boolean).join(" · ");
  item.iconPath = icon(RUN_ICONS[run.status]);
  item.contextValue = `run.${run.status}`;
  const { config } = run.record;
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${run.record.runName}** — ${run.status}\n\n`);
  tooltip.appendMarkdown(
    `Snakefile: \`${path.relative(config.cwd, config.snakefile) || config.snakefile}\`\n\n`
  );
  tooltip.appendMarkdown(`Working directory: \`${config.cwd}\`\n\n`);
  if (config.targets.length)
    tooltip.appendMarkdown(`Targets: \`${config.targets.join(" ")}\`\n\n`);
  if (config.profile) tooltip.appendMarkdown(`Profile: \`${config.profile}\`\n\n`);
  tooltip.appendMarkdown(`Jobs: ${executorLabel(run)}\n\n`);
  tooltip.appendMarkdown(`Snakemake: ${driverLabel(run)}`);
  item.tooltip = tooltip;
  return item;
}

function ruleItem(run: Run, summary: RuleSummary): vscode.TreeItem {
  const hasJobs = Object.values(run.progress.jobs).some(
    (j) => j.rule === summary.name
  );
  const item = new vscode.TreeItem(
    summary.name,
    hasJobs
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
  );
  item.id = `${run.files.dir}#rule:${summary.name}`;
  const parts = run.record.config.dryRun
    ? [`${summary.total} planned`]
    : [
        `${summary.succeeded}/${summary.total}`,
        summary.running ? `${summary.running} running` : undefined,
        summary.queued ? `${summary.queued} queued` : undefined,
        summary.failed ? `${summary.failed} failed` : undefined,
        summary.aborted ? `${summary.aborted} aborted` : undefined,
        summary.retried ? `${summary.retried} retried` : undefined
      ];
  item.description = parts.filter(Boolean).join(" · ");
  item.iconPath = run.record.config.dryRun
    ? icon(JOB_ICONS.NEW)
    : summary.failed
      ? icon(JOB_ICONS.FAILED)
      : summary.running
        ? icon(JOB_ICONS.RUNNING)
        : summary.succeeded === summary.total
          ? icon(JOB_ICONS.COMPLETED)
          : icon(JOB_ICONS.SUBMITTED);
  item.contextValue = "rule";
  return item;
}

/** A job's status in words, e.g. `queued` for a pending Workbench job. */
export function jobStatusLabel(job: JobState, dryRun = false): string {
  if (dryRun) return "planned";
  return job.status.toLowerCase();
}

function jobItem(run: Run, job: JobState): vscode.TreeItem {
  const item = new vscode.TreeItem(jobLabel(job));
  item.id = `${run.files.dir}#job${job.jobid}`;
  const elapsed =
    job.start && (job.complete || isActive(run))
      ? formatDuration((job.complete ?? Date.now()) - job.start)
      : undefined;
  const parts = [
    jobStatusLabel(job, run.record.config.dryRun),
    job.attempt > 1 ? `attempt ${job.attempt}` : undefined,
    job.externalJobId ? `job ${job.externalJobId}` : undefined,
    elapsed
  ];
  item.description = parts.filter(Boolean).join(" · ");
  item.iconPath = icon(
    run.record.config.dryRun ? JOB_ICONS.NEW : JOB_ICONS[job.status]
  );
  const flags = [
    job.externalJobId && "wb",
    job.log?.length && "log",
    // a `script:` or `run:` job; an aggregating rule like `all` has no output
    !job.shellcmd && job.output?.length && !run.record.config.dryRun && "script"
  ].filter(Boolean);
  item.contextValue = `job.${job.status.toLowerCase()}${flags.map((f) => `+${f}`).join("")}`;
  item.tooltip = [
    `${job.rule}${Object.keys(job.wildcards).length ? ` (${formatWildcards(job.wildcards)})` : ""}, job ${job.jobid}`,
    job.reason && `Reason: ${job.reason}`,
    job.externalJobId && `Workbench job: ${job.externalJobId}${job.workbenchStatus ? ` (${job.workbenchStatus})` : ""}`,
    job.output?.length && `Output: ${job.output.join(", ")}`,
    job.shellcmd && `Shell: ${job.shellcmd}`
  ]
    .filter(Boolean)
    .join("\n");
  item.command = {
    command: "snakemake.positron.runs.showJob",
    title: "Open Job Dashboard",
    arguments: [{ kind: "job", run, job }]
  };
  return item;
}
