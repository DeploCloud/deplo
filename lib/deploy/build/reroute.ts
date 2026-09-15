import "server-only";

import { loadAppGraph } from "../../data/app-graph-load";
import { basicAuthUsersValue } from "../../data/basic-auth";
import { primaryDomainName } from "../../data/domains/primary-domain";
import { withKeyedLock } from "../../data/keyed-mutex";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AppStatus } from "../../types/app";
import { mapLimit, usesComposeStack } from "../../utils";
import { ensureFileBinds } from "../agent-deploy";
import { parseComposeUpArgs } from "../compose-args";
import { buildComposeStack } from "../compose-stack/render";
import { stackName } from "../deploy-key";
import { fileBindsUnderFilesDir } from "../file-binds";
import { deployNetwork, explainNetworkError } from "../network";
import { renderCompose } from "./compose-render";
import { composeFilesDir, takenNamesForApp } from "./compose-stack-deploy";
import { appEnv, appEnvKeys } from "./deploy-env";
import { routableForDeploy } from "./deploy-routes";
import { owningServerIdForDeployKey } from "./stack-lifecycle";
import {
  parseStackHealthCheck,
  parseStackPorts,
  readStackEnvFromYaml,
  readStackImageFromYaml,
  readStackVolumesFromYaml,
} from "./stack-yaml";

const DEFERS_REROUTE = new Set<AppStatus>([
  "idle",
  "stopping",
  "queued",
  "building",
  "restoring",
]);

export async function rerouteApp(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  // ponytail: per-process, like every other lock here. Two control planes on one
  return withKeyedLock(`app-lifecycle:${appId}`, () => rerouteAppLocked(appId));
}

async function rerouteAppLocked(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const project = await loadAppGraph(appId);
  if (!project) return "deferred";
  const deployKey = project.slug;
  const name = stackName(deployKey);
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return "deferred";

  const primary = await primaryDomainName(appId);
  const routes = await routableForDeploy(appId, "production", primary);

  const hasCompose = Boolean(project.compose && project.compose.trim());
  const useCompose = usesComposeStack(project);

  const conn = await connectAgent(serverId);
  try {
    const current = await conn.readStack(deployKey);
    if (!current.exists) return "deferred";

    let rendered: string;
    let mounts: { path: string; content: string }[] = [];
    if (useCompose && hasCompose) {
      rendered = buildComposeStack({
        compose: project.compose ?? "",
        name,
        onWarn: (message) => console.warn(`[deplo] ${appId}: ${message}`),
        takenNames: await takenNamesForApp(project, appId),
        network: deployNetwork(project),
        deployKey,
        appId,
        domainRoutes: routes,
        filesDir: composeFilesDir(deployKey),
        basicAuthUsers: await basicAuthUsersValue(appId),
        // Omitting these would silently unmount storage: a compose stack is re-rendered, not read back.
        envKeys: await appEnvKeys(appId),
        volumes: project.volumes,
      });
      mounts = (project.mounts ?? []).map((m) => ({
        path: m.filePath,
        content: m.content,
      }));
    } else {
      const image = readStackImageFromYaml(current.yaml, name);
      if (!image) return "deferred";
      const env =
        readStackEnvFromYaml(current.yaml, name) ?? (await appEnv(appId));
      const volumes = readStackVolumesFromYaml(current.yaml, name);
      const basicAuthUsers = await basicAuthUsersValue(appId);
      rendered = renderCompose({
        name,
        image,
        port: project.build.port,
        appId,
        deployKey,
        network: deployNetwork(project),
        routes,
        env,
        basicAuthUsers,
        injectPort: project.source !== "docker-image",
        volumes,
        ports: parseStackPorts(current.yaml, name),
        healthCheckKeys: parseStackHealthCheck(current.yaml, name),
      });
    }

    if (current.yaml === rendered) return "unchanged";

    if (DEFERS_REROUTE.has(project.status)) return "deferred";

    const env = useCompose && hasCompose ? await appEnv(appId) : {};
    await ensureFileBinds(
      conn,
      deployKey,
      fileBindsUnderFilesDir(
        rendered,
        composeFilesDir(deployKey),
        mounts.map((m) => m.path),
        (project.volumes ?? [])
          .filter((v) => v.type === "app")
          .map((v) => v.projectPath ?? ""),
      ),
      (level, text) => {
        if (level === "warn") console.warn(`[deplo] ${appId}: ${text}`);
      },
    );
    const r = await conn.reroute({
      slug: deployKey,
      composeYaml: rendered,
      env,
      mounts,
      network: deployNetwork(project),
      composeUpArgs: parseComposeUpArgs(project.composeUpArgs),
    });
    if (!r.ok)
      throw new Error(
        explainNetworkError(r.error || "agent failed to reroute the stack"),
      );
    return "rerouted";
  } finally {
    conn.close();
  }
}

export async function reapplyNetworkAfterMove(appIds: string[]): Promise<void> {
  await mapLimit(appIds, 4, async (id) => {
    try {
      await rerouteApp(id);
    } catch (e) {
      console.warn(
        `[deplo] ${id} was moved but could not be put on its new network: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  });
}
