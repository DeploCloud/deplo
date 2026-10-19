import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { users } from "../../db/schema/control-plane/identity";
import { apps, appTraefikLabels } from "../../db/schema/control-plane/apps";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, USER_1, TEAM_A, TEAM_B } from "../identity-test-helpers";
import { seedServer, seedApp } from "../app-graph-test-helpers";
import {
  appTraefikOverrides,
  authorizeComposeTraefik,
  getAppTraefikLabels,
  setAppTraefikLabels,
} from "./traefik-labels";
import { updateAppSource } from "./source";
import { updateUserAdmin } from "../members/instance-users";

let db: TestDb;
let pg: PGlite;
const label = { key: "traefik.enable", value: "false" };
const asUser = <T>(fn: () => T) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __resetTestDb();
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    "TRUNCATE apps, servers, users, teams RESTART IDENTITY CASCADE",
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
      { id: "other", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      { id: "admin", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "app1", source: "docker-image" });
  await seedApp(db, { id: "app2", source: "docker-image", teamId: TEAM_B });
});

test("team owners cannot configure proxy labels or grant themselves permission", async () => {
  await asUser(async () => {
    await assert.rejects(
      setAppTraefikLabels("app1", [label]),
      /Configure Traefik/,
    );
    await assert.rejects(
      updateUserAdmin({
        userId: USER_1,
        isInstanceAdmin: false,
        suspended: false,
        canExposePorts: false,
        canMountHostVolumes: false,
        canConfigureTraefik: true,
      }),
    );
  });
  assert.equal((await db.select().from(appTraefikLabels)).length, 0);
});

test("instance admins can delegate; delegated users remain limited to their apps", async () => {
  await runWithIdentity({ userId: "admin", teamId: TEAM_A }, () =>
    updateUserAdmin({
      userId: USER_1,
      isInstanceAdmin: false,
      suspended: false,
      canExposePorts: false,
      canMountHostVolumes: false,
      canConfigureTraefik: true,
    }),
  );
  await asUser(async () => {
    await setAppTraefikLabels("app1", [label]);
    assert.deepEqual(await getAppTraefikLabels("app1"), [label]);
    await assert.rejects(setAppTraefikLabels("app2", [label]));
    await assert.rejects(getAppTraefikLabels("app2"));
  });
  const [app] = await db.select().from(apps).where(eq(apps.id, "app1"));
  assert.equal(app.traefikLabelsBy, USER_1);
  assert.ok(app.pendingChangesAt);
  assert.deepEqual(await appTraefikOverrides("app1"), {
    allowTraefikLabels: true,
    traefikLabels: [label],
  });
});

test("revocation, suspension and deletion invalidate background routing authorization", async () => {
  await db
    .update(users)
    .set({ canConfigureTraefik: true })
    .where(eq(users.id, USER_1));
  await asUser(() => setAppTraefikLabels("app1", [label]));
  await db
    .update(users)
    .set({ canConfigureTraefik: false })
    .where(eq(users.id, USER_1));
  await assert.rejects(appTraefikOverrides("app1"), /no longer/);
  await db
    .update(users)
    .set({ canConfigureTraefik: true, suspended: true })
    .where(eq(users.id, USER_1));
  await assert.rejects(appTraefikOverrides("app1"), /no longer/);
  await db.delete(users).where(eq(users.id, USER_1));
  await assert.rejects(appTraefikOverrides("app1"), /no longer/);
});

test("previews never inherit custom routing", async () => {
  await db
    .update(users)
    .set({ canConfigureTraefik: true })
    .where(eq(users.id, USER_1));
  await asUser(() => setAppTraefikLabels("app1", [label]));
  assert.deepEqual(await appTraefikOverrides("app1", true), {
    allowTraefikLabels: false,
    traefikLabels: [],
  });
});

test("repeated saves replace labels, validation is atomic, empty restores defaults", async () => {
  await db
    .update(users)
    .set({ canConfigureTraefik: true })
    .where(eq(users.id, USER_1));
  await asUser(async () => {
    await setAppTraefikLabels("app1", [label]);
    await setAppTraefikLabels("app1", [label]);
    await assert.rejects(
      setAppTraefikLabels("app1", [{ key: "deplo.project", value: "victim" }]),
    );
    assert.deepEqual(await getAppTraefikLabels("app1"), [label]);
    await setAppTraefikLabels("app1", []);
  });
  assert.deepEqual(await appTraefikOverrides("app1"), {
    allowTraefikLabels: false,
    traefikLabels: [],
  });
});

test("Compose labels require the grant; plain Compose does not", async () => {
  const compose =
    "services:\n  web:\n    image: nginx\n    labels:\n      traefik.enable: false\n";
  await asUser(async () => {
    assert.equal(
      await authorizeComposeTraefik("services:\n  web:\n    image: nginx\n"),
      null,
    );
    await assert.rejects(authorizeComposeTraefik(compose), /Configure Traefik/);
  });
  await db
    .update(users)
    .set({ canConfigureTraefik: true })
    .where(eq(users.id, USER_1));
  assert.equal(await asUser(() => authorizeComposeTraefik(compose)), USER_1);
});

test("deleting an app deletes its labels", async () => {
  await runWithIdentity({ userId: "admin", teamId: TEAM_A }, () =>
    setAppTraefikLabels("app1", [label]),
  );
  await db.delete(apps).where(eq(apps.id, "app1"));
  assert.equal((await db.select().from(appTraefikLabels)).length, 0);
});

test("clearing an unused Compose field preserves editor authorization", async () => {
  await db
    .update(users)
    .set({ canConfigureTraefik: true })
    .where(eq(users.id, USER_1));
  await asUser(async () => {
    await setAppTraefikLabels("app1", [label]);
    await updateAppSource("app1", {
      source: "docker-image",
      repo: null,
      dockerImage: "nginx:alpine",
      compose: "",
    });
  });
  assert.deepEqual(await appTraefikOverrides("app1"), {
    allowTraefikLabels: true,
    traefikLabels: [label],
  });
});
