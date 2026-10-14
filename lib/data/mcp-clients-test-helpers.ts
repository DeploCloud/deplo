import { before, after, beforeEach } from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { oauthConsent } from "../db/schema/auth";
import { runWithIdentity } from "../auth/request-context";
import type { Capability } from "../types/identity";

export let db: TestDb;
export let pg: PGlite;

export const OWNER = USER_1;
export const MEMBER = "user_2";
export const CLIENT = "client_abc";

const TRUNCATE = `truncate table
  oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client,
  api_tokens, activities, membership_capabilities, memberships, users, teams
  restart identity cascade;`;

export const CONNECTOR: Capability[] = [
  "view",
  "manage_mcp",
  "manage_tokens",
  "deploy_apps",
];

// Registers the database hooks: an owner and a connector-capable member in TEAM_A, both consented to CLIENT.
export function setupMcpClientsDb() {
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
    await seedIdentity(db, {
      teams: [
        { id: TEAM_A, slug: "alpha" },
        { id: TEAM_B, slug: "beta" },
      ],
      users: [
        { id: OWNER, teamId: TEAM_A, role: "owner" },
        { id: MEMBER, teamId: TEAM_A, role: "member", capabilities: CONNECTOR },
      ],
    });
    await registerClientRow(CLIENT, "Claude");
    await consentRow(CLIENT, OWNER);
    await consentRow(CLIENT, MEMBER);
  });
}

export async function registerClientRow(
  clientId: string,
  name: string,
  redirect = "https://client.test/callback",
) {
  await pg.query(
    `insert into oauth_client (id, client_id, name, redirect_uris, created_at)
     values ($1, $2, $3, ARRAY[$4], now())`,
    [`oc_${clientId}`, clientId, name, redirect],
  );
}

export async function consentRow(clientId: string, userId: string, ageMs = 0) {
  await db.insert(oauthConsent).values({
    id: `ocs_${clientId}_${userId}`,
    clientId,
    userId,
    scopes: ["openid"],
    createdAt: new Date(Date.now() - ageMs),
    updatedAt: new Date(Date.now() - ageMs),
  });
}

export async function grantOwnerIn(teamId: string) {
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_owner_b2', $1, $2, 'owner', '2025-01-01T00:00:00.000Z')`,
    [OWNER, teamId],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_owner_b2', capability from membership_capabilities
     where membership_id = $1`,
    [`mem_${OWNER}`],
  );
}

export function as<T>(userId: string, fn: () => Promise<T>, teamId = TEAM_A) {
  return runWithIdentity({ userId, teamId }, fn);
}
