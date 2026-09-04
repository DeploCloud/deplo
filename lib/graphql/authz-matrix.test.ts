import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import {
  graphql,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  subscribe,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";

import { makeTestDb, truncateAll, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { schema } from "./schema";
import { buildContext, type GraphQLContext } from "./context";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { PROJECT_SCOPED_CAPABILITIES } from "../membership-shared";
import { createToken } from "../data/tokens";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * The API-surface authorization matrix: EVERY field of the public GraphQL API,
 * against EVERY capability, over both principals that can call it - a member
 * acting through the dashboard's session and an API token acting on its own.
 */

let db: TestDb;
let pg: PGlite;

const USER_M = "user_matrix";
const MEMBERSHIP_M = `mem_${USER_M}`;
const T0 = "2026-01-01T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/**
 * A fresh instance: an owner who is also the instance admin (USER_1, the token
 * minter of last resort) and the matrix subject - a plain member whose
 * capabilities every test rewrites, and who is NOT an instance admin, so an `$any:
 * { instanceAdmin, capability }` field is decided by the capability.
 */
async function reset(caps: Capability[]): Promise<void> {
  await truncateAll(pg);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_M, teamId: TEAM_A, role: "member", capabilities: [] },
    ],
  });
  await setCaps(caps);
}

async function setCaps(caps: Capability[]): Promise<void> {
  await db.delete(membershipCapabilitiesTable);
  const wanted = new Set<Capability>([...caps, "view"]);
  await db.insert(membershipCapabilitiesTable).values(
    ALL_CAPABILITIES.filter((c) => wanted.has(c)).map((capability) => ({
      membershipId: MEMBERSHIP_M,
      capability,
    })),
  );
  // The owner keeps everything: they mint the tokens the token half runs on.
  await db.insert(membershipCapabilitiesTable).values(
    ALL_CAPABILITIES.map((capability) => ({
      membershipId: `mem_${USER_1}`,
      capability,
    })),
  );
}

/* ------------------------------------------------------------------ */
/* The endpoint inventory, read off the built schema                    */
/* ------------------------------------------------------------------ */

type Gate =
  | { kind: "capability"; cap: Capability; orInstanceAdmin: boolean }
  | { kind: "loggedIn" }
  | { kind: "instanceAdmin" }
  | { kind: "none" };

interface Endpoint {
  kind: "query" | "mutation" | "subscription";
  name: string;
  label: string;
  field: GraphQLField<unknown, unknown>;
  gate: Gate;
  doc: string;
}

function gateOf(field: GraphQLField<unknown, unknown>): Gate {
  const scopes = (
    field.extensions as { pothosOptions?: { authScopes?: unknown } }
  )?.pothosOptions?.authScopes;
  if (!scopes || typeof scopes !== "object") return { kind: "none" };
  const s = scopes as Record<string, unknown>;
  const any = s.$any as Record<string, unknown> | undefined;
  const cap = (s.capability ?? any?.capability) as Capability | undefined;
  if (cap)
    return {
      kind: "capability",
      cap,
      orInstanceAdmin: Boolean(any?.instanceAdmin),
    };
  if (s.instanceAdmin || any?.instanceAdmin) return { kind: "instanceAdmin" };
  if (s.loggedIn || any?.loggedIn) return { kind: "loggedIn" };
  return { kind: "none" };
}

/**
 * A literal for one input type. Ids are deliberately unreachable: this drives
 * the gate, and a caller who is refused for holding the wrong permission is
 * refused before an argument is ever read.
 */
function inputLiteral(type: GraphQLInputType, depth = 0): string {
  if (isNonNullType(type)) return inputLiteral(type.ofType, depth);
  if (isListType(type)) return `[${inputLiteral(type.ofType, depth)}]`;
  if (isEnumType(type)) return type.getValues()[0]?.name ?? "null";
  if (isScalarType(type)) {
    switch (type.name) {
      case "Int":
        return "1";
      case "Float":
        return "1.0";
      case "Boolean":
        return "false";
      case "JSON":
        return "{}";
      case "DateTime":
        return `"${T0}"`;
      default:
        return `"zzz_nonexistent"`;
    }
  }
  if (isInputObjectType(type)) {
    if (depth > 3) return "{}"; // a self-referencing input can't recurse forever
    // EVERY field, not only the required ones: a resolver that validates its
    // input before it authorizes would otherwise answer "choose a role" and
    // look, to this matrix, like a gate that let the caller through.
    return `{${Object.values(type.getFields())
      .map((f) => `${f.name}: ${inputLiteral(f.type, depth + 1)}`)
      .join(", ")}}`;
  }
  return "null";
}

function selectionFor(type: GraphQLOutputType): string {
  if (isNonNullType(type) || isListType(type)) return selectionFor(type.ofType);
  return isObjectType(type) || isInterfaceType(type) || isUnionType(type)
    ? " { __typename }"
    : "";
}

function documentFor(
  kind: Endpoint["kind"],
  field: GraphQLField<unknown, unknown>,
): string {
  const args = field.args.length
    ? `(${field.args.map((a) => `${a.name}: ${inputLiteral(a.type)}`).join(", ")})`
    : "";
  return `${kind} { ${field.name}${args}${selectionFor(field.type)} }`;
}

const ENDPOINTS: Endpoint[] = (
  [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
    ["subscription", schema.getSubscriptionType()],
  ] as const
).flatMap(([kind, type]) =>
  type
    ? Object.values(type.getFields()).map((field) => ({
        kind,
        name: field.name,
        label: `${kind === "mutation" ? "M" : kind === "query" ? "Q" : "S"}.${field.name}`,
        field: field as GraphQLField<unknown, unknown>,
        gate: gateOf(field as GraphQLField<unknown, unknown>),
        doc: documentFor(kind, field as GraphQLField<unknown, unknown>),
      }))
    : [],
);

/** Executable here: a subscription needs a live source, and none is gated on a capability. */
const EXECUTABLE = ENDPOINTS.filter((e) => e.kind !== "subscription");
const byCapability = new Map<Capability, Endpoint[]>();
for (const e of EXECUTABLE) {
  if (e.gate.kind === "capability")
    byCapability.set(e.gate.cap, [...(byCapability.get(e.gate.cap) ?? []), e]);
}

/* ------------------------------------------------------------------ */
/* Principals + execution                                              */
/* ------------------------------------------------------------------ */

interface Principal {
  ctx: GraphQLContext;
  identity: RequestIdentity;
}

/** What the dashboard is: a session, no token, nothing clamped. */
async function asMember(userId = USER_M, teamId = TEAM_A): Promise<Principal> {
  const identity: RequestIdentity = { userId, teamId };
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId().catch(() => null),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    }),
  );
  return { ctx, identity };
}

/** What an external client is: the real bearer path, header and all. */
async function asToken(raw: string): Promise<Principal | null> {
  const ctx = await buildContext(
    new Request("http://localhost/api/graphql", {
      headers: { authorization: `Bearer ${raw}` },
    }),
  );
  return ctx.identity ? { ctx, identity: ctx.identity } : null;
}

/** Mint a token owned by `userId` with exactly `caps` (plus the `view` floor). */
async function mintToken(
  caps: Capability[],
  userId = USER_1,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { raw } = await runWithIdentity({ userId, teamId: TEAM_A }, () =>
    createToken({ name: "matrix", capabilities: caps, ...extra }),
  );
  return raw;
}

const REFUSED =
  /not authorized|don't have permission|only an instance admin|not a member|no active team|requires two-factor|limited to specific projects/i;

const EXEC_TIMEOUT_MS = 20_000;

/** Run one endpoint as one principal. A timeout counts as "the gate let it through". */
async function call(p: Principal, e: Endpoint): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), EXEC_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      runWithIdentity(p.identity, () =>
        graphql({ schema, source: e.doc, contextValue: p.ctx }),
      ),
      timeout,
    ]);
    if (result === "timeout") return [];
    const errors = result.errors ?? [];
    // A document that doesn't validate would silently pass every assertion.
    const invalid = errors.filter((err) => !err.path);
    assert.equal(
      invalid.length,
      0,
      `${e.label}: generated document is invalid - ${invalid
        .map((x) => x.message)
        .join("; ")}\n${e.doc}`,
    );
    return errors.map((err) => err.message);
  } finally {
    clearTimeout(timer);
  }
}

const refused = (messages: string[]): boolean =>
  messages.some((m) => REFUSED.test(m));

/**
 * Endpoints that legitimately need MORE than their declared capability - an
 * instance grant, a per-app switch, or a second capability an OPTIONAL argument
 * asks for - listed one by one so "this one takes two gates" is a decision
 * somebody wrote down rather than a hole the matrix stopped noticing.
 */
const NEEDS_INSTANCE_GRANT = new Map<string, RegExp>([
  ["M.generateAvailableDbPort", /permission to publish ports/i],
  ["Q.hostPortsInUse", /permission to publish ports/i],
  ["Q.databaseCronJobs", /database.*console/i],
  ["M.createCronJob", /database.*console/i],
  ["M.setCronEnabled", /database.*console/i],
  // `sharedVarIds` links a team's shared variables to the new app, which is an
  // env act; creating an app without that argument needs only `create_apps`.
  ["M.createApp", /permission to manage environment variables/i],
]);

/** True if the refusal is the documented non-capability one for this endpoint. */
function refusedByGrant(e: Endpoint, messages: string[]): boolean {
  const expected = NEEDS_INSTANCE_GRANT.get(e.label);
  return Boolean(expected && messages.some((m) => expected.test(m)));
}

/* ------------------------------------------------------------------ */
/* 1. Inventory: nothing reaches the API without declaring a gate       */
/* ------------------------------------------------------------------ */

/**
 * The only fields that may answer an anonymous caller. The two passkey ones are
 * public for the same reason `login` is: they ARE a sign-in, so requiring a
 * session would be circular.
 */
const PUBLIC_FIELDS = new Set([
  "Q.me",
  "Q.apiContext",
  "M.login",
  "M.logout",
  "M.completeSetup",
  "M.registerThroughLink",
  "M.verifyTwoFactorLogin",
  "M.passkeyChallenge",
  "M.verifyPasskeyLogin",
]);

test("every field of the API declares a gate, and only the auth surface is public", () => {
  const ungated = ENDPOINTS.filter(
    (e) => e.gate.kind === "none" && !PUBLIC_FIELDS.has(e.label),
  ).map((e) => e.label);
  assert.deepEqual(ungated, [], `ungated fields: ${ungated.join(", ")}`);

  const declaredPublic = ENDPOINTS.filter((e) => e.gate.kind === "none").map(
    (e) => e.label,
  );
  assert.deepEqual(
    [...declaredPublic].sort(),
    [...PUBLIC_FIELDS].sort(),
    "the public surface changed - a new ungated field must be a deliberate one",
  );
});

test("every capability the catalogue offers is either enforced on the API or enforced below it", () => {
  // Not every capability names a field: the folder verbs and `delete_team` are gated
  // inside the data layer instead (their fields are `loggedIn`), and `view` is the
  // floor no field asks for.
  // `manage_tokens` and `manage_mcp` gate no field either: they decide WHERE a
  // member's personal tokens reach (`tokenReach`) and where they may speak MCP
  // (`listMcpTeams`), read by the identity builder and the MCP door.
  const enforcedBelow = new Set<Capability>([
    "view",
    "organize_folders",
    "delete_folders",
    "delete_team",
    "manage_notifications",
    "manage_tokens",
    "manage_mcp",
  ]);
  const orphans = ALL_CAPABILITIES.filter(
    (c) => !byCapability.has(c) && !enforcedBelow.has(c),
  );
  assert.deepEqual(
    orphans,
    [],
    `capabilities no field is gated on: ${orphans.join(", ")}`,
  );
});

/* ------------------------------------------------------------------ */
/* 2. The matrix, per capability, for a member and for a token          */
/* ------------------------------------------------------------------ */

for (const [cap, endpoints] of byCapability) {
  test(`${cap}: a member holding everything else is refused by all ${endpoints.length} of its endpoints`, async () => {
    await reset(ALL_CAPABILITIES.filter((c) => c !== cap));
    const principal = await asMember();
    assert.ok(
      !principal.ctx.capabilities.includes(cap),
      "fixture: the subject must not hold the capability under test",
    );
    const leaks: string[] = [];
    for (const e of endpoints) {
      if (!refused(await call(principal, e))) leaks.push(e.label);
    }
    assert.deepEqual(
      leaks,
      [],
      `reachable without ${cap}: ${leaks.join(", ")}`,
    );
  });

  test(`${cap}: a member holding only it is admitted by all ${endpoints.length} of its endpoints`, async () => {
    await reset([cap]);
    const principal = await asMember();
    const blocked: string[] = [];
    for (const e of endpoints) {
      const messages = await call(principal, e);
      if (refused(messages) && !refusedByGrant(e, messages))
        blocked.push(`${e.label} (${messages.join("; ")})`);
    }
    assert.deepEqual(
      blocked,
      [],
      `${cap} is not enough for its own endpoints: ${blocked.join(", ")}`,
    );
  });

  test(`${cap}: an API token granted everything else is refused by all ${endpoints.length} of its endpoints`, async () => {
    await reset(ALL_CAPABILITIES);
    const raw = await mintToken(
      ALL_CAPABILITIES.filter((c) => c !== cap),
      USER_M,
    );
    const principal = await asToken(raw);
    assert.ok(principal, "the token must authenticate");
    assert.ok(
      !principal.ctx.capabilities.includes(cap),
      `fixture: the token must not hold ${cap}`,
    );
    const leaks: string[] = [];
    for (const e of endpoints) {
      if (!refused(await call(principal, e))) leaks.push(e.label);
    }
    assert.deepEqual(
      leaks,
      [],
      `a token without ${cap} reached: ${leaks.join(", ")}`,
    );
  });

  test(`${cap}: an API token granted only it is admitted by all ${endpoints.length} of its endpoints`, async () => {
    await reset(ALL_CAPABILITIES);
    const raw = await mintToken([cap], USER_M);
    const principal = await asToken(raw);
    assert.ok(principal, "the token must authenticate");
    const blocked: string[] = [];
    for (const e of endpoints) {
      const messages = await call(principal, e);
      if (refused(messages) && !refusedByGrant(e, messages))
        blocked.push(`${e.label} (${messages.join("; ")})`);
    }
    assert.deepEqual(
      blocked,
      [],
      `a token holding ${cap} was refused: ${blocked.join(", ")}`,
    );
  });
}

/* ------------------------------------------------------------------ */
/* 3. The instance-admin surface                                        */
/* ------------------------------------------------------------------ */

const ADMIN_ENDPOINTS = EXECUTABLE.filter(
  (e) => e.gate.kind === "instanceAdmin",
);

test(`a member holding all ${ALL_CAPABILITIES.length} capabilities reaches none of the ${ADMIN_ENDPOINTS.length} instance-admin endpoints`, async () => {
  await reset(ALL_CAPABILITIES);
  const principal = await asMember();
  const leaks: string[] = [];
  for (const e of ADMIN_ENDPOINTS) {
    if (!refused(await call(principal, e))) leaks.push(e.label);
  }
  assert.deepEqual(leaks, [], `team capabilities reached: ${leaks.join(", ")}`);
});

test("an instance admin's token administers the instance only when it was granted that", async () => {
  await reset(ALL_CAPABILITIES);
  // Minted by the instance admin, holding every team capability - but not the
  // instance-admin switch, which is opt-in per token.
  const raw = await mintToken(ALL_CAPABILITIES, USER_1);
  const principal = await asToken(raw);
  assert.ok(principal, "the token must authenticate");
  assert.equal(
    principal.ctx.viewer?.isInstanceAdmin,
    true,
    "fixture: the PERSON behind the token really is an admin, so the refusal has to come from the token's own switch",
  );
  const leaks: string[] = [];
  for (const e of ADMIN_ENDPOINTS) {
    if (!refused(await call(principal, e))) leaks.push(e.label);
  }
  assert.deepEqual(
    leaks,
    [],
    `a token that was never given instance administration reached: ${leaks.join(", ")}`,
  );
});

/**
 * The same question for the SUBSCRIPTIONS, which {@link EXECUTABLE} leaves out. A
 * subscription's whole body is a generator, so it never reaches the data layer's
 * `requireInstanceAdmin` - the field scope is the only gate it has.
 */
const ADMIN_SUBSCRIPTIONS = ENDPOINTS.filter(
  (e) => e.kind === "subscription" && e.gate.kind === "instanceAdmin",
);

/**
 * Open one subscription as one principal and pull its FIRST event.
 */
async function open(p: Principal, e: Endpoint): Promise<string[]> {
  const result = await runWithIdentity(p.identity, () =>
    subscribe({ schema, document: parse(e.doc), contextValue: p.ctx }),
  );
  if (!(Symbol.asyncIterator in result))
    return (result.errors ?? []).map((err) => err.message);
  const it = result as AsyncGenerator<{
    errors?: readonly { message: string }[];
  }>;
  try {
    const first = await runWithIdentity(p.identity, () => it.next());
    return (first.value?.errors ?? []).map(
      (err: { message: string }) => err.message,
    );
  } finally {
    // Close it so the pubSub listener doesn't outlive the test.
    await it.return?.(undefined as never);
  }
}

test(`an instance admin's token can't open the ${ADMIN_SUBSCRIPTIONS.length} admin subscriptions either`, async () => {
  assert.ok(ADMIN_SUBSCRIPTIONS.length > 0, "fixture: there is one to test");
  await reset(ALL_CAPABILITIES);

  const plain = await asToken(await mintToken(ALL_CAPABILITIES, USER_1));
  assert.ok(plain, "the token must authenticate");
  const leaks: string[] = [];
  for (const e of ADMIN_SUBSCRIPTIONS) {
    if (!refused(await open(plain, e))) leaks.push(e.label);
  }
  assert.deepEqual(
    leaks,
    [],
    `a token that was never given instance administration opened: ${leaks.join(", ")}`,
  );

  // The control: with the switch ON, the very same stream opens - the gate is
  // the token's grant, not a subscription nobody can ever reach.
  const admin = await asToken(
    await mintToken(ALL_CAPABILITIES, USER_1, { instanceAdmin: true }),
  );
  assert.ok(admin, "the admin token must authenticate");
  for (const e of ADMIN_SUBSCRIPTIONS) {
    assert.deepEqual(
      await open(admin, e),
      [],
      `${e.label} refused a token that WAS given instance administration`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 4. A token is never more than its creator                            */
/* ------------------------------------------------------------------ */

test("a token granted everything can do nothing its creator has since lost", async () => {
  await reset(ALL_CAPABILITIES);
  const raw = await mintToken(ALL_CAPABILITIES, USER_M);
  // The creator is cut back AFTER the token was minted: nothing is
  // materialised, so the clamp has to bite on the next request. `manage_tokens`
  // stays, or the token would not reach the team at all (tested below).
  await setCaps(["manage_tokens"]);
  const principal = await asToken(raw);
  assert.ok(
    principal,
    "the token still authenticates - it is the reach that narrows",
  );
  assert.deepEqual(
    principal.ctx.capabilities,
    ["view", "manage_tokens"],
    "the token is clamped to what its creator can still do",
  );
  const leaks: string[] = [];
  for (const [cap, endpoints] of byCapability) {
    for (const e of endpoints) {
      if (!refused(await call(principal, e))) leaks.push(`${e.label} (${cap})`);
    }
  }
  assert.deepEqual(
    leaks,
    [],
    `reachable after the creator lost everything: ${leaks.join(", ")}`,
  );
  // And without `manage_tokens` the token no longer reaches the team at all.
  await setCaps([]);
  assert.equal(await asToken(raw), null, "the token must stop resolving");
});

/* ------------------------------------------------------------------ */
/* 5. Depth strips: a narrowed token loses every team-wide capability   */
/* ------------------------------------------------------------------ */

test("a token narrowed to one project loses every capability that has no per-project meaning", async () => {
  await reset(ALL_CAPABILITIES);
  await db.insert(projectsTable).values({
    id: "prc_scoped",
    teamId: TEAM_A,
    name: "scoped",
    slug: "scoped",
    createdAt: T0,
    updatedAt: T0,
  });
  const raw = await mintToken(ALL_CAPABILITIES, USER_M, {
    projectIds: ["prc_scoped"],
  });
  const principal = await asToken(raw);
  assert.ok(principal, "the token must authenticate");

  const teamWide = ALL_CAPABILITIES.filter(
    (c) => !PROJECT_SCOPED_CAPABILITIES.includes(c),
  );
  assert.deepEqual(
    principal.ctx.capabilities.filter((c) => teamWide.includes(c)),
    [],
    "a scoped token must hold none of the team-wide capabilities",
  );
  const leaks: string[] = [];
  for (const cap of teamWide) {
    for (const e of byCapability.get(cap) ?? []) {
      if (!refused(await call(principal, e))) leaks.push(`${e.label} (${cap})`);
    }
  }
  assert.deepEqual(
    leaks,
    [],
    `a project-scoped token reached: ${leaks.join(", ")}`,
  );
});

/* ------------------------------------------------------------------ */
/* 6. No credential at all                                              */
/* ------------------------------------------------------------------ */

test(`an anonymous caller is refused by all ${EXECUTABLE.length - PUBLIC_FIELDS.size} non-public fields`, async () => {
  await reset(ALL_CAPABILITIES);
  const principal: Principal = {
    // No identity to run under: this is a request that arrived with nothing.
    identity: { userId: "", teamId: "" },
    ctx: {
      viewer: null,
      teamId: null,
      capabilities: [],
      via: "anonymous",
      identity: null,
    },
  };
  const leaks: string[] = [];
  for (const e of EXECUTABLE) {
    if (PUBLIC_FIELDS.has(e.label)) continue;
    if (!refused(await call(principal, e))) leaks.push(e.label);
  }
  assert.deepEqual(
    leaks,
    [],
    `answered an anonymous caller: ${leaks.join(", ")}`,
  );
});

test("a rejected bearer token is anonymous, not the member it names", async () => {
  await reset(ALL_CAPABILITIES);
  const raw = await mintToken(ALL_CAPABILITIES, USER_M);
  for (const bad of [
    "deplo_totally_made_up",
    raw.slice(0, -1), // one character off
    raw.toUpperCase(),
    `${raw} `.replace("deplo_", "Deplo_"), // the prefix check is exact
    "not_a_deplo_token",
    "",
  ]) {
    const ctx = await buildContext(
      new Request("http://localhost/api/graphql", {
        headers: { authorization: `Bearer ${bad}` },
      }),
    );
    assert.equal(
      ctx.viewer,
      null,
      `"${bad.slice(0, 16)}…" must not authenticate`,
    );
    assert.equal(ctx.identity, null);
    assert.deepEqual(ctx.capabilities, []);
  }
});

test("a token stops resolving the moment its creator leaves the team", async () => {
  await reset(ALL_CAPABILITIES);
  const raw = await mintToken(ALL_CAPABILITIES, USER_M);
  assert.ok(
    await asToken(raw),
    "fixture: it resolves while the membership stands",
  );
  await pg.exec(`delete from memberships where user_id = '${USER_M}';`);
  assert.equal(await asToken(raw), null, "no membership, no principal");
});

test("a suspended account's token authenticates as nobody", async () => {
  await reset(ALL_CAPABILITIES);
  const raw = await mintToken(ALL_CAPABILITIES, USER_M);
  await pg.exec(`update users set suspended = true where id = '${USER_M}';`);
  const ctx = await buildContext(
    new Request("http://localhost/api/graphql", {
      headers: { authorization: `Bearer ${raw}` },
    }),
  );
  assert.equal(ctx.viewer, null, "a suspended user resolves to no viewer");
  assert.deepEqual(ctx.capabilities, [], "and to no capabilities");
});

test("the team hint can pick a team the token holds, and never one it doesn't", async () => {
  await reset(ALL_CAPABILITIES);
  // The creator joins a second team; the token is scoped to the first only.
  await pg.exec(
    `insert into memberships (id, user_id, team_id, role, created_at) values ('mem_b', '${USER_M}', '${TEAM_B}', 'member', '${T0}');`,
  );
  const raw = await mintToken(ALL_CAPABILITIES, USER_M, { teamIds: [TEAM_A] });
  for (const hint of [TEAM_B, "beta", "team_nonexistent", null]) {
    const ctx = await buildContext(
      new Request("http://localhost/api/graphql", {
        headers: {
          authorization: `Bearer ${raw}`,
          ...(hint ? { "x-deplo-team": hint } : {}),
        },
      }),
    );
    assert.equal(
      ctx.teamId,
      TEAM_A,
      `the hint "${hint}" must not move the token outside its scope`,
    );
  }
});
