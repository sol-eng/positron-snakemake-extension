// A minimal client for the Posit Workbench Launcher API, for what the
// extension does on Workbench: list clusters, check credentials, and submit,
// follow, stop and read the output of jobs. Kept free of `vscode` so it can be
// unit tested.
//
// The API is JSON-RPC over HTTP: `POST <server>/api/<method>` with
// `{ method, kwparams }`, answered with `{ result }` or `{ error: { code,
// message } }`. Credentials, in order:
// - Inside a Workbench session (`POSIT_PRODUCT=WORKBENCH` or
//   `RS_SERVER_ADDRESS` set): the session's RPC cookie, from
//   `$PWB_SESSION_RUNTIME_DIR/rpc_cookie` or else `RS_SESSION_RPC_COOKIE`,
//   sent as `X-RS-Session-Server-RPC-Cookie`, against `RS_SERVER_ADDRESS`.
// - Anywhere else: `Authorization: Bearer $WORKBENCH_API_KEY` against
//   `$WORKBENCH_SERVER`.
// The cookie file is read again for every call: the session renews it. A
// private CA comes from `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` or
// `NODE_EXTRA_CA_CERTS`.
//
// Node's http/https modules rather than fetch: they take a CA directly, and
// send header names as given. The same contract as the Python client in
// posit-sdk-snakemake and the nf-workbench plugin's WorkbenchApiClient.

import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

export const COOKIE_HEADER = "X-RS-Session-Server-RPC-Cookie";
const TIMEOUT_MS = 30000;

export class WorkbenchApiError extends Error {
  /** the HTTP status, or 0 for an error the API itself reported */
  constructor(
    message: string,
    readonly statusCode = 0
  ) {
    super(message);
  }
}

export type WorkbenchJob = {
  id: string;
  name?: string;
  status?: string;
  statusMessage?: string;
  exitCode?: number | null;
  tags?: string[];
  [key: string]: unknown;
};

export type Cluster = {
  name: string;
  supportsContainers?: boolean;
  resourceProfiles: string[];
};

/** Where a job is, in the terms the extension follows runs in. */
export type JobState = "queued" | "running" | "ended" | "missing";

type Env = Record<string, string | undefined>;

function sessionCookie(env: Env): string | undefined {
  const dir = env.PWB_SESSION_RUNTIME_DIR;
  if (dir) {
    try {
      const cookie = fs.readFileSync(path.join(dir, "rpc_cookie"), "utf8").trim();
      if (cookie) return cookie;
    } catch {
      // no cookie file: e.g. inside a job, which has it in its environment
    }
  }
  return env.RS_SESSION_RPC_COOKIE || undefined;
}

export class WorkbenchApi {
  /** `session` or `api-key` */
  readonly auth: "session" | "api-key";
  readonly server: string;

  constructor(private readonly env: Env = process.env) {
    const inSession = env.POSIT_PRODUCT === "WORKBENCH" || !!env.RS_SERVER_ADDRESS;
    if (inSession && env.RS_SERVER_ADDRESS && sessionCookie(env)) {
      this.auth = "session";
      this.server = env.RS_SERVER_ADDRESS.replace(/\/+$/, "");
    } else if (env.WORKBENCH_SERVER && env.WORKBENCH_API_KEY) {
      this.auth = "api-key";
      this.server = env.WORKBENCH_SERVER.replace(/\/+$/, "");
    } else {
      throw new WorkbenchApiError(
        "No Workbench credentials: run inside a Workbench session, or set WORKBENCH_SERVER and WORKBENCH_API_KEY."
      );
    }
    if (!/^https?:\/\//.test(this.server))
      throw new WorkbenchApiError(`Not a URL: ${this.server}`);
  }

  /** Workbench can be reached from this environment, as far as its variables say. */
  static available(env: Env = process.env): boolean {
    try {
      new WorkbenchApi(env);
      return true;
    } catch {
      return false;
    }
  }

  private headers(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body))
    };
    if (this.auth === "session") {
      const cookie = sessionCookie(this.env);
      if (!cookie)
        throw new WorkbenchApiError("The session's RPC cookie is no longer available.");
      headers[COOKIE_HEADER] = cookie;
    } else {
      headers.Authorization = `Bearer ${this.env.WORKBENCH_API_KEY}`;
    }
    return headers;
  }

  private ca(): string | undefined {
    const file =
      this.env.REQUESTS_CA_BUNDLE || this.env.SSL_CERT_FILE || this.env.NODE_EXTRA_CA_CERTS;
    if (!file) return undefined;
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }

  /** POST a call and return the response body. */
  private post(method: string, kwparams: Record<string, unknown>): Promise<string> {
    const params = Object.fromEntries(
      Object.entries(kwparams).filter(([, v]) => v !== undefined && v !== null)
    );
    const body = JSON.stringify({ method, kwparams: params });
    const url = new URL(`${this.server}/api/${method}`);
    const secure = url.protocol === "https:";
    const options: https.RequestOptions = {
      method: "POST",
      headers: this.headers(body),
      timeout: TIMEOUT_MS
    };
    if (secure) {
      const ca = this.ca();
      if (ca) options.ca = ca;
    }
    return new Promise((resolve, reject) => {
      const request = (secure ? https : http).request(url, options, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(
              new WorkbenchApiError(
                `Workbench API \`${method}\` failed: HTTP ${status}: ${text.slice(0, 500)}`,
                status
              )
            );
          } else {
            resolve(text);
          }
        });
        response.on("error", reject);
      });
      request.on("timeout", () =>
        request.destroy(new WorkbenchApiError(`Workbench API \`${method}\` timed out.`))
      );
      request.on("error", (e) =>
        reject(
          e instanceof WorkbenchApiError
            ? e
            : new WorkbenchApiError(`Cannot reach ${this.server}: ${e.message}`)
        )
      );
      request.end(body);
    });
  }

  /** Call a Launcher API method and return its `result`. */
  async call(method: string, kwparams: Record<string, unknown> = {}): Promise<any> {
    const text = await this.post(method, kwparams);
    const payload = text ? JSON.parse(text) : {};
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = payload.error ?? {};
      throw new WorkbenchApiError(
        `Workbench API \`${method}\` failed: ${error.message ?? "error"} (code ${error.code})`
      );
    }
    return payload?.result;
  }

  async clusters(): Promise<Cluster[]> {
    const envs = (await this.call("get_compute_envs")) ?? {};
    return (envs.clusters ?? []).map((c: any) => ({
      name: String(c.name),
      supportsContainers: !!c.supportsContainers,
      resourceProfiles: (c.resourceProfiles ?? []).map((p: any) => String(p.name))
    }));
  }

  /** Check the credentials with one call; describes them. */
  async whoami(): Promise<{ auth: string; server: string }> {
    await this.call("get_compute_envs");
    return { auth: this.auth, server: this.server };
  }

  /** Launch a job from its camelCase Launcher API spec; returns its id. */
  async launchJob(spec: Record<string, unknown>): Promise<string> {
    const job = Object.fromEntries(
      Object.entries(spec).filter(([, v]) => v !== undefined && v !== null)
    );
    const id = (await this.call("launch_job", { job }))?.job?.id;
    if (!id) throw new WorkbenchApiError("Workbench did not return a job id.");
    return String(id);
  }

  /**
   * All jobs visible to the credentials, by id. Historical jobs need broader
   * privileges than a regular user's session cookie has: a 401/403 there
   * leaves just the active jobs, which win over historical ones.
   */
  async statusMap(): Promise<Map<string, WorkbenchJob>> {
    const jobs = new Map<string, WorkbenchJob>();
    try {
      const historical = await this.call("get_historical_session", { include_jobs: true });
      for (const job of historical?.jobs ?? []) if (job?.id != null) jobs.set(String(job.id), job);
    } catch (e) {
      if (!(e instanceof WorkbenchApiError) || ![401, 403].includes(e.statusCode)) throw e;
    }
    const active = await this.call("get_session", { include_all_jobs: true });
    for (const job of active?.jobs ?? []) if (job?.id != null) jobs.set(String(job.id), job);
    return jobs;
  }

  async jobState(jobId: string): Promise<JobState> {
    const job = (await this.statusMap()).get(jobId);
    return job ? jobStateOf(job) : "missing";
  }

  /** A graceful stop sends SIGTERM, so the job can clean up; else SIGKILL. */
  async stopJob(jobId: string, graceful: boolean): Promise<void> {
    await this.call("stop_job", { job_id: jobId, force_quit: !graceful });
  }

  /** Stop jobs, best-effort: a job may have ended already. Returns those stopped. */
  async stopJobs(jobIds: string[], graceful = false): Promise<string[]> {
    const stopped: string[] = [];
    for (const id of jobIds) {
      try {
        await this.stopJob(id, graceful);
        stopped.push(id);
      } catch {
        // already ended
      }
    }
    return stopped;
  }

  /** A job's stdout or stderr, from the `get_job_output` stream (one JSON chunk a line). */
  async jobOutput(jobId: string, stderr = false): Promise<string> {
    const text = await this.post("get_job_output", { job_id: jobId });
    return parseOutputStream(text, stderr ? "stderr" : "stdout");
  }
}

/** How a Workbench job's status maps to the extension's job states. */
export function jobStateOf(job: WorkbenchJob): JobState {
  if (job.status === "Pending" || job.status === "Suspended") return "queued";
  if (job.status === "Running") return "running";
  return "ended";
}

export function isUnfinished(job: WorkbenchJob): boolean {
  return jobStateOf(job) !== "ended";
}

/** The text of one output type in a `get_job_output` stream; raises its errors. */
export function parseOutputStream(text: string, outputType: "stdout" | "stderr"): string {
  let output = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (chunk?.error)
      throw new WorkbenchApiError(`Workbench API \`get_job_output\` failed: ${chunk.error.message}`);
    if ((chunk?.outputType ?? "stdout") === outputType) output += chunk?.output ?? "";
  }
  return output;
}
