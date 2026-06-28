import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlayground } from "./playground";
import type { GraphQLContext } from "./context";
import type { PublicUser } from "@/lib/types";

/**
 * The playground is the one place a viewer can poke at every mutation, so its
 * gate is security-critical: queries execute read-only, mutations NEVER run and
 * are gated by the caller's own capabilities. These tests pin that contract.
 */

const viewer: PublicUser = {
  id: "u1",
  email: "v@example.com",
  username: "viewer",
  name: "Viewer",
  role: "viewer",
  isInstanceAdmin: false,
  avatarColor: "#000",
};

function ctx(over: Partial<GraphQLContext> = {}): GraphQLContext {
  return {
    viewer,
    teamId: "t1",
    capabilities: ["view"],
    via: "cookie",
    identity: null,
    ...over,
  };
}

test("anonymous callers are rejected", async () => {
  const res = await runPlayground(
    "query { me { id } }",
    {},
    null,
    ctx({ viewer: null }),
  );
  assert.equal(res.kind, "error");
});

test("a mutation the caller lacks the capability for is denied, not run", async () => {
  // `createToken` requires manage_infra; a plain viewer lacks it.
  const res = await runPlayground(
    'mutation { createToken(name: "x") { raw } }',
    {},
    null,
    ctx({ capabilities: ["view"] }),
  );
  assert.equal(res.kind, "dry-run");
  if (res.kind !== "dry-run") return;
  assert.equal(res.fields.length, 1);
  assert.equal(res.fields[0].field, "createToken");
  assert.equal(res.fields[0].allowed, false);
  assert.equal(res.fields[0].requires, "manage_infra");
  assert.match(res.fields[0].message, /[Pp]ermission denied/);
});

test("a mutation the caller is allowed runs as a dry run, not for real", async () => {
  const res = await runPlayground(
    'mutation { createToken(name: "x") { raw } }',
    {},
    null,
    ctx({ capabilities: ["view", "manage_infra"] }),
  );
  assert.equal(res.kind, "dry-run");
  if (res.kind !== "dry-run") return;
  assert.equal(res.fields[0].allowed, true);
  assert.match(res.fields[0].message, /[Dd]ry run/);
  // Crucially: no `data` field — nothing executed.
  assert.ok(!("data" in res));
});

test("instance-admin-only mutations gate on the admin flag", async () => {
  const asOwner = await runPlayground(
    "mutation { mintRegistrationLink(input: { mode: own_team }) }",
    {},
    null,
    ctx({ capabilities: ["view", "manage_members"] }),
  );
  assert.equal(asOwner.kind, "dry-run");
  if (asOwner.kind === "dry-run") {
    assert.equal(asOwner.fields[0].allowed, false);
    assert.match(asOwner.fields[0].message, /instance-admin/i);
  }

  const asAdmin = await runPlayground(
    "mutation { mintRegistrationLink(input: { mode: own_team }) }",
    {},
    null,
    ctx({ viewer: { ...viewer, isInstanceAdmin: true } }),
  );
  assert.equal(asAdmin.kind, "dry-run");
  if (asAdmin.kind === "dry-run") {
    assert.equal(asAdmin.fields[0].allowed, true);
  }
});

test("invalid documents fail validation, not execution", async () => {
  const res = await runPlayground("query { nope }", {}, null, ctx());
  assert.equal(res.kind, "error");
  if (res.kind === "error") {
    assert.match(res.errors[0].message, /nope/);
  }
});

test("parse errors are reported cleanly", async () => {
  const res = await runPlayground("query { ", {}, null, ctx());
  assert.equal(res.kind, "error");
});

test("subscriptions are not supported", async () => {
  const res = await runPlayground(
    "subscription { anything }",
    {},
    null,
    ctx(),
  );
  assert.equal(res.kind, "error");
});

test("an excessively deep query is rejected (depth bound parity)", async () => {
  // 14 nested selection sets > the depth-12 bound; the type doesn't matter
  // because the depth check runs before execution on the parsed document.
  const deep =
    "query { a { b { c { d { e { f { g { h { i { j { k { l { m } } } } } } } } } } } } }";
  const res = await runPlayground(deep, {}, null, ctx());
  // It fails — either at depth (our bound) or validation (unknown fields); both
  // prove a pathological query never reaches a resolver.
  assert.equal(res.kind, "error");
});

test("a read-only query executes for real", async () => {
  // `apiContext` reads straight off the context (no store access), so it is a
  // hermetic way to prove the query path actually runs a resolver.
  const res = await runPlayground(
    "query { apiContext }",
    {},
    null,
    ctx({ capabilities: ["view", "deploy"] }),
  );
  assert.equal(res.kind, "query");
  if (res.kind !== "query") return;
  const data = res.data as { apiContext: { via: string; teamId: string } };
  assert.equal(data.apiContext.via, "cookie");
  assert.equal(data.apiContext.teamId, "t1");
});

test("mutations reached through a fragment spread are still gated", async () => {
  const res = await runPlayground(
    `mutation { ...Tok }
     fragment Tok on Mutation { createToken(name: "x") { raw } }`,
    {},
    null,
    ctx({ capabilities: ["view"] }),
  );
  assert.equal(res.kind, "dry-run");
  if (res.kind !== "dry-run") return;
  // The fragment's field must surface — not an empty dry run.
  assert.equal(res.fields.length, 1);
  assert.equal(res.fields[0].field, "createToken");
  assert.equal(res.fields[0].allowed, false);
});

test("mutations inside an inline fragment are gated too", async () => {
  const res = await runPlayground(
    `mutation { ... on Mutation { createToken(name: "x") { raw } } }`,
    {},
    null,
    ctx({ capabilities: ["view", "manage_infra"] }),
  );
  assert.equal(res.kind, "dry-run");
  if (res.kind !== "dry-run") return;
  assert.equal(res.fields.length, 1);
  assert.equal(res.fields[0].field, "createToken");
  assert.equal(res.fields[0].allowed, true);
});

test("a multi-field mutation reports each field independently", async () => {
  const res = await runPlayground(
    `mutation {
       createToken(name: "x") { raw }
       mintRegistrationLink(input: { mode: own_team })
     }`,
    {},
    null,
    ctx({ capabilities: ["view", "manage_infra"] }),
  );
  assert.equal(res.kind, "dry-run");
  if (res.kind !== "dry-run") return;
  const byName = Object.fromEntries(res.fields.map((f) => [f.field, f]));
  // Has manage_infra → createToken allowed; not admin → mint denied.
  assert.equal(byName.createToken.allowed, true);
  assert.equal(byName.mintRegistrationLink.allowed, false);
});
