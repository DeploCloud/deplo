import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// A Server Component hands its children over as unkeyed lazy nodes, so hide(key) matches no row.
test("OptimisticList is only rendered from a client component", () => {
  const offenders = [...walk("app"), ...walk("components")].filter((file) => {
    const src = readFileSync(file, "utf8");
    return src.includes("<OptimisticList") && !src.startsWith('"use client"');
  });
  assert.deepEqual(offenders, []);
});
