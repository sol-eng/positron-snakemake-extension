// Lets AI assistants list, inspect, launch and stop pipeline runs, on top of
// the run manager in ./runs, in two ways:
//
// - Posit Assistant (Positron 2026.07 on) does not use VS Code's language
//   model tools. It runs IDE commands with its `positronCommand` tool, and
//   learns which from skills. The `snakemake.positron.assistant.*` commands
//   (declared with `agent` metadata in package.json) return the results as
//   JSON, and the skill in assistant-skills/ tells it when to use them.
// - Other assistants (e.g. Copilot) use the `snakemake_*` language model tools.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import {
  describeRun,
  launchConfig,
  stopRun,
  type LaunchInput,
  type Run,
  type RunStore
} from "./runs";
import { readTail, stripAnnotation } from "./runs/dashboard/jobFiles";
import { jobOutput } from "./runs/driverJob";
import { runEnvironment } from "./runs/env";
import { registerCommand } from "./runs/log";
import { isTerminal } from "./runs/model";
import { isActive } from "./runs/store";

const LOG_LINES = 30;
/** Failed jobs described in full; enough to explain a run, and well below
 * the size Posit Assistant accepts from a command (32k characters). */
const MAX_FAILED_JOBS = 10;
const MAX_RUNNING_JOBS = 50;
const MAX_MESSAGE = 4000;

type RunNameInput = { runName?: string };
export type LaunchToolInput = {
  snakefile: string;
  targets?: string[];
  profile?: string;
  config?: Record<string, string | number | boolean>;
  dryRun?: boolean;
  rerunIncomplete?: boolean;
};

function findRun(store: RunStore, runName?: string): Run | undefined {
  const runs = store.all();
  return runName ? runs.find((r) => r.record.runName === runName) : runs[0];
}

function tail(file: string, lines: number): string | undefined {
  try {
    const { text } = readTail(file, 16 * 1024);
    return text.trimEnd().split("\n").slice(-lines).join("\n") || undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string | undefined): string | undefined {
  return text && text.length > MAX_MESSAGE
    ? `${text.slice(0, MAX_MESSAGE)}\n[... ${text.length - MAX_MESSAGE} more characters]`
    : text;
}

export async function listRunsResult(store: RunStore) {
  await store.ready;
  return store.all().map((run) => {
    const {
      runName,
      status,
      snakefile,
      targets,
      dryRun,
      startedAt,
      finishedAt,
      totals
    } = describeRun(run);
    return {
      runName,
      status,
      snakefile,
      targets,
      dryRun,
      startedAt,
      finishedAt,
      totals
    };
  });
}

export async function runStatusResult(store: RunStore, runName?: string) {
  await store.ready;
  const run = findRun(store, runName);
  if (!run) return { error: `No pipeline run ${runName ?? ""} was found.` };
  const { jobs, ...summary } = describeRun(run);
  const cwd = run.record.config.cwd;
  const failed = jobs.filter((j) => j.status === "FAILED");
  const running = jobs.filter((j) => !isTerminal(j.status));
  return {
    ...summary,
    errorMessage: clip(summary.errorMessage),
    errors: run.progress.errors.map((e) => clip(e.message)),
    failedJobs: failed.slice(0, MAX_FAILED_JOBS).map((j) => ({
      rule: j.rule,
      jobid: j.jobid,
      wildcards: j.wildcards,
      attempt: j.attempt,
      workbenchJobId: j.externalJobId,
      shellcmd: clip(j.shellcmd),
      error: clip(j.error),
      logs: (j.log ?? []).map((log) => {
        const file = path.resolve(j.cwd ?? cwd, stripAnnotation(log));
        return { file, tail: tail(file, LOG_LINES) };
      })
    })),
    failedJobsNotShown: Math.max(0, failed.length - MAX_FAILED_JOBS),
    runningJobs: running.slice(0, MAX_RUNNING_JOBS).map((j) => ({
      rule: j.rule,
      jobid: j.jobid,
      wildcards: j.wildcards,
      status: j.status,
      workbenchJobId: j.externalJobId
    })),
    runningJobsNotShown: Math.max(0, running.length - MAX_RUNNING_JOBS),
    // Snakemake's own output: the end of the run, with its error summary
    output: tail(run.files.output, LOG_LINES)
  };
}

export async function launchResult(
  store: RunStore,
  input: LaunchToolInput,
  followWith: string
) {
  await store.ready;
  if (typeof input?.snakefile !== "string")
    return { error: "Give the workflow's Snakefile as `snakefile`." };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const snakefile = path.isAbsolute(input.snakefile)
    ? input.snakefile
    : path.join(root, input.snakefile);
  if (!fs.existsSync(snakefile))
    return { error: `${snakefile} does not exist.` };
  const launch: LaunchInput = {
    snakefile,
    targets: input.targets ?? [],
    profile: input.profile,
    config: Object.entries(input.config ?? {}).map(([k, v]) => [k, String(v)]),
    dryRun: input.dryRun,
    rerunIncomplete: input.rerunIncomplete,
    executor: input.profile ? undefined : "local"
  };
  const started = await launchConfig(store, launch);
  if (!started)
    return {
      error:
        "The pipeline could not be started; see the notification for details."
    };
  const { jobs: _jobs, rules: _rules, ...summary } = started;
  return { ...summary, hint: `${followWith} with this runName to follow the run.` };
}

export async function stopResult(store: RunStore, runName?: string) {
  await store.ready;
  const run = findRun(store, runName);
  if (!run) return { error: `No pipeline run ${runName ?? ""} was found.` };
  if (!isActive(run))
    return { error: `${run.record.runName} is not running (${run.status}).` };
  await stopRun(store, run);
  return { runName: run.record.runName, stopping: true };
}

/** Commands for Posit Assistant's `positronCommand` tool; see the skill. */
function registerAssistantCommands(store: RunStore): vscode.Disposable[] {
  const json = (value: unknown) => JSON.stringify(value, null, 1);
  const follow = "Run snakemake.positron.assistant.runStatus";
  return [
    registerCommand("snakemake.positron.assistant.listRuns", async () =>
      json(await listRunsResult(store))
    ),
    registerCommand(
      "snakemake.positron.assistant.runStatus",
      async (runName?: unknown) =>
        json(await runStatusResult(store, stringArg(runName)))
    ),
    registerCommand(
      "snakemake.positron.assistant.launchPipeline",
      async (input?: unknown) =>
        json(await launchResult(store, input as LaunchToolInput, follow))
    ),
    registerCommand(
      "snakemake.positron.assistant.jobOutput",
      async (workbenchJobId?: unknown, stderr?: unknown) =>
        json(await jobOutputResult(workbenchJobId, stderr === true))
    ),
    registerCommand(
      "snakemake.positron.assistant.stopRun",
      async (runName?: unknown) =>
        json(await stopResult(store, stringArg(runName)))
    )
  ];
}

/** The end of a Workbench job's own stdout or stderr. */
export async function jobOutputResult(workbenchJobId: unknown, stderr: boolean) {
  const id =
    typeof workbenchJobId === "string"
      ? workbenchJobId
      : (workbenchJobId as { workbenchJobId?: string } | undefined)?.workbenchJobId;
  if (!id) return { error: "Give the job's workbenchJobId, from runStatus." };
  try {
    const text = await jobOutput(await runEnvironment(), id, stderr);
    const lines = text.trimEnd().split("\n");
    return {
      workbenchJobId: id,
      stream: stderr ? "stderr" : "stdout",
      output: clip(lines.slice(-200).join("\n")) ?? "",
      linesNotShown: Math.max(0, lines.length - 200)
    };
  } catch (e) {
    return { error: `Could not get the job's output: ${e instanceof Error ? e.message : e}` };
  }
}

/** A run name, also from `{ runName }` as an agent may pass it. */
function stringArg(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  const name = (value as RunNameInput | undefined)?.runName;
  return typeof name === "string" && name ? name : undefined;
}

function textResult(value: unknown) {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}

function registerLanguageModelTools(store: RunStore): vscode.Disposable[] {
  if (!vscode.lm?.registerTool) return [];
  return [
    vscode.lm.registerTool<Record<string, never>>("snakemake_listRuns", {
      invoke: async () => textResult(await listRunsResult(store))
    }),
    vscode.lm.registerTool<RunNameInput>("snakemake_runStatus", {
      invoke: async ({ input }) =>
        textResult(await runStatusResult(store, input.runName))
    }),
    vscode.lm.registerTool<LaunchToolInput>("snakemake_launchPipeline", {
      prepareInvocation: ({ input }) => {
        const config = Object.entries(input.config ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        return {
          invocationMessage: `${input.dryRun ? "Dry-running" : "Launching"} ${path.basename(input.snakefile)}`,
          confirmationMessages: {
            title: input.dryRun
              ? "Dry-run Snakemake workflow?"
              : "Run Snakemake workflow?",
            message: new vscode.MarkdownString(
              `${input.dryRun ? "Dry-run" : "Run"} \`${input.snakefile}\`` +
                (input.targets?.length
                  ? ` for \`${input.targets.join(" ")}\``
                  : "") +
                (input.profile ? ` with profile \`${input.profile}\`` : "") +
                (config ? ` and config \`${config}\`` : "") +
                (input.rerunIncomplete ? ", rerunning incomplete jobs" : "") +
                "?"
            )
          }
        };
      },
      invoke: async ({ input }) =>
        textResult(
          await launchResult(store, input, "Use snakemake_runStatus")
        )
    }),
    vscode.lm.registerTool<RunNameInput>("snakemake_stopRun", {
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Stopping ${input.runName ?? "the pipeline run"}`,
        confirmationMessages: {
          title: "Stop Snakemake run?",
          message: `Stop ${input.runName ?? "the latest pipeline run"}? Snakemake cancels its running jobs.`
        }
      }),
      invoke: async ({ input }) =>
        textResult(await stopResult(store, input.runName))
    })
  ];
}

/**
 * Make the bundled skills known to Posit Assistant. Positron added
 * `ai.registerAgentSkillRoot` in 2026.07, after the @posit-dev/positron
 * types this builds against, hence the guard.
 */
function registerSkills(
  context: vscode.ExtensionContext,
  api: PositronApi
): vscode.Disposable[] {
  const ai = (api as { ai?: { registerAgentSkillRoot?: unknown } }).ai;
  if (typeof ai?.registerAgentSkillRoot !== "function") return [];
  const root = path.join(context.extensionPath, "assistant-skills");
  return [
    (ai.registerAgentSkillRoot as (root: string) => vscode.Disposable)(root)
  ];
}

export function activateLmTools(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  context.subscriptions.push(
    ...registerAssistantCommands(store),
    ...registerLanguageModelTools(store),
    ...registerSkills(context, api)
  );
}
