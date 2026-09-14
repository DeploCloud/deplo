import "server-only";

import { AGENT_PORT_NOTICE } from "../../agent-reachability";
import { normalizePath } from "../../migration/map/volume-discovery";
import type { PairedHostMount } from "../../migration/map/volume-pairing";

import type { Landed } from "./landed-targets";

/**
 * The one refusal that has to read the same on the review screen and at the
 * cutover: Deplo reads a volume by asking the agent ON the machine that holds it.
 */
export const UNREACHABLE_SOURCE_HOST =
  "Deplo has no agent on the machine this service's data is on, so its data cannot be copied. Add that machine as a server first - the Connect step lists it and installs the agent for you.";

/** Its twin, for the machine that HAS an agent Deplo still cannot talk to. */
export const UNREACHABLE_SOURCE_AGENT = `Deplo cannot reach the agent on the machine this service's data is on, so nothing was stopped and no data was copied. Installing the agent is outbound and works behind any firewall; reading a volume is Deplo dialing that machine back, INBOUND. ${AGENT_PORT_NOTICE} Then check the machine's address under Servers and run the copy again.`;

/**
 * What Deplo actually saw: it asked ONE machine for a volume and that machine has
 * no such volume. Only a service that is not running makes "never started there"
 * a fair reading; for one that IS running, the machine is the wrong machine.
 */
export function missingVolumeMessage(
  name: string,
  serviceName: string,
  running: boolean,
): string {
  return running
    ? `Deplo asked the machine {panel} says it runs ${serviceName} on for ${name}, and there is no such volume there - ${serviceName} is running, so its data is on a different machine. Correct that machine's address and run the copy again.`
    : `Deplo asked the machine {panel} says it runs ${serviceName} on for ${name}, and there is no such volume there. ${serviceName} is stopped over there, so it may simply never have been started - check before anyone uses it.`;
}

/** The refusal when another app on the same machine mounts the path a copy would wipe. */
export function sharedPathNote(
  owner: { name: string; path: string },
  targetPath: string,
): string {
  return `${targetPath} is also mounted by ${owner.name} on this machine (${owner.path}). Copying into it would erase what that app has there, so nothing was written - give one of them its own directory, then copy the data again.`;
}

/**
 * A `./x` bind this app HAS here that nothing on the other side filled. The
 * stopped-stack case: the panel names no path for it, so it pairs with nothing
 * and used to be a clean `0/0` over a directory that should have had data in it.
 */
export function unfilledStackBinds(
  landed: Landed,
  binds: PairedHostMount[],
): string[] {
  return landed.hostMounts
    .filter(
      (m) =>
        m.stackRelative &&
        !binds.some((b) => b.mountPath === m.mountPath) &&
        // A config FILE is filled by the configuration channel, so a stopped app
        // (no live bind to pair it with) is not missing anything.
        !landed.fileMounts.has(normalizePath(m.mountPath)),
    )
    .map(
      (m) =>
        `${m.mountPath} is bound to a directory beside this stack's compose file, and {panel} named no path for it - nothing was copied into it. Start the stack on {panel} and run the copy again if it holds data.`,
    );
}
