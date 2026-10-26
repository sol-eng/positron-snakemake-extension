// Resolves the run, job or file a command applies to from whatever argument
// it was invoked with. Tree actions pass the clicked node (`{ kind, run }` or
// `{ kind, run, job }`) and the editor title action passes the file's Uri,
// on desktop and in Posit Workbench alike. The palette passes nothing, and a
// raw tree item handle or a plain `{ scheme, path }` object are accepted too,
// in case a host does not convert them.

import * as vscode from "vscode";

import type { JobState } from "./model";
import type { Run, RunStore } from "./store";
import { runDuration } from "./tree";

/** Tree item ids: the run directory, or `<dir>#job<id>` for a job. */
const JOB_ID = /^(.*)#job(\d+)$/;

/** The id behind a tree item handle such as `1/<id>`. */
function handleId(arg: any): string | undefined {
  const handle = arg?.$treeItemHandle;
  return typeof handle === "string" && handle.startsWith("1/")
    ? handle.slice(2)
    : undefined;
}

export function resolveRun(store: RunStore, arg: any): Run | undefined {
  const dir = arg?.run?.files?.dir ?? handleId(arg)?.replace(/#.*$/, "");
  return typeof dir === "string" ? store.get(dir) : undefined;
}

export function resolveJob(
  store: RunStore,
  arg: any
): { run: Run; job: JobState } | undefined {
  if (arg?.kind === "job" && arg.job) {
    const run = resolveRun(store, arg);
    // the run's current state of the job, not the clicked node's copy
    const job = run?.progress.jobs[arg.job.jobid] ?? arg.job;
    return run ? { run, job } : undefined;
  }
  const match = handleId(arg)?.match(JOB_ID);
  const run = match && store.get(match[1]);
  const job = run && run.progress.jobs[Number(match[2])];
  return run && job ? { run, job } : undefined;
}

/** A file URI from a `vscode.Uri` or a plain `{ scheme, path }` object. */
export function resolveUri(arg: any): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (typeof arg?.scheme === "string" && typeof arg?.path === "string") {
    return vscode.Uri.from(arg);
  }
  return undefined;
}

/** Resolve the run from the argument, or ask which run is meant. */
export async function withRun(
  store: RunStore,
  arg: unknown,
  action: (run: Run) => unknown,
  filter: (run: Run) => boolean = () => true
) {
  let run = resolveRun(store, arg);
  if (!run) {
    await store.ready;
    const runs = store.all().filter(filter);
    if (!runs.length) {
      vscode.window.showInformationMessage(
        "There are no matching pipeline runs."
      );
      return;
    }
    const picked =
      runs.length === 1
        ? { run: runs[0] }
        : await vscode.window.showQuickPick(
            runs.map((r) => ({
              label: r.record.runName,
              description: `${r.status} · ${runDuration(r)}`,
              run: r
            })),
            { title: "Select a pipeline run" }
          );
    run = picked?.run;
  }
  if (run) return action(run);
}

/** A short description of an argument's shape, for the log. */
export function describeArg(arg: unknown): string {
  if (arg === undefined || arg === null) return String(arg);
  if (arg instanceof vscode.Uri) return `Uri(${arg.toString()})`;
  if (typeof arg !== "object") return `${typeof arg}`;
  const ctor = (arg as object).constructor?.name ?? "Object";
  const keys = Object.keys(arg as object).slice(0, 8);
  const handle = (arg as any).$treeItemHandle;
  return `${ctor}{${keys.join(",")}}${handle ? ` handle=${handle}` : ""}`;
}
