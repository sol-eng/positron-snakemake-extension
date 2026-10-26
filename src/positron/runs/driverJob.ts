// Runs Snakemake itself as a Posit Workbench Job through the launcher CLI,
// so a run outlives the session that started it. The job gets credentials of
// its own from Workbench, which Snakemake uses for every job it submits, so
// none are passed to it.

import * as os from "os";

import { execFile, type RunEnvironment } from "./env";
import { parseJobStatus, runTag, type JobState, type RunFiles } from "./launchArgs";
import { writeRecord, writeRunScript, type RunRecord } from "./runner";

export type DriverJobOptions = NonNullable<RunRecord["driver"]>;

export async function submitDriverJob(
  environment: RunEnvironment,
  files: RunFiles,
  record: RunRecord,
  options: DriverJobOptions
): Promise<void> {
  writeRunScript(environment.snakemake!, files, record, record.withLogger, {
    home: os.homedir(),
    user: os.userInfo().username,
    path: environment.env.PATH ?? ""
  });
  const args = [
    "submit",
    "--cluster",
    options.cluster,
    "--name",
    `smk-driver-${record.runName}`,
    "--cpus",
    String(options.cpus),
    "--mem-mb",
    String(options.memoryMb),
    "--tag",
    "snakemake-driver",
    "--tag",
    runTag(record.runName)
  ];
  if (options.image) args.push("--container", options.image);
  args.push(files.script);
  const output = await execFile(environment.launcherCli, args, {
    cwd: files.dir,
    env: environment.env,
    timeout: 60000
  });
  const jobId = output.trim();
  if (!jobId) throw new Error("the launcher did not return a job id");
  record.jobId = jobId;
  record.mode = "job";
  record.driver = options;
  writeRecord(files, record);
}

export async function driverJobState(
  environment: RunEnvironment,
  jobId: string
): Promise<JobState | undefined> {
  try {
    const output = await execFile(
      environment.launcherCli,
      ["status", jobId],
      { env: environment.env, timeout: 60000 }
    );
    return parseJobStatus(output, jobId);
  } catch {
    // the launcher is unreachable: keep the last known state
    return undefined;
  }
}

/**
 * Stop Snakemake's job. A graceful stop sends SIGTERM, which the run's
 * wrapper turns into SIGINT, so Snakemake cancels its jobs before it exits.
 */
export async function stopDriverJob(
  environment: RunEnvironment,
  jobId: string,
  graceful: boolean
): Promise<void> {
  await execFile(
    environment.launcherCli,
    ["kill", ...(graceful ? ["--graceful"] : []), jobId],
    { env: environment.env, timeout: 60000 }
  );
}

/** Stop the unfinished Workbench jobs of a run, by its tag. */
export async function cancelRunJobs(
  environment: RunEnvironment,
  runName: string
): Promise<string[]> {
  const output = await execFile(
    environment.launcherCli,
    ["kill", "--tag", runTag(runName)],
    { env: environment.env, timeout: 60000 }
  );
  return output.split("\n").filter((l) => l.trim());
}

export async function cancelJobs(environment: RunEnvironment, ids: string[]) {
  if (!ids.length) return;
  await execFile(environment.launcherCli, ["kill", ...ids], {
    env: environment.env,
    timeout: 60000
  });
}

/** A Workbench job's stdout or stderr, through the launcher. */
export function jobOutput(
  environment: RunEnvironment,
  jobId: string,
  stderr: boolean
): Promise<string> {
  return execFile(
    environment.launcherCli,
    ["output", jobId, ...(stderr ? ["--stderr"] : [])],
    { env: environment.env, timeout: 60000 }
  );
}

