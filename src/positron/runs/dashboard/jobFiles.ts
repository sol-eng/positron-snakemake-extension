// Reads what the job dashboard shows about a job: its log files, its
// benchmark, and its inputs and outputs. Kept free of `vscode` so it can be
// unit tested.

import * as fs from "fs";
import * as path from "path";

import type { JobState } from "../model";

export type LogFile = {
  name: string;
  path: string;
  size: number;
  /** the end of the file, at most `TAIL_BYTES` */
  text: string;
  truncated: boolean;
};

export type FileEntry = {
  /** as the Snakefile names it */
  name: string;
  path: string;
  exists: boolean;
  size?: number;
  isDirectory?: boolean;
};

/** One row of a Snakemake benchmark file. */
export type Benchmark = {
  seconds?: number;
  maxRssMb?: number;
  maxVmsMb?: number;
  ioInMb?: number;
  ioOutMb?: number;
  meanLoad?: number;
  cpuTimeSeconds?: number;
};

export type JobFiles = {
  logs: LogFile[];
  inputs: FileEntry[];
  outputs: FileEntry[];
  benchmark?: Benchmark & { path: string; runs: number };
};

export const TAIL_BYTES = 256 * 1024;

/** The last `limit` bytes of a file, decoded as text. */
export function readTail(
  file: string,
  limit = TAIL_BYTES
): { text: string; size: number; truncated: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // drop a partial first line when the file was cut
    if (size > limit) text = text.slice(text.indexOf("\n") + 1);
    return { text, size, truncated: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Snakemake marks files in job info, e.g. `out.txt (temp)` or
 * `logs/x.log (check log file(s) for error details)`; the path is the rest.
 */
export function stripAnnotation(file: string): string {
  return file
    .replace(/ \(check log file\(s\) for error details\)$/, "")
    .replace(/ \([a-z][a-z ,_]*\)$/, "");
}

export function readJobFiles(job: JobState, cwd: string): JobFiles {
  const resolve = (file: string) => path.resolve(cwd, stripAnnotation(file));
  const logs: LogFile[] = [];
  for (const name of job.log ?? []) {
    const file = resolve(name);
    try {
      logs.push({ name: stripAnnotation(name), path: file, ...readTail(file) });
    } catch {
      // not written (yet)
    }
  }
  const entry = (name: string): FileEntry => {
    const file = resolve(name);
    try {
      const stat = fs.statSync(file);
      return {
        name: stripAnnotation(name),
        path: file,
        exists: true,
        size: stat.isDirectory() ? undefined : stat.size,
        isDirectory: stat.isDirectory()
      };
    } catch {
      return { name: stripAnnotation(name), path: file, exists: false };
    }
  };
  const result: JobFiles = {
    logs,
    inputs: (job.input ?? []).map(entry),
    outputs: (job.output ?? []).map(entry)
  };
  if (job.benchmark) {
    const file = resolve(job.benchmark);
    try {
      const rows = parseBenchmark(fs.readFileSync(file, "utf8"));
      if (rows.length)
        result.benchmark = { ...rows[rows.length - 1], path: file, runs: rows.length };
    } catch {
      // written when the job ends
    }
  }
  return result;
}

/**
 * Parse a Snakemake benchmark TSV (`s h:m:s max_rss max_vms max_uss max_pss
 * io_in io_out mean_load cpu_time`, sizes in MB). `NA` marks a value that
 * could not be measured. A row per repeat of the job.
 */
export function parseBenchmark(text: string): Benchmark[] {
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim());
  if (!header) return [];
  const columns = header.split("\t");
  return rows.map((row) => {
    const cells = row.split("\t");
    const number = (name: string) => {
      const value = cells[columns.indexOf(name)];
      const n = Number(value);
      return value === undefined || value === "NA" || value === "" || !Number.isFinite(n)
        ? undefined
        : n;
    };
    return {
      seconds: number("s"),
      maxRssMb: number("max_rss"),
      maxVmsMb: number("max_vms"),
      ioInMb: number("io_in"),
      ioOutMb: number("io_out"),
      meanLoad: number("mean_load"),
      cpuTimeSeconds: number("cpu_time")
    };
  });
}

/**
 * The script Snakemake kept for a `script:` job (--skip-script-cleanup): the
 * one that names the job's first output, which the pickled `snakemake`
 * object in its preamble holds as plain text.
 */
export function findJobScript(
  job: JobState,
  scripts: string[]
): string | undefined {
  const marker = [...(job.output ?? []), ...(job.log ?? [])]
    .map(stripAnnotation)
    .find(Boolean);
  if (!marker) return undefined;
  return scripts.find((file) => {
    try {
      return fs.readFileSync(file, "latin1").includes(marker);
    } catch {
      return false;
    }
  });
}

/** Split a kept script into its preamble and the user's script. */
export function splitPreamble(text: string): {
  preamble: string;
  body: string;
} {
  const end = /^#+ snakemake preamble end.*$/m.exec(text);
  if (!end) return { preamble: "", body: text };
  const cut = end.index + end[0].length;
  return { preamble: text.slice(0, cut), body: text.slice(cut).replace(/^\n/, "") };
}

/** Is `file` inside `dir`? Guards paths the dashboard asks to open. */
export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
