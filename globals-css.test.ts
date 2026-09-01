import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * An entrance animation must not hold its final frame: a forwards fill keeps
 * `filter`/`transform` on the element for good, which makes it a containing
 * block and re-rasterizes its subtree on every paint (typing in a form row).
 */

// It ends at a min-width the element does not otherwise have, so releasing the
// fill would collapse the row.
const KEEPS_ITS_FILL = new Set(["deplo-phase-in"]);

const css = readFileSync(new URL("./app/globals.css", import.meta.url), "utf8");

test("entrance animations release their fill", () => {
  const offenders: string[] = [];
  for (const [, name, fill] of css.matchAll(
    /animation:\s*([\w-]+)[^;]*?\b(both|forwards)\s*;/g,
  )) {
    const isEntrance = name.endsWith("-in") || name.includes("-in-");
    if (isEntrance && !KEEPS_ITS_FILL.has(name))
      offenders.push(`${name} (${fill})`);
  }
  assert.deepEqual(offenders, [], `use \`backwards\`: ${offenders.join(", ")}`);
});
