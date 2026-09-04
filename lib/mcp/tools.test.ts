import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSchema,
  execute,
  parse,
  validate,
  type GraphQLSchema,
} from "graphql";

import { MCP_TOOLS } from "./tools";
import { CAPABILITY_META } from "../capabilities";
import { ALL_CAPABILITIES } from "../types";

/**
 * The load-bearing test for the MCP server.
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
 * reaches a model's context window has left Deplo for a third party's logs and
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

/** Console exec is RCE by another name - the token preset's own words. */
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

/**
 * A conditional document whose branches are all off returns `{}` with NO error,
 * which `runGraphql` reports as success and a model reads as "done". So a merged
 * tool has to refuse the combination itself, before the document runs.
 */
test("a merged tool maps its own arguments", () => {
  for (const t of MCP_TOOLS) {
    if (!/@include|@skip/.test(t.query)) continue;
    assert.ok(
      t.variables,
      `${t.name} branches on a directive but has no variables mapper, so nothing computes its flags`,
    );
  }
});

test("an argument combination that lights no branch is refused", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["run_backup", { kind: "app", id: "prj_1" }, /destinationId/],
    [
      "move_app",
      { appId: "prj_1", folderId: "f", projectId: "p" },
      /not several/,
    ],
    ["list_repos", { repo: "acme/site" }, /exactly one/],
    ["list_repos", { installationId: "i", connectionId: "c" }, /exactly one/],
    ["set_backup_schedule", { name: "nightly" }, /needs name, destinationId/],
    ["set_basic_auth_user", { password: "x" }, /needs appId and username/],
  ];
  for (const [name, args, expected] of cases) {
    const tool = MCP_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} is gone - stale case`);
    assert.throws(
      () => tool.variables!(args as never),
      expected,
      `${name} accepted ${JSON.stringify(args)}`,
    );
  }
});

/**
 * The list is read whole, by a model, on every connection. 220 is above the
 * longest one written so far, so this only stops it creeping up a row at a time.
 */
test("a description stays short enough to read them all", () => {
  for (const t of MCP_TOOLS)
    assert.ok(
      t.description.length <= 220,
      `${t.name}'s description is ${t.description.length} characters: ${t.description}`,
    );
});

test("the escape hatch is present and honestly flagged", () => {
  const q = MCP_TOOLS.find((t) => t.name === "graphql_query");
  const m = MCP_TOOLS.find((t) => t.name === "graphql_mutate");
  assert.ok(q && m, "both passthrough tools must exist");
  assert.equal(q.readOnly, true);
  assert.ok(!q.destructive);
  // One tool for every write there is, so the client has to ask before each.
  assert.equal(m.destructive, true);
  assert.ok(!m.readOnly);
});

/**
 * Variable coercion runs over EVERY declared variable, `@include` or not. So the
 * branch that is switched off still has to be handed values its types accept -
 * a placeholder of `undefined` for a non-null input object fails the whole call
 * with a message about a field the caller never mentioned.
 */
test("every branch of a merged tool coerces its variables", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["metrics", { kind: "app", id: "prj_1" }],
    ["metrics", { kind: "database", id: "db_1" }],
    ["metrics", { kind: "server", id: "srv_1" }],
    ["control_app", { appId: "prj_1", action: "start" }],
    ["control_app", { appId: "prj_1", action: "reload" }],
    ["control_database", { id: "db_1", action: "start" }],
    ["control_database", { id: "db_1", action: "stop" }],
    ["control_database", { id: "db_1", action: "restart" }],
    ["run_backup", { kind: "app", id: "prj_1", destinationId: "dst_1" }],
    ["run_backup", { kind: "database", id: "db_1", destinationId: "dst_1" }],
    ["run_backup", { kind: "schedule", id: "bk_1" }],
    ["move_app", { appId: "prj_1" }],
    ["move_app", { appId: "prj_1", folderId: "fld_1" }],
    ["move_app", { appId: "prj_1", projectId: "prc_1" }],
    ["move_app", { appId: "prj_1", environmentId: "environ_1" }],
    ["list_cron_jobs", { id: "prj_1" }],
    ["list_cron_jobs", { id: "db_1", kind: "database" }],
    [
      "create_cron_job",
      {
        id: "db_1",
        kind: "database",
        name: "n",
        command: "c",
        schedule: "0 3 * * *",
      },
    ],
    ["list_repos", { installationId: "i" }],
    ["list_repos", { installationId: "i", repo: "acme/site" }],
    ["list_repos", { connectionId: "c" }],
    ["list_repos", { connectionId: "c", repo: "acme/site" }],
    [
      "set_backup_schedule",
      {
        name: "n",
        appId: "prj_1",
        destinationId: "dst_1",
        schedule: "0 3 * * *",
      },
    ],
    [
      "set_backup_schedule",
      { id: "bk_1", name: "n", destinationId: "dst_1", schedule: "0 3 * * *" },
    ],
    ["set_backup_schedule", { id: "bk_1", enabled: false }],
    ["set_basic_auth_user", { appId: "prj_1", username: "u", password: "p" }],
    ["set_basic_auth_user", { id: "bau_1", password: "p" }],
    ["update_project", { id: "prc_1", name: "n" }],
    ["update_project", { id: "prc_1", color: null }],
    ["update_environment", { id: "environ_1", name: "n" }],
    ["update_environment", { id: "environ_1", makeDefault: true }],
    ["update_environment", { id: "environ_1", branch: "main" }],
    ["update_folder", { id: "fld_1", name: "n" }],
    ["update_folder", { id: "fld_1", parentId: null }],
    ["update_folder", { id: "fld_1", color: "#fff" }],
    ["set_folder_grant", { folderId: "fld_1", userId: "u", capabilities: [] }],
    [
      "set_folder_grant",
      { folderId: "fld_1", userId: "u", capabilities: ["view"] },
    ],
    ["get_app_runtime", { id: "prj_1" }],
    ["get_app_runtime", { id: "db_1", kind: "database" }],
    ["delete_deployments", { ids: ["dep_1"] }],
    ["delete_deployments", { appId: "prj_1" }],
    ["metrics_history", { kind: "app", id: "prj_1" }],
    ["metrics_history", { kind: "database", id: "db_1" }],
    ["metrics_history", { kind: "server", id: "srv_1" }],
    ["set_preview_env_var", { appId: "prj_1", key: "K", value: "v" }],
    ["set_preview_env_var", { appId: "prj_1", key: "K" }],
    ["update_server", { serverId: "srv_1", address: "1.2.3.4" }],
    ["update_server", { serverId: "srv_1", role: "worker" }],
    ["update_server", { serverId: "srv_1", allTeams: true }],
    ["update_server", { serverId: "srv_1", deployConcurrency: 2 }],
    ["update_server", { serverId: "srv_1", timezone: "Europe/Rome" }],
    ["update_server", { serverId: "srv_1", buildFallback: true }],
  ];

  // Executed against the SDL, which carries no resolvers: fields answer null and
  // the only errors that can surface are the coercion ones this is looking for.
  for (const [name, args] of cases) {
    const t = MCP_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} is gone - stale case`);
    const result = await execute({
      schema: sdl(),
      document: parse(t.query),
      variableValues: t.variables!(args as never),
      contextValue: {},
    });
    const coercion = (result.errors ?? []).filter((e) =>
      /got invalid value|was not provided|cannot represent/i.test(e.message),
    );
    assert.deepEqual(
      coercion.map((e) => e.message),
      [],
      `${name} with ${JSON.stringify(args)}`,
    );
  }
});

test("every merged tool is covered by the coercion table above", () => {
  // So a new merge cannot be added without a case, which is how the last one
  // shipped a branch that could not coerce.
  const merged = MCP_TOOLS.filter((t) => /@include|@skip/.test(t.query)).map(
    (t) => t.name,
  );
  const covered = new Set(
    readFileSync("lib/mcp/tools.test.ts", "utf8")
      .split("const cases: [string, Record<string, unknown>][] = [")[1]
      .split("];")[0]
      .matchAll(/\["(\w+)",/g),
  );
  const names = new Set([...covered].map((m) => m[1]));
  for (const name of merged)
    assert.ok(names.has(name), `${name} branches but has no coercion case`);
});
