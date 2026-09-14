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

// Statuses a reroute must not bring up: stopped on purpose, or mid-deploy. Every other
// one may still have containers running, and those have to follow a move.
const DEFERS_REROUTE = new Set<AppStatus>([
  "idle",
  "stopping",
  "queued",
  "building",
  "restoring",
]);

// rerouteApp re-applies an app's Traefik routing to its already-running stack, without
// rebuilding. Never starts a stopped app and never races a deploy in progress.
export async function rerouteApp(
  appId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  // One at a time per app: a move and a Start racing each other both re-render the
  // same stack file and both run `compose up -d` on the same compose project.
  //
  // ponytail: per-process, like every other lock here. Two control planes on one
  // database still race; a Postgres advisory lock is the fix if that ever ships.
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

  // Route exactly what a production DEPLOY would. Empty is a legitimate render: it is what
  // takes the LAST removed hostname off the running container.
  const primary = await primaryDomainName(appId);
  const routes = await routableForDeploy(appId, "production", primary);

  const hasCompose = Boolean(project.compose && project.compose.trim());
  const useCompose = usesComposeStack(project);

  const conn = await connectAgent(serverId);
  try {
    // Read the rendered stack back from the OWNING agent's disk. Never deployed (or torn
    // down) => nothing running to reroute.
    const current = await conn.readStack(deployKey);
    if (!current.exists) return "deferred";

    let rendered: string;
    let mounts: { path: string; content: string }[] = [];
    if (useCompose && hasCompose) {
      rendered = buildComposeStack({
        compose: project.compose ?? "",
        name,
        onWarn: (message) => console.warn(`[deplo] ${appId}: ${message}`),
        // Same question the deploy asks: without it a reroute would put a clashing service
        // back on the shared network and reopen the round-robin.
        takenNames: await takenNamesForApp(project, appId),
        network: deployNetwork(project),
        deployKey,
        appId,
        domainRoutes: routes,
        filesDir: composeFilesDir(deployKey),
        basicAuthUsers: await basicAuthUsersValue(appId),
        envKeys: await appEnvKeys(appId),
        // Omitting these would make a domain-only reroute silently UNMOUNT the app's
        // storage: a compose stack is re-rendered from the app, not read back from the file.
        volumes: project.volumes,
      });
      mounts = (project.mounts ?? []).map((m) => ({
        path: m.filePath,
        content: m.content,
      }));
    } else {
      // Single-image / built path: the image ref, env, volumes and ports live only in the
      // stack file, so read them back to keep this a pure routing change.
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

    // No-op when the labels already match - avoids a pointless container restart.
    if (current.yaml === rendered) return "unchanged";

    // Recreating a deliberately stopped app would silently restart it, and recreating
    // mid-deploy races the deploy on the same compose project.
    if (DEFERS_REROUTE.has(project.status)) return "deferred";

    // A single-image stack bakes its env into the YAML (mirroring the deploy path);
    // compose stacks interpolate ${VAR} from the env-file.
    const env = useCompose && hasCompose ? await appEnv(appId) : {};
    // A reroute is a bring-up too: a file bind the compose gained since the last deploy
    // would otherwise come up as a folder.
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

// reapplyNetworkAfterMove puts moved apps onto the network their new placement owns.
// Best-effort - an unreachable host is finished by the next deploy.
export async function reapplyNetworkAfterMove(appIds: string[]): Promise<void> {
  // Bounded, not serial: a bulk move reroutes every app it touched INSIDE the request, and
  // one at a time that is N round trips before the mutation answers. These rebuild nothing.
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
