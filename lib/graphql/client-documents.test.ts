import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, parse, validate } from "graphql";

// The client's inline `/* GraphQL */` documents are never checked at build time:
// a wrong input type or a query/mutation mix-up only fails at the click.

const DOC = /\/\*\s*GraphQL\s*\*\/\s*`((?:[^`\\]|\\.)*)`/g;
const CONST = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*`((?:[^`\\]|\\.)*)`/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("every inline GraphQL document in the client is valid", () => {
  const schema = buildSchema(readFileSync("schema.graphql", "utf8"));
  const failures: string[] = [];
  let checked = 0;

  for (const file of [...walk("app"), ...walk("components"), ...walk("lib")]) {
    // lib/mcp/tools.ts has its own validation test.
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    if (file.endsWith(join("lib", "mcp", "tools.ts"))) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("/* GraphQL */")) continue;

    const fragments = new Map<string, string>();
    for (const m of src.matchAll(CONST)) fragments.set(m[1], m[2]);

    for (const m of src.matchAll(DOC)) {
      let doc = m[1];
      for (let i = 0; i < 3 && doc.includes("${"); i++)
        doc = doc.replace(
          /\$\{([A-Z][A-Z0-9_]*)\}/g,
          (all, name: string) => fragments.get(name) ?? all,
        );
      if (doc.includes("${")) continue;
      checked++;
      try {
        for (const e of validate(schema, parse(doc)))
          failures.push(`${file}: ${e.message}`);
      } catch (e) {
        failures.push(`${file}: ${(e as Error).message}`);
      }
    }
  }

  assert.ok(checked > 90, `only ${checked} documents found - scan is broken`);
  assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
});
