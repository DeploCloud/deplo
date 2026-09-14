import "server-only";

import { ContractVersion, type HelloResponse } from "../../agent/gen/agent";
import {
  markServerSeen,
  observedTraefik,
} from "../../data/servers/agent-handshake";
import { connectAgent } from "./connect";
import type { AgentConnection } from "./connection";
import {
  AgentBackupStoreUnsupportedError,
  AgentBackupUnsupportedError,
  AgentCronUnsupportedError,
  AgentMetricsStreamUnsupportedError,
  CRON_UNSUPPORTED_MESSAGE,
  mapBackupUnsupported,
  mapCronUnsupported,
} from "./errors";
import {
  BACKUP_CAPABILITY,
  BACKUP_ENCRYPT_S3_CAPABILITY,
  BACKUP_S3_ARGS_CAPABILITY,
  BACKUP_S3_READ_CAPABILITY,
  BACKUP_STORE_CAPABILITY,
  BACKUP_UNTRUSTED_CONFIG_CAPABILITY,
  CRON_CAPABILITY,
  METRICS_STREAM_CAPABILITY,
} from "./hello-capabilities";

// serverSupports is best-effort: unreachable, too old or simply slow all answer
// `false`, because every caller is deciding whether to WARN, never to proceed.
export async function serverSupports(
  serverId: string,
  capability: string,
): Promise<boolean> {
  try {
    const conn = await connectAgent(serverId);
    try {
      const hello = await conn.hello();
      return hello.capabilities?.includes(capability) === true;
    } finally {
      conn.close();
    }
  } catch {
    return false;
  }
}

// agentPreflight confirms the agent answers Hello before a deploy, contract version
// included. Throws a clear "server unreachable" error, never hangs.
export async function agentPreflight(serverId: string): Promise<HelloResponse> {
  const conn = await connectAgent(serverId);
  try {
    const resp = await conn.hello();
    if (resp.contractVersion !== ContractVersion.CONTRACT_VERSION_V1) {
      throw new Error(
        `agent speaks contract ${resp.contractVersion}, control plane speaks V1`,
      );
    }
    // Heartbeat cache: best-effort, behind the live-read. Also refresh the
    // server's traefikEnabled from this live Hello so the badge reflects reality.
    try {
      void markServerSeen(
        serverId,
        resp.agentVersion,
        observedTraefik(resp),
        undefined,
        undefined,
        resp.hostArch,
      );
    } catch {
      /* unknown id: no row to touch */
    }
    return resp;
  } finally {
    conn.close();
  }
}

// connectCronAgent opens a connection to an agent that can run cron jobs, or throws.
export async function connectCronAgent(
  serverId: string,
): Promise<AgentConnection> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CRON_CAPABILITY)) {
      throw new AgentCronUnsupportedError(CRON_UNSUPPORTED_MESSAGE);
    }
  } catch (e) {
    conn.close();
    throw mapCronUnsupported(e);
  }
  return conn;
}

// connectMetricsStreamAgent opens a connection for the telemetry stream,
// preflighting the capability.
export async function connectMetricsStreamAgent(
  serverId: string,
): Promise<{ conn: AgentConnection; hello: HelloResponse }> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(METRICS_STREAM_CAPABILITY)) {
      throw new AgentMetricsStreamUnsupportedError(
        `The agent on this server predates the telemetry stream; polling it instead.`,
      );
    }
    return { conn, hello };
  } catch (e) {
    conn.close();
    throw e;
  }
}

// connectBackupAgent is the entry point every real backup/restore path uses: it
// preflights the backup capabilities and returns the LIVE connection to close().
export async function connectBackupAgent(
  serverId: string,
  /** Also require `"backup-store"` - set when the artifact lives on THIS host's
   *  disk. Split from the base check so an agent that can dump to S3 but cannot
   *  hold artifacts fails the SECOND thing with a message that names it. */
  opts: {
    store?: boolean;
    encryptedS3?: boolean;
    /** This destination carries advanced S3 flags - warn if they will be
     *  dropped, but never refuse. */
    s3Args?: boolean;
    /** Also require `"backup-s3-read"` - set when the artifact is to be streamed
     *  back OUT of a bucket, which only an agent with that RPC arm can do. */
    s3Read?: boolean;
    /** Also require `"backup-untrusted-config"` - set when the artifact came from
     *  outside the fleet, so it is only ever handed to an agent that will refuse
     *  to take its stack configuration. */
    untrustedConfig?: boolean;
  } = {},
): Promise<AgentConnection> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(BACKUP_CAPABILITY)) {
      throw new AgentBackupUnsupportedError(
        `The agent on this server is too old to run backups. ` +
          `Update the agent on this server, then try again.`,
      );
    }
    if (opts.store && !hello.capabilities?.includes(BACKUP_STORE_CAPABILITY)) {
      throw new AgentBackupStoreUnsupportedError(
        `The agent on this server is too old to store backups on its disk. ` +
          `Update the agent on this server, then try again.`,
      );
    }
    // FAIL rather than downgrade. An agent without this ignores the recipient and
    // writes the artifact - the app's entire decrypted env included - to the bucket in
    // plaintext, under a key whose `.age` suffix says otherwise.
    if (
      opts.encryptedS3 &&
      !hello.capabilities?.includes(BACKUP_ENCRYPT_S3_CAPABILITY)
    ) {
      throw new AgentBackupStoreUnsupportedError(
        `The agent on this server is too old to encrypt backups sent to a bucket, ` +
          `and Deplo will not write them unencrypted. Update the agent on this ` +
          `server, then try again.`,
      );
    }
    if (
      opts.s3Read &&
      !hello.capabilities?.includes(BACKUP_S3_READ_CAPABILITY)
    ) {
      throw new AgentBackupStoreUnsupportedError(
        `The agent on this server is too old to read a backup back out of a ` +
          `bucket. Update the agent on this server, then try again.`,
      );
    }
    if (
      opts.untrustedConfig &&
      !hello.capabilities?.includes(BACKUP_UNTRUSTED_CONFIG_CAPABILITY)
    ) {
      throw new AgentBackupStoreUnsupportedError(
        `The agent on this server is too old to restore from an uploaded file ` +
          `safely: it would take the stack configuration out of the file itself. ` +
          `Update the agent on this server, then try again.`,
      );
    }
    // Said out loud, not swallowed: the flags exist because a store misbehaves without
    // them, so an operator whose backup is failing needs to know this host is not
    // applying them.
    if (
      opts.s3Args &&
      !hello.capabilities?.includes(BACKUP_S3_ARGS_CAPABILITY)
    ) {
      console.warn(
        `[backups] the agent on server ${serverId} is too old to apply this ` +
          `destination's advanced S3 flags - it is talking to the bucket ` +
          `without them. Update the agent on this server to apply them.`,
      );
    }
  } catch (e) {
    conn.close();
    throw mapBackupUnsupported(e);
  }
  return conn;
}
