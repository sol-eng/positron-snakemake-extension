// Runs Snakemake itself as a Posit Workbench Job through the Workbench API,
// so a run outlives the session that started it. The job gets credentials of
// its own from Workbench, which Snakemake uses for every job it submits, so
// none are passed to it.

import * as os from "os";

import type { RunEnvironment } from "./env";
import { runTag, type JobState, type RunFiles } from "./launchArgs";
import { writeRecord, writeRunScript, type RunRecord } from "./runner";
import { isUnfinished, WorkbenchApi } from "./workbenchApi";

export type DriverJobOptions = NonNullable<RunRecord["driver"]>;

/** The Workbench API with the credentials runs are started with. */
export function workbenchApi(environment: RunEnvironment): WorkbenchApi {
  return new WorkbenchApi(environment.env);
}

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
  const jobId = await workbenchApi(environment).launchJob({
    cluster: options.cluster,
    name: `smk-driver-${record.runName}`,
    exe: "/bin/bash",
    args: [files.script],
    workingDirectory: files.dir,
    tags: ["snakemake-driver", runTag(record.runName)],
    container: options.image ? { image: options.image } : undefined,
    resourceLimits: [
      { type: "cpuCount", value: String(options.cpus) },
      { type: "memory", value: String(options.memoryMb) }
    ]
  });
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
    return await workbenchApi(environment).jobState(jobId);
  } catch {
    // Workbench is unreachable: keep the last known state
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
  await workbenchApi(environment).stopJob(jobId, graceful);
}

/** Stop the unfinished Workbench jobs of a run, by its tag. Returns their ids. */
export async function cancelRunJobs(
  environment: RunEnvironment,
  runName: string
): Promise<string[]> {
  const api = workbenchApi(environment);
  const tag = runTag(runName);
  const ids = [...(await api.statusMap()).values()]
    .filter((job) => (job.tags ?? []).includes(tag) && isUnfinished(job))
    .map((job) => job.id);
  return api.stopJobs(ids);
}

export async function cancelJobs(environment: RunEnvironment, ids: string[]) {
  if (!ids.length) return;
  await workbenchApi(environment).stopJobs(ids);
}

/** A Workbench job's stdout or stderr. */
export function jobOutput(
  environment: RunEnvironment,
  jobId: string,
  stderr: boolean
): Promise<string> {
  return workbenchApi(environment).jobOutput(jobId, stderr);
}
