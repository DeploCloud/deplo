import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { type Capability } from "../../types/identity";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../leaf-test-helpers";
import { authenticateToken } from "./authenticate";
import { listTokens } from "./listing";
import { createToken, updateToken } from "./mint";
import { revokeToken } from "./revoke";
import {
  TRUNCATE,
  asUser1,
  alsoMemberOfB,
  seedProject,
} from "./tokens-test-helpers";

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

test("a scoped API token can't mint a token reaching a team outside its scope (M-2)", async () => {
  await alsoMemberOfB(db);
  const asScopedToken = <T>(
    scopeTeamIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> =>
    runWithIdentity(
      {
        userId: USER_1,
        teamId: TEAM_A,
        token: {
          id: "tok_actor",
          capabilities: ["view", "manage_tokens"] as Capability[],
          instanceAdmin: false,
          scope: {
            teamIds: scopeTeamIds,
            wholeTeamIds: scopeTeamIds,
            projectIds: [],
            folderIds: [],
            appIds: [],
            appProjectIds: [],
          },
        },
      },
      fn,
    );

  await asScopedToken([TEAM_A], async () => {
    await assert.rejects(
      () =>
        createToken({
          name: "into-B",
          capabilities: ["view"],
          teamIds: [TEAM_B],
        }),
      /outside its own scope/i,
    );
    await assert.rejects(
      () => createToken({ name: "unscoped", capabilities: ["view"] }),
      /can't mint an unscoped token/i,
    );
  });

  const cookie = await asUser1(() =>
    createToken({ name: "cookie", capabilities: ["view"], teamIds: [TEAM_B] }),
  );
  assert.ok(cookie.raw.startsWith("deplo_"));
  await asScopedToken([TEAM_A, TEAM_B], async () => {
    const ok = await createToken({
      name: "both",
      capabilities: ["view"],
      teamIds: [TEAM_B],
    });
    assert.ok(ok.raw.startsWith("deplo_"));
  });
});

test("a token can't mint a successor above itself, in any team it reaches (M-3)", async () => {
  await alsoMemberOfB(db);
  const { raw } = await asUser1(() =>
    createToken({ name: "read only", capabilities: ["view"] }),
  );
  const acting = (await authenticateToken(raw))!;
  assert.deepEqual(acting.token!.capabilities, ["view"]);

  await runWithIdentity(acting, async () => {
    await assert.rejects(
      () =>
        createToken({
          name: "same team",
          capabilities: ["delete_apps"],
          teamIds: [TEAM_A],
        }),
      /permissions you hold yourself/i,
    );
    await assert.rejects(
      () =>
        createToken({
          name: "other team",
          capabilities: ["delete_apps"],
          teamIds: [TEAM_B],
        }),
      /permissions you hold yourself/i,
    );
    await assert.rejects(
      () => createToken({ name: "unscoped", capabilities: ["delete_apps"] }),
      /permissions you hold yourself/i,
    );
    const sibling = await createToken({
      name: "sibling",
      capabilities: ["view"],
    });
    assert.deepEqual(sibling.token.capabilities, ["view"]);
  });

  const cookie = await asUser1(() =>
    createToken({ name: "cookie", capabilities: ["delete_apps"] }),
  );
  assert.ok(cookie.token.capabilities.includes("delete_apps"));
});

test("a token can't re-author itself above what it holds", async () => {
  await alsoMemberOfB(db);
  const { raw, token } = await asUser1(() =>
    createToken({ name: "read only", capabilities: ["view"] }),
  );
  const acting = (await authenticateToken(raw))!;

  await runWithIdentity(acting, () =>
    assert.rejects(
      () =>
        updateToken({
          id: token.id,
          name: "read only",
          capabilities: ["delete_apps"],
          teamIds: [TEAM_B],
        }),
      /permissions you hold yourself/i,
    ),
  );
  assert.deepEqual((await authenticateToken(raw))?.token?.capabilities, [
    "view",
  ]);

  await runWithIdentity(acting, () =>
    updateToken({ id: token.id, name: "renamed", capabilities: ["view"] }),
  );
  assert.equal((await asUser1(() => listTokens()))[0]!.name, "renamed");
});

test("a token narrowed to one project can't mint a whole-team token, nor reach another project", async () => {
  await seedProject(db, "prc_a", TEAM_A, "A");
  await seedProject(db, "prc_b", TEAM_A, "B");
  const asNarrow = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithIdentity(
      {
        userId: USER_1,
        teamId: TEAM_A,
        token: {
          id: "tok_narrow",
          capabilities: ["view", "manage_tokens"] as Capability[],
          instanceAdmin: false,
          scope: {
            teamIds: [TEAM_A],
            wholeTeamIds: [],
            projectIds: ["prc_a"],
            folderIds: [],
            appIds: [],
            appProjectIds: [],
          },
        },
      },
      fn,
    );
  await asNarrow(async () => {
    await assert.rejects(
      () =>
        createToken({
          name: "whole",
          capabilities: ["view"],
          teamIds: [TEAM_A],
        }),
      /outside its own scope/i,
      "the team it reaches through one project is not a team it holds",
    );
    await assert.rejects(
      () =>
        createToken({
          name: "other",
          capabilities: ["view"],
          projectIds: ["prc_b"],
        }),
      /outside its own scope/i,
    );
    const ok = await createToken({
      name: "same",
      capabilities: ["view"],
      projectIds: ["prc_a"],
    });
    assert.deepEqual(ok.token.projectIds, ["prc_a"]);
  });
});

test("a bearer token edits and revokes only ITSELF", async () => {
  const a = await asUser1(() =>
    createToken({ name: "a", capabilities: ["view", "manage_tokens"] }),
  );
  const b = await asUser1(() =>
    createToken({ name: "b", capabilities: ["view"] }),
  );
  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithIdentity(
      {
        userId: USER_1,
        teamId: TEAM_A,
        token: {
          id: a.token.id,
          capabilities: ["view", "manage_tokens"] as Capability[],
          instanceAdmin: false,
          scope: null,
        },
      },
      fn,
    );
  await asA(async () => {
    await assert.rejects(
      () => updateToken({ id: b.token.id, name: "renamed" }),
      /Token not found/,
    );
    await assert.rejects(() => revokeToken(b.token.id), /Token not found/);
    await updateToken({ id: a.token.id, name: "me" });
  });
  const names = (await asUser1(() => listTokens())).map((t) => t.name).sort();
  assert.deepEqual(names, ["b", "me"]);
});
