import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSchema, parse, validate, type GraphQLSchema } from "graphql";

import { MCP_TOOLS } from "./tools";
import { CAPABILITY_META } from "../capabilities";
import { ALL_CAPABILITIES } from "../types";

/**
 * The load-bearing test for the MCP server.
 *
 * A tool is a GraphQL document written by hand, so the failure mode is drift: a
 * field gets renamed, an argument becomes required, and the tool keeps existing
 * while answering "Cannot query field" to every model that calls it. That is
 * exactly what happened to `docs/reference/api.md`, which still documented four
 * fields that no longer existed.
 *
 * Validating every document against the generated SDL closes it: rename a field
 * anywhere in `lib/graphql/types/*`, regenerate `schema.graphql`, and this test
 * names the tools that stopped working.
 */

let cached: GraphQLSchema | undefined;
function sdl(): GraphQLSchema {
  cached ??= buildSchema(readFileSync("schema.graphql", "utf8"));
  return cached;
}

test("every tool's GraphQL document is valid against the schema", () => {
  const failures: string[] = [];
  for (const t of MCP_TOOLS) {
    if (!t.query) continue;
    try {
      const errors = validate(sdl(), parse(t.query));
      for (const e of errors) failures.push(`${t.name}: ${e.message}`);
    } catch (e) {
      failures.push(`${t.name}: ${(e as Error).message}`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
});

test("a tool either runs a document or has its own runner, never both or neither", () => {
  for (const t of MCP_TOOLS)
    assert.ok(
      Boolean(t.query) !== Boolean(t.run),
      `${t.name} must have exactly one of query / run`,
    );
});

test("tool names are unique, snake_case, and unprefixed", () => {
  const seen = new Set<string>();
  for (const t of MCP_TOOLS) {
    assert.ok(!seen.has(t.name), `duplicate tool name ${t.name}`);
    seen.add(t.name);
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name} is not snake_case`);
    // Clients already namespace by server name; a `deplo_` prefix would read as
    // `mcp__deplo__deplo_list_apps` in the model's tool list.
    assert.ok(
      !t.name.startsWith("deplo_"),
      `${t.name} is redundantly prefixed`,
    );
  }
});

/**
 * Rule 1 of `lib/mcp/tools.ts`, enforced rather than trusted. A secret that
 * reaches a model's context window has left deplo for a third party's logs and
 * cannot be revoked from there, so no capability may unlock one over MCP.
 */
test("no tool can reveal a secret", () => {
  for (const t of MCP_TOOLS) {
    assert.doesNotMatch(
      t.name,
      /reveal|secret_value|plaintext/i,
      `${t.name} looks like a secret-reveal tool`,
    );
    assert.doesNotMatch(
      t.query,
      /\breveal[A-Z]/,
      `${t.name} calls a reveal* mutation`,
    );
  }
});

/** Console exec is RCE by another name — the token preset's own words. */
test("no tool runs an arbitrary command in a container", () => {
  for (const t of MCP_TOOLS)
    assert.doesNotMatch(
      t.query,
      /\bexec(Console|DatabaseConsole)\b/,
      `${t.name} exposes container exec`,
    );
});

test("every `requires` is a real capability, or instanceAdmin", () => {
  for (const t of MCP_TOOLS) {
    if (t.requires === null || t.requires === "instanceAdmin") continue;
    assert.ok(
      (ALL_CAPABILITIES as string[]).includes(t.requires),
      `${t.name} requires unknown capability ${t.requires}`,
    );
    assert.ok(
      CAPABILITY_META[t.requires],
      `${t.name} requires ${t.requires}, which has no catalogue entry`,
    );
  }
});

test("nothing is both read-only and destructive", () => {
  for (const t of MCP_TOOLS)
    assert.ok(
      !(t.destructive && t.readOnly),
      `${t.name} cannot be both read-only and destructive`,
    );
});

test("a paginated tool accepts limit and offset", () => {
  for (const t of MCP_TOOLS) {
    if (!t.paginate) continue;
    const shape = t.input.shape;
    assert.ok(shape.limit, `${t.name} paginates but takes no limit`);
    assert.ok(shape.offset, `${t.name} paginates but takes no offset`);
  }
});

test("every tool is described well enough to choose between", () => {
  for (const t of MCP_TOOLS) {
    assert.ok(t.title.length > 2, `${t.name} has no title`);
    // A one-word description is how a model picks the wrong tool.
    assert.ok(
      t.description.length > 30,
      `${t.name}'s description is too thin to choose by: ${t.description}`,
    );
    assert.ok(t.group.length > 0, `${t.name} has no group`);
  }
});
