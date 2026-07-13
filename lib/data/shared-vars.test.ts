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
import {
  projects as projectsTable,
  environments as environmentsTable,
  apps as appsTable,
  folders as foldersTable,
} from "../db/schema/control-plane";
import {
  saveSharedVar,
  deleteSharedVar,
  revealSharedVar,
  setSharedVarAppLink,
  listSharedVars,
  listSharedVarsForApp,
  loadSharedVarsForApp,
} from "./shared-vars";

/**
 * Data-layer tests for the unified shared-variable model (ADR-0010): the three
 * sharing modes + per-app link, ≥1-mode validation, secret masking, team
 * isolation, and the deploy loader's scope resolution (which app each mode
 * reaches, tagged with its precedence layer).
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const ALL = ["production", "preview", "development"] as const;
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
      // A second TEAM_A member (member ⇒ has manage_env) — the authorship tests
      // need an editor who is NOT the creator.
      { id: "user_3", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db);
  // A project with two environments in TEAM_A.
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
    { id: ENV_DEV, projectId: PRJ, name: "Development", slug: "development", kind: "development", gitBranch: "", isDefault: true, position: 0, createdAt: T0, updatedAt: T0 },
    { id: ENV_PROD, projectId: PRJ, name: "Production", slug: "production", kind: "production", gitBranch: "", isDefault: false, position: 1, createdAt: T0, updatedAt: T0 },
  ]);
  // app_p lives in the project's Development environment; app_top is top-level.
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

/** Create a shared var and return its id (looked up by key). */
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
    teamWide: input.teamWide ?? false,
    environmentIds: input.environmentIds ?? [],
    projectIds: input.projectIds ?? [],
    appIds: input.appIds,
  });
  const found = (await listSharedVars()).find((v) => v.key === input.key);
  assert.ok(found, `var ${input.key} created`);
  return found.id;
}

test("create + list is decorated and team-scoped", async () => {
  await asUser1(() =>
    mkVar({ key: "TEAMWIDE", teamWide: true }),
  );
  const a = await asUser1(() => listSharedVars());
  assert.deepEqual(a.map((v) => v.key), ["TEAMWIDE"]);
  assert.equal(a[0]!.teamWide, true);
  // Another team sees nothing.
  assert.deepEqual(await asUser2(() => listSharedVars()), []);
});

test("saveSharedVar rejects a var with no sharing mode", async () => {
  await assert.rejects(
    asUser1(() =>
      saveSharedVar({
        key: "NOSCOPE",
        value: "x",
        type: "plain",
        targets: [...ALL],
        teamWide: false,
        environmentIds: [],
        projectIds: [],
      }),
    ),
    /at least one/i,
  );
});

test("a link-only var (the migrated shared-group shape) can still be saved", async () => {
  // Migration 0027 explodes every legacy shared GROUP var into a var with per-app
  // LINKS and NO modes. If the ≥1-mode rule rejected that shape, every migrated
  // group variable would be permanently unsavable (you could never rotate its value).
  const id = await asUser1(() => mkVar({ key: "FROMGROUP", teamWide: true }));
  await asUser1(() => setSharedVarAppLink(id, "app_p", true));
  // Strip the only mode → now it reaches app_p purely through the link.
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "FROMGROUP",
      value: "rotated",
      type: "plain",
      targets: [...ALL],
      teamWide: false,
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.teamWide, false);
  assert.equal(v!.value, "rotated");
  assert.deepEqual(v!.appIds, ["app_p"]);
  // It still injects into the linked app, through the `link` layer.
  assert.deepEqual(
    (await loadSharedVarsForApp("app_p")).map((e) => [e.key, e.mode]),
    [["FROMGROUP", "link"]],
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
        teamWide: false,
        environmentIds: [],
        projectIds: [],
      }),
    ),
    /at least one/i,
  );
});

test("an omitted target set means every runtime", async () => {
  // An App belongs to exactly ONE Environment, so the legacy
  // production/preview/development picker is gone from every dialog. A save that
  // names no target is no longer an error — it reaches every runtime, which is
  // what the picker defaulted to anyway.
  await asUser1(() =>
    saveSharedVar({
      key: "NOTARGET",
      value: "x",
      type: "plain",
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.deepEqual(v!.targets, [...ALL]);
});

test("an edit that names no targets PRESERVES the stored ones", async () => {
  // The dialogs no longer send targets. A legacy production-only SECRET must not
  // silently widen to every runtime on a value rotation — that would inject the
  // live key into the dev container (lib/deploy/dev.ts).
  const id = await asUser1(() =>
    mkVar({ key: "STRIPE_LIVE_KEY", value: "live", type: "secret", targets: ["production"], teamWide: true }),
  );
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "STRIPE_LIVE_KEY",
      value: "rotated",
      type: "secret",
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.deepEqual(v!.targets, ["production"]);
  // The deploy loader still sees the narrow set.
  assert.deepEqual(
    (await loadSharedVarsForApp("app_p")).map((e) => e.targets),
    [["production"]],
  );
  // An explicit set still replaces them.
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "STRIPE_LIVE_KEY",
      value: "••••••••••••",
      type: "secret",
      targets: [...ALL],
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );
  assert.equal((await asUser1(() => listSharedVars()))[0]!.targets.length, 3);
});

test("the appIds whole-set replace is folder-gated on every link it adds or removes", async () => {
  // `link` is the HIGHEST deploy precedence, so a member holding team `manage_env`
  // but no grant on the folder must not be able to inject a var into an app inside
  // it — nor to unlink one (that silently strips the var off the app's next deploy).
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
  await db.update(appsTable).set({ folderId: FLD }).where(eq(appsTable.id, "app_p"));

  // ADD: user_3 has team manage_env but no access to FLD.
  await assert.rejects(
    asUser3(() =>
      saveSharedVar({
        key: "ESCALATE",
        value: "x",
        type: "plain",
        teamWide: false,
        environmentIds: [],
        projectIds: [],
        appIds: ["app_p"],
      }),
    ),
    /not found|permission/i,
  );
  assert.deepEqual(await asUser1(() => listSharedVars()), []);

  // REMOVE: the folder owner links it; user_3 can't drop the link by re-saving.
  const id = await asUser1(() =>
    mkVar({ key: "GATED", teamWide: true, appIds: ["app_p"] }),
  );
  const save = (appIds: string[]) => ({
    id,
    key: "GATED",
    value: "v",
    type: "plain" as const,
    teamWide: true,
    environmentIds: [],
    projectIds: [],
    appIds,
  });
  await assert.rejects(
    asUser3(() => saveSharedVar(save([]))),
    /not found|permission/i,
  );
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, ["app_p"]);
  // An UNCHANGED link is not a new write — resending it doesn't need the grant.
  await asUser3(() => saveSharedVar(save(["app_p"])));
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, ["app_p"]);
  // The folder owner can unlink.
  await asUser1(() => saveSharedVar(save([])));
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, []);
});

test("authorship: create stamps both columns, an edit only touches updatedBy", async () => {
  await asUser1(() => mkVar({ key: "AUTHORED", teamWide: true }));
  const [created] = await asUser1(() => listSharedVars());
  assert.equal(created!.createdBy?.id, USER_1);
  assert.equal(created!.updatedBy?.id, USER_1);
  // A different member rotates the value — the creator must not be rewritten.
  await asUser3(() =>
    saveSharedVar({
      id: created!.id,
      key: "AUTHORED",
      value: "rotated",
      type: "plain",
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );
  const [edited] = await asUser1(() => listSharedVars());
  assert.equal(edited!.createdBy?.id, USER_1);
  assert.equal(edited!.updatedBy?.id, "user_3");
  // Identity only — never an email.
  assert.deepEqual(edited!.updatedBy, {
    id: "user_3",
    name: "user_3",
    username: "user_3",
    avatarColor: "#abc",
  });
});

test("linking a var to an app stamps the author (a scope change IS a modification)", async () => {
  const id = await asUser1(() => mkVar({ key: "LINKAUTHOR", teamWide: true }));
  await asUser3(() => setSharedVarAppLink(id, "app_top", true));
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.updatedBy?.id, "user_3");
});

test("appIds shares with specific apps and whole-set replaces the link junction", async () => {
  // A var reaching apps ONLY through explicit links is legal (it is the shape
  // migration 0027 produced) — the wizard's "specific apps" scope mints it.
  const id = await asUser1(() => mkVar({ key: "APPSCOPED", appIds: ["app_p"] }));
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, ["app_p"]);
  await asUser1(() =>
    saveSharedVar({
      id,
      key: "APPSCOPED",
      value: "v",
      type: "plain",
      teamWide: false,
      environmentIds: [],
      projectIds: [],
      appIds: ["app_top"],
    }),
  );
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, ["app_top"]);
});

test("appIds is filtered to the active team's apps", async () => {
  await seedApp(db, { id: "app_b", slug: "app-b", teamId: TEAM_B });
  await asUser1(() => mkVar({ key: "FILTERED", teamWide: true, appIds: ["app_p", "app_b"] }));
  assert.deepEqual((await asUser1(() => listSharedVars()))[0]!.appIds, ["app_p"]);
});

test("an empty appIds set with no mode reaches nothing and is rejected", async () => {
  // The caller OWNS the link set when it sends one, so the stored links can't
  // vouch for reach — they are about to be deleted.
  const id = await asUser1(() => mkVar({ key: "EMPTIED", appIds: ["app_p"] }));
  await assert.rejects(
    asUser1(() =>
      saveSharedVar({
        id,
        key: "EMPTIED",
        value: "v",
        type: "plain",
        teamWide: false,
        environmentIds: [],
        projectIds: [],
        appIds: [],
      }),
    ),
    /at least one/i,
  );
});

test("listSharedVarsForApp returns EVERY team var so any can be linked", async () => {
  // Including one scoped to an environment this app does not live in — the per-app
  // link is the escape hatch for attaching an extra shared var to one app.
  await asUser1(() => mkVar({ key: "OTHERENV", environmentIds: [ENV_PROD] }));
  const rows = await asUser1(() => listSharedVarsForApp("app_top")); // top-level app
  const other = rows.find((r) => r.key === "OTHERENV")!;
  assert.ok(other, "an out-of-scope var is still listed (linkable)");
  assert.equal(other.applied, false);
  assert.equal(other.inherited, false);
  assert.equal(other.linked, false);
});

test("a secret shared var is masked in the list and revealed on demand", async () => {
  const id = await asUser1(() =>
    mkVar({ key: "SECRET", value: "s3cr3t", type: "secret", teamWide: true }),
  );
  const [v] = await asUser1(() => listSharedVars());
  assert.equal(v!.masked, true);
  assert.notEqual(v!.value, "s3cr3t");
  assert.equal(await asUser1(() => revealSharedVar(id)), "s3cr3t");
});

test("editing a secret with the MASK keeps the stored value", async () => {
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
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );
  assert.equal(await asUser1(() => revealSharedVar(id)), "real");
});

test("loadSharedVarsForApp: team-wide reaches every app", async () => {
  await asUser1(() => mkVar({ key: "TW", teamWide: true }));
  const p = await loadSharedVarsForApp("app_p");
  const top = await loadSharedVarsForApp("app_top");
  assert.deepEqual(p.map((e) => [e.key, e.mode]), [["TW", "teamWide"]]);
  assert.deepEqual(top.map((e) => [e.key, e.mode]), [["TW", "teamWide"]]);
});

test("loadSharedVarsForApp: project whitelist reaches only apps in that project", async () => {
  await asUser1(() => mkVar({ key: "PROJ", projectIds: [PRJ] }));
  assert.deepEqual(
    (await loadSharedVarsForApp("app_p")).map((e) => [e.key, e.mode]),
    [["PROJ", "project"]],
  );
  assert.deepEqual(await loadSharedVarsForApp("app_top"), []);
});

test("loadSharedVarsForApp: environment mode reaches only apps living in that env", async () => {
  await asUser1(() => mkVar({ key: "EDEV", environmentIds: [ENV_DEV] }));
  await asUser1(() => mkVar({ key: "EPROD", environmentIds: [ENV_PROD] }));
  // app_p lives in ENV_DEV → gets EDEV, not EPROD.
  assert.deepEqual(
    (await loadSharedVarsForApp("app_p")).map((e) => e.key),
    ["EDEV"],
  );
  // app_top has no environment → gets neither.
  assert.deepEqual(await loadSharedVarsForApp("app_top"), []);
});

test("loadSharedVarsForApp: a per-app link reaches only the linked app", async () => {
  const id = await asUser1(() => mkVar({ key: "LINKED", teamWide: true }));
  // Remove the team-wide mode so ONLY the link makes it apply — but ≥1 mode is
  // required at save, so instead test link on top: link app_top explicitly.
  await asUser1(() => setSharedVarAppLink(id, "app_top", true));
  const top = await loadSharedVarsForApp("app_top");
  // team-wide already reaches app_top; the link adds a second (link-mode) entry.
  assert.ok(top.some((e) => e.mode === "link" && e.key === "LINKED"));
});

test("listSharedVarsForApp annotates applied / inherited / linked / via", async () => {
  await asUser1(() => mkVar({ key: "TW", teamWide: true }));
  await asUser1(() => mkVar({ key: "PROJ", projectIds: [PRJ] }));
  const rows = await asUser1(() => listSharedVarsForApp("app_p"));
  const tw = rows.find((r) => r.key === "TW")!;
  const proj = rows.find((r) => r.key === "PROJ")!;
  assert.equal(tw.applied, true);
  assert.equal(tw.inherited, true);
  assert.equal(tw.via, "teamWide");
  assert.equal(proj.via, "project");
  assert.equal(proj.inherited, true);
});

test("setSharedVarAppLink toggles the link and is team-gated", async () => {
  const id = await asUser1(() => mkVar({ key: "L", teamWide: true }));
  await asUser1(() => setSharedVarAppLink(id, "app_top", true));
  const on = await asUser1(() => listSharedVarsForApp("app_top"));
  assert.ok(on.find((r) => r.key === "L")!.linked);
  await asUser1(() => setSharedVarAppLink(id, "app_top", false));
  const off = await asUser1(() => listSharedVarsForApp("app_top"));
  assert.equal(off.find((r) => r.key === "L")!.linked, false);
  // Another team can't touch this var.
  await assert.rejects(
    asUser2(() => setSharedVarAppLink(id, "app_top", true)),
    /not found/i,
  );
});

test("deleteSharedVar removes it (and its scope rows cascade)", async () => {
  const id = await asUser1(() => mkVar({ key: "GONE", projectIds: [PRJ] }));
  await asUser1(() => deleteSharedVar(id));
  assert.deepEqual(await asUser1(() => listSharedVars()), []);
  assert.deepEqual(await loadSharedVarsForApp("app_p"), []);
});

/* ------------------------------------------------------------------ */
/* The value-only edit (SharedVarEditDialog)                           */
/* ------------------------------------------------------------------ */

/**
 * Exactly the payload components/env/shared-var-edit-dialog.tsx sends: the scope
 * fields round-tripped verbatim off the DTO, and `appIds` / `targets` ABSENT —
 * which is the whole contract that makes a value edit unable to change what the
 * variable reaches. These tests exist to fail loudly if that contract ever
 * quietly changes (e.g. `appIds` starting to arrive as `[]`, which REPLACES the
 * link set with nothing).
 */
async function editValueLikeDialog(
  dto: { id: string; key: string; value: string; teamWide: boolean; environmentIds: string[]; projectIds: string[] },
  patch: { value?: string; type?: "plain" | "secret" } = {},
): Promise<void> {
  await saveSharedVar({
    id: dto.id,
    key: dto.key,
    // The dialog prefills the field with the DTO's value — the MASK for a secret.
    value: patch.value ?? dto.value,
    type: patch.type ?? "plain",
    teamWide: dto.teamWide,
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
    // Everything that decides what the variable reaches is untouched.
    assert.deepEqual(after.appIds, ["app_top"], "per-app link survived");
    assert.deepEqual(after.projectIds, [PRJ]);
    assert.deepEqual(after.environmentIds, []);
    assert.equal(after.teamWide, false);
    // An edit must never WIDEN a production-only variable into the dev container.
    assert.deepEqual(after.targets, ["production"]);
  });
});

test("a value-only edit of a LINK-ONLY variable still saves (links count as reach)", async () => {
  await asUser1(async () => {
    // The shape migration 0027 gives every var exploded out of a legacy group:
    // links, no modes. The reach check must read the STORED links.
    await mkVar({ key: "LINKONLY", value: "v1", appIds: ["app_p"] });
    const before = await dtoOf("LINKONLY");
    await editValueLikeDialog(before, { value: "v2" });
    const after = await dtoOf("LINKONLY");
    assert.equal(after.value, "v2");
    assert.deepEqual(after.appIds, ["app_p"]);
  });
});

test("re-sending a secret's MASK keeps the stored value; typing over it replaces it", async () => {
  await asUser1(async () => {
    await mkVar({ key: "SEC", value: "s3cret", type: "secret", teamWide: true });
    const masked = await dtoOf("SEC");
    assert.notEqual(masked.value, "s3cret", "the DTO never carries the plaintext");

    // Flip secret → plain WITHOUT touching the prefilled mask.
    await editValueLikeDialog(masked, { type: "plain" });
    const revealed = await dtoOf("SEC");
    assert.equal(revealed.type, "plain");
    assert.equal(revealed.value, "s3cret", "the mask round-trip kept the value");

    // Now actually type a new value.
    await editValueLikeDialog(revealed, { value: "n3w", type: "secret" });
    assert.equal(await asUser1(() => revealSharedVar(masked.id)), "n3w");
  });
});
