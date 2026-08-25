import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));
// Set BEFORE the module loads: with a configured public URL the hook never has
// to reach for request headers, which is also what makes it testable here.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { projects as projectsTable } from "../db/schema/control-plane";
import { createToken } from "./tokens";

const T0 = "2026-01-01T00:00:00.000Z";
import {
  deployHookUrlMasked,
  revealDeployHook,
  rotateDeployHook,
  setDeployHookEnabled,
  verifyDeployHookToken,
} from "./deploy-hook";

/**
 * The deploy hook: the URL that lets something outside deplo trigger a deploy.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table api_tokens, projects, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      // In TEAM_A, but read-only: the hook is a `configure_apps` surface.
      {
        id: "user_viewer",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asUser2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);

/** The secret last segment of a hook URL. */
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

test("no app carries a live hook token until someone opens it", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });

  // Nothing minted yet, so no URL can be valid for this app — not even an empty
  // one, which is what a naive compare against a missing token would accept.
  assert.deepEqual(await verifyDeployHookToken("prj_1", ""), {
    ok: false,
    reason: "bad-token",
  });
  assert.equal(
    await deployHookUrlMasked("prj_1"),
    "https://deplo.test/api/apps/prj_1/deploy-hook/••••••••••••",
  );

  const url = await asUser1(() => revealDeployHook("prj_1"));
  assert.match(
    url,
    /^https:\/\/deplo\.test\/api\/apps\/prj_1\/deploy-hook\/.+/,
  );
  assert.deepEqual(await verifyDeployHookToken("prj_1", tokenOf(url)), {
    ok: true,
    teamId: TEAM_A,
  });
});

test("revealing twice returns the SAME url — reading a link never changes it", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  const first = await asUser1(() => revealDeployHook("prj_1"));
  const second = await asUser1(() => revealDeployHook("prj_1"));
  assert.equal(first, second);
});

test("rotating mints a new url and kills the old one on the spot", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  const before = await asUser1(() => revealDeployHook("prj_1"));
  const after = await asUser1(() => rotateDeployHook("prj_1"));

  assert.notEqual(before, after);
  assert.deepEqual(await verifyDeployHookToken("prj_1", tokenOf(before)), {
    ok: false,
    reason: "bad-token",
  });
  assert.deepEqual(await verifyDeployHookToken("prj_1", tokenOf(after)), {
    ok: true,
    teamId: TEAM_A,
  });
});

test("the kill switch refuses the RIGHT token too", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  const url = await asUser1(() => revealDeployHook("prj_1"));

  await asUser1(() => setDeployHookEnabled("prj_1", false));
  assert.deepEqual(await verifyDeployHookToken("prj_1", tokenOf(url)), {
    ok: false,
    reason: "disabled",
  });

  // And back: turning it on again restores the same URL, so a temporary
  // shutdown doesn't force every caller to be re-configured.
  await asUser1(() => setDeployHookEnabled("prj_1", true));
  assert.deepEqual(await verifyDeployHookToken("prj_1", tokenOf(url)), {
    ok: true,
    teamId: TEAM_A,
  });
});

test("an unknown app and a wrong token answer the same: no hook", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => revealDeployHook("prj_1"));

  assert.deepEqual(await verifyDeployHookToken("prj_nope", "whatever"), {
    ok: false,
    reason: "not-found",
  });
  assert.deepEqual(await verifyDeployHookToken("prj_1", "not-the-token"), {
    ok: false,
    reason: "bad-token",
  });
});

test("another team's app has no hook to read, rotate or switch off", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });

  await assert.rejects(
    () => asUser2(() => revealDeployHook("prj_1")),
    /not found/i,
  );
  await assert.rejects(
    () => asUser2(() => rotateDeployHook("prj_1")),
    /not found/i,
  );
  await assert.rejects(
    () => asUser2(() => setDeployHookEnabled("prj_1", false)),
    /not found/i,
  );

  // And the app is untouched: still no token, still enabled.
  assert.deepEqual(await verifyDeployHookToken("prj_1", ""), {
    ok: false,
    reason: "bad-token",
  });
});

test("a member without configure_apps can't open the hook", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });

  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_viewer", teamId: TEAM_A }, () =>
        revealDeployHook("prj_1"),
      ),
    /permission/i,
  );
});

/**
 * The route's own 404/403 parity, which the data layer alone can't show.
 *
 * `verifyDeployHookToken` answers 403 "the hook is turned off" and 404 "not
 * found" for two different reasons, so the reachability check has to run BEFORE
 * it — otherwise the 403 tells a caller that an app it may not see exists, and
 * whether its hook is switched on.
 */
test("an app outside the token's project scope answers the same 404 as an unknown app", async () => {
  const { POST } =
    await import("../../app/api/apps/[id]/deploy-hook/[token]/route");
  await db.insert(projectsTable).values([
    {
      id: "prc_in",
      teamId: TEAM_A,
      name: "In",
      slug: "in",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "prc_out",
      teamId: TEAM_A,
      name: "Out",
      slug: "out",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: "prj_out", slug: "out-app", projectId: "prc_out" });
  // The hook is deliberately OFF: that is the branch that used to answer 403.
  const url = await asUser1(async () => {
    await setDeployHookEnabled("prj_out", false);
    return revealDeployHook("prj_out");
  });

  const raw = await asUser1(
    async () =>
      (
        await createToken({
          name: "Scoped CI",
          capabilities: ["deploy_apps"],
          projectIds: ["prc_in"],
        })
      ).raw,
  );

  const call = (appId: string, token: string) =>
    POST(
      new Request("https://deplo.test/hook", {
        method: "POST",
        headers: { authorization: `Bearer ${raw}` },
      }),
      { params: Promise.resolve({ id: appId, token }) },
    );

  const outOfScope = await call("prj_out", tokenOf(url));
  const unknown = await call("prj_nope", tokenOf(url));
  assert.equal(outOfScope.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await outOfScope.json(), await unknown.json());

  // And the test has teeth: an app the token CAN see, with its hook off, still
  // gets the honest 403 — so the 404 above is the scope talking, not a blanket.
  await seedApp(db, { id: "prj_in", slug: "in-app", projectId: "prc_in" });
  const inUrl = await asUser1(async () => {
    await setDeployHookEnabled("prj_in", false);
    return revealDeployHook("prj_in");
  });
  const inScope = await call("prj_in", tokenOf(inUrl));
  assert.equal(inScope.status, 403);
  assert.match((await inScope.json()).error, /turned off/);
});
