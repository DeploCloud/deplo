import "server-only";

import { eq } from "drizzle-orm";
import { neighboursForApp, redactNeighbours } from "../../data/cross-network";
import { getDb } from "../../db/client";
import {
  appMounts as appMountsTable,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import { composeEnvValues } from "../compose-stack/compose-read";
import { stackNamesOnNetwork } from "../compose-stack/stack-network";
import {
  crossNetworkMessage,
  crossNetworkRefs,
  hostsInMountedFile,
  nameClashMessage,
  nameClashes,
  type ForeignName,
} from "../cross-network";
import { appNetwork } from "../network";
import { log } from "./deployment-state";

export async function warnCrossNetwork(
  depId: string,
  appId: string,
  network: string,
  env: Record<string, string>,
  composeYaml: string,
): Promise<void> {
  try {
    const app = (
      await getDb()
        .select({
          id: appsTable.id,
          serverId: appsTable.serverId,
          teamId: appsTable.teamId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, appId))
        .limit(1)
    )[0];
    if (!app) return;
    const neighbours = redactNeighbours(await neighboursForApp(app));
    const foreign = neighbours.filter(
      (n): n is ForeignName => n.why !== "reachable" && n.network !== network,
    );
    const mounted = await getDb()
      .select({
        path: appMountsTable.filePath,
        content: appMountsTable.content,
      })
      .from(appMountsTable)
      .where(eq(appMountsTable.appId, appId));
    const named: Record<string, string> = {
      ...Object.assign(
        {},
        ...mounted.map((m) => hostsInMountedFile(m.path, m.content)),
      ),
      ...composeEnvValues(composeYaml),
      ...env,
    };
    for (const ref of crossNetworkRefs(named, foreign))
      log(depId, "warn", crossNetworkMessage(ref));
    if (network === appNetwork(app))
      for (const clash of nameClashes(
        stackNamesOnNetwork(composeYaml),
        neighbours,
      ))
        log(depId, "warn", nameClashMessage(clash));
  } catch {}
}
