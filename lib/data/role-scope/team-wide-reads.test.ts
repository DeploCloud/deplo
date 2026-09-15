import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { teamRoles as teamRolesTable } from "../../db/schema/control-plane/access-control";
import { TEAM_A } from "../identity-test-helpers";
import {
  DEV,
  PRC_IN,
  ROLE,
  as,
  scopeTo,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("a scoped member can still pick where an app runs", async () => {
  const { listServerChoices, listServersForCurrentTeam } =
    await import("../servers/roster");
  await scopeTo(h, { projects: [PRC_IN] });

  const choices = await as(DEV, () => listServerChoices());
  assert.ok(choices.length > 0, "the server picker came back empty");
  assert.deepEqual(
    Object.keys(choices[0]).sort(),
    ["id", "isDeploHost", "name", "type"],
    "the picker is a menu, not the fleet's inventory",
  );

  await assert.rejects(
    () => as(DEV, () => listServersForCurrentTeam()),
    /only reaches part of this team/,
  );
});

test("the live database stream refuses a scoped member, with no request to read", async () => {
  const { seedDatabase } = await import("../backup-test-helpers");
  const { databaseStatusStream } = await import("../../graphql/types/database");
  await seedDatabase(h.db, { id: "db_main", name: "main" });
  await scopeTo(h, { projects: [PRC_IN] });

  await assert.rejects(
    () => databaseStatusStream("db_main", TEAM_A, DEV).next(),
    /Database not found/,
    "the stream handed a scoped member a database",
  );

  await h.db
    .update(teamRolesTable)
    .set({ scoped: false })
    .where(eq(teamRolesTable.id, ROLE));
  const gen = databaseStatusStream("db_main", TEAM_A, DEV);
  const first = await gen.next();
  assert.equal(first.value?.id, "db_main");
  await gen.return(undefined as never);
});

test("nothing that belongs to the whole team is reachable through a point lookup", async () => {
  const { seedDatabase } = await import("../backup-test-helpers");
  await seedDatabase(h.db, { id: "db_main", name: "main" });
  await scopeTo(h, { projects: [PRC_IN] });

  const { getDatabase } = await import("../databases/rows");
  const { getServer } = await import("../servers/roster");
  assert.equal(await as(DEV, () => getDatabase("db_main")), null);
  assert.equal(await as(DEV, () => getServer("srv_1")), null);

  await h.db
    .update(teamRolesTable)
    .set({ scoped: false })
    .where(eq(teamRolesTable.id, ROLE));
  assert.ok(await as(DEV, () => getDatabase("db_main")));
  assert.ok(await as(DEV, () => getServer("srv_1")));
});

test("every team-wide read refuses a scoped member, in their own words", async () => {
  const { listMembers } = await import("../members/roster");
  const { listRoles } = await import("../roles/role-list");
  const { listRegistries } = await import("../registries");
  const { listDatabases } = await import("../databases/rows");
  const { listSharedVars } = await import("../shared-vars/team-view");
  const { getTeam } = await import("../teams");
  const { listGithubApps } = await import("../github");
  const { listDestinations } = await import("../destinations/listing");
  const { listNotificationChannels } = await import("../notifications");

  const reads: [string, () => Promise<unknown>][] = [
    ["members", listMembers],
    ["roles", listRoles],
    ["registries", listRegistries],
    ["databases", listDatabases],
    ["shared variables", listSharedVars],
    ["team settings", getTeam],
    ["git connections", listGithubApps],
    ["backup destinations", listDestinations],
    ["notifications", listNotificationChannels],
  ];

  for (const [what, call] of reads) {
    await as(DEV, call).catch((e: Error) => {
      assert.doesNotMatch(
        e.message,
        /only reaches part of this team/,
        `${what} refused an unscoped member as if they were scoped`,
      );
    });
  }

  await scopeTo(h, { projects: [PRC_IN] });

  for (const [what, call] of reads) {
    await assert.rejects(
      () => as(DEV, call),
      (e: Error) => {
        assert.match(
          e.message,
          /only reaches part of this team/,
          `${what} refused for the wrong reason: ${e.message}`,
        );
        assert.doesNotMatch(
          e.message,
          /This API token is limited/,
          `${what} told a person their session was an API token`,
        );
        return true;
      },
      `${what} was readable by a member limited to one project`,
    );
  }
});
