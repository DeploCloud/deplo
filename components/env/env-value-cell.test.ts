import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("on a phone a variable's value rides under its key, never in a column of its own", () => {
  let tables = 0;
  for (const name of readdirSync("components/env")) {
    if (!name.endsWith(".tsx")) continue;
    const src = readFileSync(join("components/env", name), "utf8");
    const cells = src.match(/<TableCell[^>]*>\s*<EnvValueCell/g) ?? [];
    if (cells.length === 0) continue;
    tables++;
    for (const cell of cells) assert.match(cell, /max-md:hidden/, name);
    assert.equal(src.match(/<EnvValueUnderKey/g)?.length, cells.length, name);
    assert.match(
      src,
      /<TableHead className="[^"]*max-md:hidden[^"]*">\s*Value\s*</,
      name,
    );
  }
  assert.equal(tables, 4);
});
