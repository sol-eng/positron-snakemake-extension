// Builds the `snakemake` command line and the script that runs it. Kept free
// of `vscode` so it can be unit tested.

import * as path from "path";

export type LaunchConfig = {
  /** absolute path of the Snakefile */
  snakefile: string;
  /** the working directory Snakemake runs in */
  cwd: string;
  /** rules or files to build; the workflow's default target if empty */
  targets: string[];
  /** a profile directory or name (`--profile`) */
  profile?: string;
  configfiles: string[];
  /** `--config key=value` overrides */
  config: [string, string][];
  /** run jobs as Workbench jobs; else locally, or as the profile says */
  executor?: "local" | "workbench";
  workbench?: { cluster?: string; resourceProfile?: string };
  /** `--cores` for local runs: a number or `all` */
  cores?: string;
  /** `--jobs` for Workbench jobs */
  jobs?: number;
  keepGoing?: boolean;
  rerunIncomplete?: boolean;
  dryRun?: boolean;
  extraArgs: string[];
};

export type RunFiles = {
  dir: string;
  record: string;
  /** the wrapper that runs Snakemake */
  script: string;
  output: string;
  events: string;
  /** the Snakemake process, written by the wrapper */
  pid: string;
  /** Snakemake's exit code, written by the wrapper when it ends */
  exitcode: string;
  report: string;
  summary: string;
};

export function runFiles(cwd: string, runName: string): RunFiles {
  const dir = path.join(cwd, ".snakemake", "positron", runName);
  const file = (name: string) => path.join(dir, name);
  return {
    dir,
    record: file("run.json"),
    script: file("run.sh"),
    output: file("output.log"),
    events: file("events.ndjson"),
    pid: file("snakemake.pid"),
    exitcode: file("exitcode"),
    report: file("report.html"),
    summary: file("summary.tsv")
  };
}

/** The launch directory of a run directory made by {@link runFiles}. */
export function launchDirOf(runDir: string): string {
  return path.dirname(path.dirname(path.dirname(runDir)));
}

/**
 * Snakemake's conventional layouts are `<dir>/Snakefile` and
 * `<dir>/workflow/Snakefile`; both run from `<dir>`.
 */
export function defaultCwd(snakefile: string): string {
  const dir = path.dirname(snakefile);
  return path.basename(dir) === "workflow" ? path.dirname(dir) : dir;
}

/** A name for the run, from the workflow's directory or file name. */
export function makeRunName(
  snakefile: string,
  now: Date,
  suffix = ""
): string {
  const file = path.basename(snakefile).replace(/\.(smk|snakefile)$/i, "");
  const named = file.toLowerCase() !== "snakefile" ? file : "";
  const base =
    (named || path.basename(defaultCwd(snakefile)))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base.slice(0, 50)}-${stamp}${suffix ? `-${suffix}` : ""}`;
}

export type RunOptions = {
  /** follow the run through the workbench logger plugin */
  withLogger: boolean;
  printShellCommands?: boolean;
  keepScripts?: boolean;
};

export function buildRunArgs(
  config: LaunchConfig,
  files: RunFiles,
  options: RunOptions
): string[] {
  // targets come first: --configfile and --config take several values, and
  // would swallow targets that follow them
  const args = [...config.targets, "--snakefile", config.snakefile];
  if (config.profile) args.push("--profile", config.profile);
  if (config.executor === "workbench") {
    args.push("--executor", "workbench");
    if (config.workbench?.cluster)
      args.push("--workbench-cluster", config.workbench.cluster);
    if (config.workbench?.resourceProfile)
      args.push(
        "--workbench-resource-profile",
        config.workbench.resourceProfile
      );
    if (config.jobs) args.push("--jobs", String(config.jobs));
  } else if (config.cores) {
    args.push("--cores", config.cores);
  }
  if (config.keepGoing) args.push("--keep-going");
  if (config.rerunIncomplete) args.push("--rerun-incomplete");
  if (config.dryRun) args.push("--dry-run");
  if (options.printShellCommands) args.push("--printshellcmds");
  if (options.keepScripts && !config.dryRun) args.push("--skip-script-cleanup");
  if (options.withLogger) {
    args.push(
      "--logger",
      "workbench",
      "--logger-workbench-events-file",
      files.events
    );
  }
  args.push(...config.extraArgs);
  if (config.configfiles.length)
    args.push("--configfile", ...config.configfiles);
  if (config.config.length)
    args.push("--config", ...config.config.map(([k, v]) => `${k}=${v}`));
  return args;
}

/**
 * The arguments that select the same workflow, profile and config as a run,
 * for commands like `--unlock`, `--report` or `--summary` that act on it.
 */
export function workflowArgs(config: LaunchConfig): string[] {
  const args = ["--snakefile", config.snakefile];
  if (config.profile) args.push("--profile", config.profile);
  if (config.configfiles.length)
    args.push("--configfile", ...config.configfiles);
  if (config.config.length)
    args.push("--config", ...config.config.map(([k, v]) => `${k}=${v}`));
  return args;
}

/**
 * Parse `key=value` pairs, separated by spaces, as `--config` takes them.
 * Quotes group a value with spaces.
 */
export function parseConfig(input: string): [string, string][] {
  const tokens = [...input.matchAll(/(\S+?)=("([^"]*)"|'([^']*)'|\S*)/g)];
  return tokens.map((m) => [m[1], m[3] ?? m[4] ?? m[2]]);
}

export function formatConfig(config: [string, string][]): string {
  return config
    .map(([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`)
    .join(" ");
}

/** Parse `snakemake --version` output, e.g. `9.26.1`. */
export function parseSnakemakeVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1];
}

/** Compare dotted versions numerically. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Which of the workbench plugins `snakemake --help` lists. */
export function detectPlugins(help: string): {
  logger: boolean;
  executor: boolean;
} {
  return {
    logger: help.includes("--logger-workbench-events-file"),
    executor: help.includes("--workbench-cluster")
  };
}

/** Does `ps -o command=` output belong to the run with this wrapper? */
export function isRunProcess(command: string, script: string): boolean {
  return command.includes(script);
}

/** Quote a word for bash. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;
}

export type RunScript = {
  snakemake: string;
  args: string[];
  cwd: string;
  files: RunFiles;
  /** tags the run's Workbench jobs (`snakemake-run:<id>`) */
  runId: string;
  /**
   * The session's identity, for a run that is itself a Workbench job, whose
   * container may have no passwd entry for the user (HOME is then unset or
   * `/`, and Snakemake cannot find its cache or the user name).
   */
  identity?: { home: string; user: string; path: string };
};

/**
 * The script that runs Snakemake, locally and as a Workbench job alike. It
 * runs Snakemake in the background with job control on (`set -m`), so that
 * Snakemake gets its own process group and the default SIGINT handling: a
 * background process otherwise starts with SIGINT ignored, and Snakemake
 * could not be stopped the way Ctrl+C stops it. The script forwards SIGTERM
 * and SIGINT as SIGINT to Snakemake's process group, as Ctrl+C in a terminal
 * would: local jobs end at once, and Snakemake cancels its Workbench jobs
 * before it exits. SIGUSR1 is forwarded to Snakemake alone as SIGTERM, which
 * makes it wait for its running jobs instead. Stopping a Workbench job sends
 * SIGTERM, so stopping a run that is a job cancels its jobs too.
 */
export function buildRunScript(script: RunScript): string {
  const q = shellQuote;
  const { files } = script;
  const lines = [
    "#!/bin/bash",
    "# Generated by the Positron Snakemake extension: runs Snakemake for this run.",
    "set -m",
    `cd ${q(script.cwd)} || exit 1`,
    `export SNAKEMAKE_WORKBENCH_RUN_ID=${q(script.runId)}`
  ];
  if (script.identity) {
    const { home, user, path: searchPath } = script.identity;
    lines.push(
      `export HOME=${q(home)} USER=${q(user)} LOGNAME=${q(user)}`,
      // a job's PATH comes from its image; the session's comes first
      `export PATH=${q(searchPath)}:"\${PATH:-/usr/local/bin:/usr/bin:/bin}"`
    );
  }
  lines.push(
    // trapped before Snakemake starts, so that an early stop is not lost;
    // Snakemake itself starts with the default handlers
    "pid= stop=",
    `trap 'stop=INT; [ -n "$pid" ] && kill -INT -- -"$pid" 2>/dev/null' INT TERM`,
    `trap 'stop=TERM; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null' USR1`,
    `${[script.snakemake, ...script.args].map(q).join(" ")} >>${q(files.output)} 2>&1 </dev/null &`,
    "pid=$!",
    `echo "$pid" >${q(files.pid)}`,
    `if [ "$stop" = INT ]; then kill -INT -- -"$pid" 2>/dev/null; elif [ "$stop" = TERM ]; then kill -TERM "$pid" 2>/dev/null; fi`,
    // wait returns early when a trapped signal arrives
    `wait "$pid"; code=$?`,
    `while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done`,
    `echo "$code" >${q(files.exitcode)}`,
    `exit "$code"`
  );
  return lines.join("\n") + "\n";
}

export type JobState = "queued" | "running" | "ended" | "missing";

/**
 * The state of `jobId` in `posit-workbench-smk-launcher status` output, one
 * `<id> <STATE>` line per job. A job that is not listed is `missing`: it may
 * not be visible yet right after it was submitted.
 */
export function parseJobStatus(output: string, jobId: string): JobState {
  for (const line of output.split("\n")) {
    const [id, state] = line.trim().split(/\s+/);
    if (id !== jobId) continue;
    if (state === "PENDING" || state === "HOLD") return "queued";
    if (state === "RUNNING") return "running";
    return "ended";
  }
  return "missing";
}

export type DriverMode = "local" | "job";

/**
 * Where Snakemake runs: `auto` uses a Workbench job when one is possible,
 * `job` insists on one, and `local` never uses one.
 */
export function resolveDriverMode(
  setting: string,
  jobAvailable: boolean
): { mode: DriverMode; ask: boolean } {
  if (setting === "local" || !jobAvailable)
    return { mode: "local", ask: false };
  return { mode: "job", ask: setting !== "job" };
}

/** The tag on every Workbench job of a run. */
export function runTag(runId: string): string {
  return `snakemake-run:${runId}`;
}

/** Does a profile's config.yaml choose an executor? */
export function profileExecutor(configYaml: string): string | undefined {
  return configYaml.match(/^executor:\s*["']?([\w-]+)/m)?.[1];
}
