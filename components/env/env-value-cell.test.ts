import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("on a phone a variable's value rides under its key, never in a column of its own", () => {
  let tables = 0;
  for (const name of readdirSync("components/env")) {
    if (!name.endsWith(".tsx")) continue;
    const src = readFileSync(join("components/env", name), "utf8");
    const cells =
      src.match(/<TableCell[^>]*>\s*(?:<Bone[^>]*>\s*)?<EnvValueCell/g) ?? [];
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
  assert.equal(tables, 3);
});

test("in the app's variable list the value column hides below md and rides under the key", () => {
  const list = readFileSync("components/env/env-list.tsx", "utf8");
  assert.match(list, /<div className="min-w-0 max-md:hidden">\{value\}<\/div>/);
  assert.match(list, /<span className="max-md:hidden">Value<\/span>/);
  const rows = readFileSync("components/env/env-manager-rows.tsx", "utf8");
  const values =
    rows.match(/value=\{\s*(?:<Bone[^>]*>\s*)?<EnvValueCell/g) ?? [];
  assert.ok(values.length >= 3);
  assert.equal(rows.match(/<EnvValueUnderKey/g)?.length, values.length);
});
