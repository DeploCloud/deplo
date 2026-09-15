import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { sharedEnvVars as sharedVarsTable } from "../db/schema/control-plane/env-vars";
import {
  projects as projectsTable,
  environments as environmentsTable,
  folders as foldersTable,
} from "../db/schema/control-plane/projects";
import { decryptSecret } from "../crypto";
import { setSharedVarAppLink } from "./shared-vars/app-links";
import { listSharedVarsForApp } from "./shared-vars/app-view";
import { saveSharedVar, deleteSharedVar } from "./shared-vars/authoring";
import { loadSharedVarsForApp } from "./shared-vars/deploy-entries";
import { listSharedVars } from "./shared-vars/team-view";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const ALL = ["production", "preview"] as const;
const PRJ = "prc_1";
const ENV_DEV = "environ_dev";
const ENV_PROD = "environ_prod";
const FLD = "fld_1";

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
    truncate table project_grants, environments, projects restart identity cascade;
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      { id: "user_3", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db);
  await db.insert(projectsTable).values({
    id: PRJ,
    teamId: TEAM_A,
    name: "Proj",
    slug: "proj",
    color: null,
    ownerUserId: USER_1,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(environmentsTable).values([
    {
      id: ENV_DEV,
      projectId: PRJ,
      name: "Development",
      slug: "development",
      kind: "development",
      gitBranch: "",
      isDefault: true,
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: ENV_PROD,
      projectId: PRJ,
      name: "Production",
      slug: "production",
      kind: "production",
      gitBranch: "",
      isDefault: false,
      position: 1,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: "app_p", slug: "app-p", teamId: TEAM_A });
  await seedApp(db, { id: "app_top", slug: "app-top", teamId: TEAM_A });
  await db
    .update(appsTable)
    .set({ projectId: PRJ, environmentId: ENV_DEV })
    .where(eq(appsTable.id, "app_p"));
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asUser2 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);
const asUser3 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_3", teamId: TEAM_A }, fn);

async function mkVar(input: {
  key: string;
  value?: string;
  type?: "plain" | "secret";
  targets?: (typeof ALL)[number][];
  teamWide?: boolean;
  environmentIds?: string[];
  projectIds?: string[];
  appIds?: string[];
}): Promise<string> {
  await saveSharedVar({
    key: input.key,
    value: input.value ?? "v",
    type: input.type ?? "plain",
    targets: input.targets ?? [...ALL],
    teamIds: input.teamWide ? [TEAM_A] : [],
    environmentIds: input.environmentIds ?? [],
    projectIds: input.projectIds ?? [],
    appIds: input.appIds,
  });
  const found = (await listSharedVars()).find((v) => v.key === input.key);
  assert.ok(found, `var ${input.key} created`);
  return found.id;
}

test("create + list is decorated and team-scoped", async () => {
  await asUser1(() => mkVar({ key: "TEAMWIDE", teamWide: true }));
  const a = await asUser1(() => listSharedVars());
  assert.deepEqual(
    a.map((v) => v.key),
    ["TEAMWIDE"],
  );
  assert.equal(a[0]!.teamWide, true);
  assert.deepEqual(await asUser2(() => listSharedVars()), []);
});

test("an app decoration carries the app's logo (the chip wears it)", async () => {
  await db
    .update(appsTable)
    .set({ logo: "data:image/svg+xml;base64,PHN2Zy8+" })
    .where(eq(appsTable.id, "app_p"));
  await asUser1(() => mkVar({ key: "WITHLOGO", appIds: ["app_p", "app_top"] }));
  const [v] = await asUser1(() => listSharedVars());
  assert.deepEqual(v!.apps.map((a) => [a.id, a.logo]).sort(), [
    ["app_p", "data:image/svg+xml;base64,PHN2Zy8+"],
    ["app_top", null],
  ]);
});

test("saveSharedVar rejects a var with no sharing mode", async () => {
  await assert.rejects(
    asUser1(() =>
      saveSharedVar({
        key: "NOSCOPE",
        value: "x",
        type: "plain",
        targets: [...ALL],
        teamIds: [],
        environmentIds: [],
        projectIds: [],
      }),
    ),
    /at least one/i,
  );
});

test("a link-only var (the migrated shared-group shape) can still be saved", async () => {
  const id = await asUser1(() => mkVar({ key: "FROMGROUP", teamWide: true }));
  await asUser1(() => setSharedVarAppLink(id, "app_p", true));
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "FROMGROUP",
      value: "rotated",
      type: "plain",
      targets: [...ALL],
      teamIds: [],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.teamWide, false);
  assert.equal(v!.value, "rotated");
  assert.deepEqual(v!.appIds, ["app_p"]);
  assert.deepEqual(
    (await loadSharedVarsForApp("app_p")).map((e) => e.key),
    ["FROMGROUP"],
  );
});

test("a var with neither a mode nor a link is rejected", async () => {
  const id = await asUser1(() => mkVar({ key: "NOREACH", teamWide: true }));
  await assert.rejects(
    asUser1(() =>
      saveSharedVar({
        id,
        key: "NOREACH",
        value: "x",
        type: "plain",
        targets: [...ALL],
        teamIds: [],
        environmentIds: [],
        projectIds: [],
      }),
    ),
    /at least one/i,
  );
});

test("an omitted target set means every runtime", async () => {
  await asUser1(() =>
    saveSharedVar({
      key: "NOTARGET",
      value: "x",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.deepEqual(v!.targets, [...ALL]);
});

test("an edit that names no targets PRESERVES the stored ones", async () => {
  const id = await asUser1(() =>
    mkVar({
      key: "STRIPE_LIVE_KEY",
      value: "live",
      type: "plain",
      targets: ["production"],
      teamWide: true,
      appIds: ["app_p"],
    }),
  );
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "STRIPE_LIVE_KEY",
      value: "rotated",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.deepEqual(v!.targets, ["production"]);
  assert.deepEqual(
    (await loadSharedVarsForApp("app_p")).map((e) => e.targets),
    [["production"]],
  );
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "STRIPE_LIVE_KEY",
      value: "rotated",
      type: "plain",
      targets: [...ALL],
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  assert.equal(
    (await asUser1(() => listSharedVars()))[0]!.targets.length,
    ALL.length,
  );
});

test("the appIds whole-set replace is folder-gated on every link it adds or removes", async () => {
  await db.insert(foldersTable).values({
    id: FLD,
    teamId: TEAM_A,
    name: "Secret",
    parentId: null,
    color: null,
    ownerUserId: USER_1,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .update(appsTable)
    .set({ folderId: FLD })
    .where(eq(appsTable.id, "app_p"));

  await assert.rejects(
    asUser3(() =>
      saveSharedVar({
        key: "ESCALATE",
        value: "x",
        type: "plain",
        teamIds: [],
        environmentIds: [],
        projectIds: [],
        appIds: ["app_p"],
      }),
    ),
    /not found|permission/i,
  );
  assert.deepEqual(await asUser1(() => listSharedVars()), []);

  const id = await asUser1(() =>
    mkVar({ key: "GATED", teamWide: true, appIds: ["app_p"] }),
  );
  const save = (appIds: string[]) => ({
    id,
    key: "GATED",
    value: "v",
    type: "plain" as const,
    teamIds: [TEAM_A],
    environmentIds: [],
    projectIds: [],
    appIds,
  });
  await assert.rejects(
    asUser3(() => saveSharedVar(save([]))),
    /not found|permission/i,
  );
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, [
    "app_p",
  ]);
  await asUser3(() => saveSharedVar(save(["app_p"])));
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, [
    "app_p",
  ]);
  await asUser1(() => saveSharedVar(save([])));
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, []);
});

test("authorship: create stamps both columns, an edit only touches updatedBy", async () => {
  await asUser1(() => mkVar({ key: "AUTHORED", teamWide: true }));
  const [created] = await asUser1(() => listSharedVars());
  assert.equal(created!.createdBy?.id, USER_1);
  assert.equal(created!.updatedBy?.id, USER_1);
  await asUser3(() =>
    saveSharedVar({
      id: created!.id,
      key: "AUTHORED",
      value: "rotated",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [edited] = await asUser1(() => listSharedVars());
  assert.equal(edited!.createdBy?.id, USER_1);
  assert.equal(edited!.updatedBy?.id, "user_3");
  const { avatarUrl, ...identity } = edited!.updatedBy!;
  assert.deepEqual(identity, {
    id: "user_3",
    name: "user_3",
    username: "user_3",
    avatarColor: "#abc",
  });
  assert.ok(
    avatarUrl === null ||
      /^\/api\/avatar\/[a-z]+\/[A-Za-z0-9_-]+\.svg$/.test(avatarUrl) ||
      /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?/.test(avatarUrl),
    `avatarUrl is a generated face or a derived gravatar URL, got ${avatarUrl}`,
  );
  assert.ok(
    !JSON.stringify(edited!.updatedBy).includes("@"),
    "no email anywhere",
  );
});

test("linking a var to an app stamps the author (a scope change IS a modification)", async () => {
  const id = await asUser1(() => mkVar({ key: "LINKAUTHOR", teamWide: true }));
  await asUser3(() => setSharedVarAppLink(id, "app_top", true));
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.updatedBy?.id, "user_3");
});

test("appIds shares with specific apps and whole-set replaces the link junction", async () => {
  const id = await asUser1(() =>
    mkVar({ key: "APPSCOPED", appIds: ["app_p"] }),
  );
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, [
    "app_p",
  ]);
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "APPSCOPED",
      value: "v",
      type: "plain",
      teamIds: [],
      environmentIds: [],
      projectIds: [],
      appIds: ["app_top"],
    }),
  );
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, [
    "app_top",
  ]);
});

test("appIds is filtered to the active team's apps", async () => {
  await seedApp(db, { id: "app_b", slug: "app-b", teamId: TEAM_B });
  await asUser1(() =>
    mkVar({ key: "FILTERED", teamWide: true, appIds: ["app_p", "app_b"] }),
  );
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, [
    "app_p",
  ]);
});

test("an empty appIds set with no mode reaches nothing and is rejected", async () => {
  const id = await asUser1(() => mkVar({ key: "EMPTIED", appIds: ["app_p"] }));
  await assert.rejects(
    asUser1(() =>
      saveSharedVar({
        id,
        key: "EMPTIED",
        value: "v",
        type: "plain",
        teamIds: [],
        environmentIds: [],
        projectIds: [],
        appIds: [],
      }),
    ),
    /at least one/i,
  );
});

test("listSharedVarsForApp returns EVERY team var so any can be linked", async () => {
  await asUser1(() => mkVar({ key: "OTHERENV", environmentIds: [ENV_PROD] }));
  const rows = await asUser1(() => listSharedVarsForApp("app_top"));
  const other = rows.find((r) => r.key === "OTHERENV")!;
  assert.ok(other, "an out-of-scope var is still listed (linkable)");
  assert.equal(other.linked, false);
  assert.equal(other.inScope, false);
  assert.equal(other.scope, null);
});

test("listSharedVarsForApp reads values like the Variables page does", async () => {
  await asUser1(() =>
    mkVar({ key: "PLAIN", value: "readable", teamWide: true }),
  );
  await asUser1(() =>
    mkVar({ key: "SECRET", value: "s3cr3t", type: "secret", teamWide: true }),
  );
  const rows = await asUser1(() => listSharedVarsForApp("app_p"));
  const plain = rows.find((r) => r.key === "PLAIN")!;
  const secret = rows.find((r) => r.key === "SECRET")!;
  assert.equal(plain.value, "readable");
  assert.equal(plain.masked, false);
  assert.equal(secret.masked, true);
  assert.notEqual(secret.value, "s3cr3t");
});

test("a secret shared var is masked, and NOTHING reads it back", async () => {
  await asUser1(() =>
    mkVar({ key: "SECRET", value: "s3cr3t", type: "secret", teamWide: true }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.masked, true);
  assert.notEqual(v!.value, "s3cr3t");
  const forApp = await asUser1(() => listSharedVarsForApp("app_p"));
  assert.notEqual(forApp.find((r) => r.key === "SECRET")!.value, "s3cr3t");
});

test("a scope-only edit of a secret keeps the stored value", async () => {
  const id = await asUser1(() =>
    mkVar({ key: "S", value: "real", type: "secret", teamWide: true }),
  );
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "S",
      value: "••••••••••••",
      type: "secret",
      targets: ["production"],
      teamIds: [],
      environmentIds: [],
      projectIds: [PRJ],
    }),
  );
  const after = await asUser1(() => dtoOf("S"));
  assert.deepEqual(after.projectIds, [PRJ], "the scope DID change");
  assert.equal(after.type, "secret");
  assert.equal(after.masked, true);
  const [row] = await db
    .select({ valueEnc: sharedVarsTable.valueEnc })
    .from(sharedVarsTable)
    .where(eq(sharedVarsTable.id, id));
  assert.equal(decryptSecret(row!.valueEnc), "real");
});

test("loadSharedVarsForApp: an availability scope alone injects NOTHING (opt-in, ADR-0012)", async () => {
  await asUser1(() => mkVar({ key: "TW", teamWide: true }));
  await asUser1(() => mkVar({ key: "PROJ", projectIds: [PRJ] }));
  await asUser1(() => mkVar({ key: "EDEV", environmentIds: [ENV_DEV] }));
  assert.deepEqual(await loadSharedVarsForApp("app_p"), []);
  assert.deepEqual(await loadSharedVarsForApp("app_top"), []);
});

test("loadSharedVarsForApp: a per-app link injects, and only into the linked app", async () => {
  const id = await asUser1(() => mkVar({ key: "LINKED", teamWide: true }));
  await asUser1(() => setSharedVarAppLink(id, "app_top", true));
  assert.deepEqual(
    (await loadSharedVarsForApp("app_top")).map((e) => e.key),
    ["LINKED"],
  );
  assert.deepEqual(await loadSharedVarsForApp("app_p"), []);
});

test("listSharedVarsForApp annotates linked / inScope / scope", async () => {
  const twId = await asUser1(() => mkVar({ key: "TW", teamWide: true }));
  await asUser1(() => mkVar({ key: "PROJ", projectIds: [PRJ] }));
  await asUser1(() => mkVar({ key: "EDEV", environmentIds: [ENV_DEV] }));
  await asUser1(() => setSharedVarAppLink(twId, "app_p", true));
  const rows = await asUser1(() => listSharedVarsForApp("app_p"));
  const tw = rows.find((r) => r.key === "TW")!;
  const proj = rows.find((r) => r.key === "PROJ")!;
  const edev = rows.find((r) => r.key === "EDEV")!;
  assert.equal(tw.linked, true);
  assert.equal(tw.inScope, true);
  assert.equal(tw.scope, "teamWide");
  assert.equal(proj.linked, false, "in scope is NOT applied");
  assert.equal(proj.inScope, true);
  assert.equal(proj.scope, "project");
  assert.equal(edev.scope, "environment");
});

test("setSharedVarAppLink toggles the link and is team-gated", async () => {
  const id = await asUser1(() => mkVar({ key: "L", teamWide: true }));
  await asUser1(() => setSharedVarAppLink(id, "app_top", true));
  const on = await asUser1(() => listSharedVarsForApp("app_top"));
  assert.ok(on.find((r) => r.key === "L")!.linked);
  await asUser1(() => setSharedVarAppLink(id, "app_top", false));
  const off = await asUser1(() => listSharedVarsForApp("app_top"));
  assert.equal(off.find((r) => r.key === "L")!.linked, false);
  await assert.rejects(
    asUser2(() => setSharedVarAppLink(id, "app_top", true)),
    /not found/i,
  );
});

test("deleteSharedVar removes it (and its scope + link rows cascade)", async () => {
  const id = await asUser1(() =>
    mkVar({ key: "GONE", projectIds: [PRJ], appIds: ["app_p"] }),
  );
  assert.equal((await loadSharedVarsForApp("app_p")).length, 1);
  await asUser1(() => deleteSharedVar(id));
  assert.deepEqual(await asUser1(() => listSharedVars()), []);
  assert.deepEqual(await loadSharedVarsForApp("app_p"), []);
});

async function editValueLikeDialog(
  dto: {
    id: string;
    key: string;
    value: string;
    teamWide: boolean;
    environmentIds: string[];
    projectIds: string[];
  },
  patch: { value?: string; type?: "plain" | "secret" } = {},
): Promise<void> {
  await saveSharedVar({
    id: dto.id,
    key: dto.key,
    value: patch.value ?? dto.value,
    type: patch.type ?? "plain",
    teamIds: dto.teamWide ? [TEAM_A] : [],
    environmentIds: dto.environmentIds,
    projectIds: dto.projectIds,
  });
}

const dtoOf = async (key: string) =>
  (await listSharedVars()).find((v) => v.key === key)!;

test("a value-only edit leaves the per-app links, the modes and the targets alone", async () => {
  await asUser1(async () => {
    await mkVar({
      key: "SCOPED",
      value: "before",
      projectIds: [PRJ],
      appIds: ["app_top"],
      targets: ["production"],
    });
    const before = await dtoOf("SCOPED");

    await editValueLikeDialog(before, { value: "after" });

    const after = await dtoOf("SCOPED");
    assert.equal(after.value, "after", "the value IS what changed");
    assert.deepEqual(after.appIds, ["app_top"], "per-app link survived");
    assert.deepEqual(after.projectIds, [PRJ]);
    assert.deepEqual(after.environmentIds, []);
    assert.equal(after.teamWide, false);
    assert.deepEqual(after.targets, ["production"]);
  });
});

test("a value-only edit of a LINK-ONLY variable still saves (links count as reach)", async () => {
  await asUser1(async () => {
    await mkVar({ key: "LINKONLY", value: "v1", appIds: ["app_p"] });
    const before = await dtoOf("LINKONLY");
    await editValueLikeDialog(before, { value: "v2" });
    const after = await dtoOf("LINKONLY");
    assert.equal(after.value, "v2");
    assert.deepEqual(after.appIds, ["app_p"]);
  });
});

test("a secret is frozen: the mask round-trip can no longer downgrade it", async () => {
  await asUser1(async () => {
    await mkVar({
      key: "SEC",
      value: "s3cret",
      type: "secret",
      teamWide: true,
    });
    const masked = await dtoOf("SEC");
    assert.notEqual(
      masked.value,
      "s3cret",
      "the DTO never carries the plaintext",
    );

    await assert.rejects(
      () => editValueLikeDialog(masked, { type: "plain" }),
      /cannot be edited/i,
    );
    const after = await dtoOf("SEC");
    assert.equal(after.type, "secret", "still secret");
    assert.equal(after.masked, true);
    assert.notEqual(after.value, "s3cret");

    await assert.rejects(
      () => editValueLikeDialog(masked, { value: "n3w", type: "secret" }),
      /cannot be edited/i,
    );
  });
});

test("an orphaned variable stays editable (its only scope was deleted)", async () => {
  const id = await asUser1(() =>
    mkVar({ key: "ORPHAN", environmentIds: [ENV_DEV] }),
  );
  await db.delete(environmentsTable).where(eq(environmentsTable.id, ENV_DEV));
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "ORPHAN",
      value: "repaired",
      type: "plain",
      teamIds: [],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.value, "repaired");
  await assert.rejects(
    () =>
      asUser1(() =>
        saveSharedVar({
          key: "NOWHERE",
          value: "x",
          type: "plain",
          teamIds: [],
          environmentIds: [],
          projectIds: [],
        }),
      ),
    /at least one/i,
  );
});

test("a twin - same key AND same reach - is refused, other scopes are not", async () => {
  await asUser1(() => mkVar({ key: "TWIN", teamWide: true }));
  await assert.rejects(
    () => asUser1(() => mkVar({ key: "TWIN", teamWide: true })),
    /already shared with the same/i,
  );
  await asUser1(() => mkVar({ key: "TWIN", projectIds: [PRJ] }));
  assert.equal(
    (await asUser1(() => listSharedVars())).filter((v) => v.key === "TWIN")
      .length,
    2,
  );
});

test("the activity trail says CREATED once, then UPDATED", async () => {
  const id = await asUser1(() => mkVar({ key: "TRAIL", teamWide: true }));
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "TRAIL",
      value: "v2",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const rows = await db
    .select({ message: activitiesTable.message })
    .from(activitiesTable)
    .orderBy(activitiesTable.createdAt);
  const mine = rows.map((r) => r.message).filter((m) => m.includes("TRAIL"));
  assert.deepEqual(mine, [
    "Created shared variable TRAIL",
    "Updated shared variable TRAIL",
  ]);
});
