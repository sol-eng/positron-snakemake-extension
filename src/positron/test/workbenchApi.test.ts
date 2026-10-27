import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
  COOKIE_HEADER,
  isUnfinished,
  jobStateOf,
  parseOutputStream,
  WorkbenchApi,
  WorkbenchApiError
} from "../runs/workbenchApi";

type Call = { path: string; rawHeaders: string[]; method: string; kwparams: any };

// A Launcher API stand-in: records calls, answers from `replies` by method
const calls: Call[] = [];
const replies = new Map<string, [number, unknown]>();
let url = "";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    calls.push({ path: req.url ?? "", rawHeaders: req.rawHeaders, ...parsed });
    const [status, payload] = replies.get(parsed.method) ?? [200, { result: null }];
    res.writeHead(status);
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
});

before(
  () =>
    new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        url = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      })
    )
);
after(() => server.close());
beforeEach(() => {
  calls.length = 0;
  replies.clear();
});

const apiKey = (base = "") =>
  new WorkbenchApi({ WORKBENCH_SERVER: url + base, WORKBENCH_API_KEY: "secret" });

/** A header as it went out on the wire, by exact name. */
function rawHeader(call: Call, name: string): string | undefined {
  const i = call.rawHeaders.indexOf(name);
  return i === -1 ? undefined : call.rawHeaders[i + 1];
}

test("the envelope, with the API key", async () => {
  replies.set("get_compute_envs", [200, { result: { clusters: [{ name: "k8s", resourceProfiles: [{ name: "small" }] }] } }]);
  assert.deepEqual(await apiKey().clusters(), [{ name: "k8s", supportsContainers: false, resourceProfiles: ["small"] }]);
  const [call] = calls;
  assert.equal(call.path, "/api/get_compute_envs");
  assert.equal(call.method, "get_compute_envs");
  assert.deepEqual(call.kwparams, {});
  assert.equal(rawHeader(call, "Authorization"), "Bearer secret");
});

test("the base path is kept", async () => {
  await apiKey("/rstudio/").call("get_compute_envs");
  assert.equal(calls[0].path, "/rstudio/api/get_compute_envs");
});

test("the session cookie, from the runtime dir and then the environment, under its exact name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwb-"));
  fs.writeFileSync(path.join(dir, "rpc_cookie"), "from-file\n");
  const env = { POSIT_PRODUCT: "WORKBENCH", RS_SERVER_ADDRESS: url };
  await new WorkbenchApi({ ...env, PWB_SESSION_RUNTIME_DIR: dir }).call("x");
  await new WorkbenchApi({ ...env, RS_SESSION_RPC_COOKIE: "from-env" }).call("x");
  assert.deepEqual(calls.map((c) => rawHeader(c, COOKIE_HEADER)), ["from-file", "from-env"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("credentials: a session without a cookie falls back to the API key; none at all fails", () => {
  const api = new WorkbenchApi({
    POSIT_PRODUCT: "WORKBENCH",
    RS_SERVER_ADDRESS: "http://unused",
    WORKBENCH_SERVER: url,
    WORKBENCH_API_KEY: "k"
  });
  assert.equal(api.auth, "api-key");
  assert.throws(() => new WorkbenchApi({}), WorkbenchApiError);
  assert.equal(WorkbenchApi.available({}), false);
});

test("a job is launched from its spec, unset fields left out", async () => {
  replies.set("launch_job", [200, { result: { job: { id: "42" } } }]);
  const id = await apiKey().launchJob({ cluster: "k8s", name: "d", container: undefined, tags: ["t"] });
  assert.equal(id, "42");
  assert.deepEqual(calls[0].kwparams, { job: { cluster: "k8s", name: "d", tags: ["t"] } });
});

test("job states: history may be unauthorized, active jobs win", async () => {
  const api = apiKey();
  replies.set("get_historical_session", [401, "unauthorized"]);
  replies.set("get_session", [200, { result: { jobs: [{ id: "a", status: "Running" }] } }]);
  assert.equal(await api.jobState("a"), "running");
  assert.equal(await api.jobState("b"), "missing");
  replies.set("get_historical_session", [200, { result: { jobs: [{ id: "a", status: "Pending" }, { id: "b", status: "Finished" }] } }]);
  const jobs = await api.statusMap();
  assert.equal(jobs.get("a")?.status, "Running");
  assert.equal(jobs.get("b")?.status, "Finished");
  assert.deepEqual(calls.at(-1)?.kwparams, { include_all_jobs: true });
  replies.set("get_historical_session", [500, "boom"]);
  await assert.rejects(api.statusMap(), (e: WorkbenchApiError) => e.statusCode === 500);
});

test("stopping: graceful or forced; best-effort for several", async () => {
  const api = apiKey();
  await api.stopJob("1", true);
  await api.stopJob("1", false);
  assert.deepEqual(calls.map((c) => c.kwparams), [{ job_id: "1", force_quit: false }, { job_id: "1", force_quit: true }]);
  replies.set("stop_job", [200, { error: { code: 4, message: "no such job" } }]);
  await assert.rejects(api.stopJob("x", false), /no such job/);
  assert.deepEqual(await api.stopJobs(["x", "y"]), []);
});

test("a job's output, from its stream", async () => {
  const chunks = [
    { outputType: "stdout", output: "hello\n" },
    { outputType: "stderr", output: "oops\n" },
    { outputType: "stdout", output: "world\n" }
  ];
  replies.set("get_job_output", [200, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n"]);
  assert.equal(await apiKey().jobOutput("42"), "hello\nworld\n");
  assert.equal(await apiKey().jobOutput("42", true), "oops\n");
  assert.throws(() => parseOutputStream('{"error":{"message":"gone"}}\n', "stdout"), /gone/);
});

test("job state mapping", () => {
  assert.equal(jobStateOf({ id: "1", status: "Pending" }), "queued");
  assert.equal(jobStateOf({ id: "1", status: "Suspended" }), "queued");
  assert.equal(jobStateOf({ id: "1", status: "Running" }), "running");
  assert.equal(jobStateOf({ id: "1", status: "Finished", exitCode: 1 }), "ended");
  assert.equal(isUnfinished({ id: "1", status: "Killed" }), false);
  assert.equal(isUnfinished({ id: "1", status: "Pending" }), true);
});

test("an unreachable server", async () => {
  const api = new WorkbenchApi({ WORKBENCH_SERVER: "http://127.0.0.1:1", WORKBENCH_API_KEY: "k" });
  await assert.rejects(api.call("x"), /Cannot reach/);
});
