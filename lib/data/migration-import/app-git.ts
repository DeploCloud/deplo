import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { gitConnections as gitTable } from "../../db/schema/control-plane/integrations";
import { providerFor } from "../../git/providers/registry";
import { requireActiveTeamId } from "../../membership";
import type { SourceGitConnection } from "../../migration/model";
import { blocker, type Note } from "../../migration/note";
import { connectGitProvider } from "../git-connections";

const ATTACH =
  "Attach a git connection under the app's Source settings before deploying.";

// The connection here with the same account on the same server, else a new one with the source's token.
export async function landGitConnection(
  conn: SourceGitConnection,
  repo: string,
  notes: Note[],
): Promise<string | null> {
  const named = `the ${conn.label} git connection`;
  if (!conn.token) {
    notes.push(
      blocker(
        `${repo} clones with ${named} on {panel}, whose token this token's owner may not see there. ${ATTACH}`,
      ),
    );
    return null;
  }
  const teamId = await requireActiveTeamId();
  const [here] = await getDb()
    .select({ id: gitTable.id })
    .from(gitTable)
    .where(
      and(
        eq(gitTable.teamId, teamId),
        eq(gitTable.provider, conn.provider),
        eq(gitTable.baseUrl, conn.baseUrl),
        eq(gitTable.username, conn.username),
      ),
    )
    .limit(1);
  let id = here?.id ?? null;
  if (!id)
    try {
      id = (
        await connectGitProvider({
          provider: conn.provider,
          label: conn.label,
          baseUrl: conn.baseUrl,
          username: conn.username,
          token: conn.token,
          allowPrivateEndpoint: conn.allowPrivateEndpoint,
        })
      ).id;
    } catch (e) {
      notes.push(
        blocker(
          `${named[0]!.toUpperCase()}${named.slice(1)} did not come across (${e instanceof Error ? e.message : "refused"}). Add it under Git, then attach it under the app's Source settings before deploying.`,
        ),
      );
      return null;
    }
  notes.push(
    providerFor(conn.provider).api
      ? `Pushes to ${repo} reach this Deplo through a webhook it adds with ${named}. The old webhook still deploys on {panel} - remove it there once you have moved.`
      : `Pushes to ${repo} reached {panel} through a webhook on your git server. Point it at this Deplo - the address is under the app's Source settings.`,
  );
  return id;
}
