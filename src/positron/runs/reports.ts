// Shows Snakemake's report for a run in Positron's Viewer pane, and its
// output summary in the Data Explorer. The workflow graphs are views of the
// dashboard (see dashboard/panel.ts).

import * as fs from "fs";
import * as vscode from "vscode";
import type { PositronApi, PreviewPanel } from "@posit-dev/positron";

import { snakemake } from "./env";
import { reportWithBackButton, tsvOnly } from "./graph";
import { readyEnvironment } from "./index";
import { workflowArgs } from "./launchArgs";
import { registerCommand } from "./log";
import { withRun } from "./select";
import { isActive, type Run, type RunStore } from "./store";
import { runTitle } from "./tree";

export function activateReports(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  // one panel for the report shown, with a button back to its run
  let reportPanel: PreviewPanel | undefined;
  let reportRun: Run | undefined;
  const showReport = (r: Run) => {
    const title = `Report: ${runTitle(r)}`;
    reportRun = r;
    if (!reportPanel) {
      reportPanel = api.window.createPreviewPanel(
        "snakemake.report",
        title,
        true,
        { enableScripts: true, localResourceRoots: [] }
      );
      reportPanel.webview.onDidReceiveMessage((message) => {
        if (message?.type !== "back" || !reportRun) return;
        vscode.commands.executeCommand(
          "snakemake.positron.runs.showRunDashboard",
          { kind: "run", run: reportRun }
        );
        reportPanel?.dispose();
      });
      reportPanel.onDidDispose(() => {
        reportPanel = undefined;
        reportRun = undefined;
      });
    } else {
      reportPanel.title = title;
      reportPanel.reveal(true);
    }
    reportPanel.webview.html = reportWithBackButton(
      fs.readFileSync(r.files.report, "utf8"),
      runTitle(r)
    );
  };
  context.subscriptions.push({ dispose: () => reportPanel?.dispose() });

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
        if (done && fs.existsSync(r.files.report)) showReport(r);
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

