import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  appVolumes as appVolumesTable,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import { composeHasInlineEnvValues } from "../compose-lint/document";

// Why a pull request did NOT get a preview. Surfaced verbatim to the user.
export type PreviewRefusal =
  | { kind: "previews-off" }
  | { kind: "not-github" }
  | { kind: "fork-denied" }
  | { kind: "fork-host-reach" }
  | { kind: "fork-inline-env" }
  | { kind: "awaiting-approval" }
  | { kind: "evicted"; max: number };

// The reason, as one sentence a non-expert can act on.
export function refusalMessage(r: PreviewRefusal): string {
  switch (r.kind) {
    case "previews-off":
      return "Pull request previews are off for this app.";
    case "not-github":
      return "Pull request previews need an app deployed from a GitHub repository.";
    case "fork-inline-env":
      return "A fork can't be previewed while this app's compose file carries environment values inline. Move them to the app's variables.";
    case "fork-host-reach":
      return "A fork can't be previewed while this app reaches the server (a Bind of a server folder, or a privileged compose setting).";
    case "fork-denied":
      return "This pull request comes from a fork, and this app does not build fork pull requests.";
    case "awaiting-approval":
      return "This pull request comes from a fork and needs a maintainer to approve it before it builds.";
    case "evicted":
      return `This preview was stopped to stay within the app's limit of ${r.max}. Redeploy it to bring it back.`;
  }
}

// Whether the app's stack reaches past its containers: a compose the host grant
// had to allow, or a Bind of a server folder in Storage.
export async function appReachesHost(appId: string): Promise<boolean> {
  const [app] = await getDb()
    .select({ hostReachBy: appsTable.hostReachBy })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (app?.hostReachBy) return true;
  const binds = await getDb()
    .select({ appId: appVolumesTable.appId })
    .from(appVolumesTable)
    .where(
      and(eq(appVolumesTable.appId, appId), eq(appVolumesTable.type, "host")),
    )
    .limit(1);
  return binds.length > 0;
}

// Why a FORK of this app may not be previewed right now, or null: a stranger's code
// must not run with the app's host reach, nor with values the compose file hands
// every container inline (ADR-0017 §7).
export async function forkRefusal(
  appId: string,
): Promise<PreviewRefusal | null> {
  if (await appReachesHost(appId)) return { kind: "fork-host-reach" };
  const [app] = await getDb()
    .select({ compose: appsTable.compose })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (app?.compose && composeHasInlineEnvValues(app.compose))
    return { kind: "fork-inline-env" };
  return null;
}
