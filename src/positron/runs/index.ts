// Launching, following and managing pipeline runs from the "Pipeline Runs"
// view.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import { stripAnnotation } from "./dashboard/jobFiles";
import {
  cancelJobs,
  cancelRunJobs,
  stopDriverJob,
  submitDriverJob,
  workbenchApi
} from "./driverJob";
import {
  execFile,
  resetRunEnvironment,
  runEnvironment,
  runSetting,
  setPositronApi,
  snakemake,
  type RunEnvironment
} from "./env";
import { driverJobAvailable, driverOptions, pickLaunch, type LaunchPlan } from "./launch";
import {
  defaultCwd,
  makeRunName,
  resolveDriverMode,
  runFiles,
  workflowArgs,
  type LaunchConfig
} from "./launchArgs";
import { output, reportErrors } from "./log";
import {
  isTerminal,
  jobLabel,
  mainError,
  summarize,
  totals,
  type JobState
} from "./model";
import { showOutput, trackOutputTerminals } from "./output";
import { signalRun, startRun, type RunRecord } from "./runner";
import { describeArg, resolveJob, resolveRun, resolveUri, withRun } from "./select";
import { isActive, RunStore, type Run } from "./store";
import { RunsTreeProvider, runDuration, runTitle } from "./tree";

export type { Run, RunStore } from "./store";

const SUSPEND_WARNING_KEY = "snakemake.positron.warnedAboutSuspend";
const LOGGER_WARNING_KEY = "snakemake.positron.warnedAboutLogger";

export function activateRuns(
  context: vscode.ExtensionContext,
  api: PositronApi
): RunStore {
  setPositronApi(api);
  extensionContext = context;
  const store = new RunStore(context);
  const tree = new RunsTreeProvider(store);
  const view = vscode.window.createTreeView("snakemake.runs", {
    treeDataProvider: tree,
    showCollapseAll: true,
    // to delete several runs at once
    canSelectMany: true
  });
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBar.command = "snakemake.runs.focus";
  const updateStatusBar = () => {
    const active = store.all().filter(isActive);
    if (!active.length) {
      statusBar.hide();
      return;
    }
    const [run] = active;
    const { done, total, failed } = totals(run.progress);
    statusBar.text = `$(sync~spin) ${run.record.runName} ${done}/${total}${failed ? ` $(error) ${failed}` : ""}${active.length > 1 ? ` (+${active.length - 1})` : ""}`;
    statusBar.tooltip = "Snakemake pipeline runs";
    statusBar.show();
  };
  store.onDidChange(updateStatusBar);
  store.onDidFinish((run) => {
    notifyFinished(run);
    cancelOrphans(run);
  });

  const ended = (r: Run) => !isActive(r);
  const commands: Record<string, (...args: any[]) => unknown> = {
    "snakemake.positron.runs.run": (uri?: unknown) =>
      runPipeline(context, store, resolveUri(uri), false),
    "snakemake.positron.runs.dryRun": (uri?: unknown) =>
      runPipeline(context, store, resolveUri(uri), true),
    "snakemake.positron.runs.runAgain": (node?: unknown) =>
      withRun(store, node, (run) => relaunch(store, run, {}), ended),
    "snakemake.positron.runs.rerunIncomplete": (node?: unknown) =>
      withRun(
        store,
        node,
        (run) => relaunch(store, run, { rerunIncomplete: true }),
        ended
      ),
    "snakemake.positron.runs.stop": (node?: unknown) =>
      withRun(store, node, (run) => stopRun(store, run), isActive),
    "snakemake.positron.runs.finishJobs": (node?: unknown) =>
      withRun(store, node, (run) => finishJobs(store, run), isActive),
    "snakemake.positron.runs.kill": (node?: unknown) =>
      withRun(store, node, (run) => killRun(store, run), isActive),
    "snakemake.positron.runs.unlock": (node?: unknown) =>
      resolveRun(store, node)
        ? withRun(store, node, (run) => unlock(run.record.config))
        : unlockWorkflow(context),
    "snakemake.positron.runs.lint": (node?: unknown) =>
      resolveRun(store, node)
        ? withRun(store, node, (run) => lint(run.record.config))
        : lintWorkflow(context),
    "snakemake.positron.runs.showOutput": (node?: unknown) =>
      withRun(store, node, (run) => showOutput(run)),
    "snakemake.positron.runs.openLog": (node?: unknown) =>
      withRun(store, node, (run) =>
        openFile(run.progress.logfile ?? run.files.output)
      ),
    "snakemake.positron.runs.remove": (node?: unknown) =>
      withRun(store, node, (run) => removeRun(store, run)),
    // the second argument is the tree's selection, to delete several runs
    "snakemake.positron.runs.delete": async (
      node?: unknown,
      selected?: unknown
    ) => {
      const picked = (
        Array.isArray(selected) && selected.length ? selected : [node]
      )
        .map((n) => resolveRun(store, n))
        .filter((r): r is Run => !!r);
      if (picked.length) return deleteRuns(store, [...new Set(picked)]);
      return withRun(store, undefined, (run) => deleteRuns(store, [run]), ended);
    },
    "snakemake.positron.runs.deleteOutput": (node?: unknown) =>
      withRun(store, node, (run) => deleteOutput(run), ended),
    "snakemake.positron.runs.cancelJob": (node?: unknown) =>
      withJob(store, node, ({ run, job }) => cancelJob(run, job)),
    "snakemake.positron.runs.openJobLog": (node?: unknown) =>
      withJob(store, node, ({ run, job }) => openJobLog(run, job)),
    "snakemake.positron.runs.copyJobId": (node?: unknown) =>
      withJob(
        store,
        node,
        ({ job }) =>
          job.externalJobId && vscode.env.clipboard.writeText(job.externalJobId)
      ),
    "snakemake.positron.runs.refresh": () => store.load(),
    "snakemake.positron.runs.diagnostics": () => showDiagnostics(),
    // non-interactive entry points, for tests and the Assistant tools
    "snakemake.positron.runs.launchConfig": (config: LaunchInput) =>
      launchConfig(store, config),
    "snakemake.positron.runs.list": async () => {
      await store.ready;
      return store.all().map(describeRun);
    }
  };

  context.subscriptions.push(
    store,
    view,
    statusBar,
    trackOutputTerminals(),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("snakemake.run")) resetRunEnvironment();
    }),
    // the interpreter decides which snakemake is used
    api.runtime.onDidChangeForegroundSession(() => resetRunEnvironment()),
    ...Object.entries(commands).map(([id, fn]) =>
      vscode.commands.registerCommand(id, reportErrors(id, fn))
    )
  );
  store.load();
  return store;
}

/** Job commands only come from the tree or dashboard, so a job is required. */
function withJob(
  store: RunStore,
  arg: unknown,
  action: (found: { run: Run; job: JobState }) => unknown
) {
  const found = resolveJob(store, arg);
  if (!found) {
    output().appendLine(`Could not find the job for ${describeArg(arg)}`);
    vscode.window.showWarningMessage(
      "Could not find that job; refresh the Pipeline Runs view and try again."
    );
    return;
  }
  return action(found);
}

export async function readyEnvironment(): Promise<RunEnvironment | undefined> {
  const environment = await runEnvironment();
  if (!environment.snakemake || environment.problems.length) {
    const choice = await vscode.window.showErrorMessage(
      environment.problems.join(" "),
      "Show Diagnostics"
    );
    if (choice) showDiagnostics();
    return undefined;
  }
  return environment;
}

async function runPipeline(
  context: vscode.ExtensionContext,
  store: RunStore,
  uri: vscode.Uri | undefined,
  dryRun: boolean
) {
  const environment = await readyEnvironment();
  if (!environment) return;
  const plan = await pickLaunch(context, environment, uri, dryRun);
  if (plan) await launch(context, store, environment, plan);
}

export type LaunchInput = Partial<LaunchConfig> & { snakefile: string };

let extensionContext: vscode.ExtensionContext | undefined;

/** Start a run without prompting. Resolves to the run's description. */
export async function launchConfig(store: RunStore, input: LaunchInput) {
  const environment = await readyEnvironment();
  if (!environment || !extensionContext) return undefined;
  const config: LaunchConfig = {
    cwd: defaultCwd(input.snakefile),
    targets: [],
    configfiles: [],
    config: [],
    cores: runSetting("cores", "all"),
    jobs: runSetting("jobs", 10),
    extraArgs: runSetting<string[]>("extraArgs", []),
    ...input
  };
  // without prompting: Snakemake runs as a Workbench job when the setting
  // allows one and a cluster for it is known, otherwise in this session
  const { mode } = resolveDriverMode(
    runSetting<string>("driver", "auto"),
    !config.dryRun && (await driverJobAvailable(environment))
  );
  const cluster =
    runSetting("headless.cluster", "") || config.workbench?.cluster;
  const driver =
    mode === "job" && cluster ? driverOptions(environment, cluster) : undefined;
  const run = await launch(extensionContext, store, environment, {
    config,
    driver
  });
  return run && describeRun(run);
}

/** A plain description of a run, for tests and the Assistant tools. */
export function describeRun(run: Run) {
  const { config } = run.record;
  return {
    runName: run.record.runName,
    dir: run.files.dir,
    status: run.status,
    snakefile: config.snakefile,
    workingDirectory: config.cwd,
    targets: config.targets,
    profile: config.profile,
    dryRun: !!config.dryRun,
    jobsOn: config.executor === "workbench" ? "workbench" : "local",
    cluster: config.workbench?.cluster,
    startedAt: run.record.startedAt,
    finishedAt: run.record.finishedAt,
    exitCode: run.record.exitCode,
    errorMessage: mainError(run.progress)?.message ?? run.record.driverError,
    nothingToDo: !!run.progress.nothingToDo,
    liveStatus: run.record.withLogger,
    snakemakeRunsIn: run.record.mode === "job" ? "job" : "session",
    snakemakeJobId: run.record.jobId,
    totals: totals(run.progress),
    rules: summarize(run.progress),
    jobs: Object.values(run.progress.jobs)
  };
}

async function relaunch(
  store: RunStore,
  run: Run,
  overrides: Partial<LaunchConfig>
) {
  if (isActive(run)) {
    vscode.window.showInformationMessage(
      `${run.record.runName} is still running.`
    );
    return;
  }
  const environment = await readyEnvironment();
  if (!environment || !extensionContext) return;
  await launch(extensionContext, store, environment, {
    config: { ...run.record.config, dryRun: false, ...overrides },
    // where Snakemake ran last time, with the same job options
    driver: run.record.mode === "job" ? run.record.driver : undefined
  });
}

async function launch(
  context: vscode.ExtensionContext,
  store: RunStore,
  environment: RunEnvironment,
  { config, driver }: LaunchPlan
): Promise<Run | undefined> {
  if (config.executor === "workbench" && !environment.executorPlugin) {
    vscode.window.showErrorMessage(
      "Running jobs as Workbench jobs needs the workbench executor plugin (snakemake-executor-plugin-workbench), which this Snakemake does not have."
    );
    return undefined;
  }
  const withLogger = environment.loggerPlugin;
  const now = new Date();
  let runName = makeRunName(config.snakefile, now);
  for (let i = 1; fs.existsSync(runFiles(config.cwd, runName).dir); i++) {
    runName = makeRunName(config.snakefile, now, String(i));
  }
  const files = runFiles(config.cwd, runName);
  const record: RunRecord = {
    runName,
    config,
    withLogger,
    mode: driver ? "job" : "local",
    startedAt: now.toISOString()
  };

  try {
    if (driver) {
      await submitDriverJob(environment, files, record, driver);
    } else {
      await startRun(environment.snakemake!, environment.env, files, record);
    }
  } catch (e) {
    vscode.window.showErrorMessage(
      `Failed to ${driver ? "submit Snakemake's Workbench job" : "start Snakemake"}: ${e instanceof Error ? e.message : e}`
    );
    return undefined;
  }
  const run = store.add(files, record);
  vscode.commands.executeCommand("snakemake.runs.focus");
  showOutput(run, true);

  if (!withLogger && !context.globalState.get(LOGGER_WARNING_KEY)) {
    context.globalState.update(LOGGER_WARNING_KEY, true);
    vscode.window.showInformationMessage(
      "Live job status needs the workbench logger plugin (snakemake-logger-plugin-workbench, part of posit-sdk-snakemake), which this Snakemake does not have. Job status is read from Snakemake's output instead."
    );
  }
  if (driver) {
    vscode.window.setStatusBarMessage(
      `Submitted ${runName} as Workbench job ${record.jobId} on ${driver.cluster}.`,
      8000
    );
  } else if (
    environment.inWorkbench &&
    !config.dryRun &&
    !context.globalState.get(SUSPEND_WARNING_KEY)
  ) {
    context.globalState.update(SUSPEND_WARNING_KEY, true);
    vscode.window.showInformationMessage(
      "Snakemake runs inside this Workbench session. If the session is suspended or stopped, the run is stopped too."
    );
  }
  return run;
}

/** Stop the run: Snakemake cancels its running jobs, then exits. */
export async function stopRun(store: RunStore, run: Run) {
  run.record.stopRequested = "stop";
  store.save(run);
  if (run.record.mode === "job" && run.record.jobId) {
    await stopDriverJob(await runEnvironment(), run.record.jobId, true);
  } else {
    signalRun(run.files, run.record, "stop");
  }
  vscode.window.setStatusBarMessage(
    `Stopping ${run.record.runName}; Snakemake is cancelling its jobs...`,
    5000
  );
}

async function finishJobs(store: RunStore, run: Run) {
  if (run.record.mode === "job") {
    vscode.window.showInformationMessage(
      "Snakemake runs as a Workbench job, which can only be stopped. Stop Run cancels its jobs."
    );
    return;
  }
  run.record.stopRequested = "finish";
  store.save(run);
  signalRun(run.files, run.record, "finish");
  vscode.window.setStatusBarMessage(
    `${run.record.runName} stops once its running jobs have finished.`,
    5000
  );
}

async function killRun(store: RunStore, run: Run) {
  const confirmed = await confirm(
    `Force kill ${run.record.runName}? Snakemake cannot clean up, so its Workbench jobs are cancelled separately and outputs it was writing are left incomplete.`,
    "Force Kill"
  );
  if (!confirmed) return;
  run.record.stopRequested = "kill";
  store.save(run);
  if (run.record.mode === "job" && run.record.jobId) {
    await stopDriverJob(await runEnvironment(), run.record.jobId, false);
  } else {
    signalRun(run.files, run.record, "kill");
  }
  // the jobs it left behind are cancelled once it has ended (cancelOrphans)
}

async function cancelJob(run: Run, job: JobState) {
  if (!job.externalJobId || isTerminal(job.status)) return;
  const confirmed = await confirm(
    `Cancel ${job.rule} (${jobLabel(job)}, Workbench job ${job.externalJobId})? Snakemake treats it as a failed job.`,
    "Cancel Job"
  );
  if (!confirmed) return;
  try {
    await cancelJobs(await runEnvironment(), [job.externalJobId]);
    vscode.window.setStatusBarMessage(
      `Cancelled Workbench job ${job.externalJobId}.`,
      5000
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to cancel the job: ${e}`);
  }
}

/** The Snakefile of the active editor or the only one, for workflow commands. */
async function pickWorkflow(
  context: vscode.ExtensionContext
): Promise<LaunchConfig | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  let snakefile =
    active?.languageId === "snakemake" && active.uri.scheme === "file"
      ? active.uri.fsPath
      : undefined;
  if (!snakefile) {
    const found = await vscode.workspace.findFiles(
      "**/{Snakefile,snakefile,*.smk}",
      "**/{.snakemake,.git,node_modules}/**",
      50
    );
    const picked =
      found.length === 1
        ? found[0]
        : (
            await vscode.window.showQuickPick(
              found.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
              { title: "Select the workflow's Snakefile" }
            )
          )?.uri;
    snakefile = picked?.fsPath;
  }
  if (!snakefile) return undefined;
  const previous = context.workspaceState.get<LaunchConfig>(
    `snakemake.positron.launch:${snakefile}`
  );
  return (
    previous ?? {
      snakefile,
      cwd: defaultCwd(snakefile),
      targets: [],
      configfiles: [],
      config: [],
      extraArgs: []
    }
  );
}

async function unlockWorkflow(context: vscode.ExtensionContext) {
  const config = await pickWorkflow(context);
  if (config) await unlock(config);
}

async function lintWorkflow(context: vscode.ExtensionContext) {
  const config = await pickWorkflow(context);
  if (config) await lint(config);
}

/** Remove the lock a killed run left on its working directory. */
async function unlock(config: LaunchConfig) {
  const environment = await readyEnvironment();
  if (!environment) return;
  try {
    await snakemake(environment, config.cwd, [
      ...workflowArgs(config),
      "--unlock"
    ]);
    vscode.window.showInformationMessage(
      `Unlocked ${vscode.workspace.asRelativePath(config.cwd)}.`
    );
  } catch (e) {
    vscode.window.showErrorMessage(`snakemake --unlock failed: ${e}`);
  }
}

async function lint(config: LaunchConfig) {
  const environment = await readyEnvironment();
  if (!environment) return;
  const channel = output();
  channel.show(true);
  channel.appendLine(`\n$ snakemake --lint (${config.snakefile})`);
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Linting the workflow..." },
      () =>
        execFile(
          environment.snakemake!,
          [...workflowArgs(config), "--lint"],
          { cwd: config.cwd, env: environment.env }
        )
    );
    channel.appendLine(result.trim() || "No issues found.");
  } catch (e) {
    // --lint exits with 1 when it found issues, and prints them to stderr
    channel.appendLine(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Delete the workflow's outputs, as Snakemake tracks them: the temporary
 * ones, or all of them, after showing what would go.
 */
async function deleteOutput(run: Run) {
  const environment = await readyEnvironment();
  if (!environment) return;
  const kind = await vscode.window.showQuickPick(
    [
      {
        label: "Temporary outputs",
        description: "files marked temp() that are left over",
        flag: "--delete-temp-output"
      },
      {
        label: "All outputs",
        description: "everything the workflow (with these targets) creates",
        flag: "--delete-all-output"
      }
    ],
    { title: `Delete outputs of ${run.record.config.snakefile}` }
  );
  if (!kind) return;
  const { config } = run.record;
  const args = [...config.targets, ...workflowArgs(config), kind.flag];
  let preview: string;
  try {
    preview = await snakemake(environment, config.cwd, [...args, "--dry-run"]);
  } catch (e) {
    vscode.window.showErrorMessage(`${kind.flag} failed: ${e}`);
    return;
  }
  const files = preview
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Would delete|Building DAG|Assuming|Job stats|This was a dry-run)/.test(l));
  if (!files.length) {
    vscode.window.showInformationMessage("There are no such outputs to delete.");
    return;
  }
  const confirmed = await confirm(
    `Delete ${kind.label.toLowerCase()} of the workflow?`,
    "Delete",
    preview.trim().split("\n").slice(0, 20).join("\n")
  );
  if (!confirmed) return;
  try {
    await snakemake(environment, config.cwd, args);
    vscode.window.setStatusBarMessage("Deleted the workflow's outputs.", 5000);
  } catch (e) {
    vscode.window.showErrorMessage(`${kind.flag} failed: ${e}`);
  }
}

/**
 * Remove runs from the list and delete their directories: the output, the
 * events, reports, and the scripts kept for debugging. The workflow's
 * outputs are not touched; Delete Workflow Outputs does that.
 */
async function deleteRuns(store: RunStore, runs: Run[]) {
  const active = runs.filter(isActive);
  if (active.length) {
    vscode.window.showInformationMessage(
      `Stop ${active.map((r) => r.record.runName).join(", ")} before deleting ${active.length === 1 ? "it" : "them"}.`
    );
  }
  const targets = runs.filter((r) => !isActive(r));
  if (!targets.length) return;
  const names = targets.map((r) => r.record.runName);
  const what = targets.length === 1 ? names[0] : `${targets.length} runs`;
  const confirmed = await confirm(
    `Delete ${what}?`,
    "Delete",
    [
      `This removes ${targets.length === 1 ? "it" : "them"} from Pipeline Runs and deletes ${targets.length === 1 ? "its" : "their"} output and reports.`,
      "The workflow's outputs are kept.",
      ...(targets.length > 1 ? ["", ...names] : [])
    ].join("\n")
  );
  if (!confirmed) return;
  const failed: string[] = [];
  for (const run of targets) {
    try {
      for (const script of run.progress.scripts)
        await fs.promises.rm(script, { force: true });
      await fs.promises.rm(run.files.dir, { recursive: true, force: true });
      store.remove(run);
    } catch (e) {
      failed.push(`${run.record.runName}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failed.length) {
    vscode.window.showErrorMessage(`Could not delete ${failed.length} run(s).`, {
      modal: true,
      detail: failed.join("\n")
    });
  }
  const deleted = targets.length - failed.length;
  if (deleted) {
    vscode.window.setStatusBarMessage(
      `Deleted ${deleted === 1 ? names[0] : `${deleted} runs`}.`,
      5000
    );
  }
}

async function removeRun(store: RunStore, run: Run) {
  if (isActive(run)) {
    vscode.window.showInformationMessage(
      `Stop ${run.record.runName} before removing it.`
    );
    return;
  }
  if (!runSetting("confirm", true)) {
    store.remove(run);
    return;
  }
  const remove = "Remove";
  const removeFiles = "Remove and Delete Its Files";
  const choice = await vscode.window.showWarningMessage(
    `Remove ${run.record.runName} from the list?`,
    {
      modal: true,
      detail: `Its output and reports are in ${run.files.dir}. The workflow's outputs are kept.`
    },
    remove,
    removeFiles
  );
  if (!choice) return;
  store.remove(run);
  if (choice === removeFiles)
    await fs.promises.rm(run.files.dir, { recursive: true, force: true });
}

async function openJobLog(run: Run, job: JobState) {
  const logs = (job.log ?? []).map((l) =>
    path.resolve(job.cwd ?? run.record.config.cwd, stripAnnotation(l))
  );
  const file =
    logs.length > 1
      ? (
          await vscode.window.showQuickPick(
            logs.map((l) => ({ label: path.basename(l), description: l, file: l })),
            { title: `${job.rule}: log files` }
          )
        )?.file
      : logs[0];
  if (file) await openFile(file);
}

export async function openFile(file: string) {
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage(`${file} does not exist (yet).`);
    return;
  }
  if (fs.statSync(file).isDirectory()) {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(file)
    );
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), {
    preview: true
  });
}

/**
 * A run that ended without cancelling its Workbench jobs (killed, or its
 * job stopped at once or evicted): cancel the jobs it left behind, by the
 * run's tag.
 */
async function cancelOrphans(run: Run) {
  const ids = run.orphans ?? [];
  run.orphans = undefined;
  if (!ids.length) return;
  try {
    const cancelled = await cancelRunJobs(
      await runEnvironment(),
      run.record.runName
    );
    if (cancelled.length) {
      vscode.window.setStatusBarMessage(
        `Cancelled ${cancelled.length} Workbench job(s) that ${run.record.runName} left running.`,
        8000
      );
    }
  } catch (e) {
    vscode.window.showWarningMessage(
      `${run.record.runName} may have left ${ids.length} Workbench job(s) running, which could not be cancelled: ${e instanceof Error ? e.message : e}`
    );
  }
}

function notifyFinished(run: Run) {
  const { done, total, failed } = totals(run.progress);
  const jobs = run.record.config.dryRun
    ? `${total} jobs planned`
    : run.progress.nothingToDo && !total
      ? "nothing to be done"
      : `${done}/${total} jobs${failed ? `, ${failed} failed` : ""}`;
  const summary = `${runTitle(run)} ${run.status} (${jobs}, ${runDuration(run)}).`;
  const outputAction = "Show Output";
  const dashboard = "Open Dashboard";
  const show =
    run.status === "succeeded"
      ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage;
  show(summary, dashboard, outputAction).then((choice) => {
    if (choice === outputAction) showOutput(run);
    if (choice === dashboard)
      vscode.commands.executeCommand(
        "snakemake.positron.runs.showRunDashboard",
        { kind: "run", run }
      );
  });
}

/** Ask before a destructive action, unless `snakemake.run.confirm` is off. */
async function confirm(
  message: string,
  action: string,
  detail?: string
): Promise<boolean> {
  if (!runSetting("confirm", true)) return true;
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    action
  );
  return choice === action;
}

async function showDiagnostics() {
  resetRunEnvironment();
  const environment = await runEnvironment();
  const channel = output();
  const lines = [
    `Snakemake: ${environment.snakemake ?? "not found"}${environment.version ? ` (${environment.version})` : ""}${environment.source ? `, from ${environment.source}` : ""}`,
    `Logger plugin (live status): ${environment.loggerPlugin ? "installed" : "not installed"}`,
    `Executor plugin (Workbench jobs): ${environment.executorPlugin ? "installed" : "not installed"}`,
    `Workbench session: ${environment.inWorkbench ? "yes" : "no"}`,
    `Snakemake as a Workbench Job: ${(await driverJobAvailable(environment)) ? `available (setting: ${runSetting("driver", "auto")}, image: ${driverOptions(environment, "-").image ?? "the cluster default"})` : "not available here"}`,
    `PATH: ${environment.env.PATH}`
  ];
  try {
    const { auth, server } = await workbenchApi(environment).whoami();
    lines.push(`Workbench API: ${os.userInfo().username} via ${auth} on ${server}`);
  } catch (e) {
    lines.push(`Workbench API: unavailable (${e instanceof Error ? e.message : e})`);
  }
  if (!environment.loggerPlugin || !environment.executorPlugin) {
    lines.push(
      "",
      "The workbench plugins come with posit-sdk-snakemake: install it into the same environment as Snakemake (pip install git+https://github.com/sol-eng/posit-sdk-snakemake)."
    );
  }
  if (environment.problems.length)
    lines.push("", "Problems:", ...environment.problems.map((p) => `- ${p}`));
  channel.appendLine(lines.join("\n"));
  channel.show();
}
