import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "./lib/data-dir";

// `const X = process.env.DEPLO_DATA_DIR || "/data"` at module scope, in any form.
const CAPTURED =
  /^\s*(?:const|let|var)\s[^;\n]*\bprocess\.env\.DEPLO_DATA_DIR\b/gm;

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("the data dir follows the environment at call time", () => {
  const was = process.env.DEPLO_DATA_DIR;
  try {
    process.env.DEPLO_DATA_DIR = "/tmp/first";
    assert.equal(dataDir(), "/tmp/first");
    process.env.DEPLO_DATA_DIR = "/tmp/second";
    assert.equal(dataDir(), "/tmp/second");
    delete process.env.DEPLO_DATA_DIR;
    assert.equal(dataDir(), "/data");
  } finally {
    if (was === undefined) delete process.env.DEPLO_DATA_DIR;
    else process.env.DEPLO_DATA_DIR = was;
  }
});

// A module-level copy freezes whatever the FIRST file in a test worker happened to
// set, so a later file's own temp dir is ignored and the write lands in the real
// /data - which is how a test run put prj_site/upl_abc in production's uploads.
test("no module captures the data dir at import time", () => {
  const offenders: string[] = [];
  for (const file of walk("lib")) {
    for (const [line] of readFileSync(file, "utf8").matchAll(CAPTURED)) {
      offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
