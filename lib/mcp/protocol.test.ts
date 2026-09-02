import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";

import { buildMcpServer, type McpPrincipal } from "./server";
import { MCP_TOOLS } from "./tools";
import type { Capability } from "../types";

/**
 * Drives the real SDK over a real HTTP request, so the wiring is tested rather
 * than assumed. No database: `tools/list` never reaches a resolver, so a principal
 * is just a capability set here.
 */

/**
 * The revision Deplo targets, spelled out rather than taken from the SDK's
 * `LATEST_PROTOCOL_VERSION`, which still names the PREVIOUS revision
 * (`2025-11-25`), because "latest" there means "latest of the two eras this build
 */
const PROTOCOL = "2026-07-28";

function principal(
  capabilities: Capability[],
  instanceAdmin = false,
  multiTeam = false,
): McpPrincipal {
  return {
    // Never called here: this file drives the SDK with a hand-built principal
    // and no request behind it. The team argument's own behaviour is covered in
    // lib/mcp/route.test.ts, against a real connection.
    forTeam: () =>
      Promise.reject(new Error("no team switching in this fixture")),
    gql: {
      viewer: null,
      teamId: "team_a",
      capabilities,
      via: "token",
      identity: null,
    },
    settings: { enabled: true },
    capabilities: new Set(capabilities),
    instanceAdmin,
    multiTeam,
  };
}

const handler = createMcpHandler((ctx) =>
  buildMcpServer(ctx.authInfo!.extra!.principal as McpPrincipal),
);

async function rpc(
  method: string,
  who: McpPrincipal,
  params = {},
  // Most agents can prompt their user; the tests that matter cover both.
  clientCapabilities: Record<string, unknown> = { elicitation: { form: {} } },
) {
  const body = {
    jsonrpc: "2.0" as const,
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: PROTOCOL,
        [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities,
      },
    },
  };
  const res = await handler.fetch(
    new Request("https://deplo.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // Both are REQUIRED on a 2026-07-28 POST (SEP-2243): they exist so a
        // gateway can route and meter without parsing the body, and the SDK
        // rejects a mismatch with `-32020` rather than guessing.
        "mcp-method": method,
        ...((params as { name?: string }).name
          ? { "mcp-name": (params as { name: string }).name }
          : {}),
      },
      body: JSON.stringify(body),
    }),
    {
      authInfo: {
        token: "deplo_test",
        clientId: "tok_test",
        scopes: [],
        extra: { principal: who },
      },
    },
  );
  const text = await res.text();
  // The handler may answer as a single JSON body or as one SSE frame; both
  // carry the same JSON-RPC message.
  const json = text.startsWith("data:")
    ? JSON.parse(text.slice(text.indexOf("data:") + 5).split("\n")[0])
    : JSON.parse(text);
  return { status: res.status, json };
}

const ALL: Capability[] = [
  ...new Set(
    MCP_TOOLS.map((t) => t.requires).filter(
      (r): r is Capability => r !== null && r !== "instanceAdmin",
    ),
  ),
];

test("discovery carries the instructions, with the link to the manual", async () => {
  const { json } = await rpc("server/discover", principal(["view"]));
  const instructions = json.result.instructions as string;
  assert.match(instructions, /https:\/\/deplo\.build\/docs/);
  assert.match(instructions, /App: the deployable unit/);
});

test("tools/list answers, and every tool survives JSON Schema conversion", async () => {
  const { status, json } = await rpc("tools/list", principal(ALL, true));
  assert.equal(status, 200, JSON.stringify(json));
  assert.ok(!json.error, `tools/list failed: ${JSON.stringify(json.error)}`);

  const tools = json.result.tools as { name: string; inputSchema?: unknown }[];
  assert.equal(
    tools.length,
    MCP_TOOLS.length,
    "a principal holding everything must see every tool",
  );
  for (const t of tools)
    assert.ok(t.inputSchema, `${t.name} advertised no input schema`);
});

test("the tool list is filtered to what the token can call", async () => {
  const { json } = await rpc("tools/list", principal(["view"]));
  const names = (json.result.tools as { name: string }[]).map((t) => t.name);

  assert.ok(names.includes("list_apps"), "view must reach the read tools");
  assert.ok(names.includes("whoami"), "whoami needs no capability at all");
  assert.ok(
    !names.includes("delete_app"),
    "a token without delete_apps must not even see delete_app",
  );
  assert.ok(
    !names.includes("update_server_agent"),
    "instance-admin tools stay hidden from a non-admin token",
  );
  assert.ok(
    names.length < MCP_TOOLS.length,
    "the filter must actually remove something",
  );
});

test("instance-admin tools appear only for an instance-admin token", async () => {
  const withoutAdmin = await rpc("tools/list", principal(ALL, false));
  const withAdmin = await rpc("tools/list", principal(ALL, true));
  const names = (r: { json: { result: { tools: { name: string }[] } } }) =>
    r.json.result.tools.map((t) => t.name);

  assert.ok(!names(withoutAdmin).includes("restart_server_traefik"));
  assert.ok(names(withAdmin).includes("restart_server_traefik"));
});

test("a destructive tool runs straight away, with no confirmation step", () => {
  // Deplo adds no gate of its own: what an agent may do is the token's Capabilities
  // and nothing on top.
  return rpc("tools/call", principal(ALL, true), {
    name: "delete_app",
    arguments: { appId: "prj_whatever" },
  }).then(({ json }) => {
    assert.notEqual(
      json.result?.resultType,
      "input_required",
      "Deplo must not ask for input of its own",
    );
    assert.equal(json.result?.isError, true);
  });
});

test("a client that cannot prompt is served exactly like one that can", async () => {
  // The old behaviour refused here, because Deplo owned the confirmation.
  const withPrompt = await rpc("tools/call", principal(ALL, true), {
    name: "delete_app",
    arguments: { appId: "prj_whatever" },
  });
  const withoutPrompt = await rpc(
    "tools/call",
    principal(ALL, true),
    { name: "delete_app", arguments: { appId: "prj_whatever" } },
    {},
  );
  assert.equal(
    withPrompt.json.result?.isError,
    withoutPrompt.json.result?.isError,
  );
  assert.notEqual(withoutPrompt.json.result?.resultType, "input_required");
});

test("every destructive tool advertises destructiveHint so the client can ask", async () => {
  const { json } = await rpc("tools/list", principal(ALL, true));
  const byName = new Map(
    (
      json.result.tools as {
        name: string;
        annotations?: Record<string, unknown>;
      }[]
    ).map((t) => [t.name, t.annotations ?? {}]),
  );
  for (const t of MCP_TOOLS.filter((t) => t.destructive))
    assert.equal(
      byName.get(t.name)?.destructiveHint,
      true,
      `${t.name} is destructive but does not say so in tools/list`,
    );
});
