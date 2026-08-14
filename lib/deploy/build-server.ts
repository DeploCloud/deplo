import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { deployments as deploymentsTable } from "../db/schema/control-plane";
import { listServersForTeam } from "../data/servers";
import type { App, Server } from "../types";

/**
 * Which server BUILDS an app's image, when that is not the one that runs it.
 *
 * A BUILD SERVER compiles for machines it does not host. The point is that a
 * production box can be sized for the workload instead of the build: a Next.js app
 * that serves in 300 MB needs several GB to compile, and while it compiles it
 * competes with the apps already running beside it.
 *
 * The rule is deliberately automatic. A host somebody marked "only build" exists to
 * be built on - asking every app to opt in one at a time would be paperwork for a
 * decision already made at the fleet level. So NULL on the app means "use one if
 * there is one", and the per-app setting is the override, not the switch.
 *
 * Split into a PURE {@link pickBuildServer} and the data-reading wrapper below so
 * the interesting half - precedence, the arch guard, the tie-break - is testable
 * without a database or an agent.
 */

/** Why a build server was (or was not) chosen. Surfaced in the deploy log, so the
 *  operator never has to guess which machine compiled their app. */
export type BuildServerChoice =
  | { serverId: string; reason: "pinned" | "automatic" }
  | { serverId: null; reason: "own-server" | "none-available" | "arch-mismatch" };

/**
 * The pure decision. `candidates` is every server the app's team can reach.
 *
 * Precedence, in order:
 *
 *  1. A PIN that resolves to the app's own server means "always build where it
 *     runs" - the explicit opt-out, and it beats any build server in the fleet.
 *  2. Any other pin wins outright, including over a healthier automatic choice. A
 *     setting that silently routes elsewhere is not a setting.
 *  3. Otherwise: the least busy build-only server that can produce a runnable image
 *     for this target.
 *  4. Nothing suitable ⇒ null ⇒ exactly the behaviour that predates build servers.
 *
 * A pin that no longer resolves (the server was removed, lost its grant, went
 * offline, or is a storage-only box) degrades to building on the app's own server
 * with a warning in the log - NOT to silently auto-picking a different builder. The
 * app still has to deploy, and the operator gets told their setting did not apply;
 * quietly substituting another machine would be the same class of surprise the pin
 * exists to prevent.
 */
export function pickBuildServer(
  app: Pick<App, "serverId" | "buildServerId">,
  target: Pick<Server, "id" | "hostArch">,
  candidates: readonly Server[],
  inFlightByServer: ReadonlyMap<string, number> = new Map(),
): BuildServerChoice {
  if (app.buildServerId) {
    // Pinned to where it already runs. `target` as well as `app.serverId`, because
    // a pull request preview can be pinned to a different machine than production -
    // an app that builds on its own server and previews on the builder is already
    // there, and saying "unavailable" about it would be nonsense.
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

  const usable = candidates.filter((s) => s.buildOnly && canBuildFor(s, target));
  if (usable.length === 0) return { serverId: null, reason: "none-available" };

  // Fewest builds in flight, and on a tie the one added first. Deterministic on
  // purpose: two deploys racing must not depend on map iteration order, and an
  // operator watching two builders should see them fill evenly rather than by
  // whichever the query happened to return.
  const best = usable.reduce((a, b) => {
    const na = inFlightByServer.get(a.id) ?? 0;
    const nb = inFlightByServer.get(b.id) ?? 0;
    if (na !== nb) return na < nb ? a : b;
    return a.createdAt <= b.createdAt ? a : b;
  });
  return { serverId: best.id, reason: "automatic" };
}

/**
 * Whether `builder` can produce an image `target` will actually run.
 *
 * The architecture check is the load-bearing one and it is a REFUSAL, not a
 * warning: an amd64 image loaded on an arm64 host starts and dies with `exec format
 * error`, at run time, after the deploy has already reported success. An empty
 * `hostArch` on either side (an agent too old to report it) never matches, which
 * keeps that pair out of the picker instead of guessing.
 *
 * `offline` is excluded here rather than left to the connection attempt so the
 * automatic rule skips a dead builder instead of picking it and then falling back;
 * a builder that dies between this read and the dial is what the fallback is for.
 */
export function canBuildFor(
  builder: Pick<Server, "id" | "status" | "storageOnly" | "hostArch">,
  target: Pick<Server, "id" | "hostArch">,
): boolean {
  if (builder.id === target.id) return false;
  if (builder.storageOnly) return false; // no Docker, nothing to build with
  if (builder.status === "offline" || builder.status === "provisioning") return false;
  return builder.hostArch !== "" && builder.hostArch === target.hostArch;
}

/**
 * {@link pickBuildServer} against the live fleet: the servers the app's team can
 * reach, and how many builds each is already running.
 *
 * The in-flight count comes from the `deployments` table rather than the queue's
 * in-memory lanes, so it stays right across a control-plane restart - the same
 * reason the queue treats the rows as the durable truth and itself as only the
 * dispatcher.
 */
export async function resolveBuildServer(
  app: Pick<App, "serverId" | "buildServerId" | "teamId">,
  target: Server,
): Promise<BuildServerChoice> {
  // Nothing to pin to and nothing to pick from: skip both queries entirely, which
  // is the single-server fleet, i.e. most of them.
  const candidates = await listServersForTeam(app.teamId);
  const usableIds = candidates
    .filter((s) => s.id !== target.id && !s.storageOnly)
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
    if (r.serverId) inFlight.set(r.serverId, (inFlight.get(r.serverId) ?? 0) + 1);
  }
  return pickBuildServer(app, target, candidates, inFlight);
}

/**
 * The one-line explanation of a build server choice, for the deploy log. Only the
 * cases an operator would otherwise have to investigate say anything; the ordinary
 * "built where it runs" is silent, because narrating the default on every deploy is
 * noise that trains people to skip the log.
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
