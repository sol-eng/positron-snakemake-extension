---
name: snakemake-runs
description: Inspect, explain, start, dry-run and stop the Snakemake pipeline runs shown in Positron's Pipeline Runs view (Positron Snakemake extension), including runs whose jobs run as Posit Workbench jobs. Use for questions such as "why did my Snakemake run fail?", "which jobs are still running?", "what's the status of my pipeline?", "run / dry-run this workflow", or "stop the run".
license: MIT
---

# Snakemake pipeline runs in Positron

The Positron Snakemake extension starts and follows Snakemake runs, and keeps each run's state: per-rule and per-job status, Snakemake's errors, and where each job's logs are. Ask the extension through the commands below instead of exploring files or processes in a shell. It already knows which run is which and where everything is.

Run each command with the `positronCommand` tool. Every command returns JSON.

| Command id | Arguments | Does |
|---|---|---|
| `snakemake.positron.assistant.listRuns` | none | The runs started from Positron in this workspace, most recent first: `runName`, `status`, `snakefile`, `targets`, `dryRun`, times, and job `totals`. Read-only. |
| `snakemake.positron.assistant.runStatus` | `[runName]` (optional; defaults to the most recent run) | One run in detail; see below. Read-only. |
| `snakemake.positron.assistant.launchPipeline` | `[{ "snakefile": "...", "targets": [...], "profile": "...", "config": { "key": "value" }, "dryRun": true, "rerunIncomplete": true }]`, where only `snakefile` is required | Starts a run, which then appears in Pipeline Runs. Returns its `runName`. |
| `snakemake.positron.assistant.jobOutput` | `[workbenchJobId, stderr]` (`stderr` optional, `true` for stderr) | The end of a Workbench job's own stdout or stderr, e.g. why its container failed to start. Read-only. |
| `snakemake.positron.assistant.stopRun` | `[runName]` (optional; defaults to the most recent run) | Stops a running run: Snakemake cancels its jobs, including Workbench jobs. |

Starting and stopping runs changes the user's work, so the user is asked to approve them. Only start or stop a run when the user asked for it. A dry run (`"dryRun": true`) is harmless; offer it when the user wants to know what would run.

To start a run, use `launchPipeline`, never `snakemake` in a shell. A run started in a shell does not show in Pipeline Runs, and its status cannot be followed. `snakefile` may be relative to the workspace folder. Without a `profile`, the jobs run in the Positron session; a profile may send them to Posit Workbench.

## Explaining a failed run

1. Call `runStatus`, with the `runName` the user means if they named one, from `listRuns`.
2. Read the result:
   - `status`: `queued`, `starting`, `running`, `succeeded`, `failed`, `stopped`, or `lost` (ended without a known outcome, e.g. killed).
   - `errorMessage` and `errors`: Snakemake's own errors. A `LockException` means the working directory is locked by a run that did not end cleanly. An `IncompleteFilesException` means outputs of an earlier run are incomplete. For both, the Pipeline Runs view offers a fix (Unlock, or Run Again, Rerunning Incomplete Jobs); tell the user about it.
   - `failedJobs`: for each job, its `rule` and `wildcards`, the `shellcmd` it ran, and `logs`, the end (`tail`) of each of its log files. The cause of a failure is usually in those tails. `workbenchJobId` is set when the job ran as a Posit Workbench job.
   - `failedJobsNotShown` / `runningJobsNotShown`: how many more jobs there are than were listed.
   - `output`: the last lines of Snakemake's console output for the run.
   - `rules`: per-rule counts (`total`, `succeeded`, `running`, `queued`, `failed`, `retried`); `totals` for the whole run.
3. Explain the cause in terms of the rule and its inputs. Quote the relevant log lines, and suggest a fix in the Snakefile, the config, or the environment.

If a log tail is not enough, read the whole file at the path in `logs[].file`. For a job that ran as a Workbench job, its own stdout and stderr (e.g. a container that failed to start) come from `jobOutput` with the job's `workbenchJobId`. Each run's files are in `.snakemake/positron/<runName>/` under the workflow's working directory: `output.log` (Snakemake's output), `events.ndjson` (the events the status comes from), and `run.json`.

## Status questions

For "is it done?" or "what's running?", call `runStatus` and report `status`, `totals`, and `runningJobs`. Runs keep going while the user works. Call `runStatus` again rather than relying on an earlier answer.
