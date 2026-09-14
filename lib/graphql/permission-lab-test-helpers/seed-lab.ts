import { before, after, beforeEach } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../../db/client";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { seedIdentity } from "../../data/identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH } from "../../data/app-graph-test-helpers";
import { ensureTeamRoles } from "../../data/roles/builtin-roles";
import { effectiveRoleCapabilities } from "../../data/roles/member-capabilities";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../../deploy/deploy-queue";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { __setTeardownDialForTest } from "../../data/teardown-queue";
import {
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
} from "../../data/domains/dns-check";
import { capabilitiesForRole } from "../../membership-shared";
import type { Capability, Role } from "../../types/identity";
import {
  CONTRACTOR,
  DBA,
  DBA_CAPS,
  DEPLOYER,
  DEPLOYER_CAPS,
  FOLDERDEV,
  GRANTEE,
  HR,
  HR_CAPS,
  MEMBER,
  NEWBIE,
  OPS,
  OPS_CAPS,
  OTHER,
  OWNER,
  OWNER2,
  SCOPED_CAPS,
  SOLO,
  STAGER,
  STRANGER,
  SYSADMIN,
  TEAM,
  VIEWER,
  VIEWER_CAPS,
} from "./fixture-ids";
import { seedAccessControl } from "./seed-access-control";
import { seedProjectGraph } from "./seed-project-graph";

// The lab's live fixture: assigned in `before`, re-seeded in `beforeEach`.
export const lab = {
  db: null as unknown as TestDb,
  pg: null as unknown as PGlite,
  roles: new Map<Role, string>(),
};

// installLab registers the lab's hooks in the calling test file.
export function installLab(): void {
  before(async () => {
    ({ db: lab.db, pg: lab.pg } = await makeTestDb());
    __setTestDb(lab.db);
    // The stand-in runner has to settle the row: left `queued`, the lane picks it
    // up again the moment the runner returns and spins the event loop forever.
    __setRunnerForTest(async (depId) => {
      await lab.db
        .update(deploymentsTable)
        .set({ status: "canceled" })
        .where(eq(deploymentsTable.id, depId));
    });
    // The lab has no host: a gate that passes is then stopped by the dial, which
    // is the one error every "allowed" probe is permitted to end in.
    __setAgentConnectorForTest(async () => {
      throw new AgentUnreachableError("lab: no host");
    });
    __setTeardownDialForTest(async () => {
      throw new AgentUnreachableError("lab: no host");
    });
    __setDnsResolve4ForTest(async () => ["10.0.0.1"]);
  });

  after(async () => {
    // A delete's teardown runs behind the response; let it land before the DB goes.
    await settle(300);
    __resetQueueForTest();
    __setAgentConnectorForTest();
    __setTeardownDialForTest(null);
    __resetDnsResolve4ForTest();
    __resetTestDb();
    await lab.pg.close();
  });

  beforeEach(seedLab);
}

export const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function seedLab(): Promise<void> {
  const { db, pg } = lab;
  await pg.exec(`truncate table databases restart identity cascade;`);
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(`truncate table
    activities, api_tokens, projects, team_roles, membership_capabilities,
    memberships, users, teams, instance_settings restart identity cascade;`);
  const member = (
    id: string,
    capabilities: Capability[],
    role: Role = "member",
  ) => ({ id, teamId: TEAM, role, isInstanceAdmin: false, capabilities });
  await seedIdentity(db, {
    teams: [
      { id: TEAM, slug: "lab" },
      { id: OTHER, slug: "other" },
    ],
    users: [
      { id: OWNER, teamId: TEAM, role: "owner", isInstanceAdmin: false },
      { id: OWNER2, teamId: TEAM, role: "owner", isInstanceAdmin: false },
      member(VIEWER, VIEWER_CAPS, "viewer"),
      member(MEMBER, capabilitiesForRole("member")),
      member(DEPLOYER, DEPLOYER_CAPS),
      member(OPS, OPS_CAPS),
      member(DBA, DBA_CAPS),
      member(HR, HR_CAPS),
      member(CONTRACTOR, effectiveRoleCapabilities(SCOPED_CAPS, true)),
      member(STAGER, effectiveRoleCapabilities(SCOPED_CAPS, true)),
      member(FOLDERDEV, effectiveRoleCapabilities(SCOPED_CAPS, true)),
      member(SOLO, VIEWER_CAPS, "viewer"),
      member(GRANTEE, VIEWER_CAPS, "viewer"),
      { id: STRANGER, teamId: OTHER, role: "owner", isInstanceAdmin: false },
      { ...member(NEWBIE, VIEWER_CAPS, "viewer"), teamId: OTHER },
      {
        ...member(SYSADMIN, [...VIEWER_CAPS, "manage_tokens"], "viewer"),
        teamId: OTHER,
        isInstanceAdmin: true,
      },
    ],
  });
  await seedProjectGraph(db);
  await seedAccessControl(db);

  lab.roles = await ensureTeamRoles(getDb(), TEAM);
}
