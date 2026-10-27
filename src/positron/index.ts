// Entry point for everything specific to the Positron fork. Upstream files
// only call into this folder through small hooks marked `// Positron:`.
import type * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import { activateDataExplorer } from "./dataExplorer";
import { activateDebugJob } from "./debugJob";
import { activateLmTools } from "./lmTools";
import { activateRunEmbeddedCode } from "./runEmbeddedCode";
import { activateRuns } from "./runs";
import { activateDashboard } from "./runs/dashboard/panel";
import { activateReports } from "./runs/reports";

export { hasConflictingExtension } from "./conflict";

let positronApi: PositronApi | undefined;

/**
 * Positron injects `acquirePositronApi` as a global. Use it directly rather
 * than importing from @posit-dev/positron, so that package stays type-only.
 */
export function tryAcquirePositronApi(): PositronApi | undefined {
  if (positronApi) return positronApi;
  try {
    if (typeof acquirePositronApi === "function") {
      positronApi = acquirePositronApi();
    }
  } catch (e) {
    console.log("Not running in Positron:", e);
  }
  return positronApi;
}

export function isPositron(): boolean {
  return tryAcquirePositronApi() !== undefined;
}

export function activatePositron(context: vscode.ExtensionContext) {
  const api = tryAcquirePositronApi();
  if (!api) return;
  activateRunEmbeddedCode(context, api);
  activateDataExplorer(context);
  const runs = activateRuns(context, api);
  activateDebugJob(context, api, runs);
  activateReports(context, api, runs);
  activateDashboard(context, api, runs);
  activateLmTools(context, api, runs);
}
