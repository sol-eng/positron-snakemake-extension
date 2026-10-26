// Parses the NDJSON events written by the workbench logger plugin
// (`--logger workbench --logger-workbench-events-file`) and folds them into a
// RunProgress. See snakemake_logger_plugin_workbench in posit-sdk-snakemake
// for the events and their fields; unknown events and fields are ignored.

import { updateJob, type JobStatus, type RunProgress } from "./model";

export type RunEvent = { v?: number; ts?: string; event: string } & Record<
  string,
  unknown
>;

/**
 * Split appended file content into complete events. A trailing partial line
 * is returned as `rest`, to be prepended to the next chunk.
 */
export function parseEventChunk(
  rest: string,
  chunk: string
): { events: RunEvent[]; rest: string } {
  const text = rest + chunk;
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const events: RunEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // a corrupt line is skipped rather than stalling the run's status
    }
  }
  return { events, rest: tail };
}

/** Workbench job statuses that mean the job is waiting to run. */
const WAITING = new Set(["Pending", "Suspended"]);

/** "Not cleaning up <path>", logged for each kept `script:` script. */
const KEPT_SCRIPT = /^Not cleaning up (.+)$/;

export function applyEvent(progress: RunProgress, event: RunEvent) {
  const ts = event.ts ? Date.parse(event.ts) : undefined;
  const jobid = numberOr(event.jobid);
  switch (event.event) {
    case "workflow_started":
      progress.workflow = {
        workflowId: stringOr(event.workflowId),
        runId: stringOr(event.runId),
        snakefile: stringOr(event.snakefile),
        cwd: stringOr(event.cwd),
        snakemakeVersion: stringOr(event.snakemakeVersion),
        host: stringOr(event.host),
        pid: numberOr(event.pid)
      };
      return;
    case "rulegraph":
      progress.rulegraph = {
        nodes: Array.isArray(event.nodes) ? event.nodes.map(String) : [],
        links: Array.isArray(event.links)
          ? event.links.map((l: any) => ({
              source: String(l?.source),
              target: String(l?.target)
            }))
          : []
      };
      return;
    case "run_info":
      if (event.stats && typeof event.stats === "object") {
        progress.stats = Object.fromEntries(
          Object.entries(event.stats as Record<string, unknown>).map(
            ([k, v]) => [k, Number(v) || 0]
          )
        );
      }
      return;
    case "jobs_started":
      for (const id of Array.isArray(event.jobids) ? event.jobids : []) {
        const n = numberOr(id);
        if (n !== undefined)
          updateJob(progress, { jobid: n, status: "SUBMITTED", submit: ts });
      }
      return;
    case "job_info": {
      if (jobid === undefined) return;
      const local = event.local === true;
      const retrying = progress.jobs[jobid]?.status === "FAILED";
      updateJob(
        progress,
        {
          jobid,
          rule: stringOr(event.rule),
          wildcards: stringRecord(event.wildcards),
          // a local job runs as soon as Snakemake reports it
          status: local ? "RUNNING" : "SUBMITTED",
          local,
          input: stringList(event.input),
          output: stringList(event.output),
          log: stringList(event.log),
          benchmark: stringOr(event.benchmark),
          threads: numberOr(event.threads),
          resources:
            event.resources && typeof event.resources === "object"
              ? (event.resources as Record<string, unknown>)
              : undefined,
          reason: stringOr(event.reason),
          shellcmd: stringOr(event.shellcmd),
          message: stringOr(event.ruleMsg),
          cwd: stringOr(event.cwd),
          submit: retrying ? ts : (progress.jobs[jobid]?.submit ?? ts),
          start: local ? ts : undefined
        },
        { retry: true }
      );
      return;
    }
    case "wb_submitted":
      if (jobid === undefined) return;
      updateJob(progress, {
        jobid,
        status: "QUEUED",
        externalJobId: stringOr(event.externalJobId)
      });
      return;
    case "wb_status": {
      if (jobid === undefined) return;
      const status = stringOr(event.status);
      let next: JobStatus | undefined;
      if (status === "Running") next = "RUNNING";
      else if (status && WAITING.has(status)) next = "QUEUED";
      updateJob(progress, {
        jobid,
        status: next,
        workbenchStatus: status,
        externalJobId: stringOr(event.externalJobId),
        start: next === "RUNNING" ? ts : undefined
      });
      return;
    }
    case "job_finished":
      if (jobid === undefined) return;
      updateJob(progress, { jobid, status: "COMPLETED", complete: ts });
      return;
    case "job_error":
      if (jobid === undefined) return;
      updateJob(progress, {
        jobid,
        rule: stringOr(event.rule),
        status: "FAILED",
        complete: ts,
        error: stringOr(event.msg),
        log: stringList(event.log),
        shellcmd: stringOr(event.shellcmd),
        externalJobId: stringOr(event.externalJobId)
      });
      return;
    case "progress":
      progress.done = numberOr(event.done);
      progress.total = numberOr(event.total);
      return;
    case "error":
      progress.errors.push({
        exception: stringOr(event.exception),
        message: stringOr(event.message) ?? "Snakemake reported an error."
      });
      return;
    case "log": {
      if (event.nothingToDo) progress.nothingToDo = true;
      if (typeof event.logfile === "string") progress.logfile = event.logfile;
      const kept = stringOr(event.msg)?.match(KEPT_SCRIPT);
      if (kept && !progress.scripts.includes(kept[1]))
        progress.scripts.push(kept[1]);
      return;
    }
    case "closed":
      progress.finished = true;
      return;
  }
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? undefined : n;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v)
    ])
  );
}
