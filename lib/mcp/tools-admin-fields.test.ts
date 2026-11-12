import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeInfo, parse, visit, visitWithTypeInfo } from "graphql";

import { schema } from "../graphql/schema";
import { MCP_TOOLS } from "./tools/catalog";

// A field gated on instanceAdmin fails the whole call, so a tool any token may run must never select one.
const adminOnly = (ext: unknown) => {
  const s = (ext as { pothosOptions?: { authScopes?: unknown } })?.pothosOptions
    ?.authScopes as Record<string, unknown> | undefined;
  return !!s && typeof s === "object" && s.instanceAdmin === true;
};

test("a tool that is not instance-admin selects no instance-admin field", () => {
  const failures: string[] = [];
  for (const t of MCP_TOOLS) {
    if (!t.query || t.requires === "instanceAdmin") continue;
    const info = new TypeInfo(schema);
    visit(
      parse(t.query),
      visitWithTypeInfo(info, {
        Field() {
          const def = info.getFieldDef();
          const parent = info.getParentType();
          if (def && adminOnly(def.extensions))
            failures.push(`${t.name}: ${parent?.name}.${def.name}`);
        },
      }),
    );
  }
  assert.deepEqual(failures, []);
});
