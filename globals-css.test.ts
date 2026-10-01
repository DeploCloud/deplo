import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const KEEPS_ITS_FILL = new Set(["deplo-phase-in"]);

const css = [
  "app/globals",
  ...["motion", "apps", "data", "settings"].map(
    (f) => `components/iso/styles/${f}`,
  ),
]
  .map((f) => readFileSync(new URL(`./${f}.css`, import.meta.url), "utf8"))
  .join("\n");

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
