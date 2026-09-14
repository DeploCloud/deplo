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

// What the compose adapter needs to know about the platform this service is on: the
// name a note says, and the networks that are the platform's, not the stack's.
export function composePlatform(
  c: SourceCredential,
  svc: { kind: string; id: string },
): SourcePlatformShape {
  const src = sourceClient(c);
  return { name: src.displayName, networks: src.platformNetworks(svc) };
}

// How many services a compose file declares, or null when it is not valid YAML.
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

// Compose warnings worth a REPORT line, borrowed from the editor's own linter.
export function composeAdvice(compose: string): string[] {
  return lintCompose(compose)
    .filter(
      (d) =>
        d.rule === "reserved-service-name" ||
        d.rule === "network-aliases-dropped" ||
        // A service sharing another namespace (the host's, or a sidecar's) is not
        // reachable through Deplo's proxy, so its address - if it had one over
        // there - is now a host port and nothing else.
        d.rule === "network-mode-host" ||
        d.rule === "network-mode-conflict" ||
        // A network the stack pins by name still deploys, so it is never a
        // blocker - but the report is the only place it is ever mentioned to
        // someone who holds the grant.
        d.rule === "foreign-network",
    )
    .map((d) => d.message);
}

// Which of Deplo's compose gates this file would trip, as sentences. Deliberately the
// SAME predicates `createApp` runs, because the preview has no business disagreeing
// with the write path.
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

// Why this compose cannot be created by the person running the import, or null. A
// report that names a permission has to say who turns it on.
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
