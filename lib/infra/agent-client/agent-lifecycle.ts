import "server-only";

import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";
import { isNewer } from "../../version";
import { connectAgent, dial } from "./connect";
import {
  AgentReleaseUnavailableError,
  AgentUninstallUnsupportedError,
  AgentUpdateUnsupportedError,
} from "./errors";
import {
  SELF_UNINSTALL_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
} from "./hello-capabilities";
import { resolveTarget } from "./mtls-channel";

export async function selfUpdateServerAgent(
  serverId: string,
): Promise<{ version: string; restarting: boolean }> {
  const target = await resolveTarget(serverId);

  const { resolveAgentRelease } = await import("../../agent/release");
  const release = await resolveAgentRelease();
  if (!release) throw new AgentReleaseUnavailableError();
  const binaries: Record<string, { url: string; sha256: string }> = {};
  for (const [arch, bin] of Object.entries(release.binaries)) {
    if (bin) binaries[arch] = { url: bin.url, sha256: bin.sha256 };
  }

  const conn = dial(target);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(SELF_UPDATE_CAPABILITY)) {
      throw new AgentUpdateUnsupportedError(
        `The agent on this server is too old to update itself remotely ` +
          `(target v${release.version}). Re-run the install command to upgrade it.`,
      );
    }
    // Forward-only: an agent ahead of the pin stays where it is.
    if (isNewer(hello.agentVersion, release.version))
      throw new Error(
        `This server already runs agent v${hello.agentVersion}, newer than the v${release.version} this Deplo installs. Nothing to install.`,
      );
    return await conn.selfUpdate(release.version, binaries);
  } catch (e) {
    if (
      !(e instanceof AgentUpdateUnsupportedError) &&
      (e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED
    ) {
      throw new AgentUpdateUnsupportedError(
        `The agent on this server is too old to update itself remotely ` +
          `(target v${release.version}). Re-run the install command to upgrade it.`,
      );
    }
    throw e;
  } finally {
    conn.close();
  }
}

export async function selfUninstallServerAgent(
  serverId: string,
  deadlineMs?: number,
): Promise<string[]> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(SELF_UNINSTALL_CAPABILITY)) {
      throw new AgentUninstallUnsupportedError(
        "The agent on this server is too old to uninstall itself. Run the " +
          "uninstall command on the host instead.",
      );
    }
    return await conn.selfUninstall(deadlineMs);
  } catch (e) {
    if (
      !(e instanceof AgentUninstallUnsupportedError) &&
      (e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED
    ) {
      throw new AgentUninstallUnsupportedError(
        "The agent on this server is too old to uninstall itself. Run the " +
          "uninstall command on the host instead.",
      );
    }
    throw e;
  } finally {
    conn.close();
  }
}
