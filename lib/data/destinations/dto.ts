import "server-only";

// https://deplo.build/docs/guides/data/backups-and-restore

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

// DestinationDTO is a destination as a client may see it - masked, never a credential.
export interface DestinationDTO extends Omit<
  BackupDestination,
  "accessKeyEnc" | "secretKeyEnc" | "ageIdentityEnc"
> {
  accessKeyMasked: string | null;
  serverName: string | null;
  // A pruned artifact takes its run row with it, so a `success` row is a file that still exists.
  storedBytes: number;
  storedCount: number;
}

// DestinationOption is a destination as a PICKER needs it.
export interface DestinationOption {
  id: string;
  name: string;
  kind: DestinationKind;
  // The bucket endpoint, or `<server> · <path>` - what tells two apart.
  where: string;
  status: DestinationStatus;
  // Which server holds it, so a caller can spot a same-disk backup.
  serverId: string | null;
  encrypted: boolean;
  recoveryKeySavedAt: string | null;
}

// toDestinationOption projects a destination down to DestinationOption.
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

// destinationWhere is the one-line "where does this point" string, for every picker and card.
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

// storedPerDestination reports what each destination holds, in one grouped read.
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
    // `sum` comes back as a string (bigint), and as null for a group of NULLs.
    out.set(r.destinationId, {
      bytes: Number(r.bytes ?? 0),
      count: Number(r.runs ?? 0),
    });
  }
  return out;
}

// withServerNames attaches each `server` destination's host name in one lookup, not N.
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

// withServerName is withServerNames for the single-destination case.
export async function withServerName(
  d: BackupDestination,
): Promise<DestinationDTO> {
  return (await withServerNames([d]))[0]!;
}
