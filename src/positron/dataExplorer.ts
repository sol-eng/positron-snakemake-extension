import * as path from "path";
import * as vscode from "vscode";

const DATA_EXPLORER_EDITOR = "workbench.editor.positronDataExplorer";

// Extensions Positron's Data Explorer opens directly, see
// DUCKDB_SUPPORTED_EXTENSIONS in positronDataExplorerEditor.contribution.ts
const DIRECT_EXTENSIONS = [".csv", ".tsv", ".parquet", ".parq", ".xlsx"];

function snapshotRoot(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, "data-explorer");
}

/**
 * Snakemake benchmarks are often tab-separated text with a `.txt` extension,
 * which the Data Explorer does not recognise. Open a `.tsv` copy instead. A
 * fresh folder per copy keeps the tab title clean and avoids reusing a Data
 * Explorer that still shows an older snapshot.
 */
async function snapshotAsTsv(
  context: vscode.ExtensionContext,
  uri: vscode.Uri
): Promise<vscode.Uri> {
  const name = path.basename(uri.path, path.extname(uri.path)) + ".tsv";
  const folder = vscode.Uri.joinPath(snapshotRoot(context), `${Date.now()}`);
  await vscode.workspace.fs.createDirectory(folder);
  const target = vscode.Uri.joinPath(folder, name);
  await vscode.workspace.fs.copy(uri, target, { overwrite: true });
  return target;
}

async function openInDataExplorer(
  context: vscode.ExtensionContext,
  uri?: vscode.Uri
) {
  uri ??= vscode.window.activeTextEditor?.document.uri;
  if (!uri) return;
  try {
    const ext = path.extname(uri.path).toLowerCase();
    let target = uri;
    if (!DIRECT_EXTENSIONS.includes(ext)) {
      target = await snapshotAsTsv(context, uri);
      vscode.window.setStatusBarMessage(
        `Opened a snapshot of ${path.basename(uri.path)}. Open it again to refresh.`,
        5000
      );
    }
    await vscode.commands.executeCommand(
      "vscode.openWith",
      target,
      DATA_EXPLORER_EDITOR
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to open in Data Explorer: ${e}`);
  }
}

/** Remove snapshots older than a day. Newer ones may be open in a window. */
async function removeOldSnapshots(context: vscode.ExtensionContext) {
  const root = snapshotRoot(context);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const [name] of await vscode.workspace.fs.readDirectory(root)) {
      if (Number(name) < cutoff) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, name), {
          recursive: true
        });
      }
    }
  } catch {
    // nothing to clean up yet
  }
}

export function activateDataExplorer(context: vscode.ExtensionContext) {
  removeOldSnapshots(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "snakemake.positron.openInDataExplorer",
      (uri?: vscode.Uri) => openInDataExplorer(context, uri)
    )
  );
}
