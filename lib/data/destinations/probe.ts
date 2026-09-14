import "server-only";

import { and, eq } from "drizzle-orm";

import { listAllServers } from "../servers/roster";
import { getDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { assembleDestination } from "../backup-rows";
import {
  buildS3TestReport,
  emptyS3TestReport,
  type S3TestReport,
  type S3TestTarget,
} from "../s3-test-report";
import { serverLabel } from "../../utils";
import { nowIso } from "../../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../../membership";
import {
  mapBackupUnsupported,
  AgentUnreachableError,
} from "../../infra/agent-client/errors";
import { connectBackupAgent } from "../../infra/agent-client/preflight";
import { destinationWhere, withServerName, type DestinationDTO } from "./dto";
import { listDestinations, loadDestination } from "./listing";
import {
  getDestinationWithSecrets,
  s3TargetFor,
  storeTargetFor,
} from "./credentials";
import type { S3Target } from "../../agent/gen/agent";
import type { BackupDestination } from "../../types/backup";

// DestinationTestResult is the destination repainted from the live verdict, plus the verdict.
export interface DestinationTestResult {
  destination: DestinationDTO;
  report: S3TestReport;
}

// testDestination verifies one destination for real and persists the live verdict.
export async function testDestination(
  id: string,
): Promise<DestinationTestResult> {
  const teamId = (await requireCapability("manage_backup_destinations")).teamId;
  const cur = await loadDestination(id, teamId);
  if (!cur) throw new Error("Not found");
  return probeAndRecord(id, teamId);
}

// testDestinations re-probes every destination in the active team, in listDestinations order.
export async function testDestinations(): Promise<DestinationDTO[]> {
  const teamId = (await requireCapability("manage_backup_destinations")).teamId;
  const current = await listDestinations();
  return mapBounded(current, PROBE_CONCURRENCY, async (d) => {
    try {
      return (await probeAndRecord(d.id, teamId)).destination;
    } catch {
      return d;
    }
  });
}

const PROBE_CONCURRENCY = 4;

// `Promise.all` with a ceiling on how many run at once; results keep input order.
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

async function probeAndRecord(
  id: string,
  teamId: string,
): Promise<DestinationTestResult> {
  const creds = await getDestinationWithSecrets(id);
  const d = creds.destination;

  // The agent probe (RPC) runs BEFORE the status write, never inside a transaction.
  const startedAt = nowIso();
  const began = Date.now();
  let ok = false;
  let error = "";
  let serverId: string | null = null;
  let attempts: string[] = [];
  let freeBytes: number | null = null;
  let totalBytes: number | null = null;
  let resolvedPath: string | null = null;
  try {
    if (d.kind === "server") {
      const verdict = await checkStoreOnItsServer(d);
      ok = verdict.ok;
      error = verdict.error;
      serverId = d.serverId;
      freeBytes = verdict.freeBytes;
      totalBytes = verdict.totalBytes;
      resolvedPath = verdict.root || null;
    } else {
      // `S3Check` ignores the object key (it's a bucket probe), but the wire type
      // requires one - a sentinel that documents intent.
      const verdict = await checkOnAnyBackupAgent(
        s3TargetFor(creds, "deplo/.s3check"),
        // An ENCRYPTED bucket needs an agent that honours the recipient.
        Boolean(d.ageRecipient),
      );
      ok = verdict.ok;
      error = verdict.error;
      serverId = verdict.serverId;
      attempts = verdict.attempts;
    }
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - began;

  const status = ok ? "connected" : "error";
  const updated = await getDb()
    .update(destTable)
    .set({
      status,
      lastTestAt: startedAt,
      // Empty string would read as "tested and passed" - store NULL on success.
      lastTestError: ok ? null : error || "The destination probe failed.",
      lastTestServerId: serverId,
      lastTestMs: durationMs,
      // A probe that could not reach the host measured nothing, and nothing is not
      // zero: keep the last real figures rather than losing the folder and the bar.
      lastFreeBytes: freeBytes ?? d.lastFreeBytes,
      lastTotalBytes: totalBytes ?? d.lastTotalBytes,
      resolvedPath: resolvedPath ?? d.resolvedPath,
    })
    .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  const destination = await withServerName(assembleDestination(updated[0]!));

  return {
    destination,
    report: buildS3TestReport({
      target: testTargetOf(destination),
      ok,
      error,
      startedAt,
      durationMs,
      serverName: serverId ? await serverLabelFor(serverId) : "",
      agentAttempts: attempts,
    }),
  };
}

// The destination fields the report prints, never a credential.
function testTargetOf(d: DestinationDTO): S3TestTarget {
  return {
    name: d.name,
    kind: d.kind,
    provider: d.provider ?? "other",
    endpoint: destinationWhere(d),
    region: d.region ?? "",
    bucket: d.bucket ?? "",
    // The folder the agent actually resolved beats the one that was configured; both
    // are empty for a managed root nobody has tested yet.
    path: d.resolvedPath ?? d.path ?? "",
  };
}

// A legible stand-in covers the window where a report is read against a server
// deleted moments ago (the FK is SET NULL on removal).
async function serverLabelFor(serverId: string): Promise<string> {
  const server = (await listAllServers()).find((s) => s.id === serverId);
  return server ? serverLabel(server) : "a server that has since been removed";
}

// destinationTestReport is the STORED report, so reading the last failure never re-dials.
export async function destinationTestReport(id: string): Promise<S3TestReport> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("backup destinations");
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");
  const dto = await withServerName(d);
  const target = testTargetOf(dto);
  if (!d.lastTestAt) return emptyS3TestReport(target);
  return buildS3TestReport({
    target,
    ok: !d.lastTestError,
    error: d.lastTestError ?? "",
    startedAt: d.lastTestAt,
    durationMs: d.lastTestMs ?? 0,
    serverName: d.lastTestServerId
      ? await serverLabelFor(d.lastTestServerId)
      : "",
  });
}

// Probe a `server` destination on ITS OWN host: unlike a bucket, this question is
// about one machine's disk.
async function checkStoreOnItsServer(d: BackupDestination): Promise<{
  ok: boolean;
  error: string;
  freeBytes: number | null;
  totalBytes: number | null;
  root: string;
}> {
  if (!d.serverId) {
    return {
      ok: false,
      error: "This destination has no server.",
      freeBytes: null,
      totalBytes: null,
      root: "",
    };
  }
  // `store: true` is what makes an old agent say so.
  const conn = await connectBackupAgent(d.serverId, { store: true });
  try {
    const verdict = await conn.storeCheck(storeTargetFor(d, ""));
    return {
      ok: verdict.ok,
      error: verdict.error,
      freeBytes: verdict.ok ? verdict.freeBytes : null,
      totalBytes: verdict.ok ? verdict.totalBytes : null,
      root: verdict.root,
    };
  } catch (e) {
    // An agent old enough to back up to S3 but not to hold artifacts must say exactly
    // that, rather than "the check failed".
    throw mapBackupUnsupported(e);
  } finally {
    conn.close();
  }
}

// Run `S3Check` on the first reachable, backup-capable agent.
async function checkOnAnyBackupAgent(
  target: S3Target,
  encrypted = false,
): Promise<{
  ok: boolean;
  error: string;
  serverId: string | null;
  // `<server> - <why>` for each server tried and skipped, in order.
  attempts: string[];
}> {
  // Any provisioned agent can reach a bucket - except a migration source, which is
  // another platform's host that happens to have our agent on it for one job.
  const servers = (await listAllServers()).filter(
    (s) => s.agent?.certFingerprint && !s.importOnly,
  );
  if (servers.length === 0) {
    throw new AgentUnreachableError(
      "No provisioned server is available to verify the bucket.",
    );
  }
  let lastUnsupported: Error | null = null;
  let lastUnreachable: Error | null = null;
  // Every server we walked past, so the connection log can distinguish "your bucket
  // is wrong" from "no host here could even run the check".
  const attempts: string[] = [];
  for (const server of servers) {
    let conn;
    try {
      conn = await connectBackupAgent(server.id, { encryptedS3: encrypted });
    } catch (e) {
      const mapped = mapBackupUnsupported(e);
      attempts.push(`${serverLabel(server)} - ${mapped.message}`);
      if (mapped instanceof AgentUnreachableError) lastUnreachable = mapped;
      else lastUnsupported = mapped;
      continue;
    }
    try {
      const verdict = await conn.s3Check(target);
      return { ...verdict, serverId: server.id, attempts };
    } catch (e) {
      // An old agent (UNIMPLEMENTED) or a transport drop → try the next; otherwise
      // it's a real probe failure.
      const mapped = mapBackupUnsupported(e);
      if (mapped instanceof AgentUnreachableError) lastUnreachable = mapped;
      else if (mapped.name === "AgentBackupUnsupportedError")
        lastUnsupported = mapped;
      else
        return {
          ok: false,
          error: mapped.message,
          serverId: server.id,
          attempts,
        };
      attempts.push(`${serverLabel(server)} - ${mapped.message}`);
    } finally {
      conn.close();
    }
  }
  // Prefer the actionable "update the agent" when at least one server was
  // reachable-but-too-old; else report unreachable.
  throw (
    lastUnsupported ??
    lastUnreachable ??
    new AgentUnreachableError(
      "No backup-capable agent could verify the bucket.",
    )
  );
}
