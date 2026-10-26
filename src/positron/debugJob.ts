// Re-creates a `script:` job's environment in the console. Snakemake runs
// such a job as a copy of the script with a preamble that defines the job's
// `snakemake` object (input, output, params, wildcards, ...); with
// --skip-script-cleanup it keeps that copy. The preamble is run in the
// console from the job's working directory, and the script is opened for
// stepping through with the console's own Cmd+Enter.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import { chdirCode, scriptLanguage } from "./embeddedBlock";
import { waitForRuntime } from "./runEmbeddedCode";
import { findJobScript, splitPreamble } from "./runs/dashboard/jobFiles";
import { registerCommand } from "./runs/log";
import { formatWildcards, type JobState } from "./runs/model";
import { resolveJob } from "./runs/select";
import type { Run, RunStore } from "./runs/store";

/** Snakemake names its copy `tmp<random>.<script file name>`. */
function originalName(kept: string): string {
  return path.basename(kept).replace(/^tmp[^.]+\./, "");
}

/** The user's own script, if the workspace has exactly one by that name. */
async function originalScript(kept: string): Promise<vscode.Uri | undefined> {
  const found = await vscode.workspace.findFiles(
    `**/${originalName(kept)}`,
    "**/{.snakemake,.git,node_modules}/**",
    2
  );
  return found.length === 1 ? found[0] : undefined;
}

async function debugJob(api: PositronApi, run: Run, job: JobState) {
  const cwd = job.cwd ?? run.record.config.cwd;
  const scriptsDir = path.join(cwd, ".snakemake", "scripts");
  let inDir: string[] = [];
  try {
    // a Workbench job keeps its copy too, but logs that in its own output
    inDir = fs
      .readdirSync(scriptsDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(scriptsDir, e.name));
  } catch {
    // no script was kept in this working directory
  }
  const candidates = [...run.progress.scripts, ...inDir].filter(
    (f, i, all) => all.indexOf(f) === i && fs.existsSync(f)
  );
  const kept = findJobScript(job, candidates);
  if (!kept) {
    vscode.window.showWarningMessage(
      `No script was kept for ${job.rule}. Debugging works for \`script:\` jobs of runs with \`snakemake.run.keepScripts\` on; a \`run:\` block can be run with Cmd+Shift+Enter in the Snakefile.`
    );
    return;
  }
  const language = scriptLanguage(kept);
  if (!language) {
    // e.g. Rmarkdown, Julia or Rust scripts: show what Snakemake ran
    await vscode.window.showTextDocument(vscode.Uri.file(kept), { preview: true });
    return;
  }
  if (!(await waitForRuntime(api, language))) {
    vscode.window.showErrorMessage(
      `No ${language === "r" ? "R" : "Python"} interpreter was found to debug ${job.rule}.`
    );
    return;
  }
  const { preamble, body } = splitPreamble(await fs.promises.readFile(kept, "utf8"));
  await api.runtime.executeCode(language, chdirCode(language, cwd), true, false);
  if (preamble) await api.runtime.executeCode(language, preamble, true, false);
  const original = await originalScript(kept);
  if (original) {
    await vscode.window.showTextDocument(original);
    vscode.window.setStatusBarMessage(
      "The job's `snakemake` object is defined in the console; run the script line by line with Cmd+Enter.",
      8000
    );
    return;
  }
  const label = formatWildcards(job.wildcards);
  const document = await vscode.workspace.openTextDocument({
    language,
    content: `# ${job.rule}${label ? ` (${label})` : ""}, job ${job.jobid}: the \`snakemake\` object is defined in the console\n# Working directory: ${cwd}\n\n${body.trim()}\n`
  });
  await vscode.window.showTextDocument(document);
}

export function activateDebugJob(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  context.subscriptions.push(
    registerCommand("snakemake.positron.runs.debugJob", (node?: unknown) => {
      const found = resolveJob(store, node);
      if (!found) {
        vscode.window.showWarningMessage(
          "Could not find that job; refresh the Pipeline Runs view and try again."
        );
        return;
      }
      return debugJob(api, found.run, found.job);
    })
  );
}
