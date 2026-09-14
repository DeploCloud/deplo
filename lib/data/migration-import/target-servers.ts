import "server-only";

import { requireActiveTeamId } from "../../membership";
import { isValidExposePort } from "../../databases/ports";
import { canHostWorkloads, listServersForTeam } from "../servers/roster";
import type { Report } from "./run-report";

// ServerChoice - how a source server maps onto one of ours. `from: ""` is the panel's own host.
export interface ServerChoice {
  from: string;
  to: string;
}

// Source server id (or "") to a Deplo server this team can actually deploy to.
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

// ServicePlacement - where ONE service was placed: the host it runs on, and the one it compiles on.
export interface ServicePlacement {
  // The source service id - the `sourceId` a scan reports.
  serviceId: string;
  serverId: string;
  // Null (or absent) is Automatic: use a build server if the fleet has one.
  buildServerId?: string | null;
  // A database's host port, decided in the review.
  exposedPort?: number | null;
}

// What resolvePlacements settles for one service.
export interface ResolvedPlacement {
  serverId: string;
  buildServerId: string | null;
  exposedPort?: number | null;
}

// Source service id to where it lands, for the services the caller placed.
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
  // Wider than `canRun` on purpose: a build-only host is a legal builder and an
  // illegal target, which is the whole point of the two columns.
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
    // A port outside the range createDatabase accepts is refused HERE, where the report
    // can name the service, instead of down at the create where it would read as "the
    // database could not be made".
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

// The host an app lands on when nobody named one - the same pick `createApp` makes,
// needed here because the network a name is checked against is per host.
export async function landingServerId(
  given: string | undefined,
): Promise<string> {
  if (given) return given;
  const teamId = await requireActiveTeamId();
  const usable = (await listServersForTeam(teamId)).filter(canHostWorkloads);
  return usable[0]?.id ?? "";
}
