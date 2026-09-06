import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A filled surface is filled: the dotted ground sits under every page, so a
 * background with an alpha lets it show through. See "Fills are opaque" in
 * AGENTS.md.
 */
const OVERLAY = new Set(["black", "background", "popover"]);
const ALPHA_BG = /\bbg-([a-z-]+)\/(\[?[0-9.]+%?\]?)/g;

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("every background is opaque, bar the overlays", () => {
  const offenders: string[] = [];
  for (const file of [...walk("app"), ...walk("components")]) {
    const src = readFileSync(file, "utf8");
    for (const [match, token] of src.matchAll(ALPHA_BG)) {
      if (!OVERLAY.has(token)) offenders.push(`${file}: ${match}`);
    }
  }
  assert.deepEqual(offenders, []);
});
