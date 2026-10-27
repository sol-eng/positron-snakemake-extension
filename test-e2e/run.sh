#!/bin/bash
# Runs test-e2e/suite.js in Positron, with a throwaway profile and a copy of
# test-e2e/workflow. Needs `npm run build` first, and SNAKEMAKE pointing at a
# snakemake with posit-sdk-snakemake's plugins installed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
editor="${POSITRON_BIN:-/Applications/Positron.app/Contents/MacOS/Positron}"
: "${SNAKEMAKE:?set SNAKEMAKE to the snakemake executable to test with}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -r "$here/workflow" "$tmp/workflow"
mkdir -p "$tmp/user/User"
cat >"$tmp/user/User/settings.json" <<JSON
{
  "snakemake.run.executable": "$SNAKEMAKE",
  "snakemake.run.confirm": false,
  "workbench.startupEditor": "none",
  "python.interpreter.automaticSelection": false,
  "telemetry.telemetryLevel": "off"
}
JSON
export E2E_RESULT="$tmp/result.json"
# a stand-in for the Workbench API, for the runs whose jobs are Workbench jobs
python3 "$here/fake_workbench.py" >"$tmp/fake-url" &
fake_pid=$!
disown "$fake_pid"
trap 'kill "$fake_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [ -s "$tmp/fake-url" ] && break; sleep 0.1; done
export WORKBENCH_SERVER="$(cat "$tmp/fake-url")" WORKBENCH_API_KEY=fake-key
unset POSIT_PRODUCT RS_SERVER_ADDRESS RS_SERVER_URL PWB_SESSION_RUNTIME_DIR RS_SESSION_RPC_COOKIE
# built-in extensions may write logs into the current directory
cd "$tmp"
"$editor" --user-data-dir "$tmp/user" --extensions-dir "$tmp/extensions" \
  --disable-workspace-trust --skip-welcome --new-window \
  --extensionDevelopmentPath="$repo" --extensionTestsPath="$here/suite.js" \
  "$tmp/workflow" >"$tmp/editor.log" 2>&1 || true
if [ ! -f "$E2E_RESULT" ]; then
  echo "no results; editor output:" >&2
  tail -40 "$tmp/editor.log" >&2
  exit 1
fi
node -e '
  const r = require(process.argv[1]);
  for (const c of r) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : "  " + JSON.stringify(c.detail)}`);
  process.exit(r.every((c) => c.ok) ? 0 : 1);
' "$E2E_RESULT"
