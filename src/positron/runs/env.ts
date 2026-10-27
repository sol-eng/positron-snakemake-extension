// Resolves what a pipeline run needs from the machine: the `snakemake`
// executable, the workbench logger and executor plugins, and the launcher
// CLI.

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import {
  detectPlugins,
  parseSnakemakeVersion,
  versionAtLeast
} from "./launchArgs";

/** Logger plugins, which the live status depends on, arrived with 9.0. */
export const MIN_SNAKEMAKE_VERSION = "9.0.0";

export type RunEnvironment = {
  snakemake?: string;
  /** how `snakemake` was found, for the diagnostics */
  source?: string;
  version?: string;
  /** the environment runs are started with */
  env: NodeJS.ProcessEnv;
  /** the workbench logger plugin is installed: live job status */
  loggerPlugin: boolean;
  /** the workbench executor plugin is installed: jobs as Workbench jobs */
  executorPlugin: boolean;
  /** set inside a Posit Workbench session */
  inWorkbench: boolean;
  problems: string[];
};

const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");

let cached: Promise<RunEnvironment> | undefined;
let positronApi: PositronApi | undefined;

/** The Positron API, to find the Python interpreter the user selected. */
export function setPositronApi(api: PositronApi) {
  positronApi = api;
}

export function runSetting<T>(key: string, fallback: T): T {
  return (
    vscode.workspace.getConfiguration("snakemake.run").get<T>(key) ?? fallback
  );
}

/** Forget the resolved environment, e.g. after a setting changed. */
export function resetRunEnvironment() {
  cached = undefined;
}

export function runEnvironment(): Promise<RunEnvironment> {
  cached ??= resolve();
  return cached;
}

async function resolve(): Promise<RunEnvironment> {
  const problems: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };

  const found = await findSnakemake();
  // Snakemake runs jobs with the tools next to it (python, the launcher), and
  // tools installed with `--user` or uv live in ~/.local/bin, which the
  // extension host's PATH may lack.
  const paths = (env.PATH ?? "").split(path.delimiter);
  const extra = [found && path.dirname(found.path), LOCAL_BIN].filter(
    (p): p is string => !!p && !paths.includes(p)
  );
  env.PATH = [...extra, ...paths].filter(Boolean).join(path.delimiter);

  let version: string | undefined;
  let plugins = { logger: false, executor: false };
  if (found) {
    const output = await execFile(found.path, ["--version"], { env }).catch(
      (e) => `${e}`
    );
    version = parseSnakemakeVersion(output);
    if (!version) {
      problems.push(
        `Could not run \`${found.path} --version\`: ${output.trim()}`
      );
    } else if (!versionAtLeast(version, MIN_SNAKEMAKE_VERSION)) {
      problems.push(
        `Snakemake ${version} is too old; ${MIN_SNAKEMAKE_VERSION} or later is required.`
      );
    } else {
      const help = await execFile(found.path, ["--help"], { env }).catch(
        () => ""
      );
      plugins = detectPlugins(help);
    }
  } else {
    problems.push(
      "Snakemake was not found. Select a Python interpreter that has it installed, or set `snakemake.run.executable`."
    );
  }

  return {
    snakemake: found?.path,
    source: found?.source,
    version,
    env,
    loggerPlugin: plugins.logger,
    executorPlugin: plugins.executor,
    inWorkbench: !!(env.RS_SERVER_URL || env.POSIT_PRODUCT),
    problems
  };
}

const EXE = process.platform === "win32" ? "snakemake.exe" : "snakemake";

/**
 * In order: the setting, the environment of the Python interpreter selected
 * in Positron, a virtual environment in the workspace, the PATH, and
 * ~/.local/bin.
 */
async function findSnakemake(): Promise<
  { path: string; source: string } | undefined
> {
  const configured = runSetting("executable", "");
  if (configured) {
    return fs.existsSync(configured)
      ? { path: configured, source: "the snakemake.run.executable setting" }
      : undefined;
  }
  const python = await preferredPython();
  if (python) {
    const candidate = path.join(path.dirname(python), EXE);
    if (isExecutable(candidate))
      return { path: candidate, source: `the Python interpreter ${python}` };
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const venv of [".venv", "venv", ".pixi/envs/default"]) {
      const candidate = path.join(folder.uri.fsPath, venv, "bin", EXE);
      if (isExecutable(candidate))
        return { path: candidate, source: `the workspace's ${venv}` };
    }
  }
  const onPath = findOnPath(EXE, process.env.PATH);
  if (onPath) return { path: onPath, source: "the PATH" };
  const local = path.join(LOCAL_BIN, EXE);
  return isExecutable(local) ? { path: local, source: "~/.local/bin" } : undefined;
}

async function preferredPython(): Promise<string | undefined> {
  try {
    const runtime =
      (await positronApi?.runtime.getPreferredRuntime("python")) ?? undefined;
    return runtime?.runtimePath;
  } catch {
    return undefined;
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string, searchPath?: string): string | undefined {
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function execFile(
  file: string,
  args: string[],
  options: cp.ExecFileOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      file,
      args,
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${stderr || error.message}`.trim()));
        else resolve(`${stdout}`);
      }
    );
  });
}

/**
 * Run `snakemake` with `args` in `cwd` and return its stdout. Snakemake logs
 * to stderr, which becomes the error when it fails.
 */
export function snakemake(
  environment: RunEnvironment,
  cwd: string,
  args: string[],
  timeout = 300000
): Promise<string> {
  if (!environment.snakemake)
    return Promise.reject(new Error("Snakemake was not found."));
  return execFile(environment.snakemake, args, {
    cwd,
    env: environment.env,
    timeout
  });
}
