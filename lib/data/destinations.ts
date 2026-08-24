import "server-only";

import { and, count, desc, eq, isNull } from "drizzle-orm";

import { listAllServers, listServersForCurrentTeam } from "./servers";
import { getDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  backupDestination as destTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { assembleDestination, destinationToRow } from "./backup-rows";
import { assertSafeOutboundUrl } from "../outbound-url";
import { parseS3Args, validateS3Args } from "../backups/s3-args";
import {
  buildS3TestReport,
  emptyS3TestReport,
  type S3TestReport,
  type S3TestTarget,
} from "./s3-test-report";
import { getCurrentUser } from "../auth";
import { deploHostSelfAddresses, isDeploHostServer } from "../deploy/domains";
import { serverLabel } from "../utils";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
} from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, decryptSecretOrThrow } from "../crypto";
import {
  connectBackupAgent,
  mapBackupUnsupported,
  AgentUnreachableError,
} from "../infra/agent-client";
import type { S3Target, StoreTarget } from "../agent/gen/agent";
import type {
  BackupDestination,
  DestinationKind,
  DestinationStatus,
  S3Provider,
} from "../types";

/**
 * Backup destinations: WHERE an artifact goes.
 *
 * Two kinds behind one table and one id space, because `backups.destination_id`
 * and `backup_runs.destination_id` must keep pointing at one place:
 *
 *  - `s3`     — a bucket. The historical shape; credentials encrypted at rest,
 *               decrypted at the deploy edge and sent to the agent over mTLS.
 *  - `server` — a directory on a server in the fleet. Artifacts are ALWAYS
 *               age-encrypted, with one keypair per destination.
 *
 * The asymmetry in the age keypair is the security model, not a detail. The
 * RECIPIENT (public) is all an agent gets when WRITING, so a storage host
 * produces artifacts it cannot itself read. The IDENTITY (private) leaves the
 * control plane only for a restore or a download — and it is also handed to the
 * operator once as a recovery key, because an encrypted backup whose only key
 * lives inside the thing that might be lost is not a backup.
 */

export interface DestinationDTO extends Omit<
  BackupDestination,
  "accessKeyEnc" | "secretKeyEnc" | "ageIdentityEnc"
> {
  accessKeyMasked: string | null;
  /** Name of the server holding the artifacts (`server` kind), for the card. */
  serverName: string | null;
}

/**
 * What "Test connection" returns: the destination as it now stands (its badge
 * repainted from the live verdict) AND the verdict itself. The report is the
 * point — the mutation used to return only the destination, so a caller had no
 * way to tell a passing probe from a failing one and the UI cheerfully toasted
 * success either way.
 */
export interface DestinationTestResult {
  destination: DestinationDTO;
  report: S3TestReport;
}

/**
 * A destination as a PICKER needs it — what to call it, where it points, how it
 * last answered. Deliberately narrower than the DTO: a dialog that only chooses
 * a destination has no business shipping the region, the masked key or the test
 * history to the browser.
 */
export interface DestinationOption {
  id: string;
  name: string;
  kind: DestinationKind;
  /** The bucket endpoint, or `<server> · <path>` — what tells two apart. */
  where: string;
  status: DestinationStatus;
  /** Which server holds it, so a caller can spot a same-disk backup. */
  serverId: string | null;
  /** Whether artifacts written here are age-encrypted. */
  encrypted: boolean;
  /** When someone last took the recovery key, or null if nobody ever has. The
   *  picker ships it so the screens that USE a destination can say that its
   *  backups are locked by a key living only inside this instance - the Storage
   *  card was the only place that said so, and it is not the screen where
   *  someone schedules their first backup. */
  recoveryKeySavedAt: string | null;
}

/** Project a destination down to {@link DestinationOption}. */
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

/** The one-line "where does this point" string, used by every picker and card. */
export function destinationWhere(d: DestinationDTO): string {
  if (d.kind === "s3") return d.endpoint ?? "";
  const server = d.serverName ?? "a removed server";
  const path = d.resolvedPath ?? d.path;
  return path ? `${server} · ${path}` : server;
}

function toDTO(
  d: BackupDestination,
  serverName: string | null,
): DestinationDTO {
  const { accessKeyEnc, secretKeyEnc, ageIdentityEnc, ...rest } = d;
  void secretKeyEnc;
  void ageIdentityEnc;
  return {
    ...rest,
    accessKeyMasked: accessKeyEnc ? "••••••••" : null,
    serverName,
  };
}

export const S3_PROVIDERS: {
  id: S3Provider;
  name: string;
  endpointHint: string;
}[] = [
  {
    id: "aws",
    name: "Amazon S3",
    endpointHint: "https://s3.<region>.amazonaws.com",
  },
  {
    id: "cloudflare-r2",
    name: "Cloudflare R2",
    endpointHint: "https://<account>.r2.cloudflarestorage.com",
  },
  {
    id: "backblaze-b2",
    name: "Backblaze B2",
    endpointHint: "https://s3.<region>.backblazeb2.com",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean Spaces",
    endpointHint: "https://<region>.digitaloceanspaces.com",
  },
  {
    id: "wasabi",
    name: "Wasabi",
    endpointHint: "https://s3.<region>.wasabisys.com",
  },
  {
    id: "minio",
    name: "MinIO (self-hosted)",
    endpointHint: "https://minio.example.com",
  },
  { id: "other", name: "Other S3-compatible", endpointHint: "https://..." },
];

/**
 * The outbound-URL guard lives in `lib/outbound-url.ts` (a leaf, so the alert
 * channels can import it without closing a cycle back through this module's
 * activity logging). Re-exported here because this is where its callers and its
 * tests have always looked for it.
 */
export {
  assertSafeOutboundUrl,
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
} from "../outbound-url";

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
 * A destination with its secrets DECRYPTED, for the backup executor only
 * (server-only). NEVER returned to a client — {@link DestinationDTO} is the
 * client-facing masked shape.
 *
 * For `s3` the access/secret keys ride the mTLS channel to the owning agent,
 * which holds the S3 client; the bytes never round-trip through the control
 * plane. For `server`, `ageRecipient` goes out on every backup and `ageIdentity`
 * ONLY on a restore or a download.
 */
export interface DestinationWithSecrets {
  destination: BackupDestination;
  /** s3 only */
  accessKey: string;
  secretKey: string;
  /** server only: the private half. Never send this on a BackupRequest. */
  ageIdentity: string;
}

/**
 * Load a destination with its secrets decrypted for a SPECIFIC team — the
 * session-free core. Throws when the id is unknown / not in `teamId` so a backup
 * can't target a foreign destination. The scheduler runs with NO request
 * context, so it must call this with the schedule's own `teamId` rather than the
 * cookie-derived active team; the interactive {@link getDestinationWithSecrets}
 * wraps it.
 */
export async function getDestinationWithSecretsForTeam(
  teamId: string,
  id: string,
): Promise<DestinationWithSecrets> {
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Destination not found");
  // Strict, not best-effort. Every one of these is about to be ACTED on: the
  // keys go to an agent that dials the bucket with them, and `ageIdentity` is
  // what a restore reads the artifact with. Decrypting to "" would have turned
  // a key-mismatch into "these credentials are wrong" from the S3 provider and,
  // worse, into "this destination is not encrypted" - which is the one wrong
  // answer that ends with a restore refusing an artifact it could actually have
  // read, or a backup written in the clear.
  return {
    destination: d,
    accessKey: d.accessKeyEnc
      ? decryptSecretOrThrow(d.accessKeyEnc, "This destination's access key")
      : "",
    secretKey: d.secretKeyEnc
      ? decryptSecretOrThrow(d.secretKeyEnc, "This destination's secret key")
      : "",
    ageIdentity: d.ageIdentityEnc
      ? decryptSecretOrThrow(
          d.ageIdentityEnc,
          "This destination's recovery key",
        )
      : "",
  };
}

/** Load one team-scoped destination row, assembled, or null. */
async function loadDestination(
  id: string,
  teamId: string,
): Promise<BackupDestination | null> {
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)))
    .limit(1);
  return rows[0] ? assembleDestination(rows[0]) : null;
}

/**
 * Load the ACTIVE team's destination with its secrets decrypted, for the
 * interactive executor (manual "Run now" / restore). Scoped to the active team
 * via the session (mirrors every other team-scoped read). The unattended
 * scheduler uses {@link getDestinationWithSecretsForTeam} instead (no session).
 */
export async function getDestinationWithSecrets(
  id: string,
): Promise<DestinationWithSecrets> {
  const teamId = await requireActiveTeamId();
  // A destination belongs to the team, not to a Project, so a project-scoped API
  // token has no business READING one — while the session-free core above stays
  // open, because a scoped token backing up an app it CAN reach still needs the
  // destination's credentials to do it.
  await requireTeamWide("backup destinations");
  return getDestinationWithSecretsForTeam(teamId, id);
}

/**
 * Build the wire {@link S3Target} for an agent call from a decrypted S3
 * destination + the exact object key (or prefix). The ONE place the
 * destination → S3Target mapping (incl. the provider's path-style decision)
 * lives, so the executor, the connectivity check, and the retention pruner can't
 * drift on it.
 */
export function s3TargetFor(
  s: DestinationWithSecrets,
  objectKey: string,
): S3Target {
  const d = s.destination;
  return {
    endpoint: d.endpoint ?? "",
    region: d.region ?? "",
    bucket: d.bucket ?? "",
    accessKey: s.accessKey,
    secretKey: s.secretKey,
    objectKey,
    pathStyle: pathStyleFor(d.provider ?? "other"),
    // Off for everything created from the ordinary form; on only where an
    // instance admin said the bucket lives on their own network.
    allowPrivateEndpoint: d.allowPrivateEndpoint,
    // The agent applies the flags its version knows and logs the rest — see the
    // soft gate in `connectBackupAgent`, which warns rather than refusing.
    extraArgs: parseS3Args(d.s3ExtraArgs),
  };
}

/** The wire {@link StoreTarget} for a `server` destination + an object key. */
export function storeTargetFor(
  d: BackupDestination,
  objectKey: string,
): StoreTarget {
  // Empty root means "the agent's own managed store" — the default, and the only
  // shape a non-admin can produce. A custom path travels verbatim and the agent
  // re-validates it against its sentinel rule.
  return { root: d.path ?? "", objectKey };
}

/**
 * WHICH SERVER's agent handles this destination.
 *
 * For `server` it is the destination's own host — the artifacts are on that
 * disk and no other agent can touch them. For `s3` it is the workload's host,
 * because the dump has to come from where the workload runs.
 *
 * Getting this wrong is silent: retention and delete-with-artifacts would dial
 * the app's server for an artifact living on a different one, get "no such
 * file", and either leak the artifact or block the delete. Every
 * `connectBackupAgent` in the backup path routes through here.
 */
export function destinationServerId(
  d: Pick<BackupDestination, "kind" | "serverId">,
  targetServerId: string,
): string {
  return d.kind === "server" && d.serverId ? d.serverId : targetServerId;
}

/**
 * The destinations as a PICKER needs them, for ANY member of the team.
 *
 * Deliberately not `listDestinations`. That one is team-wide-only, which is
 * right for the Storage page's cards (region, masked key, test history, free
 * space) but wrong as the only way to learn a destination EXISTS: a member
 * scoped to one folder, holding `manage_backups` on an app in it, got an empty
 * list — so their app's Backups tab showed "Unknown destination" on every
 * artifact, hid the download button, claimed no destination was configured, and
 * disabled the two buttons that would have made one. They had the permission to
 * take a backup and no way to take one.
 *
 * What comes back is {@link DestinationOption}: a name, where it points, and how
 * it last answered. Nothing here is a credential, and every id in it is one the
 * member can already use — `createBackup` and `runAppBackup` accept any
 * destination in the team, and always did.
 */
export async function listDestinationOptions(): Promise<DestinationOption[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .orderBy(desc(destTable.createdAt));
  return (await withServerNames(rows.map(assembleDestination))).map(
    toDestinationOption,
  );
}

export async function listDestinations(): Promise<DestinationDTO[]> {
  await requireTeamWide("backup destinations");
  const teamId = await requireActiveTeamId();
  // Newest-first sort pushed into SQL (matches backup_destination_team_created_idx).
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .orderBy(desc(destTable.createdAt));
  return withServerNames(rows.map(assembleDestination));
}

/** Attach each `server` destination's host name in one lookup, not N. */
async function withServerNames(
  destinations: BackupDestination[],
): Promise<DestinationDTO[]> {
  if (!destinations.some((d) => d.serverId)) {
    return destinations.map((d) => toDTO(d, null));
  }
  const servers = await listAllServers();
  const byId = new Map(servers.map((s) => [s.id, serverLabel(s)]));
  return destinations.map((d) =>
    toDTO(d, d.serverId ? (byId.get(d.serverId) ?? null) : null),
  );
}

export interface CreateDestinationInput {
  name: string;
  kind: DestinationKind;
  /* s3 */
  provider?: S3Provider | null;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  /** Instance-admin only: dial an endpoint on a private address. */
  allowPrivateEndpoint?: boolean | null;
  /** Advanced quirk flags for this store, validated against the allowlist in
   *  `lib/backups/s3-args.ts`. */
  s3ExtraArgs?: string | null;
  /* server */
  serverId?: string | null;
  path?: string | null;
}

export async function createDestination(
  input: CreateDestinationInput,
): Promise<DestinationDTO> {
  const { membership } = await requireCapability("manage_backup_destinations");
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");

  const base = {
    id: newId("dst"),
    teamId: membership.teamId,
    name: input.name.trim(),
    status: "unverified" as DestinationStatus,
    createdAt: nowIso(),
    // Never tested yet — the badge says "unverified" and the connection log
    // offers the test rather than a stale verdict.
    lastTestAt: null,
    lastTestError: null,
    lastTestServerId: null,
    lastTestMs: null,
    lastFreeBytes: null,
    lastTotalBytes: null,
    resolvedPath: null,
    recoveryKeySavedAt: null,
  };

  let d: BackupDestination;
  if (input.kind === "server") {
    d = { ...base, ...(await serverDestinationFields(input)) };
  } else {
    d = { ...base, ...(await s3DestinationFields(input)) };
  }

  await getDb().insert(destTable).values(destinationToRow(d));
  await recordActivity(
    "s3",
    `Added backup destination ${d.name}`,
    user.name,
    null,
    d.teamId,
  );
  return (await withServerNames([d]))[0]!;
}

/** The `s3` half of {@link createDestination}: validate, encrypt, shape. */
async function s3DestinationFields(input: CreateDestinationInput) {
  const bucket = (input.bucket ?? "").trim();
  if (!bucket) throw new Error("Bucket is required");
  assertUsableBucketName(bucket);
  if (!input.accessKey || !input.secretKey)
    throw new Error("Access key and secret are required");
  const region = (input.region ?? "").trim() || "auto";
  assertUsableRegion(region);
  // A private endpoint is an instance-level decision, exactly like a custom
  // store path: the agent dials this address as root, so 169.254.169.254 must
  // never be reachable from a form anyone can fill in. Turning it ON is what
  // makes a self-hosted bucket on the operator's own LAN usable at all, which is
  // an ordinary thing to want on a self-hosting platform.
  const allowPrivateEndpoint = Boolean(input.allowPrivateEndpoint);
  if (allowPrivateEndpoint) await requireInstanceAdmin();
  // The endpoint is dialed from the agents (bucket probe, backups) — never let
  // it aim inside the network unless that was the explicit, admin-only choice.
  // http stays allowed for a self-hosted MinIO fronted without TLS.
  if (!allowPrivateEndpoint)
    await assertSafeOutboundUrl((input.endpoint ?? "").trim(), "Endpoint", {
      allowHttp: true,
    });
  else assertHttpUrl((input.endpoint ?? "").trim(), "Endpoint");

  // A BUCKET artifact is encrypted too, with its own keypair, for the same
  // reason a server one is: a project archive carries the app's entire decrypted
  // env, because the restore has to write the real `.env` back. Leaving the
  // oldest destination shape as the one that wrote every secret to somebody
  // else's storage in the clear undid deplo's own write-only-secrets model.
  // Existing destinations keep `null` here and keep writing plaintext — their
  // objects already are, and rewriting history is not on offer.
  // Refused here, not dropped: a flag the agent has no mapping for would look
  // applied and change nothing, which on a store that is already misbehaving is
  // the worst possible answer. The dialog checks the same function while typing.
  const rawArgs = (input.s3ExtraArgs ?? "").trim();
  const argsError = validateS3Args(rawArgs);
  if (argsError) throw new Error(argsError);
  const s3ExtraArgs = rawArgs || null;

  const { identity, recipient } = await generateAgeKeypair();
  return {
    kind: "s3" as const,
    provider: input.provider ?? "other",
    endpoint: (input.endpoint ?? "").trim(),
    region,
    bucket,
    accessKeyEnc: encryptSecret(input.accessKey),
    secretKeyEnc: encryptSecret(input.secretKey),
    allowPrivateEndpoint,
    s3ExtraArgs,
    serverId: null,
    path: null,
    ageRecipient: recipient,
    ageIdentityEnc: encryptSecret(identity),
  };
}

/**
 * A bucket name deplo is willing to store, print and hand to an operator.
 *
 * S3's own rules are stricter than this; the point here is narrower and it is
 * about the CONNECTION LOG, which prints the bucket into a copy-pasteable
 * `aws s3api …` block. That block is an expert escape hatch an admin reaches for
 * precisely when a destination is failing, and a name carrying a quote or a
 * semicolon would turn "why is this red" into a shell command somebody else
 * wrote. The report quotes what it prints as well - both, because either alone
 * is one edit away from being the only one.
 */
function assertUsableBucketName(bucket: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/.test(bucket))
    throw new Error(
      "Bucket names can use letters, digits, dots, dashes and underscores, " +
        "and must start with a letter or digit",
    );
}

/** Same, for the region — it rides the same command line. */
function assertUsableRegion(region: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(region))
    throw new Error(
      "Region can use letters, digits, dots, dashes and underscores",
    );
}

/**
 * The shape check that survives when the SSRF guard is deliberately off: it must
 * still be an http(s) URL with a host, or the agent gets a string it cannot dial
 * and the operator gets a failure that names nothing.
 */
function assertHttpUrl(raw: string, label: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${label} must be an http(s) URL`);
  if (!url.hostname) throw new Error(`${label} must include a host`);
}

/**
 * The `server` half of {@link createDestination}: pick the host, mint the
 * keypair, and gate the custom path.
 *
 * Two rules that are easy to get wrong:
 *
 *  - The server must be one the ACTIVE TEAM can already reach. Anything else
 *    would let a member discover, and consume the disk of, a host outside their
 *    scope — and servers are the one resource deplo does not team-scope.
 *  - A custom path is instance-admin only. The default path is the agent's own
 *    managed store and carries no privilege; an arbitrary absolute path on a
 *    shared host is an instance-level decision, and the agent additionally
 *    refuses any root it has not itself marked.
 */
async function serverDestinationFields(input: CreateDestinationInput) {
  const serverId = input.serverId?.trim();
  if (!serverId) throw new Error("Pick a server to store the backups on");
  const reachable = await listServersForCurrentTeam();
  const server = reachable.find((s) => s.id === serverId);
  if (!server) throw new Error("Not found");
  if (!server.agent?.certFingerprint)
    throw new Error(`${serverLabel(server)} has no agent connected yet`);
  // Storage-only hosts are welcome here - holding backups is what they are for -
  // but a migration source is not ours to fill: it is the other platform's machine,
  // and the agent on it is removed the day the migration ends, which would take the
  // destination's artifacts with it.
  if (server.importOnly)
    throw new Error(
      `${serverLabel(server)} is a migration source - Deplo is only borrowing it ` +
        `to import from. Pick a server in your fleet.`,
    );

  const path = input.path?.trim() || null;
  if (path) {
    await requireInstanceAdmin();
    if (!path.startsWith("/"))
      throw new Error(
        "The backup folder must be an absolute path, like /mnt/backups",
      );
  }

  const { identity, recipient } = await generateAgeKeypair();
  return {
    kind: "server" as const,
    provider: null,
    endpoint: null,
    region: null,
    bucket: null,
    accessKeyEnc: null,
    secretKeyEnc: null,
    allowPrivateEndpoint: false,
    s3ExtraArgs: null,
    serverId,
    path,
    ageRecipient: recipient,
    ageIdentityEnc: encryptSecret(identity),
  };
}

/**
 * Mint the age X25519 keypair a server destination encrypts to.
 *
 * X25519 specifically, not `generateIdentity()`: the agent parses with
 * `age.ParseX25519Recipient`, and a post-quantum/hybrid identity — which newer
 * versions of the JS library will happily hand back — would be rejected there
 * with a message about the key format that tells nobody anything.
 *
 * Imported lazily so the crypto library is not pulled into every module that
 * merely reads a destination.
 */
async function generateAgeKeypair(): Promise<{
  identity: string;
  recipient: string;
}> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * Every team starts with a destination that works.
 *
 * Backups are the one feature where "you must first go sign up for a bucket"
 * turns a five-second decision into a project, and the fleet already has a disk.
 * So a team with NO destinations gets one pointing at a server it can reach,
 * with a fresh keypair — the same shape it would have created by hand.
 *
 * Lazy, like `ensureTeamRoles`: no boot hook, no backfill, nothing to run on
 * upgrade. It is also deliberately silent about failure — a team that cannot
 * reach a backup-capable server yet simply has no destinations, and the empty
 * state explains the two ways to make one.
 *
 * ONCE PER TEAM, and that is the whole point of `teams.backupDefaultSeededAt`.
 * Seeding on "this team has no destinations" made the default UNDELETABLE: the
 * three pages that show a destination picker all call this on render, so
 * removing the card deleted the row and the next render put it straight back.
 * The claiming UPDATE is also the lock — two concurrent renders can otherwise
 * both see zero destinations and both insert, leaving the team with two
 * identical defaults. The claim is RELEASED when nothing was created (no
 * backup-capable server yet, or the insert failed), so the seed still happens
 * once the fleet can serve it.
 *
 * NO capability check, on purpose, and that is not an oversight: this grants
 * nobody anything. It creates a row the team could already have created, on a
 * server the team can already reach (`listServersForCurrentTeam` is the gate),
 * and it only ever fires when the team has none. Requiring
 * `manage_backup_destinations` here would mean the seed depends on WHO happened
 * to open the page first, which is exactly the arbitrary behaviour a default is
 * meant to remove.
 */
export async function ensureDefaultDestination(): Promise<void> {
  const teamId = await requireActiveTeamId();
  const claimed = await getDb()
    .update(teamsTable)
    .set({ backupDefaultSeededAt: nowIso() })
    .where(
      and(eq(teamsTable.id, teamId), isNull(teamsTable.backupDefaultSeededAt)),
    )
    .returning({ id: teamsTable.id });
  if (claimed.length === 0) return;
  const release = () =>
    getDb()
      .update(teamsTable)
      .set({ backupDefaultSeededAt: null })
      .where(eq(teamsTable.id, teamId));

  // An instance that already had destinations before this ran keeps the claim:
  // it has what the seed exists to provide, and must not get another one the day
  // it removes the last of them.
  const existing = await getDb()
    .select({ id: destTable.id })
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .limit(1);
  if (existing.length > 0) return;

  // The Deplo host first, then any other provisioned server: "This server" has to
  // BE this server, and a default silently living on some other box in the fleet
  // is a surprise the day that box goes away. When it lands elsewhere the
  // destination is named after the server instead, because the name is the only
  // thing a picker shows.
  // Inside the try with everything else: this claim is a one-shot marker, so a
  // transient failure BEFORE the insert (a blip reading the fleet) used to keep
  // the claim forever and the team never got its default at all.
  try {
    // A migration source can be the first - or the only - provisioned server a
    // fresh team can see, and seeding its default destination there would both put
    // the backups on someone else's machine and make the server un-uninstallable
    // (destination.server_id is ON DELETE RESTRICT).
    const provisioned = (await listServersForCurrentTeam()).filter(
      (s) => s.agent?.certFingerprint && !s.importOnly,
    );
    const self = deploHostSelfAddresses();
    const server =
      provisioned.find((s) => isDeploHostServer(s, self)) ?? provisioned[0];
    if (!server) {
      await release();
      return;
    }
    const name = isDeploHostServer(server, self)
      ? "This server"
      : serverLabel(server);

    const { identity, recipient } = await generateAgeKeypair();
    const d: BackupDestination = {
      id: newId("dst"),
      teamId,
      name,
      kind: "server",
      provider: null,
      s3ExtraArgs: null,
      endpoint: null,
      region: null,
      bucket: null,
      accessKeyEnc: null,
      secretKeyEnc: null,
      allowPrivateEndpoint: false,
      serverId: server.id,
      path: null,
      ageRecipient: recipient,
      ageIdentityEnc: encryptSecret(identity),
      recoveryKeySavedAt: null,
      status: "unverified",
      createdAt: nowIso(),
      lastTestAt: null,
      lastTestError: null,
      lastTestServerId: null,
      lastTestMs: null,
      lastFreeBytes: null,
      lastTotalBytes: null,
      resolvedPath: null,
    };
    await getDb().insert(destTable).values(destinationToRow(d));
  } catch {
    // Nothing was created (a failed keygen, an insert that lost to the CHECK):
    // hand the claim back so a later render can try again. This is a
    // convenience, never a precondition — the empty state explains both ways to
    // make a destination by hand.
    await release();
  }
}

/**
 * Verify a destination for real.
 *
 * S3 → dial a reachable agent advertising `"backup"` and have IT probe the
 * bucket (HEAD + a write probe) with the decrypted creds over mTLS; the agent
 * owns the S3 client. Any provisioned backup-capable agent can serve it (it
 * needs no Docker, just network + creds), so we try servers until one answers.
 *
 * SERVER → dial THAT destination's own host: the question is about that disk,
 * so no other agent can answer it. The probe creates the managed root (or marks
 * an empty custom one), round-trips a probe file so a read-only mount reports as
 * not-writable, sweeps stale `.partial` artifacts, and returns the headroom.
 *
 * The status is persisted from the live result (`connected` on success, `error`
 * otherwise) so the badge reflects reality, never a fake success.
 */
export async function testDestination(
  id: string,
): Promise<DestinationTestResult> {
  const teamId = (await requireCapability("manage_backup_destinations")).teamId;
  const cur = await loadDestination(id, teamId);
  if (!cur) throw new Error("Not found");
  return probeAndRecord(id, teamId);
}

/**
 * Re-probe EVERY destination in the active team and return them repainted, in
 * {@link listDestinations} order. This is what the destination picker calls when
 * it opens: a stored badge can be hours old, and picking a destination is
 * exactly the moment "is this actually reachable?" has to be true rather than
 * remembered.
 *
 * One destination's failure never sinks the list — a probe that throws before it
 * can record a verdict (a decrypt failure, a vanished row) falls back to that
 * destination as it currently stands, so the picker still shows every option.
 * Probes run concurrently but bounded: each one opens its own mTLS connection to
 * a host, and a team with twenty destinations should not open twenty at once.
 */
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

/** How many destinations we probe at once in {@link testDestinations}. */
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
 * the capability and the team; this is the part {@link testDestination} and
 * {@link testDestinations} share.
 */
async function probeAndRecord(
  id: string,
  teamId: string,
): Promise<DestinationTestResult> {
  const creds = await getDestinationWithSecrets(id);
  const d = creds.destination;

  // The agent probe (RPC) runs BEFORE the status write (PLAN §1 rule (a) — never
  // inside a transaction); the status is persisted from the live verdict.
  //
  // "No agent could serve the probe" USED to throw out of here, which made the
  // most confusing failure of all (nothing to do with the destination) the one
  // with no recorded reason. It is now a verdict like any other: recorded,
  // badged red, and explained in the connection log.
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
      // requires one — a sentinel that documents intent.
      const verdict = await checkOnAnyBackupAgent(
        s3TargetFor(creds, "deplo/.s3check"),
        // An ENCRYPTED bucket needs an agent that honours the recipient. Without
        // this the probe passed on an agent that would ignore it, so the card
        // said `connected` while every backup to it was refused - a green badge
        // over a destination that cannot work is worse than no badge at all.
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
      // Empty string would read as "tested and passed" — store NULL on success.
      lastTestError: ok ? null : error || "The destination probe failed.",
      lastTestServerId: serverId,
      lastTestMs: durationMs,
      lastFreeBytes: freeBytes,
      lastTotalBytes: totalBytes,
      resolvedPath,
    })
    .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  const destination = (
    await withServerNames([assembleDestination(updated[0]!)])
  )[0]!;

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
function testTargetOf(d: DestinationDTO): S3TestTarget {
  return {
    name: d.name,
    kind: d.kind,
    provider: d.provider ?? "other",
    endpoint: destinationWhere(d),
    region: d.region ?? "",
    bucket: d.bucket ?? "",
    // The folder the agent actually resolved beats the one that was configured;
    // both are empty for a managed root nobody has tested yet, and the report
    // says so rather than guessing at a path.
    path: d.resolvedPath ?? d.path ?? "",
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
 * reading the last failure never silently re-dials. Rebuilt from the
 * `last_test_*` columns plus the destination's own coordinates (the step
 * sequence and the reproduce commands are pure functions of those, which is why
 * none of it is stored). Never tested ⇒ an explicit "not tested yet" report.
 */
export async function destinationTestReport(id: string): Promise<S3TestReport> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("backup destinations");
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");
  const dto = (await withServerNames([d]))[0]!;
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

/**
 * Probe a `server` destination on ITS OWN host. Unlike an S3 bucket, which any
 * backup-capable agent can reach, this question is about one machine's disk.
 */
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
  // `store: true` is what makes an old agent say so. Without it the check went
  // out anyway and the agent — which knows nothing about a StoreTarget and reads
  // the request as an S3 probe with no bucket — answered "s3 check request
  // missing target", which is both wrong and unactionable for a folder on a disk.
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
    // An agent old enough to back up to S3 but not to hold artifacts must say
    // exactly that, rather than "the check failed".
    throw mapBackupUnsupported(e);
  } finally {
    conn.close();
  }
}

/**
 * Run `S3Check` on the first reachable, backup-capable agent. Tries provisioned
 * servers in turn: an unreachable one (or one too old to back up) is skipped to
 * the next. Returns the agent's `{ ok, error }` verdict. Throws
 * {@link AgentBackupUnsupportedError} only when EVERY server lacks the capability
 * (so the UI says "update the agent"); throws {@link AgentUnreachableError} when
 * no server is reachable at all.
 */
async function checkOnAnyBackupAgent(
  target: S3Target,
  encrypted = false,
): Promise<{
  ok: boolean;
  error: string;
  /** The server whose agent answered; null when none did. */
  serverId: string | null;
  /** `<server> — <why>` for each server tried and skipped, in order. */
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
  // Every server we walked past, so the connection log can distinguish "your
  // bucket is wrong" from "no host here could even run the check".
  const attempts: string[] = [];
  for (const server of servers) {
    let conn;
    try {
      conn = await connectBackupAgent(server.id, { encryptedS3: encrypted });
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
      else if (mapped.name === "AgentBackupUnsupportedError")
        lastUnsupported = mapped;
      else
        return {
          ok: false,
          error: mapped.message,
          serverId: server.id,
          attempts,
        };
      attempts.push(`${serverLabel(server)} — ${mapped.message}`);
    } finally {
      conn.close();
    }
  }
  // Nothing answered: prefer the actionable "update the agent" when at least one
  // server was reachable-but-too-old; else report unreachable.
  throw (
    lastUnsupported ??
    lastUnreachable ??
    new AgentUnreachableError(
      "No backup-capable agent could verify the bucket.",
    )
  );
}

/**
 * The recovery key for a `server` destination: the age identity, in the clear,
 * once — the ONE sanctioned exception to "never add a show-secret affordance"
 * (the other being the basic-auth password).
 *
 * It exists because encryption without it is a trap. If DEPLO_SECRET is rotated,
 * or the control plane is lost in the very disaster the backups are for, the
 * artifacts on disk become unreadable forever. With this key, `age -d -i key.txt`
 * reads them on any machine, with no Deplo involved.
 *
 * Downloading it stamps `recoveryKeySavedAt`, which is what silences the nudge on
 * the card. It stays downloadable afterwards on purpose: a key you can only ever
 * see once, for a destination you may not have consciously created, is a key
 * nobody has.
 */
export async function revealRecoveryKey(id: string): Promise<{
  name: string;
  recipient: string;
  identity: string;
  where: string;
}> {
  const { teamId } = await requireCapability("manage_backup_destinations");
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");
  // On the KEYPAIR, not on the kind. Gating this on `kind === "server"` while
  // bucket artifacts had just started being encrypted produced exactly the trap
  // encryption exists to avoid: artifacts nobody can read, locked by a key that
  // lives only inside the instance they are meant to survive.
  if (!d.ageIdentityEnc || !d.ageRecipient)
    throw new Error(
      "This destination's backups are not encrypted, so it has no recovery key",
    );
  const user = (await getCurrentUser())!;
  // Decrypt FIRST. The stamp is what silences the "save your recovery key"
  // nudge, and setting it before we know there is a key to hand over meant a
  // failed decrypt left the destination looking safe while nobody held anything.
  const identity = decryptSecret(d.ageIdentityEnc);
  if (!identity)
    throw new Error(
      "This destination's recovery key could not be read. It was encrypted with " +
        "a different DEPLO_SECRET, so the backups at this destination cannot be " +
        "decrypted by this instance either.",
    );
  await getDb()
    .update(destTable)
    .set({ recoveryKeySavedAt: nowIso() })
    .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)));
  // Loud in the Activity trail: this hands over the ability to read every
  // artifact at that destination, so "who took it and when" must be answerable
  // in the UI rather than in the database.
  await recordActivity(
    "s3",
    `Downloaded the recovery key for backup destination ${d.name}`,
    user.name,
    null,
    teamId,
  );
  return {
    name: d.name,
    recipient: d.ageRecipient ?? "",
    identity,
    where: await artifactLocation(d),
  };
}

/**
 * Where the artifacts this key opens actually LIVE, in one line, for the key
 * file itself.
 *
 * The file is read in exactly one situation: this instance is gone. Whoever
 * opens it then has a key and, until now, no address - the endpoint, the bucket,
 * the host and the folder all lived in the database that was lost, and the card
 * that could have told them is not running any more. Deliberately more than the
 * card's `destinationWhere`: that one distinguishes two destinations for someone
 * looking at both, this one has to be enough to find the bytes years later.
 */
async function artifactLocation(d: BackupDestination): Promise<string> {
  if (d.kind === "s3")
    return `bucket "${d.bucket ?? ""}" at ${d.endpoint ?? ""}`;
  const [dto] = await withServerNames([d]);
  const host = dto?.serverName ?? "a server that is no longer in the fleet";
  // `resolvedPath` is what the agent actually used, and it is the only one that
  // names the managed folder - `path` is null for every destination that did not
  // ask for a custom one, which is most of them.
  const folder = d.resolvedPath ?? d.path;
  return folder
    ? `${host}, in ${folder}`
    : `${host}, in the agent's managed backups folder`;
}

/**
 * What removing a destination is about to destroy, so the dialog can say it
 * instead of guessing. Counted, not estimated: "N schedules and M restore
 * points" is the sentence someone needs before they confirm.
 */
export async function destinationRemovalImpact(id: string): Promise<{
  schedules: number;
  runs: number;
  artifacts: number;
}> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("backup destinations");
  const [sched] = await getDb()
    .select({ n: count() })
    .from(backupsTable)
    .where(
      and(eq(backupsTable.destinationId, id), eq(backupsTable.teamId, teamId)),
    );
  const [runs] = await getDb()
    .select({ n: count() })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.destinationId, id),
        eq(backupRunsTable.teamId, teamId),
      ),
    );
  const [stored] = await getDb()
    .select({ n: count() })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.destinationId, id),
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
      ),
    );
  return {
    schedules: Number(sched?.n ?? 0),
    runs: Number(runs?.n ?? 0),
    artifacts: Number(stored?.n ?? 0),
  };
}

/**
 * Remove a destination, and optionally the artifacts it holds.
 *
 * `deleteArtifacts` exists because "we keep your files" was, for a `server`
 * destination, a promise deplo could not follow through on: nothing lists what
 * is in a store, so the files stayed on that disk with no screen naming them and
 * no way to reclaim them short of an SSH session — the one thing the platform
 * exists to make unnecessary. Off by default, because keeping them is still the
 * safe answer and an S3 bucket is the operator's own to sweep.
 */
export async function deleteDestination(
  id: string,
  opts: { deleteArtifacts?: boolean } = {},
): Promise<void> {
  const { membership } = await requireCapability("manage_backup_destinations");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");

  // BEFORE the rows go: the keys live on the runs, and the creds on the row we
  // are about to delete. A failure here aborts the whole removal rather than
  // leaving files nothing can name any more.
  if (opts.deleteArtifacts) {
    const runs = await getDb()
      .select({ objectKey: backupRunsTable.objectKey })
      .from(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.destinationId, id),
          eq(backupRunsTable.teamId, teamId),
          eq(backupRunsTable.status, "success"),
        ),
      );
    const keys = runs
      .filter((r) => r.objectKey)
      .map((r) => ({ key: r.objectKey }));
    if (keys.length > 0) {
      // Imported HERE rather than at the top: backup-transport imports this
      // module for `destinationServerId` / `s3TargetFor`, so a static import back
      // would close a cycle — the same one `assertSafeOutboundUrl` was moved into
      // its own leaf to avoid.
      const { deleteManyFromDestination } = await import("./backup-transport");
      const creds = await getDestinationWithSecretsForTeam(teamId, id);
      const results = await deleteManyFromDestination(
        creds,
        creds.destination.serverId ?? "",
        keys,
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0)
        throw new Error(
          failed[0]!.error ||
            `Could not delete ${failed.length} backup file${failed.length === 1 ? "" : "s"}. ` +
              `The destination was not removed.`,
        );
    }
  }
  // `backup_destination` ← `backups.destination_id` / `backup_runs.destination_id`
  // are both RESTRICT (a destination must never be silently cascade-deleted out
  // from under live schedules / restore points), so the dependent rows are removed
  // EXPLICITLY in one transaction. The run records go too rather than being left
  // with a dangling destinationId — the artifacts they name were either swept
  // above or deliberately kept.
  await getDb().transaction(async (tx) => {
    await tx
      .delete(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.destinationId, id),
          eq(backupRunsTable.teamId, teamId),
        ),
      );
    await tx
      .delete(backupsTable)
      .where(
        and(
          eq(backupsTable.destinationId, id),
          eq(backupsTable.teamId, teamId),
        ),
      );
    await tx
      .delete(destTable)
      .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)));
  });
  await recordActivity(
    "s3",
    opts.deleteArtifacts
      ? `Removed backup destination ${d.name} and the backups kept there`
      : `Removed backup destination ${d.name}`,
    user.name,
    null,
    teamId,
  );
}
