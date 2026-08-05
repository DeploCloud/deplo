import "server-only";

import { lookup } from "node:dns/promises";

import { and, desc, eq } from "drizzle-orm";

import { listAllServers } from "./servers";
import { getDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  s3Destination as s3Table,
} from "../db/schema/control-plane";
import { assembleS3, s3ToRow } from "./backup-rows";
import {
  buildS3TestReport,
  emptyS3TestReport,
  type S3TestReport,
  type S3TestTarget,
} from "./s3-test-report";
import { getCurrentUser } from "../auth";
import { serverLabel } from "../utils";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability, requireUnscoped } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  connectBackupAgent,
  mapBackupUnsupported,
  AgentUnreachableError,
} from "../infra/agent-client";
import type { S3Target } from "../agent/gen/agent";
import type { S3Destination, S3Provider, S3Status } from "../types";

export interface S3DestinationDTO
  extends Omit<S3Destination, "accessKeyEnc" | "secretKeyEnc"> {
  accessKeyMasked: string;
}

/**
 * What "Test connection" returns: the destination as it now stands (its badge
 * repainted from the live verdict) AND the verdict itself. The report is the
 * point — the mutation used to return only the destination, so a caller had no
 * way to tell a passing probe from a failing one and the UI cheerfully toasted
 * success either way.
 */
export interface S3TestResult {
  destination: S3DestinationDTO;
  report: S3TestReport;
}

/**
 * A destination as a PICKER needs it — what to call it, where it points, how it
 * last answered. Deliberately narrower than the DTO: a dialog that only chooses
 * a bucket has no business shipping the region, the masked key or the test
 * history to the browser.
 */
export interface DestinationOption {
  id: string;
  name: string;
  endpoint: string;
  status: S3Status;
}

/** Project a destination down to {@link DestinationOption}. */
export function toDestinationOption(d: S3DestinationDTO): DestinationOption {
  return { id: d.id, name: d.name, endpoint: d.endpoint, status: d.status };
}

function toDTO(s: S3Destination): S3DestinationDTO {
  const { accessKeyEnc, secretKeyEnc, ...rest } = s;
  void secretKeyEnc;
  return { ...rest, accessKeyMasked: "••••••••" };
}

export const S3_PROVIDERS: { id: S3Provider; name: string; endpointHint: string }[] = [
  { id: "aws", name: "Amazon S3", endpointHint: "https://s3.<region>.amazonaws.com" },
  { id: "cloudflare-r2", name: "Cloudflare R2", endpointHint: "https://<account>.r2.cloudflarestorage.com" },
  { id: "backblaze-b2", name: "Backblaze B2", endpointHint: "https://s3.<region>.backblazeb2.com" },
  { id: "digitalocean", name: "DigitalOcean Spaces", endpointHint: "https://<region>.digitaloceanspaces.com" },
  { id: "wasabi", name: "Wasabi", endpointHint: "https://s3.<region>.wasabisys.com" },
  { id: "minio", name: "MinIO (self-hosted)", endpointHint: "https://minio.example.com" },
  { id: "other", name: "Other S3-compatible", endpointHint: "https://..." },
];

/**
 * The one name resolver the outbound guard goes through, swappable so the pglite
 * suite stays hermetic (a real lookup would hit the network — and answer
 * differently on every machine). Production always uses node's resolver.
 */
let dnsLookup: (host: string) => Promise<{ address: string }[]> = (host) =>
  lookup(host, { all: true });

export function __setDnsLookupForTest(
  fn: (host: string) => Promise<{ address: string }[]>,
): void {
  dnsLookup = fn;
}

export function __resetDnsLookupForTest(): void {
  dnsLookup = (host) => lookup(host, { all: true });
}

/**
 * Guard a user-supplied outbound URL (S3 endpoint, notification webhook)
 * against SSRF: the control plane dials the webhooks itself and the agents dial
 * the endpoint, so it must be http(s) and must never aim INSIDE the deployment.
 * Literal loopback, RFC1918, CGNAT, link-local (incl. the cloud metadata IP
 * 169.254.169.254) and IPv6 loopback/link-local/ULA hosts are rejected.
 * (WHATWG URL canonicalizes octal/hex/decimal IPv4 forms, so `0177.0.0.1` lands
 * on the dotted-decimal checks below.)
 *
 * A HOSTNAME is resolved and every address it answers with runs through the same
 * check — otherwise the guard only stopped the naive spelling of the attack, and
 * `http://internal.example.com/` walked straight past it into the control
 * plane's own network. That is also why the callers dial with
 * `redirect: "manual"`: a 302 is the other way out of a checked URL.
 *
 * The ceiling this does NOT reach is a rebinding race — the name is resolved
 * here and again by the dial, and only pinning the address through to the socket
 * closes that. A name that fails to resolve is left alone: the dial will fail
 * too, and refusing to SAVE a webhook because DNS blipped is a worse trade.
 */
export async function assertSafeOutboundUrl(
  raw: string,
  label: string,
  opts?: { allowHttp?: boolean },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(opts?.allowHttp && url.protocol === "http:"))
    throw new Error(`${label} must be an ${opts?.allowHttp ? "http(s)" : "https"} URL`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const refuse = () => {
    throw new Error(`${label} must not point at a private or internal address`);
  };
  if (isInternalHost(host)) refuse();
  // A literal is its own answer; only a NAME has to be resolved.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return;
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host);
  } catch {
    return; // unresolvable today — the dial fails too, see the docblock
  }
  if (addresses.some((a) => isInternalHost(a.address.toLowerCase()))) refuse();
}

/** True for a host literal inside the deployment's own network (see above). */
function isInternalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || // "this network"
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT (100.64/10)
      (a === 169 && b === 254) || // link-local + the metadata IP
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) // RFC1918
    );
  }
  if (host.includes(":")) {
    // An IPv6 literal (brackets stripped by the caller).
    return (
      host === "::" ||
      host === "::1" || // loopback
      /^fe[89ab]/.test(host) || // link-local fe80::/10
      /^f[cd]/.test(host) || // ULA fc00::/7 (covers fd00::/8)
      host.startsWith("::ffff:") // v4-mapped — must not dodge the v4 checks
    );
  }
  return false;
}

/**
 * Whether to address a provider's bucket PATH-style (bucket in the URL path) vs
 * VIRTUAL-HOST style (bucket as a subdomain). AWS S3 is virtual-host; the
 * S3-compatible stores (R2, B2, Spaces, Wasabi, self-hosted MinIO, "other")
 * generally need or tolerate path-style, so we default everything non-AWS to
 * path-style. The agent's minio-go client honours this flag.
 */
function pathStyleFor(provider: S3Provider): boolean {
  return provider !== "aws";
}

/**
 * A destination with its creds DECRYPTED, for the backup executor only
 * (server-only). NEVER returned to a client — `S3DestinationDTO` is the
 * client-facing masked shape. The decrypted access/secret keys ride the mTLS
 * channel to the owning agent, which holds the S3 client (minio-go); the bytes
 * never round-trip through the control plane.
 */
export interface S3WithSecrets {
  destination: S3Destination;
  accessKey: string;
  secretKey: string;
}

/**
 * Load a destination with its creds decrypted for a SPECIFIC team — the
 * session-free core. Throws when the id is unknown / not in `teamId` so a backup
 * can't target a foreign bucket. The scheduler (Step 6) runs with NO request
 * context, so it must call this with the schedule's own `teamId` rather than the
 * cookie-derived active team; the interactive {@link getS3WithSecrets} wraps it.
 */
export async function getS3WithSecretsForTeam(
  teamId: string,
  id: string,
): Promise<S3WithSecrets> {
  const s = await loadS3(id, teamId);
  if (!s) throw new Error("Destination not found");
  return {
    destination: s,
    accessKey: decryptSecret(s.accessKeyEnc),
    secretKey: decryptSecret(s.secretKeyEnc),
  };
}

/** Load one team-scoped S3 destination row, assembled, or null. */
async function loadS3(id: string, teamId: string): Promise<S3Destination | null> {
  const rows = await getDb()
    .select()
    .from(s3Table)
    .where(and(eq(s3Table.id, id), eq(s3Table.teamId, teamId)))
    .limit(1);
  return rows[0] ? assembleS3(rows[0]) : null;
}

/**
 * Load the ACTIVE team's S3 destination with its creds decrypted, for the
 * interactive executor (manual "Run now" / restore). Scoped to the active team
 * via the session (mirrors every other team-scoped read). The unattended
 * scheduler uses {@link getS3WithSecretsForTeam} instead (no session).
 */
export async function getS3WithSecrets(id: string): Promise<S3WithSecrets> {
  const teamId = await requireActiveTeamId();
  // A destination belongs to the team, not to a Project, so a project-scoped API
  // token has no business READING one — while the session-free core above stays
  // open, because a scoped token backing up an app it CAN reach still needs the
  // bucket's credentials to do it.
  requireUnscoped("S3 destinations");
  return getS3WithSecretsForTeam(teamId, id);
}

/**
 * Build the wire {@link S3Target} for an agent Backup/Restore/S3* call from a
 * decrypted destination + the exact object key (or prefix). The ONE place the
 * destination → S3Target mapping (incl. the provider's path-style decision)
 * lives, so the executor, the connectivity check, and the retention pruner can't
 * drift on it.
 */
export function s3TargetFor(s: S3WithSecrets, objectKey: string): S3Target {
  const d = s.destination;
  return {
    endpoint: d.endpoint,
    region: d.region,
    bucket: d.bucket,
    accessKey: s.accessKey,
    secretKey: s.secretKey,
    objectKey,
    pathStyle: pathStyleFor(d.provider),
  };
}

export async function listS3(): Promise<S3DestinationDTO[]> {
  requireUnscoped("S3 destinations");
  const teamId = await requireActiveTeamId();
  // Newest-first sort pushed into SQL (matches s3_destination_team_created_idx).
  const rows = await getDb()
    .select()
    .from(s3Table)
    .where(eq(s3Table.teamId, teamId))
    .orderBy(desc(s3Table.createdAt));
  return rows.map((r) => toDTO(assembleS3(r)));
}

export async function createS3(input: {
  name: string;
  provider: S3Provider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}): Promise<S3DestinationDTO> {
  const { membership } = await requireCapability("manage_s3");
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.bucket.trim()) throw new Error("Bucket is required");
  if (!input.accessKey || !input.secretKey)
    throw new Error("Access key and secret are required");
  // The endpoint is dialed from the agents (bucket probe, backups) — never let
  // it aim inside the network. http stays allowed for a self-hosted MinIO
  // fronted without TLS.
  await assertSafeOutboundUrl(input.endpoint.trim(), "Endpoint", { allowHttp: true });

  const s: S3Destination = {
    id: newId("s3"),
    teamId: membership.teamId,
    name: input.name.trim(),
    provider: input.provider,
    endpoint: input.endpoint.trim(),
    region: input.region.trim() || "auto",
    bucket: input.bucket.trim(),
    accessKeyEnc: encryptSecret(input.accessKey),
    secretKeyEnc: encryptSecret(input.secretKey),
    status: "unverified",
    createdAt: nowIso(),
    // Never tested yet — the badge says "unverified" and the connection log
    // offers the test rather than a stale verdict.
    lastTestAt: null,
    lastTestError: null,
    lastTestServerId: null,
    lastTestMs: null,
  };
  await getDb().insert(s3Table).values(s3ToRow(s));
  await recordActivity("s3", `Connected S3 destination ${s.name}`, user.name, null);
  return toDTO(s);
}

/**
 * Verify S3 connectivity for real: dial a reachable agent advertising the
 * `"backup"` capability and have IT probe the bucket (HEAD + a write probe) with
 * the decrypted creds over mTLS — the agent owns the S3 client (minio-go). The
 * destination's `status` is persisted from the live result (`connected` on
 * success, `error` otherwise) so the badge reflects reality, never a fake
 * success.
 *
 * Any provisioned, backup-capable agent can serve the probe (it needs no Docker,
 * just network + creds), so we try provisioned servers until one answers. If NO
 * server has a backup-capable agent yet, we surface the agent-update guidance
 * ({@link AgentBackupUnsupportedError}) rather than flipping to `connected`.
 */
export async function testS3(id: string): Promise<S3TestResult> {
  const teamId = (await requireCapability("manage_s3")).teamId;
  const cur = await loadS3(id, teamId);
  if (!cur) throw new Error("Not found");
  return probeAndRecord(id, teamId);
}

/**
 * Re-probe EVERY destination in the active team and return them repainted, in
 * `listS3` order. This is what the destination picker calls when it opens: a
 * stored badge can be hours old, and picking a destination is exactly the moment
 * "is this bucket actually reachable?" has to be true rather than remembered.
 *
 * One destination's failure never sinks the list — a probe that throws before it
 * can record a verdict (a decrypt failure, a vanished row) falls back to that
 * destination as it currently stands, so the picker still shows every option.
 * Probes run concurrently but bounded: each one opens its own mTLS connection to
 * a host, and a team with twenty buckets should not open twenty at once.
 */
export async function testAllS3(): Promise<S3DestinationDTO[]> {
  const teamId = (await requireCapability("manage_s3")).teamId;
  const current = await listS3();
  return mapBounded(current, PROBE_CONCURRENCY, async (d) => {
    try {
      return (await probeAndRecord(d.id, teamId)).destination;
    } catch {
      return d;
    }
  });
}

/** How many buckets we probe at once in {@link testAllS3}. */
const PROBE_CONCURRENCY = 4;

/** `Promise.all` with a ceiling on how many run at once; results keep input order. */
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

/**
 * Probe one destination and persist the verdict. The caller has already proven
 * the capability and the team; this is the part {@link testS3} and
 * {@link testAllS3} share.
 */
async function probeAndRecord(id: string, teamId: string): Promise<S3TestResult> {
  const creds = await getS3WithSecrets(id);
  // `S3Check` ignores the object key (it's a bucket probe), but the wire type
  // requires one — a sentinel that documents intent.
  const target = s3TargetFor(creds, "deplo/.s3check");

  // The agent probe (RPC) runs BEFORE the status write (PLAN §1 rule (a) — never
  // inside a transaction); the status is persisted from the live verdict.
  //
  // "No agent could serve the probe" USED to throw out of here, which made the
  // most confusing failure of all (nothing to do with the bucket) the one with no
  // recorded reason. It is now a verdict like any other: recorded, badged red,
  // and explained in the connection log.
  const startedAt = nowIso();
  const began = Date.now();
  let ok = false;
  let error = "";
  let serverId: string | null = null;
  let attempts: string[] = [];
  try {
    const verdict = await checkOnAnyBackupAgent(target);
    ok = verdict.ok;
    error = verdict.error;
    serverId = verdict.serverId;
    attempts = verdict.attempts;
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - began;

  const status = ok ? "connected" : "error";
  const updated = await getDb()
    .update(s3Table)
    .set({
      status,
      lastTestAt: startedAt,
      // Empty string would read as "tested and passed" — store NULL on success.
      lastTestError: ok ? null : error || "The bucket probe failed.",
      lastTestServerId: serverId,
      lastTestMs: durationMs,
    })
    .where(and(eq(s3Table.id, id), eq(s3Table.teamId, teamId)))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  const destination = toDTO(assembleS3(updated[0]!));

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

/** The destination fields the report prints — never a credential. */
function testTargetOf(d: S3DestinationDTO): S3TestTarget {
  return {
    name: d.name,
    provider: d.provider,
    endpoint: d.endpoint,
    region: d.region,
    bucket: d.bucket,
  };
}

/**
 * A server's display name for the log header, or a legible stand-in when the row
 * is gone (the FK is SET NULL on removal, so this only covers the window where a
 * report is read against a server deleted moments ago).
 */
async function serverLabelFor(serverId: string): Promise<string> {
  const server = (await listAllServers()).find((s) => s.id === serverId);
  return server ? serverLabel(server) : "a server that has since been removed";
}

/**
 * The stored report for a destination — what the connection log opens on, so
 * reading the last failure never silently re-dials the bucket. Rebuilt from the
 * four `last_test_*` columns plus the destination's own coordinates (the step
 * sequence and the reproduce commands are pure functions of those, which is why
 * none of it is stored). Never tested ⇒ an explicit "not tested yet" report.
 */
export async function s3TestReport(id: string): Promise<S3TestReport> {
  const teamId = await requireActiveTeamId();
  requireUnscoped("S3 destinations");
  const s = await loadS3(id, teamId);
  if (!s) throw new Error("Not found");
  const target = testTargetOf(toDTO(s));
  if (!s.lastTestAt) return emptyS3TestReport(target);
  return buildS3TestReport({
    target,
    ok: !s.lastTestError,
    error: s.lastTestError ?? "",
    startedAt: s.lastTestAt,
    durationMs: s.lastTestMs ?? 0,
    serverName: s.lastTestServerId
      ? await serverLabelFor(s.lastTestServerId)
      : "",
  });
}

/**
 * Run `S3Check` on the first reachable, backup-capable agent. Tries provisioned
 * servers in turn: an unreachable one (or one too old to back up) is skipped to
 * the next. Returns the agent's `{ ok, error }` verdict. Throws
 * {@link AgentBackupUnsupportedError} only when EVERY server lacks the capability
 * (so the UI says "update the agent"); throws {@link AgentUnreachableError} when
 * no server is reachable at all.
 */
async function checkOnAnyBackupAgent(target: S3Target): Promise<{
  ok: boolean;
  error: string;
  /** The server whose agent answered; null when none did. */
  serverId: string | null;
  /** `<server> — <why>` for each server tried and skipped, in order. */
  attempts: string[];
}> {
  const servers = (await listAllServers()).filter((s) => s.agent?.certFingerprint);
  if (servers.length === 0) {
    throw new AgentUnreachableError(
      "No provisioned server is available to verify the bucket.",
    );
  }
  let lastUnsupported: Error | null = null;
  let lastUnreachable: Error | null = null;
  // Every server we walked past, so the connection log can distinguish "your
  // bucket is wrong" from "no host here could even run the check".
  const attempts: string[] = [];
  for (const server of servers) {
    let conn;
    try {
      conn = await connectBackupAgent(server.id);
    } catch (e) {
      const mapped = mapBackupUnsupported(e);
      attempts.push(`${serverLabel(server)} — ${mapped.message}`);
      if (mapped instanceof AgentUnreachableError) lastUnreachable = mapped;
      else lastUnsupported = mapped;
      continue; // try the next server
    }
    try {
      const verdict = await conn.s3Check(target);
      return { ...verdict, serverId: server.id, attempts };
    } catch (e) {
      // The RPC itself failed: an old agent (UNIMPLEMENTED) → try the next; a
      // transport drop → try the next; otherwise it's a real probe failure.
      const mapped = mapBackupUnsupported(e);
      if (mapped instanceof AgentUnreachableError) lastUnreachable = mapped;
      else if (mapped.name === "AgentBackupUnsupportedError") lastUnsupported = mapped;
      else return { ok: false, error: mapped.message, serverId: server.id, attempts };
      attempts.push(`${serverLabel(server)} — ${mapped.message}`);
    } finally {
      conn.close();
    }
  }
  // Nothing answered: prefer the actionable "update the agent" when at least one
  // server was reachable-but-too-old; else report unreachable.
  throw lastUnsupported ?? lastUnreachable ?? new AgentUnreachableError(
    "No backup-capable agent could verify the bucket.",
  );
}

export async function deleteS3(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_s3");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const s = await loadS3(id, teamId);
  if (!s) throw new Error("Not found");
  // `s3_destination` ← `backups.destination_id` / `backup_runs.destination_id` are
  // both RESTRICT (a destination must never be silently cascade-deleted out from
  // under live schedules / restore points), so the dependent rows are removed
  // EXPLICITLY in one transaction (PLAN §1 "deleteS3 (s3_destination + backups
  // cascade)"). The JSONB version dropped dependent SCHEDULES but orphaned run
  // history with a dangling destinationId; the RESTRICT FK forbids that, so the
  // run records go too — this removes only control-plane records, not the S3
  // objects (the "delete artifacts too" flow handles those separately).
  await getDb().transaction(async (tx) => {
    await tx
      .delete(backupRunsTable)
      .where(
        and(eq(backupRunsTable.destinationId, id), eq(backupRunsTable.teamId, teamId)),
      );
    await tx
      .delete(backupsTable)
      .where(and(eq(backupsTable.destinationId, id), eq(backupsTable.teamId, teamId)));
    await tx
      .delete(s3Table)
      .where(and(eq(s3Table.id, id), eq(s3Table.teamId, teamId)));
  });
  await recordActivity("s3", `Removed S3 destination ${s.name}`, user.name, null);
}
