"""A stand-in for the Workbench Launcher API that runs each job as a local process.

Good enough to drive the extension, with posit-sdk-snakemake's executor plugin, end to end without
a Workbench server (the same stand-in as posit-sdk-snakemake's tests/fake_workbench.py, plus the
test-only method ``debug_calls``, which returns the calls received so far): it answers ``launch_job``, ``get_session``,
``get_historical_session``, ``stop_job``, ``get_compute_envs`` and ``get_job_output``, and checks
the Bearer token. Jobs run ``exe args`` with the job's environment and working directory, start
``Pending`` and become ``Running``, then ``Finished`` (with the exit code), or ``Killed``.

Run it as a script to serve on a port: ``python fake_workbench.py [port]``; it prints its URL.
"""

from __future__ import annotations

import itertools
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = "fake-key"


class FakeWorkbench:
    def __init__(self, port: int = 0, api_key: str = API_KEY, clusters=None):
        self.api_key = api_key
        self.jobs: dict[str, dict] = {}
        self.output: dict[str, list[dict]] = {}
        self.calls: list[dict] = []
        self.clusters = clusters or [
            {
                "name": "Local",
                "type": "Local",
                "supportsContainers": False,
                "resourceProfiles": [{"name": "small"}, {"name": "large"}],
            }
        ]
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                fake.calls.append(body)
                if self.headers.get("Authorization") != f"Bearer {fake.api_key}":
                    return self._send(401, b"unauthorized")
                method, kw = body.get("method"), body.get("kwparams") or {}
                if method == "get_job_output":
                    lines = "".join(
                        json.dumps(c) + "\n" for c in fake.output.get(kw["job_id"], [])
                    )
                    return self._send(200, lines.encode())
                handler = getattr(fake, f"_{method}", None)
                if handler is None:
                    payload = {"error": {"code": 1, "message": f"unknown method {method}"}}
                else:
                    try:
                        payload = {"result": handler(**kw)}
                    except KeyError as e:
                        payload = {"error": {"code": 4, "message": f"no such job {e}"}}
                self._send(200, json.dumps(payload).encode())

            def _send(self, status, data):
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> FakeWorkbench:
        self._thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        for job in list(self.jobs.values()):
            proc = job.pop("_proc", None)
            if proc and proc.poll() is None:
                proc.kill()

    def environ(self) -> dict[str, str]:
        """The environment a client needs to talk to this server."""
        return {"WORKBENCH_SERVER": self.url, "WORKBENCH_API_KEY": self.api_key}

    # --- API methods ---

    def _debug_calls(self, **_):
        return self.calls[:-1]

    def _get_compute_envs(self, **_):
        return {"clusters": self.clusters, "workbenches": []}

    def _launch_job(self, job, **_):
        job_id = f"job{next(self._ids)}"
        record = {**job, "id": job_id, "status": "Pending", "exitCode": None}
        with self._lock:
            self.jobs[job_id] = record
            self.output[job_id] = []
        threading.Thread(target=self._run, args=(record,), daemon=True).start()
        return {"job": {k: v for k, v in record.items() if not k.startswith("_")}}

    def _run(self, record):
        time.sleep(0.3)  # long enough to be seen pending
        env = {**os.environ, **{e["name"]: e["value"] for e in record.get("environment") or []}}
        proc = subprocess.Popen(
            [record["exe"], *(record.get("args") or [])],
            cwd=record.get("workingDirectory") or None,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        record["_proc"] = proc
        if record["status"] == "Pending":
            record["status"] = "Running"
        out, err = proc.communicate()
        self.output[record["id"]] += [
            {"jobId": record["id"], "outputType": "stdout", "output": out.decode()},
            {"jobId": record["id"], "outputType": "stderr", "output": err.decode()},
        ]
        record["exitCode"] = proc.returncode
        if record["status"] != "Killed":
            record["status"] = "Finished"

    def _get_session(self, **_):
        return {"jobs": [self._public(j) for j in self.jobs.values()]}

    def _get_historical_session(self, **_):
        return {"jobs": []}

    def _stop_job(self, job_id, force_quit=None, **_):
        record = self.jobs[job_id]
        proc = record.get("_proc")
        if proc and proc.poll() is None:
            # like the Launcher: the whole job, TERM unless forced
            os.killpg(proc.pid, signal.SIGKILL if force_quit else signal.SIGTERM)
        record["status"] = "Killed"

    @staticmethod
    def _public(job):
        return {k: v for k, v in job.items() if not k.startswith("_")}


if __name__ == "__main__":
    fake = FakeWorkbench(port=int(sys.argv[1]) if len(sys.argv) > 1 else 0).start()
    print(fake.url, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        fake.stop()
