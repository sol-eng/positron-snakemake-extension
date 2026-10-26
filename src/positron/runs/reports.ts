// Shows a run's workflow graphs and Snakemake's report in Positron's Viewer
// pane, and its output summary in the Data Explorer.

import * as fs from "fs";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import { snakemake } from "./env";
import { graphHtml, mermaidOnly, ruleGraphMermaid, tsvOnly } from "./graph";
import { readyEnvironment } from "./index";
import { workflowArgs } from "./launchArgs";
import { registerCommand } from "./log";
import { withRun } from "./select";
import { isActive, type Run, type RunStore } from "./store";

export function activateReports(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  const media = vscode.Uri.joinPath(context.extensionUri, "dist", "media");

  const showGraph = (title: string, mermaid: string) => {
    const panel = api.window.createPreviewPanel(
      "snakemake.graph",
      title,
      true,
      { enableScripts: true, localResourceRoots: [media] }
    );
    const mermaidUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(media, "mermaid.min.js")
    );
    panel.webview.html = graphHtml(
      mermaid,
      title,
      mermaidUri.toString(),
      panel.webview.cspSource
    );
  };

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
    registerCommand("snakemake.positron.runs.openRulegraph", (node?: unknown) =>
      withRun(store, node, async (r) => {
        // the run's own graph, coloured by progress, once Snakemake sent it
        const live = ruleGraphMermaid(r.progress, r.record.config.dryRun);
        if (live) return showGraph(`Rules: ${r.record.runName}`, live);
        const mermaid = await run(r, "Drawing the rule graph...", [
          "--rulegraph",
          "mermaid-js"
        ]).catch(failed("rule graph"));
        if (mermaid) showGraph(`Rules: ${r.record.runName}`, mermaidOnly(mermaid));
      })
    ),
    registerCommand("snakemake.positron.runs.openDag", (node?: unknown) =>
      withRun(store, node, async (r) => {
        const mermaid = await run(r, "Drawing the job graph...", [
          "--dag",
          "mermaid-js"
        ]).catch(failed("job graph"));
        if (mermaid) showGraph(`Jobs: ${r.record.runName}`, mermaidOnly(mermaid));
      })
    ),
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
          api.window.previewHtml(r.files.report);
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

