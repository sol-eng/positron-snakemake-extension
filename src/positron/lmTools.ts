// Tools that let Positron Assistant list, inspect, launch and stop pipeline
// runs, on top of the run manager in ./runs.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  describeRun,
  launchConfig,
  stopRun,
  type LaunchInput,
  type Run,
  type RunStore
} from "./runs";
import { readTail, stripAnnotation } from "./runs/dashboard/jobFiles";
import { isTerminal } from "./runs/model";
import { isActive } from "./runs/store";

const LOG_LINES = 30;

type RunNameInput = { runName?: string };
type LaunchToolInput = {
  snakefile: string;
  targets?: string[];
  profile?: string;
  config?: Record<string, string | number | boolean>;
  dryRun?: boolean;
  rerunIncomplete?: boolean;
};

function json(value: unknown) {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}

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

function runStatus(run: Run) {
  const { jobs, ...summary } = describeRun(run);
  const cwd = run.record.config.cwd;
  return {
    ...summary,
    errors: run.progress.errors.map((e) => e.message),
    failedJobs: jobs
      .filter((j) => j.status === "FAILED")
      .map((j) => ({
        rule: j.rule,
        jobid: j.jobid,
        wildcards: j.wildcards,
        attempt: j.attempt,
        workbenchJobId: j.externalJobId,
        shellcmd: j.shellcmd,
        error: j.error,
        logs: (j.log ?? []).map((log) => {
          const file = path.resolve(j.cwd ?? cwd, stripAnnotation(log));
          return { file, tail: tail(file, LOG_LINES) };
        })
      })),
    runningJobs: jobs
      .filter((j) => !isTerminal(j.status))
      .map((j) => ({
        rule: j.rule,
        jobid: j.jobid,
        wildcards: j.wildcards,
        status: j.status,
        workbenchJobId: j.externalJobId
      })),
    output: tail(run.files.output, LOG_LINES)
  };
}

export function activateLmTools(
  context: vscode.ExtensionContext,
  store: RunStore
) {
  if (!vscode.lm?.registerTool) return;
  context.subscriptions.push(
    vscode.lm.registerTool<Record<string, never>>("snakemake_listRuns", {
      invoke: async () => {
        await store.ready;
        return json(
          store.all().map((run) => {
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
          })
        );
      }
    }),
    vscode.lm.registerTool<RunNameInput>("snakemake_runStatus", {
      invoke: async ({ input }) => {
        await store.ready;
        const run = findRun(store, input.runName);
        if (!run)
          return json({
            error: `No pipeline run ${input.runName ?? ""} was found.`
          });
        return json(runStatus(run));
      }
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
      invoke: async ({ input }) => {
        await store.ready;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const snakefile = path.isAbsolute(input.snakefile)
          ? input.snakefile
          : path.join(root, input.snakefile);
        if (!fs.existsSync(snakefile))
          return json({ error: `${snakefile} does not exist.` });
        const launch: LaunchInput = {
          snakefile,
          targets: input.targets ?? [],
          profile: input.profile,
          config: Object.entries(input.config ?? {}).map(([k, v]) => [
            k,
            String(v)
          ]),
          dryRun: input.dryRun,
          rerunIncomplete: input.rerunIncomplete,
          executor: input.profile ? undefined : "local"
        };
        const started = await launchConfig(store, launch);
        if (!started)
          return json({
            error:
              "The pipeline could not be started; see the notification for details."
          });
        const { jobs: _jobs, rules: _rules, ...summary } = started;
        return json({
          ...summary,
          hint: "Use snakemake_runStatus with this runName to follow the run."
        });
      }
    }),
    vscode.lm.registerTool<RunNameInput>("snakemake_stopRun", {
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Stopping ${input.runName ?? "the pipeline run"}`,
        confirmationMessages: {
          title: "Stop Snakemake run?",
          message: `Stop ${input.runName ?? "the latest pipeline run"}? Snakemake cancels its running jobs.`
        }
      }),
      invoke: async ({ input }) => {
        await store.ready;
        const run = findRun(store, input.runName);
        if (!run)
          return json({
            error: `No pipeline run ${input.runName ?? ""} was found.`
          });
        if (!isActive(run))
          return json({
            error: `${run.record.runName} is not running (${run.status}).`
          });
        await stopRun(store, run);
        return json({ runName: run.record.runName, stopping: true });
      }
    })
  );
}
