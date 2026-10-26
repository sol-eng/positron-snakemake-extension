# Contributing

## Working on the Positron fork

This repository is a fork of [snakemake/snakemake-lang-vscode-plugin](https://github.com/snakemake/snakemake-lang-vscode-plugin), tracked as the `upstream` remote. To keep upstream merges easy:

- Put Positron-specific code in `src/positron/`, which is the only place that touches the Positron API.
- Keep changes to upstream files to small hooks marked with a `// Positron:` comment (`src/extension.ts`, and `build.mjs`, which copies mermaid for the graph pages).
- Detect Positron with `isPositron()` from `src/positron`. It uses the `acquirePositronApi` global that Positron injects, so `@posit-dev/positron` is only used for types. Gate Positron-only contributions in `package.json` with the `isPositron` context key.

The design follows the [Positron Nextflow extension](https://github.com/sol-eng/positron-nextflow-extension), module for module.

The run manager lives in `src/positron/runs/`. Its pure parts (the event reducer, the console-output fallback, command-line and script building, and the dashboard's file reading in `model.ts`, `events.ts`, `textLog.ts`, `launchArgs.ts`, `graph.ts` and `dashboard/jobFiles.ts`) are kept free of `vscode`, and are tested against output captured from real Snakemake runs in `src/positron/test/fixtures/` (`npm run test:positron`).

Live status comes from the events file written by the workbench logger plugin (`--logger workbench --logger-workbench-events-file`, in [posit-sdk-snakemake](https://github.com/sol-eng/posit-sdk-snakemake)), and Workbench jobs are found by the `snakemake-run:<run name>` tag the executor plugin puts on them. Changes to either need a matching change there.

Each run is started through a generated `run.sh` (see `buildRunScript` in `launchArgs.ts`). It runs Snakemake with job control on, so Snakemake keeps its SIGINT handling in the background, and turns SIGTERM into a SIGINT to Snakemake's process group, which is how both Stop and stopping a headless run's Workbench job cancel the run's jobs.

`make e2e` drives the extension in Positron against `test-e2e/workflow`, with a throwaway profile (`SNAKEMAKE=<path to snakemake>`; see `test-e2e/run.sh`). `testing.txt` is the manual checklist for Posit Workbench.

Every push to `main` publishes a pre-release with the VSIX, numbered `<version>-dev.<run>` (see `.github/workflows/prerelease.yml`); the last five are kept. To release, set the version in `package.json`, add a `CHANGELOG.md` entry noting the upstream base, tag `v<version>` and create a GitHub release with the VSIX. Then bump `package.json` to the next patch version, so pre-releases sort after the release.
