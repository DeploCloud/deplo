import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";

// Without an id, dnd-kit numbers its aria ids from a counter the server never resets,
// so a server-rendered list hydrates with ids that point at nothing.
test("every DndContext has a stable id", () => {
  const offenders: string[] = [];
  for (const file of globSync("{app,components}/**/*.tsx")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<DndContext\b([^>]*)>/g))
      if (!/\bid="[^"]+"/.test(m[1])) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
