import "server-only";

import { AGENT_PORT_NOTICE } from "../../agent-reachability";
import { normalizePath } from "../../migration/map/volume-discovery";
import type { PairedHostMount } from "../../migration/map/volume-pairing";

import type { Landed } from "./landed-targets";

export const UNREACHABLE_SOURCE_HOST =
  "Deplo has no agent on the machine this service's data is on, so its data cannot be copied. Add that machine as a server first - the Connect step lists it and installs the agent for you.";

export const UNREACHABLE_SOURCE_AGENT = `Deplo cannot reach the agent on the machine this service's data is on, so nothing was stopped and no data was copied. Installing the agent is outbound and works behind any firewall; reading a volume is Deplo dialing that machine back, INBOUND. ${AGENT_PORT_NOTICE} Then check the machine's address under Servers and run the copy again.`;

export function missingVolumeMessage(
  name: string,
  serviceName: string,
  running: boolean,
): string {
  return running
    ? `Deplo asked the machine {panel} says it runs ${serviceName} on for ${name}, and there is no such volume there - ${serviceName} is running, so its data is on a different machine. Correct that machine's address and run the copy again.`
    : `Deplo asked the machine {panel} says it runs ${serviceName} on for ${name}, and there is no such volume there. ${serviceName} is stopped over there, so it may simply never have been started - check before anyone uses it.`;
}

export function sharedPathNote(
  owner: { name: string; path: string },
  targetPath: string,
): string {
  return `${targetPath} is also mounted by ${owner.name} on this machine (${owner.path}). Copying into it would erase what that app has there, so nothing was written - give one of them its own directory, then copy the data again.`;
}

export function unfilledStackBinds(
  landed: Landed,
  binds: PairedHostMount[],
): string[] {
  return landed.hostMounts
    .filter(
      (m) =>
        m.stackRelative &&
        !binds.some((b) => b.mountPath === m.mountPath) &&
        !landed.fileMounts.has(normalizePath(m.mountPath)),
    )
    .map(
      (m) =>
        `${m.mountPath} is bound to a directory beside this stack's compose file, and {panel} named no path for it - nothing was copied into it. Start the stack on {panel} and run the copy again if it holds data.`,
    );
}
