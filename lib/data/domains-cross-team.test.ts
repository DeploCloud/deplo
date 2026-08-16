import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  addDomain,
  assertPreviewBaseNotAnotherTeams,
  routableRoutes,
  updateDomain,
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains";

/**
 * A hostname belongs to ONE TEAM.
 *
 * The stored uniqueness is `(name, coalesce(path_prefix,''))` rather than
 * `name`, on purpose: one team serving `app.com` on `/` and `app.com` on `/api`
 * from two apps is a real feature. What it also allowed was a DIFFERENT team
 * attaching the victim's hostname to an app of their own on a path of their
 * choosing, and every step after that landed by itself:
 *
 *  - `servers.all_teams` defaults to true, so the attacker picks the very host
 *    the victim's app runs on;
 *  - the victim's DNS already points there, so the row is born `valid`;
 *  - `traefikRouterLabels` pins a path router ABOVE the whole-host router by
 *    design, so the new route WINS for that path.
 *
 * Same-origin content under someone else's hostname. These tests are the guard,
 * and the third one is the half that must NOT regress: inside one team the
 * shared-hostname feature still works.
 */

let db: TestDb;
let pg: PGlite;

const HOST = "shared-host.example.com";
/** Both apps on the SAME server - the ordinary single-server self-host. */
const HOST_IP = "10.0.0.1";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The victim's DNS points at the shared host, as it must for their own app to
  // work. That is the only DNS fact in play.
  __setDnsResolve4ForTest(async () => [HOST_IP]);
});

after(async () => {
  __resetDnsResolve4ForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: "u_victim", teamId: TEAM_A, role: "owner" },
      { id: "u_attacker", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db, "srv_1");
  await seedApp(db, {
    id: "prj_victim",
    teamId: TEAM_A,
    slug: "victim",
    serverId: "srv_1",
  });
  await seedApp(db, {
    id: "prj_attacker",
    teamId: TEAM_B,
    slug: "attacker",
    serverId: "srv_1",
  });
  await seedApp(db, {
    id: "prj_sibling",
    teamId: TEAM_A,
    slug: "sibling",
    serverId: "srv_1",
  });
});

const asVictim = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "u_victim", teamId: TEAM_A }, fn);
const asAttacker = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "u_attacker", teamId: TEAM_B }, fn);

test("another team cannot attach a path route to a hostname this team owns", async () => {
  const own = await asVictim(() => addDomain("prj_victim", HOST, {}));
  // The precondition that makes the hijack land: the row is live, not pending.
  assert.equal(own.status, "valid");

  await assert.rejects(
    asAttacker(() =>
      addDomain("prj_attacker", HOST, { pathPrefix: "/login" }),
    ),
    /already routed by another team/,
  );

  const routes = await asAttacker(() => routableRoutes("prj_attacker"));
  assert.deepEqual(routes, []);
});

test("a RENAME is not the way around it either", async () => {
  await asVictim(() => addDomain("prj_victim", HOST, {}));
  const mine = await asAttacker(() =>
    addDomain("prj_attacker", "attacker-own.example.com", {}),
  );
  await assert.rejects(
    asAttacker(() => updateDomain(mine.id, { name: HOST, pathPrefix: "/api" })),
    /already routed by another team/,
  );
});

test("the same team may still share one hostname across two apps by path", async () => {
  await asVictim(() => addDomain("prj_victim", HOST, {}));
  const api = await asVictim(() =>
    addDomain("prj_sibling", HOST, { pathPrefix: "/api" }),
  );
  assert.equal(api.name, HOST);
  assert.equal(api.pathPrefix, "/api");
});

test("the same row can still be edited without tripping over itself", async () => {
  const own = await asVictim(() => addDomain("prj_victim", HOST, {}));
  await asVictim(() => updateDomain(own.id, { port: 8080 }));
});

/**
 * A preview host never enters the `domains` table: `previewHost` builds
 * `<slug>-pr-<n>.<base>` straight into a Traefik router, with `letsencrypt` by
 * default. So the guard above has a twin here, or the takeover it closes is
 * reachable one level down — routers AND certificate orders under a name that
 * belongs to somebody else.
 */
test("a preview base domain under another team's hostname is refused", async () => {
  await asVictim(() => addDomain("prj_victim", HOST, {}));
  await assert.rejects(
    () => assertPreviewBaseNotAnotherTeams(HOST, TEAM_B),
    /another team/,
    "the hostname itself",
  );
  await assert.rejects(
    () => assertPreviewBaseNotAnotherTeams(`preview.${HOST}`, TEAM_B),
    /another team/,
    "and anything under it",
  );
});

test("a team may point previews at a domain it already serves", async () => {
  await asVictim(() => addDomain("prj_victim", HOST, {}));
  await assertPreviewBaseNotAnotherTeams(HOST, TEAM_A);
  await assertPreviewBaseNotAnotherTeams(`preview.${HOST}`, TEAM_A);
  // And a hostname nobody serves is nobody's to refuse.
  await assertPreviewBaseNotAnotherTeams("unclaimed.example.com", TEAM_B);
});

test("a suffix that is not a label boundary is not a claim", async () => {
  await asVictim(() => addDomain("prj_victim", HOST, {}));
  // `notvictim.com` merely ENDS WITH the victim's host; it is a different name.
  await assertPreviewBaseNotAnotherTeams(`not${HOST}`, TEAM_B);
});
