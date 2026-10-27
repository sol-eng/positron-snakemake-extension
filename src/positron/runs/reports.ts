// Shows Snakemake's report for a run in Positron's Viewer pane, with a
// button back to the run's dashboard, and its
// output summary in the Data Explorer. The workflow graphs are views of the
// dashboard (see dashboard/panel.ts).

import * as fs from "fs";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import { snakemake } from "./env";
import { tsvOnly } from "./graph";
import type { HtmlViewer } from "./htmlViewer";
import { readyEnvironment } from "./index";
import { workflowArgs } from "./launchArgs";
import { registerCommand } from "./log";
import { withRun } from "./select";
import { isActive, type Run, type RunStore } from "./store";
import { runTitle } from "./tree";

export function activateReports(
  context: vscode.ExtensionContext,
  _api: PositronApi,
  store: RunStore,
  viewer: HtmlViewer
) {

  /** Run `snakemake` for the run's workflow, with a progress notification. */
  const run = async (run: Run, title: string, args: string[]) => {
    const environment = await readyEnvironment();
    if (!environment) return undefined;
    const { config } = run.record;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () =>
        snakemake(environment, config.cwd, [
          ...config.targets,
          ...workflowArgs(config),
          ...args
        ])
    );
  };

  const failed = (what: string) => (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(
      `Could not create the ${what}: ${message.split("\n").slice(-6).join("\n")}`
    );
  };

  context.subscriptions.push(
    registerCommand("snakemake.positron.runs.openReport", (node?: unknown) =>
      withRun(store, node, async (r) => {
        if (isActive(r)) {
          vscode.window.showInformationMessage(
            `The report of ${r.record.runName} can be created when the run has ended.`
          );
          return;
        }
        const done = await run(r, "Creating the report...", [
          "--report",
          r.files.report
        ]).then(() => true, failed("report"));
        if (done && fs.existsSync(r.files.report))
          viewer.show({
            file: r.files.report,
            title: `Report: ${runTitle(r)}`,
            backLabel: `\u2190 ${runTitle(r)}`,
            onBack: () =>
              vscode.commands.executeCommand(
                "snakemake.positron.runs.showRunDashboard",
                { kind: "run", run: r }
              )
          });
      })
    ),
    registerCommand("snakemake.positron.runs.openSummary", (node?: unknown) =>
      withRun(store, node, async (r) => {
        const summary = await run(r, "Summarizing the outputs...", [
          "--detailed-summary"
        ]).catch(failed("summary"));
        if (!summary) return;
        fs.mkdirSync(r.files.dir, { recursive: true });
        fs.writeFileSync(r.files.summary, tsvOnly(summary));
        return vscode.commands.executeCommand(
          "snakemake.positron.openInDataExplorer",
          vscode.Uri.file(r.files.summary)
        );
      })
    )
  );
}

