import "server-only";

import yaml from "../../yaml";

import { canExposePorts, canMountHostVolumes } from "../../membership";
import { composePublishesPorts } from "../../deploy/compose-lint/host-ports";
import {
  composeHostReach,
  composeUsesExternalMerge,
} from "../../deploy/compose-lint/host-privileges";
import { lintCompose } from "../../deploy/compose-lint/lint";
import {
  composeClaimsReservedName,
  composeInterpolatedHostname,
  interpolatedHostnameMessage,
} from "../../deploy/compose-lint/networks";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type { SourcePlatformShape } from "../../migration/map/source-platform";

export function composePlatform(
  c: SourceCredential,
  svc: { kind: string; id: string },
): SourcePlatformShape {
  const src = sourceClient(c);
  return { name: src.displayName, networks: src.platformNetworks(svc) };
}

export function composeServiceCount(compose: string): number | null {
  let doc: unknown;
  try {
    doc = yaml.load(compose);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return 0;
  const services = (doc as { services?: unknown }).services;
  return services && typeof services === "object" && !Array.isArray(services)
    ? Object.keys(services as Record<string, unknown>).length
    : 0;
}

export function composeAdvice(compose: string): string[] {
  return lintCompose(compose)
    .filter(
      (d) =>
        d.rule === "reserved-service-name" ||
        d.rule === "network-aliases-dropped" ||
        d.rule === "network-mode-host" ||
        d.rule === "network-mode-conflict" ||
        d.rule === "foreign-network",
    )
    .map((d) => d.message);
}

export function composeBlockers(
  compose: string,
  grants: { mayMountHost: boolean; mayExposePorts: boolean },
): string[] {
  const out: string[] = [];
  const merge = composeUsesExternalMerge(compose);
  if (merge)
    out.push(
      `Uses \`${merge}\`, which Deplo refuses in a compose file - inline what it pulls in.`,
    );
  const reserved = composeClaimsReservedName(compose);
  if (reserved)
    out.push(
      `A service claims the name "${reserved}", which Deplo's own infrastructure answers to on the shared network - rename it (or its \`hostname:\`).`,
    );
  const filled = composeInterpolatedHostname(compose);
  if (filled) out.push(interpolatedHostnameMessage(filled));
  if (!grants.mayExposePorts && composePublishesPorts(compose))
    out.push("Publishes host ports, which needs the expose-ports grant.");
  const reach = grants.mayMountHost ? [] : composeHostReach(compose);
  if (reach.length > 0)
    out.push(
      `Uses ${reach.join(", ")}, which needs the host-volumes grant - without it this stack does not come across at all.`,
    );
  return out;
}

export async function composeGrantRefusal(
  compose: string,
  name: string,
): Promise<string | null> {
  const reach = composeHostReach(compose);
  if (reach.length > 0 && !(await canMountHostVolumes()))
    return `${name} uses ${reach.join(", ")}, which needs the host-volumes permission, so its stack did not come across. An admin turns it on with "Bind server folders" in Settings -> Users, then import this app again.`;
  if (composePublishesPorts(compose) && !(await canExposePorts()))
    return `${name} publishes ports on the server, which needs the expose-ports permission, so its stack did not come across. An admin turns it on with "Publish ports" in Settings -> Users, then import this app again.`;
  return null;
}
