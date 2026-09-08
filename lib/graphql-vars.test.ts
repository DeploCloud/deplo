import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, parse, validate, type GraphQLSchema } from "graphql";

import { assertVariablesDeclared } from "./graphql-vars";

/**
 * The two things that go wrong with the inline documents the dashboard sends:
 * a variable nobody declared (dropped in silence by the server) and a field the
 * schema no longer has.
 */

const DOC = `
  mutation StartMigration($input: MigrationSourceInput!, $queued: [MigrationQueuedTeamInput!]) {
    startMigration(input: $input, queued: $queued)
  }
`;

test("a variable the document declares passes", () => {
  assertVariablesDeclared(DOC, { input: {}, queued: [] });
  assertVariablesDeclared(DOC, undefined);
});

// The bug this exists for: the call site grew a `queued` argument, the document
// kept the old header, and every team but the first was dropped without a word.
test("a variable the document does NOT declare throws", () => {
  assert.throws(
    () => assertVariablesDeclared(DOC, { input: {}, keepSources: true }),
    /\$keepSources/,
  );
});

test("a variable named in the SELECTION does not count as declared", () => {
  assert.throws(
    () => assertVariablesDeclared(DOC, { orgName: "x" }),
    /\$orgName/,
  );
});

/* ---- every inline document the UI sends ---------------------------- */

let cached: GraphQLSchema | undefined;
const sdl = () =>
  (cached ??= buildSchema(readFileSync("schema.graphql", "utf8")));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Every `/* GraphQL *\/` template in a file, minus the interpolated ones. */
function documentsIn(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/\/\* GraphQL \*\/\s*`([\s\S]*?)`/g)]
    .map((m) => m[1])
    .filter((d) => !d.includes("${"));
}

test("every GraphQL document the dashboard sends is valid against the schema", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const file of [...sources("components"), ...sources("app")]) {
    for (const doc of documentsIn(file)) {
      checked++;
      try {
        for (const e of validate(sdl(), parse(doc)))
          failures.push(`${file}: ${e.message}`);
      } catch (e) {
        failures.push(`${file}: ${(e as Error).message}`);
      }
    }
  }
  assert.ok(
    checked > 50,
    `only ${checked} documents found - the scan is wrong`,
  );
  assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
});
