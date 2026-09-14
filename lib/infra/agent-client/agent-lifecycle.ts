import "server-only";

import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";
import { isNewer } from "../../version";
import { connectAgent, dial } from "./connect";
import {
  AgentUninstallUnsupportedError,
  AgentUpdateUnsupportedError,
} from "./errors";
import {
  SELF_UNINSTALL_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
} from "./hello-capabilities";
import { resolveTarget } from "./mtls-channel";

// selfUpdateServerAgent updates a server's agent binary IN PLACE to the latest
// release, WITHOUT reissuing its certificates.
export async function selfUpdateServerAgent(
  serverId: string,
): Promise<{ version: string; restarting: boolean }> {
  // Resolves only for a provisioned server with un-revoked trust; throws
  // AgentUnreachableError otherwise.
  const target = await resolveTarget(serverId);

  // Resolve the release out here so a GitHub outage fails before we touch the agent,
  // and so version/urls are one consistent release.
  const { resolveLatestAgentRelease } = await import("../../agent/release");
  const release = await resolveLatestAgentRelease();
  if (!release) {
    throw new Error(
      "Could not resolve the latest agent release from GitHub - try again, or use Check for updates.",
    );
  }
  // Shape the release's per-arch binaries into the RPC's { arch -> {url,sha256} }
  // map, dropping any arch the release didn't publish (the agent picks its own).
  const binaries: Record<string, { url: string; sha256: string }> = {};
  for (const [arch, bin] of Object.entries(release.binaries)) {
    if (bin) binaries[arch] = { url: bin.url, sha256: bin.sha256 };
  }

  const conn = dial(target);
  try {
    // An agent too old to know the RPC won't advertise the capability - reject
    // distinctly so the UI says "re-run the installer" rather than UNIMPLEMENTED.
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(SELF_UPDATE_CAPABILITY)) {
      throw new AgentUpdateUnsupportedError(
        `The agent on this server is too old to update itself remotely ` +
          `(target v${release.version}). Re-run the install command to upgrade it.`,
      );
    }
    // Forward only (docs/agents/fleet-rollout.md). A GitHub blip resolves the
    // PINNED fallback instead of `latest`, which can be older than what this host
    // already runs, and the agent has no downgrade path.
    if (isNewer(hello.agentVersion, release.version))
      throw new Error(
        `This server already runs agent v${hello.agentVersion}, newer than the latest release Deplo can see (v${release.version}). Nothing to install.`,
      );
    return await conn.selfUpdate(release.version, binaries);
  } catch (e) {
    // Belt-and-braces: a just-old-enough agent that advertises nothing useful, or
    // a version skew, may still answer the call with UNIMPLEMENTED.
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

// selfUninstallServerAgent asks the agent to remove itself and reports what it
// removed. The caller must not revoke trust, nor delete the row, before it resolves.
export async function selfUninstallServerAgent(
  serverId: string,
  /** Shorter deadline for the one attempt made while somebody is waiting on the
   *  wizard; the background retries take the full one. */
  deadlineMs?: number,
): Promise<string[]> {
  // `connectAgent`, not resolveTarget + dial: identical in production, but it is
  // the seam the tests inject a stand-in through.
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
