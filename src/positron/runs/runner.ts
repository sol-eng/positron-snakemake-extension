// Starts Snakemake as a detached process and persists what is needed to
// follow and control it after a window reload.

import * as cp from "child_process";
import * as fs from "fs";

import { execFile, runSetting } from "./env";
import {
  buildRunArgs,
  buildRunScript,
  isRunProcess,
  type LaunchConfig,
  type RunFiles,
  type RunScript
} from "./launchArgs";

export type RunRecord = {
  runName: string;
  config: LaunchConfig;
  /** followed through the workbench logger plugin's events */
  withLogger: boolean;
  /** where Snakemake runs */
  mode: "local" | "job";
  /** Snakemake's own Workbench job, for `mode: "job"` */
  jobId?: string;
  driver?: {
    cluster: string;
    image?: string;
    cpus: number;
    memoryMb: number;
  };
  /** the wrapper script's process, for local runs */
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  /** Snakemake's exit code, if the wrapper saw it end */
  exitCode?: number;
  /** why Snakemake's job ended before Snakemake started */
  driverError?: string;
  stopRequested?: "stop" | "finish" | "kill";
};

export function readRecord(files: RunFiles): RunRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(files.record, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeRecord(files: RunFiles, record: RunRecord) {
  fs.writeFileSync(files.record, JSON.stringify(record, null, 2));
}

/** Write the wrapper script that runs Snakemake for the run. */
export function writeRunScript(
  snakemake: string,
  files: RunFiles,
  record: RunRecord,
  withLogger: boolean,
  identity?: RunScript["identity"]
) {
  fs.mkdirSync(files.dir, { recursive: true });
  const args = buildRunArgs(record.config, files, {
    withLogger,
    printShellCommands: runSetting("printShellCommands", true),
    keepScripts: runSetting("keepScripts", true)
  });
  fs.writeFileSync(
    files.script,
    buildRunScript({
      snakemake,
      args,
      cwd: record.config.cwd,
      files,
      runId: record.runName,
      identity
    }),
    { mode: 0o755 }
  );
}

// Starts "$@" in the background and prints its pid. The shell exits right
// away, so the run is adopted by init. Job control (`set -m`) keeps SIGINT
// from being ignored in the background process, so the run can be stopped.
const LAUNCH_SCRIPT =
  'set -m; "$@" </dev/null >/dev/null 2>&1 & echo $!';

/**
 * Start the run so that it is not a descendant of the extension host, which
 * Positron kills on window close or reload. It also runs in its own session,
 * so it is not sent the SIGHUP that would abort it.
 */
export async function startRun(
  snakemake: string,
  env: NodeJS.ProcessEnv,
  files: RunFiles,
  record: RunRecord
): Promise<void> {
  writeRunScript(snakemake, files, record, record.withLogger);
  const output = await new Promise<string>((resolve, reject) => {
    const shell = cp.spawn(
      "/bin/bash",
      ["-c", LAUNCH_SCRIPT, "sh", "/bin/bash", files.script],
      {
        cwd: record.config.cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    shell.stdout!.on("data", (d) => (stdout += d));
    shell.stderr!.on("data", (d) => (stderr += d));
    shell.on("error", reject);
    shell.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))
    );
  });
  const pid = Number(output.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`could not start ${snakemake}: ${output}`);
  }
  record.pid = pid;
  writeRecord(files, record);
}

/** Is the run's wrapper still alive, and not a reused pid? */
export async function isRunAlive(
  files: RunFiles,
  record: RunRecord
): Promise<boolean> {
  if (!record.pid || record.finishedAt) return false;
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  const command = await processCommand(record.pid);
  return command === undefined || isRunProcess(command, files.script);
}

export async function processCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  return execFile("ps", ["-o", "command=", "-p", String(pid)]).then(
    (out) => out.trim(),
    () => ""
  );
}

/** The exit code the wrapper wrote when Snakemake ended. */
export function readExitCode(files: RunFiles): number | undefined {
  try {
    const code = Number(fs.readFileSync(files.exitcode, "utf8").trim());
    return Number.isInteger(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function snakemakePid(files: RunFiles): number | undefined {
  try {
    const pid = Number(fs.readFileSync(files.pid, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `stop` cancels the running jobs and ends Snakemake, `finish` lets the
 * running jobs finish first (both through the wrapper, see buildRunScript),
 * and `kill` ends Snakemake and its local jobs at once, leaving Workbench
 * jobs behind.
 */
export function signalRun(
  files: RunFiles,
  record: RunRecord,
  how: "stop" | "finish" | "kill"
) {
  if (!record.pid) return;
  const send = (pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  };
  if (how === "stop") send(record.pid, "SIGTERM");
  else if (how === "finish") send(record.pid, "SIGUSR1");
  else {
    // the wrapper and Snakemake each lead a process group (`set -m`)
    const pid = snakemakePid(files);
    if (pid) send(-pid, "SIGKILL");
    send(-record.pid, "SIGKILL");
  }
}
