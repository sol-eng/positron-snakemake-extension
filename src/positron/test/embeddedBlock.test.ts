import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockBody,
  chdirCode,
  dedent,
  findRunBlock,
  scriptLanguage,
  usesJobObjects
} from "../embeddedBlock";

const SNAKEFILE = `rule a:
    output: "a.txt"
    run:
        with open(output[0], "w") as f:

            f.write("hi")
    # trailing comment

rule b:
    output: "b.txt"
    shell: "touch {output}"
`.split("\n");

test("finds the run: block around the cursor", () => {
  const block = findRunBlock(SNAKEFILE, 5);
  assert.deepEqual(block, { runLine: 2, startLine: 3, endLine: 5 });
  assert.equal(
    dedent(blockBody(SNAKEFILE, block!)),
    'with open(output[0], "w") as f:\n\n    f.write("hi")'
  );
  assert.ok(findRunBlock(SNAKEFILE, 2));
});

test("no run: block outside one", () => {
  assert.equal(findRunBlock(SNAKEFILE, 1), undefined);
  assert.equal(findRunBlock(SNAKEFILE, 6), undefined);
  assert.equal(findRunBlock(SNAKEFILE, 10), undefined);
});

test("job objects, languages and working directories", () => {
  assert.equal(usesJobObjects("open(output[0])"), true);
  assert.equal(usesJobObjects("x = wildcards.sample"), true);
  assert.equal(usesJobObjects("import os\n# output[0]"), false);
  assert.equal(scriptLanguage("tmpab.plot.R"), "r");
  assert.equal(scriptLanguage("tmpab.hello.py"), "python");
  assert.equal(scriptLanguage("tmpab.report.Rmd"), undefined);
  assert.equal(chdirCode("python", "/w"), 'import os; os.chdir("/w")');
  assert.equal(chdirCode("r", "/w"), 'setwd("/w")');
});
