import "server-only";

import { requireActiveTeamId } from "../../membership";
import { isValidExposePort } from "../../databases/ports";
import { canHostWorkloads, listServersForTeam } from "../servers/roster";
import type { Report } from "./run-report";

export interface ServerChoice {
  from: string;
  to: string;
}

export async function resolveServers(
  teamId: string,
  choices: ServerChoice[],
  report: Report,
  projectName: string,
): Promise<Map<string, string | undefined>> {
  const usable = new Set(
    (await listServersForTeam(teamId))
      .filter(canHostWorkloads)
      .map((s) => s.id),
  );
  const out = new Map<string, string | undefined>();
  for (const { from, to } of choices) {
    if (usable.has(to)) out.set(from, to);
    else
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: from || "the {panel} host",
        outcome: "manual",
        message:
          "The server picked for this {panel} host is not one this team can deploy to - Deplo's default server was used instead.",
      });
  }
  return out;
}

export interface ServicePlacement {
  serviceId: string;
  serverId: string;
  buildServerId?: string | null;
  exposedPort?: number | null;
}

export interface ResolvedPlacement {
  serverId: string;
  buildServerId: string | null;
  exposedPort?: number | null;
}

export async function resolvePlacements(
  teamId: string,
  placements: ServicePlacement[],
  report: Report,
  projectName: string,
): Promise<Map<string, ResolvedPlacement>> {
  const out = new Map<string, ResolvedPlacement>();
  if (placements.length === 0) return out;

  const servers = await listServersForTeam(teamId);
  const canRun = new Set(servers.filter(canHostWorkloads).map((s) => s.id));
  const canBuild = new Set(
    servers.filter((s) => !s.storageOnly && !s.importOnly).map((s) => s.id),
  );

  for (const p of placements) {
    if (!canRun.has(p.serverId)) {
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: p.serviceId,
        outcome: "manual",
        message:
          "The server picked for this app is not one this team can deploy to - Deplo's default server was used instead.",
      });
      continue;
    }
    let buildServerId: string | null = null;
    if (p.buildServerId) {
      if (canBuild.has(p.buildServerId)) buildServerId = p.buildServerId;
      else
        await report.add({
          path: projectName,
          sourceKind: "server",
          sourceName: p.serviceId,
          outcome: "manual",
          message:
            "The build server picked for this app is not one this team can build on - it builds automatically instead.",
        });
    }
    let exposedPort = p.exposedPort;
    if (typeof exposedPort === "number" && !isValidExposePort(exposedPort)) {
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: p.serviceId,
        outcome: "manual",
        message: `Port ${exposedPort} is not a port a database can publish (1024-65535) - the one it had on {panel} was used instead.`,
      });
      exposedPort = undefined;
    }
    out.set(p.serviceId, { serverId: p.serverId, buildServerId, exposedPort });
  }
  return out;
}

export async function landingServerId(
  given: string | undefined,
): Promise<string> {
  if (given) return given;
  const teamId = await requireActiveTeamId();
  const usable = (await listServersForTeam(teamId)).filter(canHostWorkloads);
  return usable[0]?.id ?? "";
}
