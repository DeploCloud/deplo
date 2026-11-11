import "server-only";

import { requireActiveTeamId } from "../../membership";
import { listServerChoices } from "../servers/roster";
import { listClustersForTeam } from "./roster";

export interface PlacementChoice {
  kind: "server" | "cluster";
  id: string;
  name: string;
  type: "localhost" | "remote";
  isDeploHost: boolean;
}

/** A choice as a picker's option takes it: a cluster is marked, a server is not. */
export const placementOption = (c: PlacementChoice) => ({
  id: c.id,
  name: c.name,
  isDeploHost: c.isDeploHost,
  ...(c.kind === "cluster" ? { kind: "cluster" as const } : {}),
});

/** Where an App may be placed: the team's servers (never a cluster member) then its clusters. */
export async function listPlacementChoices(): Promise<PlacementChoice[]> {
  const teamId = await requireActiveTeamId();
  const servers = await listServerChoices();
  const clusters = await listClustersForTeam(teamId);
  return [
    ...servers.map((s) => ({
      kind: "server" as const,
      id: s.id,
      name: s.name,
      type: s.type,
      isDeploHost: s.isDeploHost,
    })),
    ...clusters.map((c) => ({
      kind: "cluster" as const,
      id: c.id,
      name: c.name,
      type: "remote" as const,
      isDeploHost: false,
    })),
  ];
}
