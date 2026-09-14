import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenProjects,
} from "../../db/schema/control-plane/api-tokens";
import { ALL_CAPABILITIES } from "../../types/identity";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../leaf-test-helpers";
import { listTokens } from "./listing";
import { createToken, updateToken } from "./mint";
import { TRUNCATE, asUser1, seedProject } from "./tokens-test-helpers";

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
  await pg.exec(TRUNCATE);
  await seedIdentity(db);
});

test("createToken persists its own capability set, in catalog order, with the view floor", async () => {
  await asUser1(async () => {
    const { raw, token } = await createToken({
      name: "CI",
      capabilities: ["view_logs", "deploy_apps"],
    });
    assert.ok(raw.startsWith("deplo_"), "raw token is a deplo_ token");
    assert.equal(token.name, "CI");
    assert.equal(token.lastUsedAt, null);
    assert.deepEqual(token.capabilities, ["view", "deploy_apps", "view_logs"]);

    const list = await listTokens();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, token.id);
    assert.equal(list[0]!.prefix, raw.slice(0, 12));
    assert.deepEqual(list[0]!.capabilities, [
      "view",
      "deploy_apps",
      "view_logs",
    ]);
    assert.equal(list[0]!.scoped, false);
    assert.deepEqual(list[0]!.teamIds, []);
    assert.deepEqual(list[0]!.projectIds, []);
    assert.deepEqual(list[0]!.appIds, []);
    assert.equal("tokenHash" in list[0]!, false);
  });

  const rows = await db.select().from(apiTokens);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.tokenHash, "");
});

test("a token with no capabilities named is view-only, never everything", async () => {
  await asUser1(async () => {
    const { token } = await createToken({ name: "Bare" });
    assert.deepEqual(token.capabilities, ["view"]);
  });
});

test("createToken rejects a blank name", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "   " }),
      /Give the token a name/,
    );
  });
});

test("a non-owner can't mint a token more powerful than themselves", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      {
        id: USER_1,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_tokens", "deploy_apps"],
      },
    ],
  });
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "Escalate", capabilities: ["delete_apps"] }),
      /only give a token permissions you hold yourself[\s\S]*delete apps/,
    );
    const { token } = await createToken({
      name: "Fine",
      capabilities: ["deploy_apps"],
    });
    assert.deepEqual(token.capabilities, ["view", "deploy_apps"]);
  });
});

test("an owner can mint Root access", async () => {
  await asUser1(async () => {
    const { token } = await createToken({
      name: "Root",
      capabilities: [...ALL_CAPABILITIES],
    });
    assert.deepEqual(token.capabilities, ALL_CAPABILITIES);
  });
});

test("a retired coarse capability name still expands on the token path", async () => {
  await asUser1(async () => {
    const { token } = await createToken({
      name: "Legacy",
      capabilities: ["deploy" as never],
    });
    assert.ok(token.capabilities.includes("deploy_apps"));
    assert.ok(
      token.capabilities.length > 2,
      "it expanded to more than the floor",
    );
  });
});

test("a project scope round-trips, and a foreign project writes nothing", async () => {
  await seedProject(db, "prc_a", TEAM_A, "Alpha");
  await seedProject(db, "prc_b", TEAM_B, "Beta");
  await asUser1(async () => {
    const { token } = await createToken({
      name: "Scoped",
      capabilities: ["deploy_apps"],
      projectIds: ["prc_a"],
    });
    assert.equal(token.scoped, true);
    assert.deepEqual(token.projectIds, ["prc_a"]);

    await assert.rejects(
      () =>
        createToken({
          name: "Foreign",
          projectIds: ["prc_b"],
        }),
      /isn't in a team you can use API tokens in/,
    );
  });
  assert.equal((await db.select().from(apiTokens)).length, 1);
  assert.equal((await db.select().from(apiTokenProjects)).length, 1);
});

test("instance admin is opt-in per token, and only an instance admin may grant it", async () => {
  await asUser1(async () => {
    const { token } = await createToken({ name: "Ops", instanceAdmin: true });
    assert.equal(token.instanceAdmin, true);
    await assert.rejects(
      () =>
        createToken({
          name: "Contradiction",
          instanceAdmin: true,
          projectIds: ["prc_a"],
        }),
      /can't administer the instance/,
    );
  });

  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      {
        id: USER_1,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_tokens"],
      },
    ],
  });
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "Sneaky", instanceAdmin: true }),
      /Only an instance admin/,
    );
  });
});

test("a non-admin can't edit a token that administers the instance", async () => {
  const id = await asUser1(
    async () =>
      (await createToken({ name: "Ops", instanceAdmin: true })).token.id,
  );
  await pg.exec(`delete from membership_capabilities;`);
  await db.execute(
    `insert into membership_capabilities (membership_id, capability) values ('mem_${USER_1}', 'view'), ('mem_${USER_1}', 'manage_tokens')`,
  );
  await db.execute(
    `update users set is_instance_admin = false where id = '${USER_1}'`,
  );

  await asUser1(async () => {
    await assert.rejects(
      () => updateToken({ id, name: "Hijacked", capabilities: ["view"] }),
      /Only an instance admin/,
    );
  });
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
  assert.equal(
    rows[0]!.instanceAdmin,
    true,
    "the bit was not silently cleared",
  );
  assert.equal(rows[0]!.name, "Ops");
});

test("updateToken rewrites both junctions rather than merging into them", async () => {
  await seedProject(db, "prc_a", TEAM_A, "Alpha");
  const id = await asUser1(
    async () =>
      (
        await createToken({
          name: "Scoped",
          capabilities: ["deploy_apps", "view_logs"],
          projectIds: ["prc_a"],
        })
      ).token.id,
  );
  await asUser1(async () => {
    await updateToken({ id, name: "Narrowed", capabilities: ["view_logs"] });
    const t = (await listTokens())[0]!;
    assert.equal(t.name, "Narrowed");
    assert.deepEqual(t.capabilities, ["view", "view_logs"]);
    assert.equal(t.scoped, false);
    assert.deepEqual(t.projectIds, []);
  });
  assert.equal(
    (await db.select().from(apiTokenCapabilities)).length,
    2,
    "the old capability rows are gone, not merged",
  );
  assert.equal((await db.select().from(apiTokenProjects)).length, 0);
});
