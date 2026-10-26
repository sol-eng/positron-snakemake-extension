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
