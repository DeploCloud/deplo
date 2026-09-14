import {
  asOwner,
  CONNECT,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { runWithIdentity } from "../../auth/request-context";
import { TEAM_B, USER_1 } from "../identity-test-helpers";
import { moveMigrationServiceData } from "./move";

before(async () => {
  await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a service this run did not import cannot be moved into anything", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-ghost",
        }),
      ),
    /did not create anything/,
  );
});

test("a service Dokploy no longer has is refused before anything else", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-vanished",
        }),
      ),
    /no longer on the Dokploy instance/,
  );
});

test("a run from another team is not a place to write a report", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
        }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});
