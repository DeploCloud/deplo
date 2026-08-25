import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { deployments as deploymentsTable } from "../db/schema/control-plane";
import { listServersForTeam } from "../data/servers";
import type { App, Server } from "../types";

/**
 * Which server BUILDS an app's image, when that is not the one that runs it.
 */

/** Why a build server was (or was not) chosen. Surfaced in the deploy log, so the
 *  operator never has to guess which machine compiled their app. */
export type BuildServerChoice =
  | { serverId: string; reason: "pinned" | "automatic" }
  | {
      serverId: null;
      reason: "own-server" | "none-available" | "arch-mismatch";
    };

/**
 * The pure decision. Precedence, in order: 1. A setting that silently routes
 * elsewhere is not a setting.
 */
export function pickBuildServer(
  app: Pick<App, "serverId" | "buildServerId">,
  target: Pick<Server, "id" | "hostArch">,
  candidates: readonly Server[],
  inFlightByServer: ReadonlyMap<string, number> = new Map(),
): BuildServerChoice {
  if (app.buildServerId) {
    // Pinned to where it already runs.
    if (app.buildServerId === app.serverId || app.buildServerId === target.id) {
      return { serverId: null, reason: "own-server" };
    }
    const pinned = candidates.find((s) => s.id === app.buildServerId);
    if (pinned && canBuildFor(pinned, target)) {
      return { serverId: pinned.id, reason: "pinned" };
    }
    // A pin to a host of the WRONG ARCHITECTURE is worth naming separately: the
    // setting is still there and still says that server, and the honest answer is
    // that it cannot produce an image this host can execute - not "no builder".
    if (pinned && pinned.hostArch !== target.hostArch) {
      return { serverId: null, reason: "arch-mismatch" };
    }
    return { serverId: null, reason: "none-available" };
  }

  const usable = candidates.filter(
    (s) => s.buildOnly && canBuildFor(s, target),
  );
  if (usable.length === 0) return { serverId: null, reason: "none-available" };

  // Fewest builds in flight, and on a tie the one added first.
  const best = usable.reduce((a, b) => {
    const na = inFlightByServer.get(a.id) ?? 0;
    const nb = inFlightByServer.get(b.id) ?? 0;
    if (na !== nb) return na < nb ? a : b;
    return a.createdAt <= b.createdAt ? a : b;
  });
  return { serverId: best.id, reason: "automatic" };
}

/**
 * Whether `builder` can produce an image `target` will actually run. An empty
 * `hostArch` on either side (an agent too old to report it) never matches, which
 * keeps that pair out of the picker instead of guessing.
 */
export function canBuildFor(
  builder: Pick<
    Server,
    "id" | "status" | "storageOnly" | "importOnly" | "hostArch"
  >,
  target: Pick<Server, "id" | "hostArch">,
): boolean {
  if (builder.id === target.id) return false;
  if (builder.storageOnly) return false; // no Docker, nothing to build with
  // A migration source HAS Docker - it is the other platform's own host - which is
  // exactly why it must be named here: a build ships this app's source and its
  // decrypted env to the builder, and that machine is not ours.
  if (builder.importOnly) return false;
  if (builder.status === "offline" || builder.status === "provisioning")
    return false;
  return builder.hostArch !== "" && builder.hostArch === target.hostArch;
}

/**
 * {@link pickBuildServer} against the live fleet: the servers the app's team can
 * reach, and how many builds each is already running.
 */
export async function resolveBuildServer(
  app: Pick<App, "serverId" | "buildServerId" | "teamId">,
  target: Server,
): Promise<BuildServerChoice> {
  // Nothing to pin to and nothing to pick from: skip both queries entirely, which
  // is the single-server fleet, i.e. most of them.
  const candidates = await listServersForTeam(app.teamId);
  const usableIds = candidates
    .filter((s) => s.id !== target.id && !s.storageOnly && !s.importOnly)
    .map((s) => s.id);
  if (usableIds.length === 0) {
    return pickBuildServer(app, target, candidates);
  }
  const rows = await getDb()
    .select({ serverId: deploymentsTable.buildServerId })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.status, "building"),
        inArray(deploymentsTable.buildServerId, usableIds),
      ),
    );
  const inFlight = new Map<string, number>();
  for (const r of rows) {
    if (r.serverId)
      inFlight.set(r.serverId, (inFlight.get(r.serverId) ?? 0) + 1);
  }
  return pickBuildServer(app, target, candidates, inFlight);
}

/**
 * The one-line explanation of a build server choice, for the deploy log.
 */
export function buildServerLogLine(
  choice: BuildServerChoice,
  builderName: string,
  targetName: string,
): { level: "info" | "warn"; text: string } | null {
  switch (choice.reason) {
    case "pinned":
    case "automatic":
      return {
        level: "info",
        text: `Building on ${builderName}, then releasing on ${targetName}`,
      };
    case "arch-mismatch":
      return {
        level: "warn",
        text:
          `The build server chosen for this app has a different CPU architecture than ${targetName}, ` +
          `so an image built there could not run here. Building on ${targetName} instead.`,
      };
    case "none-available":
      // Reached when a pin no longer resolves. Worth one line: the setting still
      // names a server, and the deploy quietly did something else.
      return {
        level: "warn",
        text: `The build server chosen for this app is unavailable. Building on ${targetName} instead.`,
      };
    case "own-server":
      return null;
  }
}
