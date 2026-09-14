import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { teamRoleCapabilities as teamRoleCapabilitiesTable } from "../../db/schema/control-plane/access-control";
import { TEAM_A } from "../identity-test-helpers";
import type { Capability } from "../../types/identity";
import {
  ADMIN,
  APP_IN_PRC,
  APP_OUT_PRC,
  DEV,
  PRC_IN,
  PRC_OUT,
  ROLE,
  as,
  reaches,
  scopeTo,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("limiting a role limits its holders, and clearing it gives them the team back", async () => {
  const { updateRole } = await import("../roles/role-editing");
  const { listRoles } = await import("../roles/role-list");

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps"],
      scope: { projectIds: [PRC_IN] },
    }),
  );
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));
  assert.equal(await reaches({ kind: "app", id: APP_OUT_PRC }), false);
  const scoped = (await as(ADMIN, () => listRoles())).find(
    (r) => r.id === ROLE,
  )!;
  assert.deepEqual(scoped.scope?.projectIds, [PRC_IN]);

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps"],
      scope: null,
    }),
  );
  assert.ok(await reaches({ kind: "app", id: APP_OUT_PRC }));
  const wide = (await as(ADMIN, () => listRoles())).find((r) => r.id === ROLE)!;
  assert.equal(wide.scope, null);
});

test("a limited admin can neither widen a role nor reset one", async () => {
  const { updateRole } = await import("../roles/role-editing");
  const { resetRole } = await import("../roles/builtin-roles");
  const { listRoles } = await import("../roles/role-list");
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_roles' from memberships where user_id = '${DEV}'`,
  );
  await h.db
    .insert(teamRoleCapabilitiesTable)
    .values({ roleId: ROLE, capability: "manage_roles" });
  await scopeTo(h, { projects: [PRC_IN] });

  await assert.rejects(
    () =>
      as(DEV, () =>
        updateRole({
          id: ROLE,
          name: "Scoped",
          capabilities: ["view", "deploy_apps", "manage_roles"],
          scope: null,
        }),
      ),
    /your own role reaches part of this team/i,
    "an admin whose own role is limited minted an unrestricted one",
  );

  await assert.rejects(
    () =>
      as(DEV, () =>
        updateRole({
          id: ROLE,
          name: "Scoped",
          capabilities: ["view", "deploy_apps", "manage_roles"],
          scope: { projectIds: [PRC_OUT] },
        }),
      ),
    /isn't in this team any more/,
  );

  const viewer = (await as(ADMIN, () => listRoles())).find(
    (r) => r.builtinKey === "viewer",
  )!;
  await assert.rejects(
    () => as(DEV, () => resetRole(viewer.id)),
    /your own role reaches part of this team/i,
  );
});

test("a scoped role cannot hold a team-wide capability, however it was authored", async () => {
  await h.db
    .delete(teamRoleCapabilitiesTable)
    .where(eq(teamRoleCapabilitiesTable.roleId, ROLE));
  const authored: Capability[] = [
    "view",
    "deploy_apps",
    "manage_env",
    "manage_members",
    "manage_roles",
    "manage_team",
    "create_databases",
    "manage_tokens",
  ];
  await h.db
    .insert(teamRoleCapabilitiesTable)
    .values(authored.map((capability) => ({ roleId: ROLE, capability })));
  await scopeTo(h, { projects: [PRC_IN] });

  const { roleAssignment } = await import("../roles/role-assignment");
  const assignment = await roleAssignment(getDb(), TEAM_A, ROLE);
  assert.deepEqual(
    assignment.capabilities,
    ["view", "deploy_apps", "manage_env"],
    "a scoped role keeps only what still means something inside a project",
  );

  const stored = await h.db
    .select({ capability: teamRoleCapabilitiesTable.capability })
    .from(teamRoleCapabilitiesTable)
    .where(eq(teamRoleCapabilitiesTable.roleId, ROLE));
  assert.equal(stored.length, authored.length);
});

test("the picker mutes exactly what the save clamps away", async () => {
  const { PROJECT_SCOPED_CAPABILITIES } =
    await import("../../membership-shared");
  const { effectiveRoleCapabilities } =
    await import("../roles/member-capabilities");
  const { ALL_CAPABILITIES } = await import("../../types/identity");
  const muted = ALL_CAPABILITIES.filter(
    (c) => !PROJECT_SCOPED_CAPABILITIES.includes(c),
  );
  const dropped = ALL_CAPABILITIES.filter(
    (c) => !effectiveRoleCapabilities([...ALL_CAPABILITIES], true).includes(c),
  );
  assert.deepEqual(
    dropped,
    muted,
    "the editor would present a capability the save throws away",
  );
});
