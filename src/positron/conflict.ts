import * as vscode from "vscode";

// The fork contributes the same language, grammars and snippets as the
// upstream Snakemake extension, so the two should not run side by side: both
// would register providers for the same files. The manifest has no way to
// declare a conflict, so it is enforced here instead.
const UPSTREAM_ID = "snakemake.snakemake-lang";

/**
 * Returns true, and offers to remove the upstream extension, when it is
 * installed and enabled. The fork should not activate in that case.
 */
export function hasConflictingExtension(): boolean {
  if (!vscode.extensions.getExtension(UPSTREAM_ID)) return false;
  promptToResolveConflict();
  return true;
}

async function promptToResolveConflict() {
  const uninstall = "Uninstall Snakemake Language";
  const show = "Show Extension";
  const choice = await vscode.window.showWarningMessage(
    "Positron Snakemake replaces the Snakemake Language extension and is disabled while both are installed.",
    uninstall,
    show
  );
  if (choice === uninstall) {
    await vscode.commands.executeCommand(
      "workbench.extensions.uninstallExtension",
      UPSTREAM_ID
    );
    const reload = "Reload Window";
    const next = await vscode.window.showInformationMessage(
      "Reload the window to activate Positron Snakemake.",
      reload
    );
    if (next === reload) {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else if (choice === show) {
    vscode.commands.executeCommand(
      "workbench.extensions.action.showExtensionsWithIds",
      [UPSTREAM_ID]
    );
  }
}
