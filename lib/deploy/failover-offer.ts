import "server-only";

import {
  type DeployRequest,
  ReadyCheck,
  RestartRule,
  SourceKind,
} from "../agent/gen/agent";
import { parseDocument } from "yaml";

import { scheduleAppBundle } from "../data/clusters/app-restore";
import { inBackground, storedBundle } from "../data/clusters/bundles";

/** Stands for the replica count in a bundle's stack; the leader puts in how many a member runs. */
export const REPLICAS_MARK = "__DEPLO_REPLICAS__";

function markReplicas(composeYaml: string, service: string): string | null {
  const doc = parseDocument(composeYaml);
  if (!doc.hasIn(["services", service, "deploy", "replicas"])) return null;
  doc.setIn(["services", service, "deploy", "replicas"], REPLICAS_MARK);
  return doc.toString({ lineWidth: 0 });
}

/** Hands a cluster App's leader what this deploy sent, so it can start the App again without Deplo (ADR-0045). */
export function offerFailoverBundle(
  appId: string,
  agentDeployId: string,
  req: DeployRequest,
  // The service of an App spread over its cluster: the leader says how many replicas a member starts.
  scaledService?: string,
): void {
  const composeYaml = scaledService
    ? markReplicas(req.composeYaml, scaledService)
    : null;
  scheduleAppBundle({
    appId,
    deploymentId: agentDeployId.replace(/-stack$/, ""),
    stack: {
      slug: req.slug,
      projectId: req.projectId,
      imageRef: req.imageRef,
      composeYaml: composeYaml ?? req.composeYaml,
      ...(composeYaml ? { scale: REPLICAS_MARK } : {}),
      network: req.network,
      env: { ...req.env },
      // Pulled images need their credentials again; a built image is already on the member.
      registryAuth:
        req.pullImage || req.sourceKind === SourceKind.SOURCE_KIND_COMPOSE
          ? req.registryAuth.map((a) => ({ ...a }))
          : [],
      composeUpArgs: [...req.composeUpArgs],
      ...(req.startAfterReady.length > 0
        ? { startAfterReady: [...req.startAfterReady] }
        : {}),
      // What keeps a moved App checked, restarted and configured as this deploy left it.
      ...(req.ready ? { ready: ReadyCheck.toJSON(req.ready) } : {}),
      ...(req.restartRule
        ? { restartRule: RestartRule.toJSON(req.restartRule) }
        : {}),
      ...(req.mounts.length > 0
        ? { mounts: req.mounts.map((m) => ({ ...m })) }
        : {}),
      ...(req.filesBindSources.length > 0
        ? { filesBindSources: [...req.filesBindSources] }
        : {}),
    },
  });
}

type PortCheck = { port?: number } | undefined;

/** A reroute changed what the member runs: its leader gets that stack, on the port it is routed to now. */
export function offerReroutedBundle(
  appId: string,
  composeYaml: string,
  service: string,
  port: number | null,
): void {
  inBackground(appId, async () => {
    const held = await storedBundle(appId);
    if (!held) return;
    const stack = { ...held.stack };
    delete stack.tunnelToken;
    stack.composeYaml =
      (stack.scale && markReplicas(composeYaml, service)) || composeYaml;
    const ready = stack.ready as PortCheck;
    const rule = stack.restartRule as PortCheck;
    if (port && ready?.port && ready.port !== port) {
      if (rule?.port === ready.port) stack.restartRule = { ...rule, port };
      stack.ready = { ...ready, port };
    }
    scheduleAppBundle({ appId, deploymentId: held.deploymentId, stack });
  });
}
