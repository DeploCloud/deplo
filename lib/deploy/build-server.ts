import "server-only";

// https://deplo.build/docs/advanced/build-servers

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { deployments as deploymentsTable } from "../db/schema/control-plane";
import { listServersForTeam } from "../data/servers";
import {
  deploHostSelfAddresses,
  isBuildFallbackServer,
  isDeploHostServer,
} from "./domains";
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

/** Every host this deploy may compile on, in the order they are tried. */
export interface BuildPlan {
  /** The app's own choice first, then the fleet's build fallbacks. */
  chain: string[];
  /** Whether the app's own server may build it, once every host above failed. */
  local: boolean;
  /** Why the build is not happening where the app's setting says, when it is not. */
  missed: {
    reason: "none-available" | "arch-mismatch";
    /** Whether the app names that server itself, as opposed to Automatic. */
    pinned: boolean;
  } | null;
}

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

  return {
    serverId: leastBusy(usable, inFlightByServer).id,
    reason: "automatic",
  };
}

/** Fewest builds in flight, and on a tie the one added first. */
function leastBusy(
  servers: readonly Server[],
  inFlightByServer: ReadonlyMap<string, number>,
): Server {
  return servers.reduce((a, b) => {
    const na = inFlightByServer.get(a.id) ?? 0;
    const nb = inFlightByServer.get(b.id) ?? 0;
    if (na !== nb) return na < nb ? a : b;
    return a.createdAt <= b.createdAt ? a : b;
  });
}

/**
 * The fleet's build fallbacks for one target, in the order they are tried: the
 * Deplo host first (it is the default one), then the operator's own picks.
 */
export function pickBuildFallbacks(
  target: Pick<Server, "id" | "hostArch">,
  candidates: readonly Server[],
  self: ReadonlySet<string>,
  inFlightByServer: ReadonlyMap<string, number> = new Map(),
  exclude?: string | null,
): Server[] {
  const rank = (s: Server) => (isDeploHostServer(s, self) ? 0 : 1);
  const load = (s: Server) => inFlightByServer.get(s.id) ?? 0;
  return candidates
    .filter(
      (s) =>
        s.id !== exclude &&
        isBuildFallbackServer(s, self) &&
        canBuildFor(s, target),
    )
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        load(a) - load(b) ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/**
 * Every host this deploy may compile on. The app's own choice, then the fleet's
 * fallbacks, then the server the app runs on - and the per-app switch is what
 * decides whether anything after the first entry exists at all.
 */
export function planBuildServers(
  app: Pick<App, "serverId" | "buildServerId" | "buildFallback">,
  target: Pick<Server, "id" | "hostArch">,
  candidates: readonly Server[],
  self: ReadonlySet<string> = deploHostSelfAddresses(),
  inFlightByServer: ReadonlyMap<string, number> = new Map(),
): BuildPlan {
  const primary = pickBuildServer(app, target, candidates, inFlightByServer);
  const fallbacks = (exclude?: string) =>
    pickBuildFallbacks(target, candidates, self, inFlightByServer, exclude).map(
      (s) => s.id,
    );

  if (primary.serverId !== null) {
    return {
      chain: app.buildFallback
        ? [primary.serverId, ...fallbacks(primary.serverId)]
        : [primary.serverId],
      local: app.buildFallback,
      missed: null,
    };
  }
  // Nothing was going to build elsewhere: an app pinned to its own server, or a
  // fleet with no build server at all. No fallback question to answer.
  if (
    primary.reason === "own-server" ||
    !buildsElsewhere(app, target, candidates)
  )
    return { chain: [], local: true, missed: null };

  const missed = { reason: primary.reason, pinned: !!app.buildServerId };
  if (!app.buildFallback) return { chain: [], local: false, missed };
  return { chain: fallbacks(), local: true, missed };
}

/** Whether this app meant to compile somewhere other than where it runs. */
function buildsElsewhere(
  app: Pick<App, "serverId" | "buildServerId">,
  target: Pick<Server, "id">,
  candidates: readonly Server[],
): boolean {
  if (app.buildServerId)
    return (
      app.buildServerId !== app.serverId && app.buildServerId !== target.id
    );
  return candidates.some((s) => s.buildOnly && s.id !== target.id);
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
 * {@link planBuildServers} against the live fleet: the servers the app's team can
 * reach, and how many builds each is already running.
 */
export async function resolveBuildPlan(
  app: Pick<App, "serverId" | "buildServerId" | "buildFallback" | "teamId">,
  target: Server,
): Promise<BuildPlan> {
  // Nothing to pin to and nothing to pick from: skip the second query entirely,
  // which is the single-server fleet, i.e. most of them.
  const candidates = await listServersForTeam(app.teamId);
  const self = deploHostSelfAddresses();
  const usableIds = candidates
    .filter((s) => s.id !== target.id && !s.storageOnly && !s.importOnly)
    .map((s) => s.id);
  if (usableIds.length === 0) {
    return planBuildServers(app, target, candidates, self);
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
  return planBuildServers(app, target, candidates, self, inFlight);
}

/**
 * What the deploy log says about where this app compiles, so nobody has to guess
 * which machine ran the build - or why it was not the one they picked.
 */
export function buildPlanLines(
  plan: BuildPlan,
  serverName: (serverId: string) => string,
  targetName: string,
): { level: "info" | "warn" | "error"; text: string }[] {
  const head = plan.chain[0];
  if (!plan.missed) {
    return head
      ? [
          {
            level: "info",
            text: `Building on ${serverName(head)}, then releasing on ${targetName}`,
          },
        ]
      : [];
  }
  const why = !plan.missed.pinned
    ? "No build server in this fleet can take this build right now."
    : plan.missed.reason === "arch-mismatch"
      ? `The build server chosen for this app has a different CPU architecture than ${targetName}, so an image built there could not run here.`
      : "The build server chosen for this app is unavailable.";
  if (head)
    return [
      {
        level: "warn",
        text: `${why} Building on ${serverName(head)} instead.`,
      },
    ];
  if (plan.local)
    return [
      { level: "warn", text: `${why} Building on ${targetName} instead.` },
    ];
  return [
    {
      level: "error",
      text: `${why} This app is set not to build anywhere else, so the running version was not touched.`,
    },
  ];
}
