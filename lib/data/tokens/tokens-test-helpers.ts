import {
  memberships,
  membershipCapabilities,
} from "../../db/schema/control-plane/access-control";
import { projects as projectsTable } from "../../db/schema/control-plane/projects";
import { runWithIdentity } from "../../auth/request-context";
import type { TestDb } from "../../db/test-harness";
import { TEAM_A, TEAM_B, USER_1 } from "../leaf-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../../types/identity";

const T0 = "2026-01-01T00:00:00.000Z";

export const TRUNCATE = `truncate table api_tokens, oauth_client, projects, activities, users, teams restart identity cascade;`;

export const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

export const asUser1InB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_B }, fn);

export async function alsoMemberOfB(db: TestDb): Promise<void> {
  await db.insert(memberships).values({
    id: "mem_user_1_b",
    userId: USER_1,
    teamId: TEAM_B,
    role: "owner",
    createdAt: T0,
  });
  await db.insert(membershipCapabilities).values(
    ALL_CAPABILITIES.map((c) => ({
      membershipId: "mem_user_1_b",
      capability: c,
    })),
  );
}

export async function seedProject(
  db: TestDb,
  id: string,
  teamId: string,
  name = id,
) {
  await db.insert(projectsTable).values({
    id,
    teamId,
    name,
    slug: name.toLowerCase(),
    createdAt: T0,
    updatedAt: T0,
  });
}

export async function seedMembership(
  db: TestDb,
  userId: string,
  teamId: string,
  caps: Capability[],
): Promise<void> {
  const id = `mem_${userId}_${teamId}`;
  await db
    .insert(memberships)
    .values({ id, userId, teamId, role: "member", createdAt: T0 });
  await db
    .insert(membershipCapabilities)
    .values(caps.map((capability) => ({ membershipId: id, capability })));
}
