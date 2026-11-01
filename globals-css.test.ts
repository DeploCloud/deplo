import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const KEEPS_ITS_FILL = new Set(["deplo-phase-in"]);

const css = [
  "app/globals",
  "app/motion",
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

test("touch screens cannot select text, but fields stay editable", () => {
  const touch = css.match(
    /@media \(hover: none\) and \(pointer: coarse\) \{([\s\S]*?)\n  \}/,
  )?.[1];
  assert.ok(touch, "the touch-only selection block is missing");
  assert.match(touch, /body \{[^}]*user-select: none;/);
  assert.match(touch, /body \{[^}]*-webkit-touch-callout: none;/);
  assert.match(touch, /input,\s*textarea,[^{]*\{[^}]*user-select: text;/);
});
