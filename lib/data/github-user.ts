import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { githubApps as githubAppsTable } from "../db/schema/control-plane/integrations";
import { getCurrentUser } from "../auth/current-user";
import { requireCapability } from "../membership";
import { assembleGithubApp } from "./infra-rows";
import { recordActivity } from "./activity";
import { completeUserAuthorize } from "../github/user-token";

// The return leg of "Sign in with GitHub": the app must be the active team's, and the person must be able to create apps there.
export async function completeGithubUserAuthorize(
  appDbId: string,
  code: string,
  publicBase: string,
): Promise<void> {
  const { teamId, userId } = await requireCapability("create_apps");
  const row = (
    await getDb()
      .select()
      .from(githubAppsTable)
      .where(eq(githubAppsTable.id, appDbId))
      .limit(1)
  )[0];
  if (!row || row.teamId !== teamId) throw new Error("GitHub App not found");
  const login = await completeUserAuthorize(
    assembleGithubApp(row),
    userId,
    code,
    publicBase,
  );
  const user = await getCurrentUser();
  await recordActivity(
    "integration",
    `Signed in to GitHub as ${login} to create repositories`,
    user?.name ?? "Someone",
    null,
    teamId,
  );
}
