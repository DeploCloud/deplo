import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A modal scrim and its content are separate portals: at an equal z-index a reopen can paint the
// scrim over the dialog, leaving a blurred screen with no modal on it.
const CONTENT_Z = 50;
const SCRIM = /"[^"]*\bfixed inset-0\b[^"]*"/g;
const Z = /\bz-\[?(\d+)\]?/;

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("a modal scrim sits below the modal content", () => {
  const offenders: string[] = [];
  for (const file of [...walk("app"), ...walk("components")]) {
    for (const [cls] of readFileSync(file, "utf8").matchAll(SCRIM)) {
      if (!cls.includes("bg-black/")) continue;
      const z = Number(cls.match(Z)?.[1] ?? NaN);
      if (!(z < CONTENT_Z)) offenders.push(`${file}: z-${z}`);
    }
  }
  assert.deepEqual(offenders, []);
});
