# Snakemake extension for Positron

A fork of the [Snakemake Language extension for VS Code](https://github.com/snakemake/snakemake-lang-vscode-plugin) with additions for [Positron](https://positron.posit.co/): running Snakemake pipelines and following them live, locally or as [Posit Workbench](https://posit.co/products/enterprise/workbench/) jobs. Everything below the Positron section is upstream's documentation and applies unchanged.

## Positron

In Positron the extension adds:

- **Run and manage pipelines.** The **Pipeline Runs** view in the Snakemake sidebar runs a workflow (the ▶ button on a Snakefile, or **Snakemake: Run Pipeline...**). It asks for the targets, a profile, config overrides or files, and, with the [workbench executor plugin](https://github.com/sol-eng/posit-sdk-snakemake) installed, whether the jobs run in the session or as Workbench jobs, on which cluster and resource profile. It then follows the run live, per rule and job.
  - **Stop** a run (Snakemake cancels its jobs, including Workbench jobs, as Ctrl+C would), **Stop After Running Jobs Finish**, or **Force Kill** it. **Run Again** builds what is still missing or out of date; **Run Again, Rerunning Incomplete Jobs** adds `--rerun-incomplete`.
  - **Dry Run Pipeline...** shows the jobs Snakemake would run, per rule, without running them.
  - A run that failed because the working directory is locked, or because outputs are incomplete, offers **Unlock** or **Rerun Incomplete** right in the tree.
  - Click a job to open its **dashboard** in the Viewer: its rule, wildcards, reason, resources, shell command, log files, benchmark (time, peak memory, CPU, I/O), outputs and inputs, and for Workbench jobs the job's own stdout and stderr. A run's dashboard shows per-rule progress, and failed jobs with the end of their logs.
  - **Debug Job in Console** for a `script:` job runs the preamble Snakemake generated for it in the R or Python console, which defines the job's `snakemake` object (`snakemake.input`, `snakemake.wildcards`, ...) in the job's working directory, and opens the script to step through.
  - **Cancel** a single Workbench job.
  - Show the **rule graph** (live, coloured by progress) and the **job graph** in the run's dashboard, with a way back to the run, create Snakemake's **report** and open it in the Viewer (with a button back to the run), and open the **output summary** (`--detailed-summary`) or a benchmark file in the Data Explorer.
  - **Lint Workflow**, **Unlock Working Directory**, and **Delete Workflow Outputs...** (temporary or all, after a preview).
  - Runs keep going when the window is reloaded or closed, and are picked up again by the next window. Each run's output and events are in `.snakemake/positron/<run name>/` under its working directory.
  - **Headless runs on Posit Workbench:** Run Pipeline can start Snakemake itself as a Workbench Job ("As a Workbench Job"), so the run keeps going when the session is suspended or stopped, and a later session picks it up. Stop and Force Kill stop the job; Workbench jobs it leaves behind are cancelled by the run's tag. See the `snakemake.run.driver` and `snakemake.run.headless.*` settings. A run inside the session itself stops when the session is suspended.
- **Assistant integration.** Posit Assistant can list runs, explain why a run failed (from each failed job's logs and Snakemake's errors), and launch (or dry-run) or stop a run after you approve it. The extension gives it a `snakemake-runs` skill and agent-compatible commands (`snakemake.positron.assistant.*`), which it runs with its `positronCommand` tool; assistants that use VS Code language model tools, such as Copilot, get the same as `snakemake_*` tools.
- **Run code in the console.** A Snakefile is Python: press <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to run the current line or selection in the Python console, or <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> to run the rule's `run:` block around the cursor.
- **Open in Data Explorer.** Right-click a CSV/TSV file, such as a sample sheet or a benchmark, and choose **Open in Data Explorer**.

In VS Code the extension behaves like upstream.

### Requirements

- Snakemake 9 or later. The extension uses the `snakemake` of the Python interpreter selected in Positron, a `.venv` in the workspace, or the one on the `PATH`; set `snakemake.run.executable` to choose another.
- For live job status, Workbench jobs and headless runs: [posit-sdk-snakemake](https://github.com/sol-eng/posit-sdk-snakemake), installed into the same environment as Snakemake (`uv pip install <path-to-posit-sdk-snakemake>`). It provides the workbench logger plugin (live events), the workbench executor plugin (`--executor workbench`), and the `posit-workbench-smk-launcher` CLI. Without it, runs work locally and job status is read from Snakemake's output.
- **Snakemake: Show Run Diagnostics** shows what the extension found.

The extension ID is `posit.positron-snakemake`. It contributes the same language, grammars and snippets as `snakemake.snakemake-lang`, so it stays inactive, and offers to uninstall that extension, while both are installed.

To install, build the VSIX with `make` and install `positron-snakemake.vsix`, or run `make install`. Settings for runs are under `snakemake.run.*`.

---

# Snakemake Language Support

Provides basic language support for [Snakemake](https://snakemake.readthedocs.io) files (Snakefile, *.smk).
Feedback, suggestions, and contributions are very welcome!

This project has been started by Peter Alping, and can be considered a fork of [this repository](https://gitlab.com/alping/vscode-snakemake).

## Features

- Syntax definitions based on Python, with added Snakemake keywords
- Language rules based on Python
- Snippets

## Example

![Snakemake syntax highlighting example](misc/example.png)

<!--
Needs to be published with:
vsce publish --baseContentUrl https://gitlab.com/alping/vscode-snakemake/raw/master
-->

Example taken from [Snakemake documentation](https://snakemake.readthedocs.io/en/stable/tutorial/advanced.html#summary).

## Supported Syntax

<details>

<summary>[Keywords and Functions](src/keywords.yaml)</summary>

- Configurations
  - these keywords specified in the format `<keyword>: <values>` within a snakefile.
  - for example:
    ```snakemake
    configfile: "config.yaml"

    onsuccess:
        print("All jobs finished successfully.")

    include: "workflow/report.smk"
    ```

- [Rules and Modules](https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html#snakefiles-and-rules)
  - `rule <rulename>:` defines a rule with its parameters, followed by an indented body
  - [`checkpoint <rulename>:`] is a special type of `rule` that allows dynamic determination of workflow steps based on its output.
  - `module <modulename>:` declares a module repository from which rules can be imported
  - `subworkflow` is now deprecated

- Rule Parameters
  - Used in `rule` and `checkpoint` blocks to define inputs, outputs, and other settings.
  - You can re- `used rule <rulename> as <newrulename> ... with` different parameters, but you cannot change the way it runs, including:
    - run
    - shell
    - script
    - [`notebook`](https://snakemake.readthedocs.io/en/stable/tutorial/interaction_visualization_reporting/tutorial.html#tutorial-interaction-visualization-and-reporting-with-snakemake)
    - [`wrapper`](https://snakemake.readthedocs.io/en/stable/snakefiles/modularization.html#wrappers)
    - template_engine
    - [`cwl`](https://snakemake.readthedocs.io/en/stable/snakefiles/modularization.html#common-workflow-language-cwl-support)

- [Module Parameters](https://snakemake.readthedocs.io/en/stable/snakefiles/modularization.html#modules):
  - Define where and how to import rules when using the `module` directive.
  - Example:
    ```snakemake
    module remote:
        snakefile: "local.smk"
        config: {**config, "remote": True}
        replace_prefix: "local/"
        prefix: "remote/"

    use rule * from remote as remote_*
    ```

- Global Variables:
  - The following classes are available without explicit import from the snakemake module:
    - `Path`
    - `WorkflowError`
  - Important variables used across workflows include:
    - snakemake
    - `rules`: reference rules via `rules.<rulename>`
    - workflow
    - `checkpoints`: access outputs of [checkpoint](https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html#data-dependent-conditional-execution) rules
    - [`storage`](https://snakemake.readthedocs.io/en/stable/snakefiles/storage.html#storage-support)
    - [`access`](https://snakemake.readthedocs.io/en/stable/snakefiles/storage.html#access-pattern-annotation)
    - [`scatter` and `gather`](https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html#defining-scatter-gather-processes)

- Job Parameters:
  - These parameters are only available during job execution and should be used within `run` or `shell` blocks
    - input
    - output
    - params
    - wildcards
    - threads
    - resources
    - log
  - [`config`](https://snakemake.readthedocs.io/en/stable/snakefiles/configuration.html#configuration) is a dict that contains the configuration values and can be accessed everywhere

- Functions:
  - Various [built-in helper functions](https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html#helpers-for-defining-rules) are available for use without needing to import them

</details>

## TODO

- [x] recognize files provided as string after `include:`, `conda`, `snakefile`, and allow quickly jumping to them
- [x] add bash-color to docstring in `shell:` block
- [ ] Indentation rules (really tricky for some reason)
- [ ] Recognize wildcard constraints inside string substitutions: `"{sample,[A-Za-z0-9]+}"`

## Snakemake Support for other Editors

- [Vim](https://github.com/snakemake/snakemake/tree/master/misc/vim)
