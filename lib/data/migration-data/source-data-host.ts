import "server-only";

import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import { sourceAgentReachable } from "../agent-reach";
import { getServerById } from "../servers/roster";
import { isDeploVolumeName } from "../../migration/map/volume-discovery";
import {
  UNREACHABLE_SOURCE_AGENT,
  UNREACHABLE_SOURCE_PANEL,
} from "./copy-notes";
import { resolveSourceServer, volumesOnHost } from "./source-cutover";

export interface DataSource {
  exportVolume(name: string): AsyncIterable<Buffer>;
  exportHostPath(path: string, allowFile?: boolean): AsyncIterable<Buffer>;
}

export interface SourceDataHost {
  // The server row the bytes come from; null when the source panel hands them over itself (ADR-0034).
  serverId: string | null;
  hostsNothing: boolean;
  unreachable: string;
  reachable(): Promise<boolean>;
  volumesPresent(names: string[]): Promise<Set<string> | null>;
  connect(
    targetServerId: string,
  ): Promise<{ source: DataSource; dest: AgentConnection; close(): void }>;
}

export async function sourceDataHost(
  c: SourceCredential,
  teamId: string,
  svc: { kind: string; id: string; serverId: string },
): Promise<SourceDataHost> {
  const panel = sourceClient(c).dataExport;
  if (panel)
    return {
      serverId: null,
      hostsNothing: true,
      unreachable: UNREACHABLE_SOURCE_PANEL,
      reachable: () =>
        panel
          .check(svc, [])
          .then((r) => r.reachable)
          .catch(() => false),
      volumesPresent: (names) =>
        panel
          .check(svc, names)
          .then((r) => (r.present ? new Set(r.present) : null))
          .catch(() => null),
      connect: async (targetServerId) => {
        const dest = await connectAgent(targetServerId);
        return {
          source: {
            exportVolume: (name) => panel.exportVolume(svc, name),
            exportHostPath: (path, allowFile) =>
              panel.exportHostPath(svc, path, allowFile),
          },
          dest,
          close: () => dest.close(),
        };
      },
    };

  const serverId = await resolveSourceServer(c, teamId, svc.serverId);
  // The panel names the volumes, and one in Deplo's own namespace belongs to a workload here.
  const panelOwns = (name: string) => !isDeploVolumeName(name);
  return {
    serverId,
    hostsNothing: Boolean((await getServerById(serverId))?.importOnly),
    unreachable: UNREACHABLE_SOURCE_AGENT,
    reachable: () => sourceAgentReachable(serverId),
    volumesPresent: (names) => volumesOnHost(serverId, names.filter(panelOwns)),
    connect: async (targetServerId) => {
      const agent = await connectAgent(serverId);
      const dest =
        serverId === targetServerId
          ? agent
          : await connectAgent(targetServerId);
      return {
        source: {
          async *exportVolume(name) {
            if (!panelOwns(name))
              throw new Error(
                "it is storage Deplo manages, not this service's, so it was not copied",
              );
            yield* agent.exportVolume(name);
          },
          exportHostPath: (path, allowFile) =>
            agent.exportHostPath(path, allowFile),
        },
        dest,
        close: () => {
          agent.close();
          if (dest !== agent) dest.close();
        },
      };
    },
  };
}
