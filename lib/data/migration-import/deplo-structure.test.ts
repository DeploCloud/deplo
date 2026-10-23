import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import type { DeploExportProject } from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import { listEnvironmentsForProject } from "../environments";
import { createProject } from "../projects/lifecycle";
import { listProjects } from "../projects/read";
import { listApps } from "../apps/listing";
import {
  asOwner,
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import { importFromDeplo } from "./deplo-import-test-helpers";
import { getMigrationRun } from "./run-queries";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
});

const SHOP: DeploExportProject = {
  id: "prc_shop",
  name: "Shop",
  color: "#ff8800",
  environments: [
    {
      id: "environ_prod",
      name: "Live",
      isDefault: true,
      kind: "production",
      gitBranch: "main",
    },
    {
      id: "environ_qa",
      name: "QA",
      isDefault: false,
      kind: "custom",
      gitBranch: "qa",
    },
  ],
};

async function landed(name: string) {
  return asOwner(async () => {
    const project = (await listProjects()).find((p) => p.name === name);
    assert.ok(project, `${name} landed`);
    const envs = await listEnvironmentsForProject(project.id);
    return {
      project,
      envs: envs.map((e) => [e.name, e.kind, e.gitBranch, e.isDefault]),
    };
  });
}

test("a new project lands with its colour, its environments and its default", async () => {
  await importFromDeplo(deploExport({ projects: [SHOP], databases: [] }), [
    "prc_shop",
  ]);
  const { project, envs } = await landed("Shop");
  assert.equal(project.color, "#ff8800");
  assert.deepEqual(envs, [
    ["Live", "production", "main", true],
    ["QA", "custom", "qa", false],
  ]);
});

test("a project with nothing in it still comes across", async () => {
  const later: DeploExportProject = { ...SHOP, id: "prc_later", name: "Later" };
  await importFromDeplo(
    deploExport({
      projects: [
        later,
        {
          ...SHOP,
          environments: SHOP.environments.map((e) => ({
            ...e,
            id: `${e.id}_2`,
          })),
        },
      ],
      databases: [],
    }),
    ["prc_later"],
  );
  const { envs } = await landed("Later");
  assert.deepEqual(
    envs.map((e) => e[0]),
    ["Live", "QA"],
  );
});

test("a project already here keeps its own colour and default", async () => {
  await asOwner(() => createProject("Shop", "#000000"));
  await importFromDeplo(deploExport({ projects: [SHOP], databases: [] }), [
    "prc_shop",
  ]);
  const { project, envs } = await landed("Shop");
  assert.equal(project.color, "#000000");
  assert.deepEqual(
    envs.find((e) => e[3]),
    ["Production", "production", "", true],
  );
  assert.ok(
    envs.some((e) => e[0] === "Live" && e[1] === "production"),
    "the missing environment is still created, with its kind",
  );
});

test("an environment Deplo cannot create keeps its apps out of the others, and says so", async () => {
  const tooLong = "An environment name far longer than allowed";
  const runId = await importFromDeplo(
    deploExport({
      projects: [
        {
          ...SHOP,
          environments: [
            SHOP.environments[0],
            { ...SHOP.environments[1], name: tooLong },
          ],
        },
      ],
      apps: [
        exportApp({
          id: "prj_qa",
          name: "qa-web",
          environmentId: "environ_qa",
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  const apps = await asOwner(() => listApps());
  assert.equal(
    apps.some((a) => a.name === "qa-web"),
    false,
    "the app did not land in another environment",
  );
  // A failure keeps its own count, so it is a failed line rather than a blocker.
  const failed = (await asOwner(() => getMigrationRun(runId)))!.items
    .filter((i) => i.outcome === "failed")
    .map((i) => i.message ?? "")
    .join("\n");
  assert.match(failed, /characters or fewer/);
  assert.match(failed, /qa-web/);
});
