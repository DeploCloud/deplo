import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildSchema,
  getNamedType,
  isObjectType,
  parse,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from "graphql";

/**
 * A query that names a team or a person asks for its picture too: the hand-written
 * response type says `avatarUrl` either way, so a missing field is silent - the
 * avatar just falls back to initials.
 */
const DOC = /`([^`]*)`/g;

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("a document that selects a name selects the picture with it", () => {
  const schema = buildSchema(readFileSync("schema.graphql", "utf8"));
  const offenders: string[] = [];
  for (const file of [...walk("app"), ...walk("components")]) {
    if (file.includes(".test.")) continue;
    for (const [, body] of readFileSync(file, "utf8").matchAll(DOC)) {
      if (!/^\s*(query|mutation|subscription)\b/.test(body)) continue;
      if (body.includes("${")) continue;
      let doc;
      try {
        doc = parse(body);
      } catch {
        continue;
      }
      const info = new TypeInfo(schema);
      visit(
        doc,
        visitWithTypeInfo(info, {
          SelectionSet(node) {
            const type = getNamedType(info.getParentType()!);
            if (!isObjectType(type) || !type.getFields().avatarUrl) return;
            const picked = node.selections.flatMap((s) =>
              s.kind === "Field" ? [s.name.value] : [],
            );
            if (picked.includes("name") && !picked.includes("avatarUrl"))
              offenders.push(`${file}: ${type.name} { ${picked.join(" ")} }`);
          },
        }),
      );
    }
  }
  assert.deepEqual(offenders, []);
});
