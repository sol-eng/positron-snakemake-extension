// Locates the Python code in a Snakefile that a Positron console can run: a
// rule's `run:` block, or any selected lines. Kept free of `vscode` so it can
// be unit tested with plain Node.

export type RunBlock = {
  /** line of the `run:` directive */
  runLine: number;
  /** first and last line of the block's body */
  startLine: number;
  endLine: number;
};

const RUN_DIRECTIVE = /^(\s*)run\s*:\s*(#.*)?$/;

function indentOf(line: string): number {
  return line.match(/^\s*/)![0].length;
}

/** The `run:` block that contains `line`, if any. */
export function findRunBlock(
  lines: string[],
  line: number
): RunBlock | undefined {
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const match = lines[i].match(RUN_DIRECTIVE);
    if (!match) {
      // left the rule: a line at or left of a rule's directives
      if (lines[i].trim() && indentOf(lines[i]) === 0 && i < line) return undefined;
      continue;
    }
    const indent = match[1].length;
    let endLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= indent) break;
      endLine = j;
    }
    if (endLine === i || line > endLine) return undefined;
    return { runLine: i, startLine: i + 1, endLine };
  }
  return undefined;
}

/** The body of `block`, without the directive. */
export function blockBody(lines: string[], block: RunBlock): string {
  return lines.slice(block.startLine, block.endLine + 1).join("\n");
}

/** Remove the common indentation, so that indented code runs at top level. */
export function dedent(text: string): string {
  const lines = text.split(/\r?\n/);
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => indentOf(l));
  const indent = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(indent))
    .join("\n")
    .trim();
}

/**
 * Does the code use the job's objects (`input`, `output`, `wildcards`, ...)?
 * They only exist while Snakemake runs the job.
 */
export function usesJobObjects(code: string): boolean {
  return /\b(input|output|params|wildcards|threads|resources|log)\s*[.[]/.test(
    code.replace(/#.*$/gm, "")
  );
}

/** Console code that makes `dir` the working directory. */
export function chdirCode(language: "r" | "python", dir: string): string {
  // a JSON string literal is also a valid R and Python string literal
  const quoted = JSON.stringify(dir);
  return language === "r"
    ? `setwd(${quoted})`
    : `import os; os.chdir(${quoted})`;
}

/** The console language of a script, from its file name. */
export function scriptLanguage(file: string): "r" | "python" | undefined {
  if (/\.py$/i.test(file)) return "python";
  if (/\.R$/i.test(file)) return "r";
  return undefined;
}
