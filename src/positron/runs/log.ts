// The "Snakemake Runs" output, and error reporting for commands.

import * as vscode from "vscode";

import { describeArg } from "./select";

let channel: vscode.OutputChannel | undefined;

/** Called in a loop by tests and the Assistant tools, so not logged. */
const QUIET = new Set(["snakemake.positron.runs.list"]);

export function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Snakemake Runs");
  return channel;
}

/**
 * Log each invocation with the shape of its arguments, and show a failure
 * instead of letting the command fail silently.
 */
export function reportErrors(id: string, fn: (...args: any[]) => unknown) {
  return async (...args: any[]) => {
    if (!QUIET.has(id)) {
      output().appendLine(
        `${new Date().toISOString()} ${id}(${args.map(describeArg).join(", ")})`
      );
    }
    try {
      return await fn(...args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      output().appendLine(
        `${id} failed: ${e instanceof Error ? e.stack : message}`
      );
      const show = "Show Log";
      vscode.window
        .showErrorMessage(`Snakemake: ${message}`, show)
        .then((choice) => choice && output().show());
      return undefined;
    }
  };
}

/** Register a command with {@link reportErrors}. */
export function registerCommand(
  id: string,
  fn: (...args: any[]) => unknown
): vscode.Disposable {
  return vscode.commands.registerCommand(id, reportErrors(id, fn));
}
