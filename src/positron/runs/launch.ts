// The interactive "Run Pipeline" flow: pick the Snakefile, targets, profile,
// config and where the jobs run, remembering the previous answers per
// Snakefile.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type { DriverJobOptions } from "./driverJob";
import {
  execFile,
  runSetting,
  snakemake,
  type RunEnvironment
} from "./env";
import {
  defaultCwd,
  formatConfig,
  parseConfig,
  profileExecutor,
  resolveDriverMode,
  type LaunchConfig
} from "./launchArgs";

export type LaunchPlan = {
  config: LaunchConfig;
  /** run Snakemake as a Workbench job with these options, else locally */
  driver?: DriverJobOptions;
};

type Cluster = {
  name: string;
  supportsContainers?: boolean;
  resourceProfiles: string[];
};

const lastConfigKey = (snakefile: string) =>
  `snakemake.positron.launch:${snakefile}`;

/** Folders never searched for Snakefiles. */
const EXCLUDE = "**/{.snakemake,.git,node_modules,.venv,venv,.pixi,results,resources}/**";

export async function pickLaunch(
  context: vscode.ExtensionContext,
  environment: RunEnvironment,
  uri?: vscode.Uri,
  dryRun = false
): Promise<LaunchPlan | undefined> {
  const snakefile = await pickSnakefile(uri);
  if (!snakefile) return undefined;
  const cwd = defaultCwd(snakefile);
  const previous = context.workspaceState.get<LaunchConfig>(
    lastConfigKey(snakefile)
  );

  const targets = await pickTargets(environment, snakefile, cwd, previous);
  if (!targets) return undefined;

  const profile = await pickProfile(snakefile, cwd, previous);
  if (profile === null) return undefined;

  const configured = await pickConfig(cwd, previous);
  if (!configured) return undefined;

  const profileSays = profile ? readProfileExecutor(profile) : undefined;
  const jobs = await pickExecutor(environment, profileSays, previous, dryRun);
  if (jobs === null) return undefined;

  // a dry run only plans the jobs, so it never needs a job of its own
  const driver = dryRun
    ? undefined
    : await pickDriver(environment, jobs.workbench?.cluster);
  if (driver === null) return undefined;

  const config: LaunchConfig = {
    snakefile,
    cwd,
    targets,
    profile,
    configfiles: configured.configfiles,
    config: configured.config,
    executor: jobs.executor,
    workbench: jobs.workbench,
    cores: runSetting("cores", "all"),
    jobs: runSetting("jobs", 10),
    dryRun,
    extraArgs: runSetting<string[]>("extraArgs", [])
  };
  await context.workspaceState.update(lastConfigKey(snakefile), {
    ...config,
    dryRun: false
  });
  return { config, driver };
}

/** Is this a Snakefile, rather than an include? */
function isSnakefile(file: string): boolean {
  return /^(Snakefile|snakefile)$|\.smk$|\.Snakefile$/.test(path.basename(file));
}

async function pickSnakefile(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri?.scheme === "file" && isSnakefile(uri.fsPath)) return uri.fsPath;
  const active = vscode.window.activeTextEditor?.document;
  if (active?.uri.scheme === "file" && active.languageId === "snakemake") {
    return active.uri.fsPath;
  }
  const found = await vscode.workspace.findFiles(
    "**/{Snakefile,snakefile}",
    EXCLUDE,
    50
  );
  if (found.length === 1) return found[0].fsPath;
  const candidates = found.length
    ? found
    : await vscode.workspace.findFiles("**/*.smk", EXCLUDE, 50);
  if (candidates.length) {
    const picked = await vscode.window.showQuickPick(
      candidates
        .map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f }))
        .sort((a, b) => a.label.length - b.label.length),
      { title: "Run Pipeline: Snakefile", ignoreFocusOut: true }
    );
    return picked?.uri.fsPath;
  }
  const chosen = await vscode.window.showOpenDialog({
    title: "Select the workflow's Snakefile"
  });
  return chosen?.[0].fsPath;
}

/**
 * Listing the target rules parses the workflow, which can take a moment, so
 * the picker is shown straight away and filled in when they are known. No
 * selection builds the workflow's default target.
 */
function pickTargets(
  environment: RunEnvironment,
  snakefile: string,
  cwd: string,
  previous?: LaunchConfig
): Promise<string[] | undefined> {
  const quickPick = vscode.window.createQuickPick();
  quickPick.title = "Run Pipeline: Targets";
  quickPick.placeholder = "Reading the workflow's rules...";
  quickPick.canSelectMany = true;
  quickPick.ignoreFocusOut = true;
  quickPick.busy = true;
  quickPick.enabled = false;
  quickPick.show();
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string[] | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
      quickPick.dispose();
    };
    quickPick.onDidAccept(() =>
      done(quickPick.selectedItems.map((item) => item.label))
    );
    quickPick.onDidHide(() => done(undefined));
    listTargetRules(environment, snakefile, cwd).then((rules) => {
      if (settled) return;
      // only one target: it is the default
      if (rules.length <= 1) {
        done([]);
        return;
      }
      quickPick.items = rules.map((label, i) => ({
        label,
        description: i === 0 ? "default target" : undefined
      }));
      quickPick.selectedItems = quickPick.items.filter((item) =>
        previous?.targets.includes(item.label)
      );
      quickPick.placeholder =
        "Select the rules to run, or none for the default target";
      quickPick.busy = false;
      quickPick.enabled = true;
    });
  });
}

async function listTargetRules(
  environment: RunEnvironment,
  snakefile: string,
  cwd: string
): Promise<string[]> {
  try {
    const output = await snakemake(
      environment,
      cwd,
      ["--snakefile", snakefile, "--list-target-rules"],
      60000
    );
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Za-z_]\w*$/.test(l));
  } catch (e) {
    vscode.window.showWarningMessage(
      `Could not list the workflow's rules; running its default target. ${e instanceof Error ? e.message.split("\n").slice(-3).join(" ") : e}`
    );
    return [];
  }
}

/** Profile directories: the workflow's own, and the user's. */
function findProfiles(snakefile: string, cwd: string): string[] {
  const roots = [
    path.join(cwd, "profiles"),
    path.join(path.dirname(snakefile), "profiles"),
    path.join(os.homedir(), ".config", "snakemake")
  ];
  const profiles = new Set<string>();
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(root, name);
      if (fs.existsSync(path.join(dir, "config.yaml"))) profiles.add(dir);
    }
  }
  return [...profiles];
}

/**
 * A profile directory, undefined for none, or null if cancelled. Snakemake
 * applies `profiles/default` next to the Snakefile by itself, so it is not
 * offered.
 */
async function pickProfile(
  snakefile: string,
  cwd: string,
  previous?: LaunchConfig
): Promise<string | undefined | null> {
  const profiles = findProfiles(snakefile, cwd).filter(
    (p) => path.basename(p) !== "default" || p.startsWith(os.homedir() + "/.config")
  );
  if (!profiles.length) return undefined;
  type Item = vscode.QuickPickItem & { profile?: string };
  const items: Item[] = [
    { label: "$(dash) No profile" },
    ...profiles.map((p) => ({
      label: path.basename(p),
      description: [
        p.startsWith(cwd) ? path.relative(cwd, p) : p.replace(os.homedir(), "~"),
        p === previous?.profile ? "last used" : undefined
      ]
        .filter(Boolean)
        .join(" · "),
      profile: p
    }))
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Run Pipeline: Profile",
    ignoreFocusOut: true
  });
  if (!picked) return null;
  return picked.profile;
}

function readProfileExecutor(profile: string): string | undefined {
  try {
    return profileExecutor(
      fs.readFileSync(path.join(profile, "config.yaml"), "utf8")
    );
  } catch {
    return undefined;
  }
}

async function pickConfig(
  cwd: string,
  previous?: LaunchConfig
): Promise<Pick<LaunchConfig, "config" | "configfiles"> | undefined> {
  type Item = vscode.QuickPickItem & { action: string };
  const items: Item[] = [];
  if (previous && (previous.config.length || previous.configfiles.length)) {
    items.push({
      label: "$(history) Same as last time",
      description: [
        ...previous.configfiles.map((f) => path.relative(cwd, f)),
        formatConfig(previous.config)
      ]
        .filter(Boolean)
        .join(" "),
      action: "previous"
    });
  }
  items.push(
    {
      label: "$(dash) The workflow's config",
      description: "no overrides",
      action: "none"
    },
    {
      label: "$(edit) Override values...",
      description: "samples=samples.tsv threads=4",
      action: "enter"
    },
    {
      label: "$(file) Use a config file...",
      description: "YAML or JSON",
      action: "file"
    }
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: "Run Pipeline: Config",
    ignoreFocusOut: true
  });
  if (!picked) return undefined;
  if (picked.action === "previous") {
    return { config: previous!.config, configfiles: previous!.configfiles };
  }
  if (picked.action === "none") return { config: [], configfiles: [] };
  if (picked.action === "enter") {
    const value = await vscode.window.showInputBox({
      title: "Run Pipeline: Config overrides",
      prompt: "key=value pairs, as for --config",
      value: previous ? formatConfig(previous.config) : "",
      ignoreFocusOut: true
    });
    return value === undefined
      ? undefined
      : { config: parseConfig(value), configfiles: [] };
  }
  const file = await vscode.window.showOpenDialog({
    title: "Select a config file",
    defaultUri: vscode.Uri.file(cwd),
    canSelectMany: true,
    filters: { Config: ["yaml", "yml", "json"] }
  });
  return file
    ? { config: [], configfiles: file.map((f) => f.fsPath) }
    : undefined;
}

/**
 * Where the jobs run. Asked when the workbench executor is installed and the
 * profile does not decide. Null if cancelled.
 */
async function pickExecutor(
  environment: RunEnvironment,
  profileSays: string | undefined,
  previous: LaunchConfig | undefined,
  dryRun: boolean
): Promise<Pick<LaunchConfig, "executor" | "workbench"> | null> {
  if (profileSays) {
    // the profile sets the executor and its settings, e.g. the cluster
    return { executor: undefined };
  }
  // in a Workbench session, or with an API key for the Workbench server
  const reachable =
    environment.inWorkbench || !!environment.env.WORKBENCH_API_KEY;
  if (dryRun || !environment.executorPlugin || !reachable)
    return { executor: "local" };
  const local = {
    label: "$(vm) In this session",
    description: "jobs run here, with the cores this session has",
    executor: "local" as const
  };
  const workbench = {
    label: "$(cloud) As Workbench jobs",
    description: "each job is a Posit Workbench job on a cluster",
    executor: "workbench" as const
  };
  const items =
    previous?.executor === "workbench" ? [workbench, local] : [local, workbench];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Run Pipeline: Where should the jobs run?",
    ignoreFocusOut: true
  });
  if (!picked) return null;
  if (picked.executor === "local") return { executor: "local" };
  const settings = await pickWorkbench(environment, previous?.workbench);
  if (settings === null) return null;
  return { executor: "workbench", workbench: settings };
}

/** The cluster and resource profile for Workbench jobs, or null if cancelled. */
async function pickWorkbench(
  environment: RunEnvironment,
  previous?: LaunchConfig["workbench"]
): Promise<LaunchConfig["workbench"] | null> {
  const clusters = await withProgress("Listing Workbench clusters...", () =>
    listClusters(environment)
  );
  if (!clusters?.length) {
    const cluster = await vscode.window.showInputBox({
      title: "Run Pipeline: Workbench cluster",
      prompt: "The cluster to run the jobs on",
      value: previous?.cluster ?? "",
      ignoreFocusOut: true
    });
    return cluster ? { cluster } : null;
  }
  const picked =
    clusters.length === 1
      ? clusters[0]
      : (
          await vscode.window.showQuickPick(
            clusters.map((cluster) => ({
              label: cluster.name,
              description:
                cluster.name === previous?.cluster ? "last used" : undefined,
              cluster
            })),
            { title: "Run Pipeline: Workbench cluster", ignoreFocusOut: true }
          )
        )?.cluster;
  if (!picked) return null;
  const { name, resourceProfiles } = picked;
  if (!resourceProfiles.length) return { cluster: name };
  const profile = await vscode.window.showQuickPick(
    [
      { label: "$(settings) Cluster default", value: undefined },
      ...resourceProfiles.map((p) => ({
        label: p,
        description: p === previous?.resourceProfile ? "last used" : undefined,
        value: p
      }))
    ],
    { title: `Run Pipeline: Resource profile on ${name}`, ignoreFocusOut: true }
  );
  if (!profile) return null;
  return { cluster: name, resourceProfile: profile.value };
}

let launcherWorks: Promise<boolean> | undefined;

/**
 * Snakemake can run as a Workbench job from a Workbench session whose
 * launcher CLI answers. The job then runs with Workbench credentials of its
 * own.
 */
export function driverJobAvailable(
  environment: RunEnvironment
): Promise<boolean> {
  if (!environment.inWorkbench) return Promise.resolve(false);
  launcherWorks ??= execFile(environment.launcherCli, ["whoami", "--json"], {
    env: environment.env,
    timeout: 30000
  }).then(
    () => true,
    () => {
      launcherWorks = undefined;
      return false;
    }
  );
  return launcherWorks;
}

/** The options of Snakemake's own job from the settings, given its cluster. */
export function driverOptions(
  environment: RunEnvironment,
  cluster: string
): DriverJobOptions {
  return {
    cluster,
    // Workbench sets PWB_SESSION_CONTAINER_IMAGE in sessions
    image:
      runSetting("headless.image", "") ||
      environment.env.PWB_SESSION_CONTAINER_IMAGE ||
      undefined,
    cpus: runSetting("headless.cpus", 1),
    memoryMb: runSetting("headless.memory", 2048)
  };
}

/**
 * Where Snakemake itself runs. Resolves to the job's options, to undefined to
 * run it in this session, or to null if cancelled.
 */
async function pickDriver(
  environment: RunEnvironment,
  jobsCluster?: string
): Promise<DriverJobOptions | undefined | null> {
  const setting = runSetting<string>("driver", "auto");
  const available = await driverJobAvailable(environment);
  if (setting === "job" && !available) {
    vscode.window.showWarningMessage(
      "Running Snakemake as a Workbench Job needs a Positron session on Posit Workbench with a working launcher CLI; it runs in this session instead."
    );
  }
  const { mode, ask } = resolveDriverMode(setting, available);
  if (mode === "local") return undefined;
  if (ask) {
    const local = {
      label: "$(vm) In this session",
      description: "stops with the session",
      mode: "local"
    };
    const job = {
      label: "$(cloud) As a Workbench Job",
      description: "keeps running when this session is suspended or stopped",
      mode: "job"
    };
    const picked = await vscode.window.showQuickPick([local, job], {
      title: "Run Pipeline: Where should Snakemake itself run?",
      ignoreFocusOut: true
    });
    if (!picked) return null;
    if (picked.mode === "local") return undefined;
  }
  let cluster = runSetting("headless.cluster", "") || jobsCluster || "";
  if (!cluster) {
    const clusters = await withProgress("Listing Workbench clusters...", () =>
      listClusters(environment)
    );
    if (!clusters?.length) return undefined;
    const picked =
      clusters.length === 1
        ? clusters[0]
        : (
            await vscode.window.showQuickPick(
              clusters.map((c) => ({ label: c.name, cluster: c })),
              {
                title: "Run Pipeline: Cluster for Snakemake itself",
                ignoreFocusOut: true
              }
            )
          )?.cluster;
    if (!picked) return null;
    cluster = picked.name;
  }
  return driverOptions(environment, cluster);
}

export async function listClusters(
  environment: RunEnvironment
): Promise<Cluster[] | undefined> {
  try {
    const output = await execFile(
      environment.launcherCli,
      ["clusters", "--json"],
      { env: environment.env, timeout: 30000 }
    );
    return JSON.parse(output);
  } catch (e) {
    vscode.window.showWarningMessage(
      `Could not list Workbench clusters with \`${environment.launcherCli}\`. ${e}`
    );
    return undefined;
  }
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );
}
