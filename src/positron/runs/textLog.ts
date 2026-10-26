// The fallback for runs without the workbench logger plugin: Snakemake's
// console output, which has a block per job and a line for each finished or
// failed one. Kept free of `vscode` so it can be unit tested.

import { emptyProgress, updateJob, type RunProgress } from "./model";

// `rule square:`, `localrule all:` or `checkpoint split:` opens a job block
const JOB_START = /^(?:local)?(?:rule|checkpoint) ([A-Za-z_][\w]*):\s*$/;
const FIELD = /^\s{4}(\w+): (.*)$/;
const FINISHED = /^Finished jobid: (\d+)/;
const ERROR_IN = /^Error in rule ([A-Za-z_][\w]*):/;
const PROGRESS = /^(\d+) of (\d+) steps \(.*\) done/;
const STATS_ROW = /^(\S+)\s+(\d+)$/;

/** Parse the whole output of a run into a fresh RunProgress. */
export function parseTextLog(text: string): RunProgress {
  const progress = emptyProgress();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("Job stats:")) {
      // `job count` header, a dashed rule, then `<rule> <count>` rows
      const stats: Record<string, number> = {};
      for (i += 3; i < lines.length; i++) {
        const row = lines[i].match(STATS_ROW);
        if (!row) break;
        stats[row[1]] = Number(row[2]);
      }
      progress.stats ??= stats;
      continue;
    }
    const start = line.match(JOB_START);
    if (start) {
      const fields = readFields(lines, i + 1);
      const jobid = Number(fields.jobid);
      if (Number.isFinite(jobid)) {
        updateJob(
          progress,
          {
            jobid,
            rule: start[1],
            status: line.startsWith("local") ? "RUNNING" : "SUBMITTED",
            local: line.startsWith("local"),
            wildcards: parseWildcards(fields.wildcards),
            output: splitFiles(fields.output),
            input: splitFiles(fields.input),
            log: splitFiles(fields.log),
            benchmark: fields.benchmark,
            reason: fields.reason
          },
          { retry: true }
        );
      }
      continue;
    }
    const finished = line.match(FINISHED);
    if (finished) {
      updateJob(progress, { jobid: Number(finished[1]), status: "COMPLETED" });
      continue;
    }
    const error = line.match(ERROR_IN);
    if (error) {
      const jobid = Number(readFields(lines, i + 1).jobid);
      if (Number.isFinite(jobid))
        updateJob(progress, { jobid, rule: error[1], status: "FAILED" });
      continue;
    }
    const steps = line.match(PROGRESS);
    if (steps) {
      progress.done = Number(steps[1]);
      progress.total = Number(steps[2]);
      continue;
    }
    if (line.startsWith("Nothing to be done")) progress.nothingToDo = true;
    if (line.startsWith("Complete log(s): "))
      progress.logfile = line.slice("Complete log(s): ".length).trim();
    if (/^(\w+(Exception|Error)):$/.test(line)) {
      progress.errors.push({
        exception: line.slice(0, -1),
        message: lines.slice(i, i + 4).join("\n")
      });
    }
  }
  return progress;
}

/** The indented `key: value` lines that follow a job's first line. */
function readFields(lines: string[], from: number): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = from; i < lines.length; i++) {
    const field = lines[i].match(FIELD);
    if (!field) {
      if (/^\s{5,}/.test(lines[i])) continue; // a continuation, e.g. shell:
      break;
    }
    fields[field[1]] = field[2];
  }
  return fields;
}

function splitFiles(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .replace(/ \(check log file\(s\) for error details\)$/, "")
    .split(", ")
    .filter(Boolean);
}

function parseWildcards(value: string | undefined): Record<string, string> {
  const wildcards: Record<string, string> = {};
  for (const part of (value ?? "").split(", ")) {
    const index = part.indexOf("=");
    if (index > 0) wildcards[part.slice(0, index)] = part.slice(index + 1);
  }
  return wildcards;
}
