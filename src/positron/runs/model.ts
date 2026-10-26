// The state of a pipeline run, built from the events that the workbench
// logger plugin writes (see events.ts) or, without the plugin, from
// Snakemake's console output (see textLog.ts). Kept free of `vscode` so it
// can be unit tested.

export type JobStatus =
  | "NEW"
  | "SUBMITTED"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "ABORTED";

export type JobState = {
  jobid: number;
  rule: string;
  wildcards: Record<string, string>;
  status: JobStatus;
  /** starts at 1, and goes up when Snakemake retries a failed job */
  attempt: number;
  /** the job's Workbench job, when it runs as one */
  externalJobId?: string;
  /** the Workbench job's own status, e.g. `Pending` */
  workbenchStatus?: string;
  /** ran inside the Snakemake process, e.g. a localrule */
  local?: boolean;
  input?: string[];
  output?: string[];
  log?: string[];
  benchmark?: string;
  threads?: number;
  resources?: Record<string, unknown>;
  reason?: string;
  shellcmd?: string;
  message?: string;
  /** the directory the job's relative paths are relative to */
  cwd?: string;
  error?: string;
  /** epoch ms */
  submit?: number;
  start?: number;
  complete?: number;
};

export type WorkflowInfo = {
  workflowId?: string;
  runId?: string;
  snakefile?: string;
  cwd?: string;
  snakemakeVersion?: string;
  host?: string;
  pid?: number;
};

export type RunError = { exception?: string; message: string };

export type RunProgress = {
  jobs: Record<number, JobState>;
  workflow?: WorkflowInfo;
  /** jobs to run per rule, from Snakemake's job stats, with `total` */
  stats?: Record<string, number>;
  rulegraph?: { nodes: string[]; links: { source: string; target: string }[] };
  done?: number;
  total?: number;
  errors: RunError[];
  /** Snakemake found every requested output up to date */
  nothingToDo?: boolean;
  /** Snakemake's own log file for the run */
  logfile?: string;
  /** scripts kept for `script:` jobs (--skip-script-cleanup) */
  scripts: string[];
  /** the logger closed: Snakemake has ended */
  finished: boolean;
};

export type RuleSummary = {
  name: string;
  total: number;
  pending: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  /** stopped, e.g. after the run was cancelled */
  aborted: number;
  /** failed attempts that were retried */
  retried: number;
};

const RANK: Record<JobStatus, number> = {
  NEW: 0,
  SUBMITTED: 1,
  QUEUED: 2,
  RUNNING: 3,
  COMPLETED: 4,
  FAILED: 4,
  ABORTED: 4
};

export function emptyProgress(): RunProgress {
  return { jobs: {}, errors: [], scripts: [], finished: false };
}

export function isTerminal(status: JobStatus): boolean {
  return RANK[status] === 4;
}

/**
 * Merge a job update into the progress. Status only moves forward, so e.g. a
 * late Workbench `Running` cannot undo `job_finished`. A job that failed and
 * is reported again is being retried: that starts its next attempt.
 */
export function updateJob(
  progress: RunProgress,
  update: Partial<JobState> & { jobid: number },
  { retry = false } = {}
) {
  const current = progress.jobs[update.jobid];
  const defaults: Omit<JobState, "jobid"> = {
    rule: "",
    wildcards: {},
    status: "NEW",
    attempt: 1
  };
  const next = {
    ...defaults,
    ...current,
    ...stripUndefined(update)
  } as JobState;
  if (retry && current?.status === "FAILED") {
    next.attempt = current.attempt + 1;
    next.error = undefined;
    next.complete = undefined;
    next.externalJobId = update.externalJobId;
    next.workbenchStatus = undefined;
  } else if (
    current &&
    RANK[update.status ?? current.status] < RANK[current.status]
  ) {
    next.status = current.status;
  }
  progress.jobs[update.jobid] = next;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** `{ sample: "a", lane: "1" }` → `sample=a, lane=1` */
export function formatWildcards(wildcards: Record<string, string>): string {
  return Object.entries(wildcards)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** A job's label within its rule: its wildcards, or its job id. */
export function jobLabel(job: JobState): string {
  return formatWildcards(job.wildcards) || `job ${job.jobid}`;
}

/**
 * Per-rule counts, in the order of Snakemake's job stats, then of the jobs
 * seen. Jobs Snakemake planned but has not reported yet count as pending.
 */
export function summarize(progress: RunProgress): RuleSummary[] {
  const byRule = new Map<string, JobState[]>();
  for (const rule of Object.keys(progress.stats ?? {})) {
    if (rule !== "total") byRule.set(rule, []);
  }
  const jobs = Object.values(progress.jobs).sort((a, b) => a.jobid - b.jobid);
  for (const job of jobs) {
    const list = byRule.get(job.rule) ?? [];
    list.push(job);
    byRule.set(job.rule, list);
  }
  return [...byRule].map(([name, list]) => {
    const summary: RuleSummary = {
      name,
      total: Math.max(progress.stats?.[name] ?? 0, list.length),
      pending: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
      retried: 0
    };
    for (const job of list) {
      summary.retried += job.attempt - 1;
      if (job.status === "COMPLETED") summary.succeeded++;
      else if (job.status === "FAILED") summary.failed++;
      else if (job.status === "ABORTED") summary.aborted++;
      else if (job.status === "RUNNING") summary.running++;
      else if (job.status === "QUEUED") summary.queued++;
    }
    summary.pending =
      summary.total -
      summary.succeeded -
      summary.failed -
      summary.aborted -
      summary.running -
      summary.queued;
    return summary;
  });
}

export function totals(progress: RunProgress) {
  const all = summarize(progress);
  const sum = (key: keyof Omit<RuleSummary, "name">) =>
    all.reduce((n, p) => n + p[key], 0);
  return {
    total: progress.stats?.total ?? sum("total"),
    done: sum("succeeded"),
    failed: sum("failed"),
    running: sum("running")
  };
}

/**
 * Once a run has ended, jobs it never reported as finished (e.g. after the
 * run was killed) did not complete either. A dry run's jobs were only
 * planned, so they go back to NEW.
 */
export function settleUnfinished(progress: RunProgress, dryRun = false) {
  for (const job of Object.values(progress.jobs)) {
    if (dryRun) job.status = "NEW";
    else if (!isTerminal(job.status)) job.status = "ABORTED";
  }
}

/**
 * The error that explains a failed run best: Snakemake ends every failed run
 * with a generic "At least one job did not complete successfully", so an
 * earlier, specific one is preferred.
 */
export function mainError(progress: RunProgress): RunError | undefined {
  const generic = /did not complete successfully|Exiting because a job/;
  return (
    progress.errors.find((e) => !generic.test(e.message)) ?? progress.errors[0]
  );
}

/** Snakemake exceptions that an action in the UI can resolve. */
export function errorKinds(progress: RunProgress): {
  locked: boolean;
  incomplete: boolean;
} {
  const has = (re: RegExp) =>
    progress.errors.some((e) => re.test(e.exception ?? "") || re.test(e.message));
  return {
    locked: has(/LockException|Directory cannot be locked/),
    incomplete: has(/IncompleteFilesException|incomplete files/i)
  };
}

/** Workbench job ids of jobs that never finished, to cancel them. */
export function unfinishedJobIds(jobs: JobState[]): string[] {
  return jobs
    .filter((j) => j.externalJobId && !isTerminal(j.status))
    .map((j) => j.externalJobId!);
}
