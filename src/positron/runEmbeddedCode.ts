import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import {
  blockBody,
  dedent,
  findRunBlock,
  usesJobObjects
} from "./embeddedBlock";

let warnedAboutJobObjects = false;

async function execute(
  api: PositronApi,
  text: string,
  document: vscode.TextDocument
) {
  const code = dedent(text);
  if (!code) return;
  if (usesJobObjects(code) && !warnedAboutJobObjects) {
    warnedAboutJobObjects = true;
    vscode.window.showWarningMessage(
      "This code uses a job's objects (e.g. `input`, `wildcards`), which only exist while Snakemake runs the job. To step through a job with them, use Debug Job in Console on a `script:` job in Pipeline Runs."
    );
  }
  if (!(await waitForRuntime(api, "python"))) {
    vscode.window.showErrorMessage(
      "No Python interpreter was found to run this code in the console."
    );
    return;
  }
  try {
    await api.runtime.executeCode(
      "python",
      code,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      document.uri
    );
  } catch (e) {
    // errors raised by the code itself are already shown in the console
    console.log("Snakemake: console execution failed:", e);
  }
}

/**
 * Right after startup Positron may still be discovering interpreters, and
 * executeCode fails until one is registered for the language.
 */
export async function waitForRuntime(
  api: PositronApi,
  languageId: string,
  timeoutMs = 30000
): Promise<boolean> {
  const registered = await api.runtime.getRegisteredRuntimes();
  if (registered.some((r) => r.languageId === languageId)) return true;
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Waiting for interpreters to be discovered..."
    },
    () =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => done(false), timeoutMs);
        const listener = api.runtime.onDidRegisterRuntime((r) => {
          if (r.languageId === languageId) done(true);
        });
        function done(found: boolean) {
          clearTimeout(timer);
          listener.dispose();
          resolve(found);
        }
      })
  );
}

/**
 * Run the selection, or the current line and move to the next one. A
 * Snakefile is Python, so any of it can run in the Python console.
 */
async function runSelection(api: PositronApi) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const { selection, document } = editor;
  if (!selection.isEmpty) {
    await execute(api, document.getText(selection), document);
    return;
  }
  const line = selection.active.line;
  await execute(api, document.lineAt(line).text, document);
  let next = line + 1;
  while (next < document.lineCount - 1 && !document.lineAt(next).text.trim())
    next++;
  if (next < document.lineCount) {
    const position = new vscode.Position(next, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }
}

/** Run the whole `run:` block around the cursor. */
async function runBlock(api: PositronApi) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const lines = editor.document.getText().split(/\r?\n/);
  const block = findRunBlock(lines, editor.selection.active.line);
  if (!block) {
    vscode.window.showInformationMessage(
      "Place the cursor inside a rule's `run:` block to run it in the console."
    );
    return;
  }
  await execute(api, blockBody(lines, block), editor.document);
}

export function activateRunEmbeddedCode(
  context: vscode.ExtensionContext,
  api: PositronApi
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("snakemake.positron.runSelection", () =>
      runSelection(api)
    ),
    vscode.commands.registerCommand("snakemake.positron.runBlock", () =>
      runBlock(api)
    )
  );
}
