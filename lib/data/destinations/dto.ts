import "server-only";

import { and, count, eq, inArray, sum } from "drizzle-orm";

import { listAllServers } from "../servers/roster";
import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { serverLabel } from "../../utils";
import type {
  BackupDestination,
  DestinationKind,
  DestinationStatus,
} from "../../types/backup";

export interface DestinationDTO extends Omit<
  BackupDestination,
  "accessKeyEnc" | "secretKeyEnc" | "ageIdentityEnc"
> {
  accessKeyMasked: string | null;
  serverName: string | null;
  storedBytes: number;
  storedCount: number;
}

export interface DestinationOption {
  id: string;
  name: string;
  kind: DestinationKind;
  where: string;
  status: DestinationStatus;
  serverId: string | null;
  encrypted: boolean;
  recoveryKeySavedAt: string | null;
}

export function toDestinationOption(d: DestinationDTO): DestinationOption {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    where: destinationWhere(d),
    status: d.status,
    serverId: d.serverId,
    encrypted: Boolean(d.ageRecipient),
    recoveryKeySavedAt: d.recoveryKeySavedAt,
  };
}

export function destinationWhere(d: DestinationDTO): string {
  if (d.kind === "s3") return d.endpoint ?? "";
  const server = d.serverName ?? "a removed server";
  const path = d.resolvedPath ?? d.path;
  return path ? `${server} · ${path}` : server;
}

function toDTO(
  d: BackupDestination,
  serverName: string | null,
  stored: Stored = EMPTY_STORED,
): DestinationDTO {
  const { accessKeyEnc, secretKeyEnc, ageIdentityEnc, ...rest } = d;
  void secretKeyEnc;
  void ageIdentityEnc;
  return {
    ...rest,
    accessKeyMasked: accessKeyEnc ? "••••••••" : null,
    serverName,
    storedBytes: stored.bytes,
    storedCount: stored.count,
  };
}

interface Stored {
  bytes: number;
  count: number;
}

const EMPTY_STORED: Stored = { bytes: 0, count: 0 };

export async function storedPerDestination(
  teamId: string,
  ids: string[],
): Promise<Map<string, Stored>> {
  const out = new Map<string, Stored>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select({
      destinationId: backupRunsTable.destinationId,
      bytes: sum(backupRunsTable.sizeBytes),
      runs: count(),
    })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
        inArray(backupRunsTable.destinationId, ids),
      ),
    )
    .groupBy(backupRunsTable.destinationId);
  for (const r of rows) {
    out.set(r.destinationId, {
      bytes: Number(r.bytes ?? 0),
      count: Number(r.runs ?? 0),
    });
  }
  return out;
}

export async function withServerNames(
  destinations: BackupDestination[],
  stored: Map<string, Stored> = new Map(),
): Promise<DestinationDTO[]> {
  if (!destinations.some((d) => d.serverId)) {
    return destinations.map((d) => toDTO(d, null, stored.get(d.id)));
  }
  const servers = await listAllServers();
  const byId = new Map(servers.map((s) => [s.id, serverLabel(s)]));
  return destinations.map((d) =>
    toDTO(
      d,
      d.serverId ? (byId.get(d.serverId) ?? null) : null,
      stored.get(d.id),
    ),
  );
}

export async function withServerName(
  d: BackupDestination,
): Promise<DestinationDTO> {
  return (await withServerNames([d]))[0]!;
}
