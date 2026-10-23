import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import {
  deploExport,
  exportApp,
  exportDatabase,
} from "../../migration/deplo/deplo-test-helpers";
import type {
  DeploExport,
  DeploExportRole,
} from "../../migration/deplo/export-shape";
import { runWithIdentity } from "../../auth/request-context";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapsTable,
} from "../../db/schema/control-plane/access-control";
import { TEAM_A } from "../identity-test-helpers";
import { capabilitiesForRole } from "../../membership-shared";
import { listFolders } from "../folders";
import { listProjects } from "../projects/read";
import { listApps } from "../apps/listing";
import { getMemberAccess } from "../user-access";
import { listRoles } from "../roles/role-list";
import { importMigrationMembers } from "./member-invites";
import {
  asOwner,
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  DEPLO_SOURCE,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";

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

const FOLDERS = [
  { id: "fld_a", name: "Clients", parentId: null, color: "#112233" },
  { id: "fld_b", name: "Big", parentId: "fld_a", color: null },
];

const outside = () =>
  deploExport({
    folders: FOLDERS,
    apps: [
      exportApp({
        id: "prj_top",
        name: "top-web",
        slug: "top-web",
        projectId: null,
        environmentId: null,
      }),
      exportApp({
        id: "prj_big",
        name: "big-web",
        slug: "big-web",
        projectId: null,
        environmentId: null,
        folderId: "fld_b",
      }),
    ],
    databases: [exportDatabase({ environmentId: null })],
  });

test("apps in a folder land in the same folder tree, not in a project", async () => {
  await importFromDeplo(outside(), ["folder:fld_b"]);
  const folders = await asOwner(() => listFolders());
  const clients = folders.find((f) => f.name === "Clients");
  const big = folders.find((f) => f.name === "Big");
  assert.ok(clients && big, "both folders landed");
  assert.equal(clients.color, "#112233");
  assert.equal(big.parentId, clients.id);
  const app = (await asOwner(() => listApps())).find(
    (a) => a.name === "big-web",
  );
  assert.equal(app?.folderId, big.id);
  assert.equal(app?.projectId ?? null, null);
  assert.equal(
    (await asOwner(() => listProjects())).some((p) => p.name.includes("Big")),
    false,
  );
});

test("a folder already here is reused rather than made twice", async () => {
  await importFromDeplo(outside(), ["folder:fld_b"]);
  await importFromDeplo(outside(), ["folder:fld_b"]);
  const folders = await asOwner(() => listFolders());
  assert.equal(folders.filter((f) => f.name === "Big").length, 1);
  assert.equal(folders.filter((f) => f.name === "Clients").length, 1);
});

const T0 = "2026-01-01T00:00:00.000Z";
const LIMITED = "user_limited";

async function seedPeople() {
  await db.insert(usersTable).values(
    ["dana", "erin"].map((id) => ({
      id: `user_${id}`,
      email: `${id}@acme.test`,
      username: id,
      name: id[0].toUpperCase() + id.slice(1),
      role: "member",
      avatarColor: "#abc",
      createdAt: T0,
      updatedAt: T0,
    })),
  );
}

const ROLES: DeploExportRole[] = [
  {
    id: "role_src_viewer",
    name: "Viewer",
    description: null,
    builtinKey: "viewer",
    capabilities: capabilitiesForRole("viewer"),
    scoped: false,
    requireTwoFactor: false,
    scope: null,
  },
  {
    id: "role_src_deployers",
    name: "Deployers",
    description: "Ship it",
    builtinKey: null,
    capabilities: ["view", "deploy_apps"],
    scoped: false,
    requireTwoFactor: false,
    scope: null,
  },
];

const withAccess = (access: DeploExport["access"]): DeploExport => ({
  ...outside(),
  members: [
    { email: "dana@acme.test", name: "Dana", role: "Deployers" },
    { email: "erin@acme.test", name: "Erin", role: "Viewer" },
    { email: "frank@acme.test", name: "Frank", role: "Deployers" },
  ],
  access,
});

const ACCESS: DeploExport["access"] = {
  roles: ROLES,
  members: [
    {
      email: "dana@acme.test",
      rank: "member",
      roleId: "role_src_deployers",
      granular: false,
      customCapabilities: false,
      capabilities: ["view", "deploy_apps"],
      grants: [],
    },
    {
      email: "erin@acme.test",
      rank: "viewer",
      roleId: "role_src_viewer",
      granular: true,
      customCapabilities: false,
      capabilities: capabilitiesForRole("viewer"),
      grants: [
        { kind: "folder", nodeId: "fld_b", capabilities: ["deploy_apps"] },
      ],
    },
    {
      email: "frank@acme.test",
      rank: "member",
      roleId: "role_src_deployers",
      granular: false,
      customCapabilities: false,
      capabilities: ["view", "deploy_apps"],
      grants: [],
    },
  ],
};

async function bringMembers(
  runId: string,
  as: <T>(fn: () => Promise<T>) => Promise<T> = asOwner,
) {
  await as(() => importMigrationMembers({ ...DEPLO_SOURCE, runId }));
}

test("a custom role comes across, and members already here get it and their folder access", async () => {
  await seedPeople();
  const runId = await importFromDeplo(withAccess(ACCESS), ["folder:fld_b"]);
  await bringMembers(runId);

  const dana = await asOwner(() => getMemberAccess("user_dana"));
  assert.equal(dana?.roleName, "Deployers");
  assert.deepEqual([...dana!.baseCapabilities].sort(), ["deploy_apps", "view"]);
  const big = (await asOwner(() => listFolders())).find(
    (f) => f.name === "Big",
  )!;
  const erin = await asOwner(() => getMemberAccess("user_erin"));
  assert.equal(erin?.roleName, "Viewer");
  assert.equal(erin?.granular, true);
  assert.deepEqual(
    erin?.nodes.map((n) => [n.kind, n.nodeId, [...n.capabilities].sort()]),
    [["folder", big.id, ["deploy_apps", "view"]]],
  );
  const lines = (await reportLines(runId)).join("\n");
  assert.match(lines, /Frank.*Deployers/);
  assert.doesNotMatch(lines, /Dana[^\n]*restor/);
});

test("whoever runs the migration cannot hand out more than they hold", async () => {
  await seedPeople();
  await db.insert(usersTable).values({
    id: LIMITED,
    email: "limited@here.test",
    username: "limited",
    name: "Limited",
    role: "member",
    isInstanceAdmin: true,
    avatarColor: "#abc",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(membershipsTable).values({
    id: `mem_${LIMITED}`,
    userId: LIMITED,
    teamId: TEAM_A,
    role: "member",
    createdAt: T0,
  });
  await db
    .insert(membershipCapsTable)
    .values(
      (
        ["view", "create_projects", "manage_members", "manage_roles"] as const
      ).map((capability) => ({ membershipId: `mem_${LIMITED}`, capability })),
    );
  const runId = await importFromDeplo(withAccess(ACCESS), ["folder:fld_b"]);
  await bringMembers(runId, (fn) =>
    runWithIdentity({ userId: LIMITED, teamId: TEAM_A }, fn),
  );

  for (const id of ["user_dana", "user_erin"]) {
    const a = await asOwner(() => getMemberAccess(id));
    assert.ok(a, `${id} joined`);
    assert.deepEqual(a.baseCapabilities, ["view"]);
    assert.deepEqual(a.nodes, []);
  }
  const lines = (await reportLines(runId)).join("\n");
  assert.match(lines, /Dana/);
  assert.match(lines, /Erin/);
});

test("a role scoped to a folder reaches the imported folder, and nothing that did not come across", async () => {
  await seedPeople();
  const scoped: DeploExportRole = {
    ...ROLES[1],
    id: "role_src_ops",
    name: "Ops",
    scoped: true,
    scope: {
      projectIds: ["prc_not_imported"],
      environmentIds: [],
      folderIds: ["fld_b"],
      appIds: [],
    },
  };
  const runId = await importFromDeplo(
    withAccess({
      roles: [...ROLES, scoped],
      members: [{ ...ACCESS!.members[0], roleId: "role_src_ops" }],
    }),
    ["folder:fld_b"],
  );
  await bringMembers(runId);
  const big = (await asOwner(() => listFolders())).find(
    (f) => f.name === "Big",
  )!;
  const ops = (await asOwner(() => listRoles())).find((r) => r.name === "Ops");
  assert.deepEqual(ops?.scope, {
    projectIds: [],
    environmentIds: [],
    folderIds: [big.id],
    appIds: [],
  });
  const lines = (await reportLines(runId)).join("\n");
  assert.match(lines, /reaches only what did/);
  assert.match(lines, /Dana[^\n]*did not come across/);
});

test("an older Deplo that sends no access says so", async () => {
  await seedPeople();
  const runId = await importFromDeplo(withAccess(undefined), ["folder:fld_b"]);
  await bringMembers(runId);
  assert.match(
    (await reportLines(runId)).join("\n"),
    /too old to send its roles/,
  );
});

test("what was at the top level stays at the top level", async () => {
  await importFromDeplo(outside(), ["top:team_src"]);
  assert.equal(
    (await asOwner(() => listProjects())).some((p) => p.name === "Acme"),
    false,
  );
  const app = (await asOwner(() => listApps())).find(
    (a) => a.name === "top-web",
  );
  assert.ok(app, "the app landed");
  assert.equal(app.folderId ?? null, null);
  assert.equal(app.projectId ?? null, null);
});
