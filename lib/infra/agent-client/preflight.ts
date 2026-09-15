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

export async function agentPreflight(serverId: string): Promise<HelloResponse> {
  const conn = await connectAgent(serverId);
  try {
    const resp = await conn.hello();
    if (resp.contractVersion !== ContractVersion.CONTRACT_VERSION_V1) {
      throw new Error(
        `agent speaks contract ${resp.contractVersion}, control plane speaks V1`,
      );
    }
    try {
      void markServerSeen(
        serverId,
        resp.agentVersion,
        observedTraefik(resp),
        undefined,
        undefined,
        resp.hostArch,
      );
    } catch {}
    return resp;
  } finally {
    conn.close();
  }
}

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

export async function connectBackupAgent(
  serverId: string,
  opts: {
    store?: boolean;
    encryptedS3?: boolean;
    s3Args?: boolean;
    s3Read?: boolean;
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
