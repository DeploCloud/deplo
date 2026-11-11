import "server-only";

import {
  type DeployRequest,
  ReadyCheck,
  RestartRule,
  SourceKind,
} from "../agent/gen/agent";
import { scheduleFailoverBundle } from "../data/clusters/bundles";

/** Hands a cluster App's leader what this deploy sent, so it can start the App again without Deplo (ADR-0045). */
export function offerFailoverBundle(
  appId: string,
  agentDeployId: string,
  req: DeployRequest,
): void {
  scheduleFailoverBundle({
    appId,
    deploymentId: agentDeployId.replace(/-stack$/, ""),
    stack: {
      slug: req.slug,
      projectId: req.projectId,
      imageRef: req.imageRef,
      composeYaml: req.composeYaml,
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
