import "server-only";

import { loadAppGraph, loadDomainsForApp } from "../../data/app-graph-load";
import { basicAuthUsersValue } from "../../data/basic-auth";
import {
  defaultRoute,
  routableRoutes,
  type RoutableDomain,
} from "../../data/domains/routes";
import { connectAgent } from "../../infra/agent-client/connect";
import { usesComposeStack } from "../../utils";
import { buildComposeStack } from "../compose-stack/render";
import { stackName } from "../deploy-key";
import { deployNetwork } from "../network";
import { composeFilesDir, takenNamesForApp } from "./compose-stack-deploy";
import { appEnvKeys } from "./deploy-env";
import { owningServerIdForDeployKey } from "./stack-lifecycle";

export async function renderAppStack(appId: string): Promise<string | null> {
  const project = await loadAppGraph(appId);
  if (!project) return null;
  const deployKey = project.slug;
  const name = stackName(deployKey);

  const hasCompose = Boolean(project.compose && project.compose.trim());
  if (usesComposeStack(project) && hasCompose) {
    const routes = await routableRoutes(appId);
    const domainRoutes: RoutableDomain[] = routes.length
      ? routes
      : (await loadDomainsForApp(appId))
          .sort((a, b) => Number(b.primary) - Number(a.primary))
          .map((d) => defaultRoute(d.name, d.service ?? null, d.port ?? null));
    return buildComposeStack({
      compose: project.compose ?? "",
      name,
      deployKey,
      appId,
      network: deployNetwork(project),
      domainRoutes,
      takenNames: await takenNamesForApp(project, appId),
      filesDir: composeFilesDir(deployKey),
      basicAuthUsers: await basicAuthUsersValue(appId),
      envKeys: await appEnvKeys(appId),
      resources: project.resources,
      volumes: project.volumes,
    });
  }

  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return null;
  const conn = await connectAgent(serverId);
  try {
    const { exists, yaml: stackYaml } = await conn.readStack(deployKey);
    return exists ? stackYaml : null;
  } catch {
    return null;
  } finally {
    conn.close();
  }
}
