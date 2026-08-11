import "server-only";

import {
  credentials,
  Metadata,
  status as GrpcStatus,
  type ClientReadableStream,
  type ClientWritableStream,
  type ClientDuplexStream,
  type ServiceError,
} from "@grpc/grpc-js";
import type { PeerCertificate } from "node:tls";
import {
  AgentClient as GrpcAgentClient,
  ContractVersion,
  type HelloResponse,
  type HostMetrics,
  type ContainerStat,
  type MetricsStreamRequest,
  type MetricsSample,
  type DeployRequest,
  type DeployEvent,
  type ReattachRequest,
  type BackupRequest,
  type BackupEvent,
  type RestoreRequest,
  type RestoreEvent,
  type S3Target,
  type LogChunk,
  type AttachInput,
  type AttachOutput,
  type ConsoleInstance as PbConsoleInstance,
  type FileEntry as PbFileEntry,
  type VolumeChunk,
  type FilesChunk,
  type StoreTarget,
  type StoreChunk,
  type StoreResult,
  type RestoreChunk,
  type RestoreChunk_Header,
  type StackResult,
  type DockerCleanupRequest,
  type DockerCleanupResponse,
  type HostInfoRequest,
  type HostInfoResponse,
  type SetTimezoneRequest,
  type TraefikConfigRequest,
  type TraefikConfigResponse,
  type RestartControlPlaneRequest,
  type RestartControlPlaneResponse,
} from "../agent/gen/agent";
export type {
  HostInfoResponse,
  TraefikConfigResponse,
  RestartControlPlaneResponse,
} from "../agent/gen/agent";
import type { AttachHandle } from "./docker";
import { streamEvents, pumpClientStream } from "./stream-events";
import { getServerById, markServerSeen, observedTraefik } from "../data/servers";
import type { Server } from "../types";

/**
 * The agent client — the control plane's side of the second system boundary
 * (ADR-0006). Given a `serverId`, it dials that server's agent over mTLS and
 * exposes a small promise/async-iterator API (`hello`, `metrics`, `deploy`,
 * `reattach`). This is the ONE choke point that replaces direct
 * `lib/infra/docker.ts` calls in the deploy path: `runDeployment` calls
 * `agentDeploy(...)` instead of spawning docker locally.
 *
 * EVERY server — the host running Deplo included — resolves to its declared
 * address + port and PINS the agent's certificate fingerprint (stored in the
 * Server row at bootstrap, P3/P6). There is one uniform trust model: the dial is
 * mTLS against a CA-signed, pinned agent cert, with no in-process / un-pinned
 * special case.
 */

const HELLO_TIMEOUT_MS = 8_000;
/**
 * The Hello deadline the HEALTH PROBER uses (lib/data/server-health.ts) — much
 * shorter than {@link HELLO_TIMEOUT_MS}, which is a deploy pre-flight budget spent
 * on a deploy the operator has already committed to. A health probe runs while
 * someone waits on the Servers page, and a slow answer is itself the answer.
 */
export const HEALTH_HELLO_TIMEOUT_MS = 3_000;
const DEPLOY_DEADLINE_MS = 30 * 60_000; // a build can be long
const CONSOLE_TIMEOUT_MS = 30_000; // exec runs in-container; match docker.ts exec
/**
 * Cron RPC deadlines. Both are SHORT on purpose, and neither bounds the job.
 *
 * That is the whole point of the Start/Poll/Kill shape (ADR-0018): the command
 * runs inside the agent on its own context, so a 24-hour job is 24 hours of
 * `PollJob` calls that each take milliseconds - never one 24-hour connection.
 * `StartJob` gets the more generous budget because it is the one that has to
 * cross a possibly-slow link with the command and its environment attached.
 */
const CRON_START_TIMEOUT_MS = 15_000;
const CRON_POLL_TIMEOUT_MS = 10_000;
// The Metrics / ContainerStats POLL deadline — deliberately a fraction of the
// console class. A normal measurement is ~1.2s (a 1s net-delta window + a 200ms
// CPU sample + a docker list + statfs), so anything past ~8s means the host is
// momentarily UNMEASURABLE: its Docker/disk pinned by its own deploy (a buildkit
// export + container recreate) or otherwise saturated. The dashboards poll on a
// busy-guard — one in-flight call blocks the next tick — so a LONG deadline here
// is the amplifier that turns a ~15s host pin into a 30-60s chart hole: the poll
// hangs the full deadline before it can retry and catch the moment the host frees
// up. Fail fast instead and let the next 1s tick (or the 5s background collector)
// recover; a genuinely missed window renders as a small, honest "No data" band,
// not a minute-long void. Still ~6x the ~1.2s baseline, so a merely slow-but-
// healthy host is not falsely marked unreachable.
const METRICS_TIMEOUT_MS = 8_000;
const FILES_TIMEOUT_MS = 15_000;
const STREAM_DEADLINE_MS = 30 * 60_000; // logs/attach are long-lived
/**
 * The StreamMetrics deadline — its own constant because {@link STREAM_DEADLINE_MS}
 * would tear the telemetry stream down every 30 minutes, and this one is meant to
 * stay open for the life of the process.
 *
 * It is still FINITE on purpose, and the supervisor treats DEADLINE_EXCEEDED on it
 * as NORMAL ROTATION (reconnect immediately, no backoff, no health write). Two
 * things a rotation buys that an infinite stream cannot: it bounds any leak on
 * either side, and it forces a periodic fresh mTLS handshake that RE-VALIDATES the
 * pinned certificate fingerprint — so revoking trust (clearing the pin) takes
 * effect within an hour instead of never, on a connection that would otherwise
 * outlive the revocation. Immediate reconnect keeps the rotation gap at ~100ms,
 * two orders of magnitude under the chart's GAP_MS.
 */
const METRICS_STREAM_DEADLINE_MS = 55 * 60_000;
/** How many unread telemetry frames to hold before dropping the oldest. */
const METRICS_STREAM_MAX_QUEUED = 4;
// A dump+upload (or download+restore) of a large DB or volume-heavy project can
// be long; the agent caps each step at ~30min, this is that plus dial slack.
const BACKUP_DEADLINE_MS = 60 * 60_000;
/**
 * How long a `running` backup run may sit before the boot reconcile calls it
 * orphaned. Derived from the deadline above rather than guessed alongside it:
 * the two used to be picked independently and disagreed with a comment claiming
 * a third number, so a run could be declared dead while its RPC was still legal.
 * The margin covers the dial, the descriptor build and the terminal write.
 */
export const BACKUP_RUN_MAX_MS = BACKUP_DEADLINE_MS + 30 * 60_000;
// S3Check/S3Delete are quick bucket ops, but a slow/unreachable S3 endpoint must
// time out rather than hang the request that triggered it.
const S3_OP_DEADLINE_MS = 60_000;
const SELF_UPDATE_TIMEOUT_MS = 2 * 60_000; // agent downloads + verifies + swaps its own binary
// Stack lifecycle verbs (reroute/start/stop/destroy). The agent caps its own
// compose up/down at ~90-120s; this is that plus dial/network slack. A deadline
// is mandatory: these run under the per-DB lifecycle lock (lib/data/keyed-mutex),
// so a hung RPC with no deadline would wedge every future op for that database.
const STACK_DEADLINE_MS = 3 * 60_000;
// A cross-host volume copy (export/import) tars a whole DB data volume across the
// wire; the agent caps each side at ~30min. Match the backup-class deadline plus
// dial slack — same reasoning as BACKUP_DEADLINE_MS (a volume-heavy move is long).
const VOLUME_COPY_DEADLINE_MS = 60 * 60_000;
// How many BYTE-carrying frames a relay may hold before it pauses the source
// stream. The agent frames at 1 MiB (deplo-agent volumecopy.go `chunkBytes`), so
// this is ~8 MiB in flight per transfer: enough that the socket never starves
// between event-loop turns, small enough that a dozen concurrent relays cannot
// move the control plane's heap. Applies to exportVolume/exportFiles and to a
// relayed backup — the three streams where a dropped frame corrupts the payload
// and an unbounded queue is the whole artifact in memory.
const STREAM_BYTES_PAUSE_ABOVE = 8;
// A port-availability probe is a single bind()+close() on the host — near-instant.
// Keep the deadline short so an unreachable agent fails fast (this gates an
// interactive "generate available port" click + the pre-provision guard).
const CHECK_PORT_DEADLINE_MS = 15_000;
// One HTTP GET from the host to a container of an app's stack. The agent budgets
// ~6s for the request itself; this is that plus dial slack. Deliberately short:
// the only caller is icon detection, a cosmetic read that must never hold a
// deploy or a settings click open waiting on a slow app.
const PROBE_HTTP_DEADLINE_MS = 12_000;
// A cleanup sweep walks every image, volume and build-cache record on the host and
// then removes them one at a time (never in one `prune` verb — see dockerCleanup);
// on a full host that is tens of GB of unlinking. The agent budgets ~30min for its
// own docker calls, so this is the backup class of deadline, not the interactive
// one. It stays MANDATORY all the same: an agent that wedges mid-sweep must fail
// the run rather than pin the request forever.
const CLEANUP_DEADLINE_MS = 30 * 60_000;
// Host ops. HostInfo/SetTimezone/RestartControlPlane are file reads, a relink and
// a detached spawn — interactive, so an unresponsive host must fail fast rather
// than hold a settings page open. TraefikConfig is the outlier: it can pull an
// image and recreate the container, and the agent caps its own docker call at
// 180s, so it gets that plus dial slack.
const HOSTOPS_DEADLINE_MS = 20_000;
const TRAEFIK_DEADLINE_MS = 200_000;

/** What to ask an app's own container for — never an address (see `probeHttp`). */
export interface AgentProbeHttpRequest {
  /** The app whose stack to reach; the container must carry its label. */
  appId: string;
  /** The app's slug, how the agent reads a service out of a container name. */
  slug: string;
  /** Compose service to reach; "" ⇒ the app's single running container. */
  service: string;
  /** Port INSIDE the container (what Traefik routes to, not a host port). */
  port: number;
  /** Absolute request path. */
  path: string;
  /** Host header; "" ⇒ the container's IP. An app with host authorization
   *  (ALLOWED_HOSTS, a configured site URL) needs its real domain here. */
  host: string;
  /** Cap on the returned body; 0 ⇒ the agent's default. */
  maxBytes: number;
}

/** One HTTP response, body capped. */
export interface AgentProbeHttpResult {
  status: number;
  /** Lowercased Content-Type, parameters kept; "" when absent. */
  contentType: string;
  body: Buffer;
  truncated: boolean;
  /** Location on a 3xx (the agent never follows one); "" otherwise. */
  location: string;
}

/** Plain structural shapes the agent returns — mapped 1:1 by the data layer. */
export interface AgentConsoleInstance {
  name: string;
  service: string;
  image: string;
  running: boolean;
  exposed: boolean;
  user: string;
  workdir: string;
  openStdin: boolean;
  tty: boolean;
  /**
   * Raw docker state ("running" | "restarting" | "exited" | …). EMPTY from an
   * agent older than the field, which only sent `running` — and a bool cannot
   * tell a crash loop from a clean stop. Treat "" as unknown, never as a state.
   */
  state: string;
  /** "healthy" | "unhealthy" | "starting", or "" when the image has no
   *  healthcheck (which is NOT the same as healthy). */
  health: string;
  /** How many times docker has restarted this container. */
  restartCount: number;
}
export interface AgentFileEntry {
  path: string;
  name: string;
  kind: string;
  size: number;
  modifiedAt: string;
}
export interface AgentFileContent {
  path: string;
  text: string | null;
  size: number;
  reason: "binary" | "too-large" | null;
}
export interface AgentExecResult {
  stdout: string;
  stderr: string;
  code: number;
  rawMode: boolean;
}

/** What {@link AgentConnection.startJob} needs to spawn one cron attempt. */
export interface AgentStartJobRequest {
  /** `deplo.project` label the agent re-validates the container against. */
  projectId: string;
  /** Resolved LIVE before every attempt - a redeploy mints new container names. */
  container: string;
  image: string;
  /** "sh" | "bash"; empty lets the agent probe, as the console does. */
  shell: string;
  command: string;
  timeoutSeconds: number;
  workdir: string;
  user: string;
  /** The NAME rides argv, the VALUE rides the docker client's own env - so a
   *  secret is never readable from `ps` on the host. */
  env: { name: string; value: string }[];
}

/** What {@link AgentConnection.pollJob} answers. */
export interface AgentJobStatus {
  /** false ⇒ this agent has no record of the job (it restarted). Not an error. */
  found: boolean;
  running: boolean;
  /** Meaningful once `running` is false. -1 ⇒ the command never spawned. */
  exitCode: number;
  /** Empty while running; the last 16 KiB otherwise (tail, not head). */
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A live, mTLS-secured connection to one agent, with a typed wrapper. */
export interface AgentConnection {
  /**
   * The reachability + capability handshake. `timeoutMs` overrides the default
   * {@link HELLO_TIMEOUT_MS} deploy-preflight budget — the health prober passes
   * the much shorter {@link HEALTH_HELLO_TIMEOUT_MS} because it runs while an
   * operator waits on a page, not while a deploy is already committed.
   *
   * Rejects with {@link AgentUnreachableError}; on a certificate failure that
   * error carries `trust: true` (the peer answered, it just isn't the agent we
   * pinned) — the one signal that separates a broken agent from a dead host.
   */
  hello(timeoutMs?: number): Promise<HelloResponse>;
  metrics(dataDir?: string): Promise<HostMetrics>;
  /**
   * Live per-container resource usage for one project's containers (the
   * per-app / per-database Monitoring tab). `projectId` is the `deplo.project`
   * label the agent re-validates; `containers` are the already-resolved names
   * (empty => every container in the project). Gated by the `container-stats`
   * Hello capability: an agent too old to serve it rejects with gRPC
   * UNIMPLEMENTED, which the data layer maps via {@link mapContainerStatsUnsupported}
   * to the tab's "update the agent" state (no per-poll Hello preflight).
   */
  containerStats(
    projectId: string,
    containers: string[],
  ): Promise<ContainerStat[]>;
  /**
   * ONE long-lived stream carrying this host's metrics AND every Deplo-managed
   * container's stats, sampled on the AGENT's ticker rather than pulled per
   * viewer per resource. Yields until the caller breaks out, the transport dies,
   * or {@link METRICS_STREAM_DEADLINE_MS} rotates it.
   *
   * This is what makes telemetry cost O(hosts) instead of O(hosts x containers x
   * viewers): the control plane holds exactly one of these per server and demuxes
   * frames into its RAM ring buffers by each stat's `projectId`. Gated by the
   * `metrics-stream` Hello capability — see {@link connectMetricsStreamAgent},
   * which preflights it so an old agent falls back to polling instead of erroring.
   */
  streamMetrics(
    req: MetricsStreamRequest,
  ): AsyncGenerator<MetricsSample, void, unknown>;
  /** Stream a deploy; yields DeployEvents until the terminal result. */
  deploy(req: DeployRequest): AsyncGenerator<DeployEvent, void, unknown>;
  /** Reconnect to an in-flight deploy and replay missed events (D5, Part B). */
  reattach(req: ReattachRequest): AsyncGenerator<DeployEvent, void, unknown>;
  /** Stack lifecycle on the agent (Part C: stop/start; destroy from Part B). */
  stopStack(slug: string): Promise<{ ok: boolean; error: string }>;
  startStack(slug: string): Promise<{ ok: boolean; error: string }>;
  /** Tear down a stack on the agent (P6 teardown / lifecycle). `removeVolumes`
   *  (default false) also drops the stack's named volumes (`down -v`) and removes
   *  the compose file — used by database deletion so the data volume is reclaimed
   *  rather than orphaned. An agent too old to understand the flag ignores it
   *  (protobuf skips the unknown field) and falls back to a volume-orphaning
   *  `down`; the caller logs that the volume needs a manual sweep. */
  destroyStack(
    slug: string,
    removeVolumes?: boolean,
  ): Promise<{ ok: boolean; error: string }>;
  /** Re-apply routing to a running stack WITHOUT a rebuild: the control plane
   *  re-renders the stack YAML (+ env + compose mounts) and the agent writes it
   *  and `compose up`s in place. Replaces the old in-process reroute. */
  reroute(req: {
    slug: string;
    composeYaml: string;
    env: Record<string, string>;
    mounts: { path: string; content: string }[];
    /** The app's extra `compose up` flags (already split into argv tokens). A
     *  reroute brings the stack up too, so they apply here exactly as on a
     *  deploy; an agent without "deploy.compose-args" ignores them. */
    composeUpArgs?: string[];
  }): Promise<{ ok: boolean; error: string }>;
  /** Cert renewal, step 1: ask the agent for a fresh CSR (it generates a new
   *  keypair whose private key never leaves the host). Gated on the "cert-renewal"
   *  Hello capability; a too-old agent rejects with UNIMPLEMENTED. */
  renewalCsr(): Promise<{ csrPem: string }>;
  /** Cert renewal, step 2: hand the agent the CA-signed leaf produced from its
   *  last CSR; the agent verifies it matches the pending key and hot-swaps its TLS
   *  cert without a restart. `caPem` empty ⇒ the CA is unchanged (leaf-only rotate). */
  installRenewedCert(req: {
    certPem: string;
    caPem: string;
  }): Promise<{ ok: boolean; error: string }>;
  /** Stream a named Docker volume's gzipped tar OUT of this (source) host, for a
   *  cross-host server move. Yields raw byte chunks until the stream ends. The
   *  caller must have QUIESCED the source (stopped the owning stack) first so the
   *  on-disk files can't change mid-read. An agent too old to implement it rejects
   *  with UNIMPLEMENTED (mapped to AgentVolumeCopyUnsupportedError by the caller).
   *  Data does not round-trip through S3 — the control plane relays these chunks
   *  straight into {@link importVolume} on the destination host. */
  exportVolume(volumeName: string): AsyncGenerator<Buffer, void, unknown>;
  /** Untar a stream of gzipped-tar chunks INTO a named Docker volume on this
   *  (destination) host — the receiving half of a cross-host move. `wipeFirst`
   *  empties the target before untarring so the copy overwrites rather than merges.
   *  The caller must have stopped the destination stack first. Resolves with the
   *  terminal StackResult. Rejects with UNIMPLEMENTED on a too-old agent (mapped by
   *  the caller). */
  importVolume(
    volumeName: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string }>;
  /** Stream an app's host-side FILES DIR (a plain host directory, not a Docker
   *  volume) OUT of this host as a gzipped tar — the files-dir sibling of
   *  {@link exportVolume} for an app move. A missing dir yields an empty stream.
   *  Rejects with UNIMPLEMENTED on a too-old agent (mapped by the caller). */
  exportFiles(slug: string): AsyncGenerator<Buffer, void, unknown>;
  /** Untar a stream of gzipped-tar chunks INTO an app's files dir on this host —
   *  the receiving half. `wipeFirst` empties the dir first (overwrite, not merge).
   *  Resolves with the terminal StackResult. Rejects with UNIMPLEMENTED on a too-old
   *  agent (mapped by the caller). */
  importFiles(
    slug: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string }>;
  /** Read back the rendered stack YAML the agent has on disk, for the "View full
   *  compose" preview. `exists` is false (empty yaml) when never deployed. */
  readStack(slug: string): Promise<{ exists: boolean; yaml: string }>;
  /** Whether a host TCP port is free to publish. The agent answers by attempting
   *  to bind it (seeing both Docker-published ports and raw host listeners), so a
   *  false here means the port is genuinely taken on that host right now. Gates
   *  the database "Expose publicly" flow — the pre-provision collision guard and
   *  the "generate an available port" button. An agent too old to implement it
   *  rejects with UNIMPLEMENTED (mapped to AgentCheckPortUnsupportedError by the
   *  caller). */
  checkPort(port: number): Promise<{ available: boolean; reason: string }>;
  /** One bounded HTTP GET to a container of an app's OWN stack, issued from the
   *  host over Docker's network. The agent resolves the address itself (the
   *  container carrying this app's `deplo.project` label, on `service`), so the
   *  caller picks WHAT to ask for and never WHERE — this is not a general fetch.
   *  Redirects come back unfollowed. Used by icon detection to read the favicon a
   *  compose app only ever serves. Rejects with UNIMPLEMENTED on an agent without
   *  the `http-probe` capability, and UNAVAILABLE when the app isn't answering. */
  probeHttp(req: AgentProbeHttpRequest): Promise<AgentProbeHttpResult>;
  /** Update the agent BINARY in place to `version`, WITHOUT reissuing certs: the
   *  agent picks the asset for its own arch from `binaries`, verifies the sha256,
   *  swaps itself, and re-execs reusing the on-disk mTLS materials. Resolves once
   *  the swap is staged and the restart is scheduled (`restarting`). */
  selfUpdate(
    version: string,
    binaries: Record<string, { url: string; sha256: string }>,
  ): Promise<{ version: string; restarting: boolean }>;
  /** Reclaim Docker disk on the host — a STRICT ALLOW-LIST, never a prune verb. The
   *  agent removes only what it can PROVE is unreferenced (a container-reference
   *  reverse index over running AND exited containers, or an on-disk sentinel), and
   *  never runs `system`/`container`/`volume`/`network prune`: on a Deplo host a
   *  STOPPED app is a LIVE app (StopStack is `compose stop` — the container, its
   *  volumes and its networks must survive it) and a dangling volume may hold a
   *  database's data files. With `dryRun` it enumerates the candidates and reclaims
   *  NOTHING, filling every result field as if it had — that is what the confirm
   *  dialog renders. A scope that fails, or that the agent declines because it could
   *  not build the reverse index, is reported per-scope and the sweep carries on;
   *  `ok:false` means the sweep never started. An agent too old to implement it
   *  rejects with UNIMPLEMENTED (mapped to AgentCleanupUnsupportedError by the
   *  caller — go through {@link runAgentCleanup}, which pre-flights the capability). */
  dockerCleanup(req: DockerCleanupRequest): Promise<DockerCleanupResponse>;

  // ---- Host ops: the four host-level verbs behind the "hostops" capability ----
  /** What this host IS (CPU model, distro, kernel, clock, Docker root dir) plus
   *  the two pieces of host state the control plane can act on: the deplo-traefik
   *  stack file and whether the control-plane container hint resolves. Never
   *  fails on a half-broken host — an unreadable field comes back empty. */
  hostInfo(req: HostInfoRequest): Promise<HostInfoResponse>;
  /** Move the host clock to an IANA zone; answers with a FRESH HostInfoResponse
   *  so the caller sees the clock that actually moved. The agent re-validates the
   *  name against /usr/share/zoneinfo — it ends in a relink of /etc/localtime. */
  setTimezone(req: SetTimezoneRequest): Promise<HostInfoResponse>;
  /** Rewrite and/or restart the deplo-traefik stack from control-plane-rendered
   *  YAML (ADR-0006). Refuses — as `ok:false`, not an RPC error — when Deplo did
   *  not install Traefik on that host. */
  traefikConfig(req: TraefikConfigRequest): Promise<TraefikConfigResponse>;
  /** Bounce the container the Deplo panel runs in on this host. `ok:true` means
   *  SCHEDULED, not done: the restart kills the process waiting on the reply. */
  restartControlPlane(
    req: RestartControlPlaneRequest,
  ): Promise<RestartControlPlaneResponse>;

  // ---- Backups: dump/restore to S3 + the S3 affordances (ADR-0007) ----
  /** Dump a database or project to S3, streaming progress; yields BackupEvents
   *  until the terminal result (objectKey + sizeBytes on success). The agent
   *  runs the engine's dump tool / tars the project's volumes+files+snapshot,
   *  gzip-compresses, and uploads itself — the bytes never round-trip here. */
  backup(req: BackupRequest): AsyncGenerator<BackupEvent, void, unknown>;
  /** Restore a database or project from an S3 object, in place; yields
   *  RestoreEvents until the terminal result. DB = drop-and-recreate; project =
   *  stop → wipe + untar volumes/files → re-Reroute the snapshot. */
  restore(req: RestoreRequest): AsyncGenerator<RestoreEvent, void, unknown>;
  /** Verify S3 connectivity + that the bucket is writable (makes the S3 half of
   *  testDestination real). */
  s3Check(s3: S3Target): Promise<{ ok: boolean; error: string }>;
  /** Delete a single object (or, with `prefix`, a whole target folder) from S3 —
   *  backs retention pruning + delete-with-artifacts. Idempotent; returns the
   *  count removed. `s3.objectKey` is the key or prefix. */
  s3Delete(
    s3: S3Target,
    prefix?: boolean,
  ): Promise<{ ok: boolean; error: string; deleted: number }>;

  // ---- Backup STORES: artifacts on a server's disk (capability "backup-store") ----
  /** Verify a store root on THIS host: resolve it (creating the managed one, or
   *  marking an empty custom one), probe writability, sweep stale `.partial`
   *  artifacts, and report the filesystem headroom. Unlike an S3 bucket, this
   *  question is about one machine's disk, so it must run on that machine. */
  storeCheck(store: StoreTarget): Promise<{
    ok: boolean;
    error: string;
    freeBytes: number;
    totalBytes: number;
    root: string;
  }>;
  /** Delete an artifact (or, with `prefix`, a target's whole folder) from a store.
   *  Idempotent; a prefix that resolves to the root itself is refused agent-side. */
  storeDelete(
    store: StoreTarget,
    prefix?: boolean,
  ): Promise<{ ok: boolean; error: string; deleted: number }>;
  /** Stream an artifact out of wherever it is kept: this host's store, or a
   *  bucket the host can dial (exactly one of `store` / `s3`). Verbatim (still
   *  encrypted) by default - which is what a relay needs; pass `ageIdentity` to
   *  have the agent DECRYPT on the way out, which is what a download needs. Never
   *  gunzipped: the file the user wants IS the .tar.gz / .dump.gz. */
  readStoreFile(
    target: { store?: StoreTarget; s3?: S3Target },
    ageIdentity?: string,
    /** The sha256 recorded when this artifact was written. A STORE artifact is
     *  hashed before a byte leaves, so a mismatch refuses outright; a BUCKET one
     *  can only be hashed as it goes past, so the stream ends in an error after
     *  bytes have already arrived. Omit only for a run taken before integrity
     *  checking shipped. */
    expectedSha256?: string,
  ): AsyncGenerator<Buffer, void, unknown>;
  /** Stream an artifact INTO a store — the destination half of a cross-host
   *  backup. Returns what actually landed (bytes + sha256), which is the number
   *  the run records: on a filesystem there is no ETag. */
  writeStoreFile(
    store: StoreTarget,
    overwrite: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string; bytesWritten: number; sha256: string }>;
  /** Restore from an artifact this host cannot reach: the header carries the kind,
   *  the descriptor and the age identity, then the artifact's bytes stream in.
   *  Yields RestoreEvents exactly like `restore`. */
  restoreFrom(
    header: RestoreChunk_Header,
    chunks: AsyncIterable<Buffer>,
  ): AsyncGenerator<RestoreEvent, void, unknown>;

  // ---- Part C: console observability ----
  /** The RAW docker state of an app's single-image container (`deplo-<slug>`):
   *  "running" | "restarting" | "exited" | … . The one place the agent already
   *  tells the truth about a crash loop; ListInstances only carries a boolean.
   *  A compose stack's containers are not addressable by slug — `exists:false`. */
  inspect(slug: string): Promise<{ exists: boolean; running: boolean; state: string }>;
  /** Live `docker logs -f` as an output-only AttachHandle (reuses the SSE session
   *  plumbing). `write` is a no-op; `close()` cancels the stream + the grpc client. */
  followLogs(appId: string, container: string, tail: number): AttachHandle;
  /** Interactive attach as a full-duplex AttachHandle (write = stdin, onData =
   *  output). `tty` selects the pty backing agent-side. */
  attach(
    appId: string,
    container: string,
    tty: boolean,
    cols: number,
    rows: number,
  ): AttachHandle;
  /** Every attachable container in a project's stack (no synthetic fallback). */
  listInstances(
    appId: string,
    slug: string,
    exposeService: string,
  ): Promise<AgentConsoleInstance[]>;
  /** Run a command in a container (docker exec); guest exit code, never throws on it. */
  exec(
    appId: string,
    container: string,
    command: string,
    image: string,
  ): Promise<AgentExecResult>;
  /** The container's shell label for the console banner. */
  shellLabel(appId: string, container: string, image: string): Promise<string>;

  // ---- Cron jobs (ADR-0018) ----
  /**
   * Spawn a scheduled command in a container and get its handle back. Returns in
   * well under a second: the agent does the container check and the shell probe
   * inside its own goroutine, so a pre-spawn failure arrives through
   * {@link AgentConnection.pollJob} as `exitCode: -1` rather than as a throw.
   *
   * Deliberately NOT {@link AgentConnection.exec}, which is capped at 30s and
   * unary because a console REPL types one command and waits. The process here
   * lives in the AGENT, on a job-scoped context, so restarting the control plane
   * does not kill a running cron job.
   */
  startJob(req: AgentStartJobRequest): Promise<string>;
  /**
   * A job's current state. `found: false` means this agent has no record of it -
   * it restarted, or the job was evicted after its retention window. That is a
   * normal answer, and the caller records the run as `lost` (outcome unknown),
   * never as a failure.
   *
   * Output is populated only once `running` is false.
   */
  pollJob(jobId: string): Promise<AgentJobStatus>;
  /** Stop a running job. Idempotent: unknown or finished answers `false`. */
  killJob(jobId: string): Promise<boolean>;

  // ---- Part C: project config files ----
  listFiles(slug: string, path: string): Promise<AgentFileEntry[]>;
  readFile(slug: string, path: string): Promise<AgentFileContent>;
  writeFile(slug: string, path: string, content: string): Promise<AgentFileEntry>;
  uploadFile(slug: string, path: string, data: Buffer): Promise<AgentFileEntry>;
  createDir(slug: string, path: string): Promise<AgentFileEntry>;
  deleteFile(slug: string, path: string): Promise<boolean>;
  renameFile(slug: string, path: string, newPath: string): Promise<AgentFileEntry>;
  filesExist(slug: string): Promise<boolean>;

  close(): void;
}

/**
 * A resolved dial target: the address + serverName + the control plane's client
 * creds + the pinned fingerprint. The pin is REQUIRED for every server (trust
 * that EXACT cert, P6 revocation) — there is no un-pinned in-process agent.
 */
interface DialTarget {
  address: string;
  serverName: string;
  clientCreds: { certPem: string; keyPem: string; caPem: string };
  /** sha256(DER) hex of the agent cert we will accept. */
  pinnedFingerprint: string;
}

/**
 * A typed availability error: the agent could not be reached (caller falls back).
 *
 * The two optional fields exist for ONE caller — the health prober
 * (`lib/data/server-health.ts`), which has to tell "the box is off" apart from
 * "the box answered with the wrong certificate". They are additive and optional,
 * so every existing `instanceof AgentUnreachableError` guard (team-delete, backups,
 * s3, apps, console, metricsFor) keeps behaving exactly as before.
 */
export class AgentUnreachableError extends Error {
  constructor(
    message: string,
    /** The gRPC status code we normalised, when the failure came from an RPC. */
    readonly code?: number,
    /**
     * True when the failure is a TRUST failure rather than a dead host: the peer
     * presented a cert that is not the pinned one, or it rejected OUR client cert
     * (UNAUTHENTICATED). Both reach gRPC as an opaque transport error, so the fact
     * is captured at the only place that knows it ({@link dial}) instead of being
     * recovered by parsing an error string we do not control.
     */
    readonly trust?: boolean,
  ) {
    super(message);
  }
}

/**
 * The reachable agent does not (yet) implement the in-place self-update RPC.
 *
 * The agent binary lives in its own repo (DeploCloud/deplo-agent) and ships on
 * its own cadence; the `SelfUpdate` RPC — "fetch the checksum-verified latest
 * binary, swap yourself on disk, re-exec keeping the SAME on-disk mTLS materials"
 * — is added there and rolled out in an agent release. Until a server is running
 * an agent new enough to answer it, `selfUpdateServerAgent` rejects with THIS
 * error (distinct from {@link AgentUnreachableError}: the agent IS up, it just
 * can't update itself remotely). The data/GraphQL layers surface it as a clear
 * "update this agent by re-running the installer for now" message rather than a
 * generic failure. When the RPC ships, only the body of `selfUpdateServerAgent`
 * changes — every layer above it is already wired.
 */
export class AgentUpdateUnsupportedError extends Error {}

/**
 * The reachable agent does not (yet) implement the backup RPCs (Backup /
 * Restore / S3Check / S3Delete) — it doesn't advertise the `"backup"`
 * capability in Hello, or it answers the call with gRPC UNIMPLEMENTED.
 *
 * Backups route through the OWNING server's agent (ADR-0007): the real dump +
 * S3 upload, the connectivity check, and object deletion all run agent-side via
 * RPCs that ship in a `deplo-agent` release. Until a server runs an agent new
 * enough to answer them, the data layer surfaces THIS error — distinct from
 * {@link AgentUnreachableError} (the agent IS up, it just can't back up yet) —
 * so the UI says "update the agent on this server" rather than faking a success
 * or emitting a confusing UNIMPLEMENTED. Mirrors {@link AgentUpdateUnsupportedError}.
 */
export class AgentBackupUnsupportedError extends Error {}

/**
 * The reachable agent can back up to S3 but cannot hold artifacts on its own
 * disk — it predates the `"backup-store"` capability. Distinct from
 * {@link AgentBackupUnsupportedError} on purpose: during a fleet rollout the two
 * are genuinely different states, and "backups are unsupported here" would send
 * an operator whose S3 backups are working fine looking in the wrong place.
 */
export class AgentBackupStoreUnsupportedError extends Error {}

/**
 * The reachable agent does not (yet) implement the {@link AgentConnection.containerStats}
 * RPC — it predates the `"container-stats"` capability, so it answers with gRPC
 * UNIMPLEMENTED. The per-app / per-database Monitoring tab needs the agent to
 * report a container's live CPU/mem/net/block usage; until a server runs a new
 * enough agent, the data layer surfaces THIS (distinct from
 * {@link AgentUnreachableError} — the agent IS up, it just can't stat containers
 * yet) so the tab shows an "update the agent on this server" state rather than a
 * confusing error. Mirrors {@link AgentBackupUnsupportedError}.
 */
export class AgentContainerStatsUnsupportedError extends Error {}

/**
 * The reachable agent does not (yet) implement {@link AgentConnection.streamMetrics}
 * — it predates the `"metrics-stream"` capability.
 *
 * Unlike its siblings this is NOT a user-facing error state, and nothing should
 * ever surface it in the UI. The monitoring supervisor catches it specifically and
 * DEMOTES that one server to the legacy poll path, which still produces correct
 * charts at a higher cost. That is the whole degradation story for a mixed-version
 * fleet: a rollout is server-by-server, and a user can register a server running
 * last year's agent tomorrow.
 */
export class AgentMetricsStreamUnsupportedError extends Error {}

/**
 * The reachable agent does not (yet) implement the {@link AgentConnection.checkPort}
 * RPC — it doesn't advertise the `"checkport"` capability in Hello, or it answers
 * with gRPC UNIMPLEMENTED. The database "Expose publicly" flow needs the agent to
 * tell it whether a host port is free (both the pre-provision collision guard and
 * the "generate an available port" button), so until a server runs an agent new
 * enough to answer, the data layer surfaces THIS error — distinct from
 * {@link AgentUnreachableError} (the agent IS up, it just can't probe ports yet) —
 * and the UI says "update the agent on this server". Mirrors
 * {@link AgentBackupUnsupportedError}.
 */
export class AgentCheckPortUnsupportedError extends Error {}

/**
 * Map a checkPort RPC error to {@link AgentCheckPortUnsupportedError} when it is a
 * gRPC UNIMPLEMENTED (the agent predates the RPC); every other error passes
 * through unchanged. Callers preflight the capability via Hello first, but an
 * agent could advertise nothing yet still reject — this is the belt-and-braces.
 */
export function mapCheckPortUnsupported(e: unknown): Error {
  if (e instanceof AgentCheckPortUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCheckPortUnsupportedError(
      "This server's agent is too old to check port availability. Update the agent on this server, then try again.",
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * The reachable agent does not (yet) implement the cross-host data-copy RPCs used
 * by a server move — the volume-copy pair ({@link AgentConnection.exportVolume} /
 * {@link AgentConnection.importVolume}, capability `"volume-copy"`) and/or the
 * files-dir pair ({@link AgentConnection.exportFiles} /
 * {@link AgentConnection.importFiles}, capability `"files-copy"`) — or it answers
 * with gRPC UNIMPLEMENTED. Moving a database or app to another server copies its
 * data host-to-host through these RPCs, so until BOTH the source and destination
 * servers run an agent new enough to answer, the data layer surfaces THIS error —
 * distinct from {@link AgentUnreachableError} (the agent IS up, it just can't copy
 * data yet) — and the UI says "update the agent on this server". Mirrors
 * {@link AgentCheckPortUnsupportedError}.
 */
export class AgentVolumeCopyUnsupportedError extends Error {}

/**
 * Map a cross-host data-copy RPC error (volume OR files) to
 * {@link AgentVolumeCopyUnsupportedError} when it is a gRPC UNIMPLEMENTED (the agent
 * predates the RPCs); every other error passes through unchanged. `which` names the
 * side ("source"/"destination") so the message points at the right server.
 */
export function mapVolumeCopyUnsupported(e: unknown, which: string): Error {
  if (e instanceof AgentVolumeCopyUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentVolumeCopyUnsupportedError(
      `The ${which} server's agent is too old to copy data between servers. Update the agent on that server, then try again.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * The reachable agent does not (yet) implement the {@link AgentConnection.dockerCleanup}
 * RPC — it doesn't advertise the `"docker-cleanup"` capability in Hello, or it answers
 * with gRPC UNIMPLEMENTED. Reclaiming Docker disk is host-coupled work, so it lives
 * entirely agent-side (ADR-0006); until a server runs an agent new enough to answer,
 * the data layer surfaces THIS error — distinct from {@link AgentUnreachableError} (the
 * agent IS up, it just can't reclaim disk yet) — and the UI says "update the agent on
 * this server".
 *
 * The alternative — letting an unsupported call resolve as an ok response with zero
 * bytes reclaimed — is the one outcome a cleanup must NEVER produce: a sweep that
 * silently did nothing is indistinguishable from one that worked, and the operator
 * would go on believing the disk was being kept clear while it filled up. Mirrors
 * {@link AgentCheckPortUnsupportedError}.
 */
export class AgentCleanupUnsupportedError extends Error {}

/** The single message an out-of-date agent produces, wherever the gap is caught —
 *  the Hello pre-flight in {@link runAgentCleanup} or the RPC's own UNIMPLEMENTED.
 *  One string so the two paths can never drift into two different stories. */
const CLEANUP_UNSUPPORTED_MESSAGE =
  "The agent on this server is too old to clean up Docker disk. " +
  "Update the agent on this server, then try again.";

/**
 * Map a DockerCleanup RPC error to {@link AgentCleanupUnsupportedError} when it is a
 * gRPC UNIMPLEMENTED (the agent predates the RPC); every other error passes through
 * unchanged. {@link runAgentCleanup} preflights the capability via Hello first, but an
 * agent could advertise nothing yet still reject — this is the belt-and-braces.
 * Idempotent on an already-mapped error.
 */
export function mapCleanupUnsupported(e: unknown): Error {
  if (e instanceof AgentCleanupUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * gRPC status codes that mean "the agent is down / not answering" rather than
 * "the agent answered with an application error". A provisioned-but-offline agent
 * (process dead, host down, network partition) rejects RPCs with one of these,
 * NOT with AgentUnreachableError — so without this mapping every "is the agent
 * unreachable?" guard in the data layer would miss the common case and either
 * 500 a page or lie about status. We normalise them to AgentUnreachableError at
 * the client boundary so the locked rule ("remote unreachable → fail clearly,
 * report offline, never fall back / lie") holds for down agents too, not just
 * never-provisioned ones.
 */
const TRANSPORT_DOWN_CODES = new Set<number>([
  GrpcStatus.UNAVAILABLE, // connection refused / TLS / keepalive / agent gone
  GrpcStatus.DEADLINE_EXCEEDED, // dialed but never answered within the deadline
  GrpcStatus.UNAUTHENTICATED, // mTLS handshake failed (revoked / wrong cert)
]);

/**
 * Normalise an RPC error: a transport-down gRPC error becomes an
 * AgentUnreachableError (so the data-layer guards catch it); anything else (an
 * application error the agent deliberately returned — NOT_FOUND, PERMISSION_DENIED,
 * INVALID_ARGUMENT, FAILED_PRECONDITION) passes through unchanged.
 */
function toAgentError(err: unknown): Error {
  if (err instanceof AgentUnreachableError) return err;
  const code = (err as Partial<ServiceError> | null)?.code;
  if (typeof code === "number" && TRANSPORT_DOWN_CODES.has(code)) {
    const msg = err instanceof Error ? err.message : String(err);
    // Carry the code so the health prober can separate "no answer within the
    // deadline" from "connection refused". Every other caller ignores it.
    return new AgentUnreachableError(msg, code);
  }
  return err instanceof Error ? err : new Error(String(err));
}



/** Why a log stream died, in the only vocabulary the browser is allowed to see. */
export type LogsFailure = "unreachable" | "not-found" | "denied" | "failed";

/**
 * Curate a FollowLogs stream failure into a stable, client-safe reason. A raw
 * gRPC transport error embeds the dial address and the pinned cert fingerprint
 * (see AppSummary.statusMessage: those never leave the server), so the wire
 * carries one of these four words and nothing else.
 */
function logsFailureReason(err: unknown): LogsFailure {
  if (toAgentError(err) instanceof AgentUnreachableError) return "unreachable";
  const code = (err as Partial<ServiceError> | null)?.code;
  if (code === GrpcStatus.NOT_FOUND) return "not-found";
  if (code === GrpcStatus.PERMISSION_DENIED) return "denied";
  return "failed";
}

/**
 * Resolve a server to a dial target: its declared host/port + the control plane's
 * client cert, pinning the agent cert recorded at bootstrap. Applies uniformly to
 * every server, the host running Deplo included. Throws {@link AgentUnreachableError}
 * if the server is unknown, has no provisioned agent yet, or trust was revoked —
 * the caller surfaces "server unreachable / not provisioned" instead of hanging.
 */
async function resolveTarget(serverId: string): Promise<DialTarget> {
  const server = await getServerById(serverId);
  if (!server) {
    throw new AgentUnreachableError(`server ${serverId} not found`);
  }
  if (!server.agent || !server.agent.certFingerprint) {
    throw new AgentUnreachableError(
      `server ${server.name} is not provisioned (no agent has called home yet)`,
    );
  }
  return remoteTarget(server);
}

/** Build a dial target for a provisioned agent (Part B). */
async function remoteTarget(server: Server): Promise<DialTarget> {
  const { issueControlPlaneClientCert, caCertPem, IPV4_RE } = await import("../agent/pki");
  const client = await issueControlPlaneClientCert();
  const agent = server.agent!;
  const host = server.ip || server.host;
  return {
    address: `${host}:${agent.port}`,
    // TLS SNI / authority. The agent cert's SANs cover the server's IP/host
    // (signAgentCsr used them), so hostname verification passes either way — but
    // Node's TLS layer REFUSES to send an IP literal as the SNI servername (RFC
    // 6066: SNI must be a hostname). Dialing an IP-addressed server with
    // serverName=<ip> therefore throws ERR_INVALID_ARG_VALUE before the
    // handshake, which surfaces as gRPC UNAVAILABLE and silently kills every
    // metrics/hello poll (the server shows "online" from call-home but no stats).
    // For an IP host, verify against `localhost` instead — signAgentCsr ALWAYS
    // adds it as a DNS SAN, so verification still passes. The real trust anchor
    // is the exact-fingerprint pin in checkServerIdentity below, not the name.
    serverName: IPV4_RE.test(host) ? "localhost" : host,
    clientCreds: { certPem: client.certPem, keyPem: client.keyPem, caPem: await caCertPem() },
    pinnedFingerprint: agent.certFingerprint,
  };
}

/** Normalise a tls PeerCertificate fingerprint ("AA:BB:..") to lowercase hex. */
function peerFingerprint(cert: PeerCertificate): string {
  return (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
}

/**
 * One promise wrapper for a plain unary call whose response IS the DTO. The
 * generated client's callback signature is identical for all of them, so the
 * host-ops methods share this instead of four near-identical Promise bodies that
 * could drift in their error mapping.
 */
function unary<Req, Resp>(
  call: (
    req: Req,
    md: Metadata,
    opts: { deadline: Date },
    cb: (err: ServiceError | null, resp: Resp) => void,
  ) => unknown,
  req: Req,
  deadlineMs: number,
): Promise<Resp> {
  return new Promise<Resp>((resolve, reject) => {
    call(
      req,
      new Metadata(),
      { deadline: new Date(Date.now() + deadlineMs) },
      (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp)),
    );
  });
}

/** Build a typed connection over an mTLS channel to the given target. */
function dial(target: DialTarget): AgentConnection {
  const { certPem, keyPem, caPem } = target.clientCreds;
  // Set by checkServerIdentity below when the peer's cert is not the pinned one.
  // Node's TLS layer turns that rejection into a handshake failure, which grpc-js
  // surfaces as an opaque UNAVAILABLE — indistinguishable from "the host is off".
  // Recording the fact HERE, at the only place that knows it, is what lets the
  // health prober report a trust failure as `error` instead of lying with
  // `offline`. (Recovering it by matching on the error string would mean parsing
  // a message grpc-js owns and can reword at any release.)
  let trustFailed = false;
  const creds = credentials.createSsl(
    Buffer.from(caPem),
    Buffer.from(keyPem),
    Buffer.from(certPem),
    {
      // Standard CA-chain + hostname verification still runs; this fires AFTER
      // it. We additionally require the EXACT pinned fingerprint, so a cert that
      // chains to our CA but isn't the one we provisioned (or whose trust was
      // revoked by clearing the pin) is rejected — P6 revocation.
      checkServerIdentity: (_host, cert) => {
        const got = peerFingerprint(cert);
        if (got !== target.pinnedFingerprint) {
          trustFailed = true;
          return new Error(
            `agent cert fingerprint mismatch: pinned ${target.pinnedFingerprint}, got ${got}`,
          );
        }
        return undefined;
      },
    },
  );
  const client = new GrpcAgentClient(target.address, creds, {
    // Verify the agent cert against this name (covered by the cert SANs).
    "grpc.ssl_target_name_override": target.serverName,
    "grpc.default_authority": target.serverName,
    // Large messages: a streamed build context rides inside the Deploy request.
    "grpc.max_receive_message_length": 256 * 1024 * 1024,
    "grpc.max_send_message_length": 256 * 1024 * 1024,
    // Keepalive, for the LONG-LIVED streams (StreamMetrics runs for the life of
    // this process; logs/attach for hours). Without it a stream that goes quiet
    // behind a NAT or stateful firewall gets its mapping reaped and we never
    // learn: no error, no end event, just a chart that stops updating.
    //
    // The agent's server-side EnforcementPolicy sets MinTime 15s, so 30s is
    // legal. Do NOT lower this below that floor without changing the agent in the
    // same release — grpc-go answers a too-frequent ping with GOAWAY /
    // ENHANCE_YOUR_CALM, which presents as random stream drops.
    "grpc.keepalive_time_ms": 30_000,
    "grpc.keepalive_timeout_ms": 10_000,
    // Only ping while an RPC is in flight. Matches the agent's
    // PermitWithoutStream:false — a ping on a wholly idle channel would be
    // refused, and we have no reason to send one.
    "grpc.keepalive_permit_without_calls": 0,
  });



  /**
   * Adapt a gRPC server-stream of LogChunks into the output-only AttachHandle the
   * logs session registry consumes — so lib/logs/session.ts works UNCHANGED for a
   * remote backing. Pre-subscription chunks are BUFFERED and flushed to the first
   * subscriber, exactly reproducing the synchronous tail burst the local
   * `docker logs` pipe delivers (so session.backlog semantics hold). `close()`
   * cancels the stream AND the grpc client (this is the only consumer of it).
   */
  function logsHandle(stream: ClientReadableStream<LogChunk>): AttachHandle {
    const subs = new Set<(c: Buffer) => void>();
    let pending: Buffer[] | null = [];
    let exitCb: ((error?: string) => void) | null = null;
    let closed = false;
    const fanout = (buf: Buffer) => {
      if (subs.size === 0 && pending) {
        pending.push(buf);
        return;
      }
      for (const s of subs) s(buf);
    };
    stream.on("data", (c: LogChunk) => fanout(Buffer.from(c.data)));
    const end = (error?: string) => {
      if (closed) return;
      exitCb?.(error);
    };
    stream.on("end", () => end());
    // A stream FAILURE is not a clean end: the agent can refuse the container
    // (no such container / not this app's), or the host can drop mid-follow.
    // Reporting it as a plain exit is what left the viewer sitting empty with
    // nothing to say — carry the reason out so the UI can show it. A cancel we
    // asked for (close()) is filtered by the `closed` guard above.
    stream.on("error", (e: Error) => end(logsFailureReason(e)));
    return {
      onData(cb) {
        subs.add(cb);
        if (pending) {
          const p = pending;
          pending = null;
          for (const c of p) cb(c);
        }
        return () => subs.delete(cb);
      },
      onExit(cb) {
        exitCb = cb;
      },
      write() {
        /* logs are read-only */
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          stream.cancel();
        } catch {
          /* already gone */
        }
        client.close();
      },
    };
  }

  /**
   * Adapt a gRPC bidi attach stream into a full-duplex AttachHandle. `write`
   * sends stdin AttachInput.data frames; output AttachOutput.data frames fan out
   * via onData; an exit frame (or stream end) fires onExit. `close()` cancels the
   * stream and the grpc client. The FIRST frame (AttachOpen) is sent by the
   * factory before the handle is returned, so the agent has the container+tty.
   */
  function attachHandle(
    stream: ClientDuplexStream<AttachInput, AttachOutput>,
  ): AttachHandle {
    const subs = new Set<(c: Buffer) => void>();
    let pending: Buffer[] | null = [];
    let exitCb: (() => void) | null = null;
    let closed = false;
    stream.on("data", (o: AttachOutput) => {
      if (o.data && o.data.length) {
        const buf = Buffer.from(o.data);
        if (subs.size === 0 && pending) pending.push(buf);
        else for (const s of subs) s(buf);
      } else if (o.exit) {
        exitCb?.();
      }
    });
    const end = () => {
      if (closed) return;
      exitCb?.();
    };
    stream.on("end", end);
    stream.on("error", end);
    return {
      onData(cb) {
        subs.add(cb);
        if (pending) {
          const p = pending;
          pending = null;
          for (const c of p) cb(c);
        }
        return () => subs.delete(cb);
      },
      onExit(cb) {
        exitCb = cb;
      },
      write(data: string) {
        if (closed) return;
        try {
          stream.write({ data: Buffer.from(data, "utf8") });
        } catch {
          /* stream gone; ignore */
        }
      },
      resize(cols: number, rows: number) {
        if (closed) return;
        try {
          // A tty-only AttachInput frame; the agent applies it to the pty. On a
          // pipe-backed (non-tty) attach the agent ignores it — harmless.
          stream.write({ resize: { cols, rows } });
        } catch {
          /* stream gone; ignore */
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          stream.cancel();
        } catch {
          /* already gone */
        }
        client.close();
      },
    };
  }

  const filesDeadline = () => ({ deadline: new Date(Date.now() + FILES_TIMEOUT_MS) });
  const consoleDeadline = () => ({ deadline: new Date(Date.now() + CONSOLE_TIMEOUT_MS) });
  const metricsDeadline = () => ({ deadline: new Date(Date.now() + METRICS_TIMEOUT_MS) });
  const mapInstance = (i: PbConsoleInstance): AgentConsoleInstance => ({
    name: i.name,
    service: i.service,
    image: i.image,
    running: i.running,
    exposed: i.exposed,
    user: i.user,
    workdir: i.workdir,
    openStdin: i.openStdin,
    tty: i.tty,
    // Absent from an older agent: protobuf leaves them at "" / 0, which the
    // runtime probe reads as "this agent cannot tell me" and falls back.
    state: i.state,
    health: i.health,
    restartCount: i.restartCount,
  });
  const mapEntry = (e: PbFileEntry): AgentFileEntry => ({
    path: e.path,
    name: e.name,
    kind: e.kind,
    size: Number(e.size),
    modifiedAt: e.modifiedAt,
  });

  /**
   * Hello-specific error normaliser. A cert-pin rejection (recorded by
   * `checkServerIdentity` above) or an UNAUTHENTICATED — the agent refusing OUR
   * client cert — is a TRUST failure, not a dead host: the peer is up, the mTLS
   * identity is wrong. Only `hello` normalises this way, because only the health
   * prober consumes the distinction; every other RPC keeps seeing the plain
   * transport-down AgentUnreachableError it always has.
   */
  const helloError = (err: unknown): Error => {
    const e = toAgentError(err);
    if (
      e instanceof AgentUnreachableError &&
      (trustFailed || e.code === GrpcStatus.UNAUTHENTICATED)
    ) {
      return new AgentUnreachableError(e.message, e.code, true);
    }
    return e;
  };

  return {
    hello(timeoutMs = HELLO_TIMEOUT_MS) {
      return new Promise<HelloResponse>((resolve, reject) => {
        const deadline = new Date(Date.now() + timeoutMs);
        client.hello(
          { contractVersion: ContractVersion.CONTRACT_VERSION_V1, controlPlaneVersion: "" },
          new Metadata(),
          { deadline },
          (err, resp) => (err ? reject(helloError(err)) : resolve(resp)),
        );
      });
    },
    metrics(dataDir = "") {
      return new Promise<HostMetrics>((resolve, reject) => {
        // A SHORT deadline is mandatory (METRICS_TIMEOUT_MS): the dashboard polls
        // ~1s on a busy-guard, so a remote agent that accepts the connection but
        // can't finish measuring (host pinned by its own deploy/load) must fail
        // fast so the next tick can retry — not hang the poll for the full console
        // deadline and amplify a brief pin into a minute-long chart gap.
        client.metrics({ dataDir }, new Metadata(), metricsDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve(resp),
        );
      });
    },
    containerStats(projectId: string, containers: string[]) {
      return new Promise<ContainerStat[]>((resolve, reject) => {
        // Same reasoning as metrics(): the Monitoring tab polls ~1s on a busy-
        // guard, so an agent that accepts the dial but can't finish stat-ing the
        // stack (e.g. its containers are mid-recreate during a deploy) must fail
        // fast and let the next tick recover, not hang the full console deadline.
        client.containerStats(
          { projectId, containers },
          new Metadata(),
          metricsDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.stats),
        );
      });
    },
    streamMetrics(req: MetricsStreamRequest) {
      return streamEvents(
        client.streamMetrics(req, {
          deadline: new Date(Date.now() + METRICS_STREAM_DEADLINE_MS),
        }),
        // Bounded, drop-oldest. Four frames is ~20s of history at the default
        // cadence — enough to ride out a GC pause or a slow buffer write, far
        // short of anything worth replaying. If the consumer is further behind
        // than that, the right sample to keep is the newest one.
        { maxQueued: METRICS_STREAM_MAX_QUEUED, normalise: toAgentError },
      );
    },
    deploy(req: DeployRequest) {
      return streamEvents(
        client.deploy(req, { deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS) }),
        { normalise: toAgentError },
      );
    },
    reattach(req: ReattachRequest) {
      return streamEvents(
        client.reattachDeploy(req, {
          deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
        }),
        { normalise: toAgentError },
      );
    },
    stopStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        // `removeVolumes` is part of StackRef but meaningless for start/stop —
        // these only toggle the running state, never touch volumes.
        client.stopStack(
          { slug, removeVolumes: false },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    startStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.startStack(
          { slug, removeVolumes: false },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    destroyStack(slug: string, removeVolumes = false) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.destroyStack(
          { slug, removeVolumes },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    reroute(req: {
      slug: string;
      composeYaml: string;
      env: Record<string, string>;
      mounts: { path: string; content: string }[];
      composeUpArgs?: string[];
    }) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.reroute(
          {
            slug: req.slug,
            composeYaml: req.composeYaml,
            env: req.env,
            mounts: req.mounts,
            composeUpArgs: req.composeUpArgs ?? [],
          },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    renewalCsr() {
      return new Promise<{ csrPem: string }>((resolve, reject) => {
        client.renewalCsr(
          {},
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ csrPem: resp.csrPem }),
        );
      });
    },
    installRenewedCert(req: { certPem: string; caPem: string }) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.installRenewedCert(
          { certPem: req.certPem, caPem: req.caPem },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    exportVolume(volumeName: string) {
      // Server-streaming: the agent tars the volume out as VolumeChunk{data}
      // frames. Bridge to an async generator (like backup) and hand back the raw
      // bytes; the caller relays them into importVolume on the other host.
      return (async function* () {
        const stream = client.exportVolume(
          { volumeName },
          { deadline: new Date(Date.now() + VOLUME_COPY_DEADLINE_MS) },
        );
        for await (const chunk of streamEvents<VolumeChunk>(stream, {
          pauseAbove: STREAM_BYTES_PAUSE_ABOVE,
          normalise: toAgentError,
        })) {
          // Export only ever emits `data` frames; ignore anything else defensively.
          if (chunk.data && chunk.data.length) yield Buffer.from(chunk.data);
        }
      })();
    },
    importVolume(
      volumeName: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      // Client-streaming: header frame first (the only message carrying `header`),
      // then data frames, then end(). ts-proto models the oneof as flat optional
      // fields. The terminal StackResult arrives via the callback.
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        const call: ClientWritableStream<VolumeChunk> = client.importVolume(
          new Metadata(),
          { deadline: new Date(Date.now() + VOLUME_COPY_DEADLINE_MS) },
          (err: ServiceError | null, resp: StackResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
        pumpClientStream<VolumeChunk>(
          call,
          { header: { volumeName, wipeFirst } },
          chunks,
          (data) => ({ data }),
          (e) => reject(toAgentError(e)),
        );
      });
    },
    exportFiles(slug: string) {
      // Server-streaming files-dir tar out — the exact shape of exportVolume, with
      // FilesChunk{data} frames instead of VolumeChunk{data}.
      return (async function* () {
        const stream = client.exportFiles(
          { slug },
          { deadline: new Date(Date.now() + VOLUME_COPY_DEADLINE_MS) },
        );
        for await (const chunk of streamEvents<FilesChunk>(stream, {
          pauseAbove: STREAM_BYTES_PAUSE_ABOVE,
          normalise: toAgentError,
        })) {
          if (chunk.data && chunk.data.length) yield Buffer.from(chunk.data);
        }
      })();
    },
    importFiles(slug: string, wipeFirst: boolean, chunks: AsyncIterable<Buffer>) {
      // Client-streaming files-dir untar in — mirrors importVolume with a slug header.
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        const call: ClientWritableStream<FilesChunk> = client.importFiles(
          new Metadata(),
          { deadline: new Date(Date.now() + VOLUME_COPY_DEADLINE_MS) },
          (err: ServiceError | null, resp: StackResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
        pumpClientStream<FilesChunk>(
          call,
          { header: { slug, wipeFirst } },
          chunks,
          (data) => ({ data }),
          (e) => reject(toAgentError(e)),
        );
      });
    },
    readStack(slug: string) {
      return new Promise<{ exists: boolean; yaml: string }>((resolve, reject) => {
        client.readStack({ slug, removeVolumes: false }, (err, resp) =>
          err
            ? reject(toAgentError(err))
            : resolve({ exists: resp.exists, yaml: resp.yaml }),
        );
      });
    },
    checkPort(port: number) {
      return new Promise<{ available: boolean; reason: string }>((resolve, reject) => {
        client.checkPort(
          { port },
          new Metadata(),
          { deadline: new Date(Date.now() + CHECK_PORT_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ available: resp.available, reason: resp.reason }),
        );
      });
    },
    probeHttp(req: AgentProbeHttpRequest) {
      return new Promise<AgentProbeHttpResult>((resolve, reject) => {
        client.probeHttp(
          {
            projectId: req.appId,
            slug: req.slug,
            service: req.service,
            port: req.port,
            path: req.path,
            host: req.host,
            maxBytes: req.maxBytes,
          },
          new Metadata(),
          { deadline: new Date(Date.now() + PROBE_HTTP_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  status: resp.status,
                  contentType: resp.contentType,
                  body: Buffer.from(resp.body),
                  truncated: resp.truncated,
                  location: resp.location,
                }),
        );
      });
    },
    selfUpdate(
      version: string,
      binaries: Record<string, { url: string; sha256: string }>,
    ) {
      return new Promise<{ version: string; restarting: boolean }>((resolve, reject) => {
        client.selfUpdate(
          { version, binaries },
          new Metadata(),
          { deadline: new Date(Date.now() + SELF_UPDATE_TIMEOUT_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ version: resp.version, restarting: resp.restarting }),
        );
      });
    },
    dockerCleanup(req: DockerCleanupRequest) {
      // The response IS the DTO (per-scope results and all): the caller reads the
      // whole report, so there is nothing to narrow and re-mapping it field by field
      // would only risk dropping a scope the agent did report.
      return new Promise<DockerCleanupResponse>((resolve, reject) => {
        client.dockerCleanup(
          req,
          new Metadata(),
          { deadline: new Date(Date.now() + CLEANUP_DEADLINE_MS) },
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp)),
        );
      });
    },

    // ---- Host ops (hostops) ----
    // All four are plain unary calls whose response IS the DTO, so they share one
    // helper rather than four near-identical Promise wrappers.
    hostInfo(req: HostInfoRequest) {
      return unary<HostInfoRequest, HostInfoResponse>(
        (r, md, opts, cb) => client.hostInfo(r, md, opts, cb),
        req,
        HOSTOPS_DEADLINE_MS,
      );
    },
    setTimezone(req: SetTimezoneRequest) {
      return unary<SetTimezoneRequest, HostInfoResponse>(
        (r, md, opts, cb) => client.setTimezone(r, md, opts, cb),
        req,
        HOSTOPS_DEADLINE_MS,
      );
    },
    traefikConfig(req: TraefikConfigRequest) {
      return unary<TraefikConfigRequest, TraefikConfigResponse>(
        (r, md, opts, cb) => client.traefikConfig(r, md, opts, cb),
        req,
        // A config change pulls an image and recreates the container; the agent
        // caps its own docker call at 180s, so allow for that plus the round trip.
        TRAEFIK_DEADLINE_MS,
      );
    },
    restartControlPlane(req: RestartControlPlaneRequest) {
      return unary<RestartControlPlaneRequest, RestartControlPlaneResponse>(
        (r, md, opts, cb) => client.restartControlPlane(r, md, opts, cb),
        req,
        HOSTOPS_DEADLINE_MS,
      );
    },

    // ---- Backups: dump/restore to S3 + the S3 affordances (ADR-0007) ----
    backup(req: BackupRequest) {
      return streamEvents(
        client.backup(req, { deadline: new Date(Date.now() + BACKUP_DEADLINE_MS) }),
        // BOUNDED, like every other stream that can carry bytes. Under
        // `stream_out` this one IS the artifact: the frames are 1 MiB slices of
        // a relayed backup, and an unbounded queue would hold the whole thing in
        // this process while the destination disk catches up. Harmless for the
        // ordinary log-line shape, where the consumer drains in a tight loop and
        // the bound is never reached.
        { normalise: toAgentError, pauseAbove: STREAM_BYTES_PAUSE_ABOVE },
      );
    },
    restore(req: RestoreRequest) {
      return streamEvents(
        client.restore(req, { deadline: new Date(Date.now() + BACKUP_DEADLINE_MS) }),
        { normalise: toAgentError },
      );
    },
    s3Check(s3: S3Target) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.s3Check(
          { s3 },
          new Metadata(),
          { deadline: new Date(Date.now() + S3_OP_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    s3Delete(s3: S3Target, prefix = false) {
      return new Promise<{ ok: boolean; error: string; deleted: number }>(
        (resolve, reject) => {
          client.s3Delete(
            { s3, prefix },
            new Metadata(),
            { deadline: new Date(Date.now() + S3_OP_DEADLINE_MS) },
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({ ok: resp.ok, error: resp.error, deleted: resp.deleted }),
          );
        },
      );
    },

    // ---- Backup stores: artifacts on a server's disk ----
    storeCheck(store: StoreTarget) {
      return new Promise<{
        ok: boolean;
        error: string;
        freeBytes: number;
        totalBytes: number;
        root: string;
      }>((resolve, reject) => {
        client.s3Check(
          { store },
          new Metadata(),
          { deadline: new Date(Date.now() + S3_OP_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  ok: resp.ok,
                  error: resp.error,
                  freeBytes: resp.freeBytes,
                  totalBytes: resp.totalBytes,
                  root: resp.root,
                }),
        );
      });
    },
    storeDelete(store: StoreTarget, prefix = false) {
      return new Promise<{ ok: boolean; error: string; deleted: number }>(
        (resolve, reject) => {
          client.s3Delete(
            { store, prefix },
            new Metadata(),
            { deadline: new Date(Date.now() + S3_OP_DEADLINE_MS) },
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({ ok: resp.ok, error: resp.error, deleted: resp.deleted }),
          );
        },
      );
    },
    readStoreFile(
      target: { store?: StoreTarget; s3?: S3Target },
      ageIdentity = "",
      expectedSha256 = "",
    ) {
      // Server-streaming bytes: same shape as exportVolume, same backpressure —
      // an artifact is exactly the kind of stream an unbounded queue turns into
      // an OOM.
      return (async function* () {
        const stream = client.readStoreFile(
          { ...target, ageIdentity, expectedSha256 },
          { deadline: new Date(Date.now() + BACKUP_DEADLINE_MS) },
        );
        for await (const chunk of streamEvents<StoreChunk>(stream, {
          pauseAbove: STREAM_BYTES_PAUSE_ABOVE,
          normalise: toAgentError,
        })) {
          if (chunk.data && chunk.data.length) yield Buffer.from(chunk.data);
        }
      })();
    },
    writeStoreFile(
      store: StoreTarget,
      overwrite: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      // Client-streaming, modelled on importVolume: header frame first, then data
      // frames, honouring write backpressure so a slow destination disk cannot
      // make the relay buffer the whole artifact here.
      return new Promise<{
        ok: boolean;
        error: string;
        bytesWritten: number;
        sha256: string;
      }>((resolve, reject) => {
        const call: ClientWritableStream<StoreChunk> = client.writeStoreFile(
          new Metadata(),
          { deadline: new Date(Date.now() + BACKUP_DEADLINE_MS) },
          (err: ServiceError | null, resp: StoreResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  ok: resp.ok,
                  error: resp.error,
                  bytesWritten: resp.bytesWritten,
                  sha256: resp.sha256,
                }),
        );
        pumpClientStream<StoreChunk>(
          call,
          { header: { store, overwrite } },
          chunks,
          (data) => ({ data }),
          // Normalised like every other rejection here, so a transport drop
          // mid-relay surfaces as AgentUnreachableError rather than a raw
          // ServiceError the data layer would not recognise.
          (e) => reject(toAgentError(e)),
        );
      });
    },
    restoreFrom(header: RestoreChunk_Header, chunks: AsyncIterable<Buffer>) {
      // The only BIDI call in the client: bytes go up while progress comes down.
      const call = client.restoreFrom({
        deadline: new Date(Date.now() + BACKUP_DEADLINE_MS),
      });
      pumpClientStream<RestoreChunk>(
        call,
        { header },
        chunks,
        (data) => ({ data }),
        // A write-side failure surfaces on the read side too (the agent sees the
        // stream break and ends), so it needs no separate rejection path here.
        () => {},
      );
      return streamEvents<RestoreEvent>(call, { normalise: toAgentError });
    },

    // ---- Part C: console observability ----
    inspect(slug: string) {
      return new Promise<{ exists: boolean; running: boolean; state: string }>(
        (resolve, reject) => {
          client.inspect(
            { slug },
            new Metadata(),
            consoleDeadline(),
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({
                    exists: resp.exists,
                    running: resp.running,
                    state: resp.state,
                  }),
          );
        },
      );
    },
    followLogs(appId: string, container: string, tail: number) {
      return logsHandle(
        client.followLogs(
          { projectId: appId, container, tail },
          { deadline: new Date(Date.now() + STREAM_DEADLINE_MS) },
        ),
      );
    },
    attach(
      appId: string,
      container: string,
      tty: boolean,
      cols: number,
      rows: number,
    ) {
      const stream = client.attach({
        deadline: new Date(Date.now() + STREAM_DEADLINE_MS),
      });
      // The agent requires AttachOpen as the FIRST frame.
      stream.write({ open: { projectId: appId, container, tty, cols, rows } });
      return attachHandle(stream);
    },
    listInstances(appId: string, slug: string, exposeService: string) {
      return new Promise<AgentConsoleInstance[]>((resolve, reject) => {
        client.listInstances(
          { projectId: appId, slug, exposeService },
          new Metadata(),
          consoleDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.instances.map(mapInstance)),
        );
      });
    },
    exec(appId: string, container: string, command: string, image: string) {
      return new Promise<AgentExecResult>((resolve, reject) => {
        client.exec(
          { projectId: appId, container, command, image },
          new Metadata(),
          consoleDeadline(),
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  stdout: resp.stdout,
                  stderr: resp.stderr,
                  code: resp.code,
                  rawMode: resp.rawMode,
                }),
        );
      });
    },
    startJob(req: AgentStartJobRequest) {
      return new Promise<string>((resolve, reject) => {
        client.startJob(
          req,
          new Metadata(),
          { deadline: new Date(Date.now() + CRON_START_TIMEOUT_MS) },
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp.jobId)),
        );
      });
    },
    pollJob(jobId: string) {
      return new Promise<AgentJobStatus>((resolve, reject) => {
        client.pollJob(
          { jobId },
          new Metadata(),
          { deadline: new Date(Date.now() + CRON_POLL_TIMEOUT_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  found: resp.found,
                  running: resp.running,
                  exitCode: resp.exitCode,
                  stdout: resp.stdout,
                  stderr: resp.stderr,
                  timedOut: resp.timedOut,
                }),
        );
      });
    },
    killJob(jobId: string) {
      return new Promise<boolean>((resolve, reject) => {
        client.killJob(
          { jobId },
          new Metadata(),
          { deadline: new Date(Date.now() + CRON_POLL_TIMEOUT_MS) },
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp.found)),
        );
      });
    },
    shellLabel(appId: string, container: string, image: string) {
      return new Promise<string>((resolve, reject) => {
        client.shellLabel(
          { projectId: appId, container, image },
          new Metadata(),
          consoleDeadline(),
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp.label)),
        );
      });
    },

    // ---- Part C: project config files ----
    listFiles(slug: string, path: string) {
      return new Promise<AgentFileEntry[]>((resolve, reject) => {
        client.listFiles({ slug, path }, new Metadata(), filesDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve(resp.entries.map(mapEntry)),
        );
      });
    },
    readFile(slug: string, path: string) {
      return new Promise<AgentFileContent>((resolve, reject) => {
        client.readFile({ slug, path }, new Metadata(), filesDeadline(), (err, resp) =>
          err
            ? reject(toAgentError(err))
            : resolve({
                path: resp.path,
                text: resp.reason ? null : resp.text,
                size: Number(resp.size),
                reason: (resp.reason || null) as AgentFileContent["reason"],
              }),
        );
      });
    },
    writeFile(slug: string, path: string, content: string) {
      return new Promise<AgentFileEntry>((resolve, reject) => {
        client.writeFile({ slug, path, content }, new Metadata(), filesDeadline(), (err, resp) =>
          err || !resp.entry ? reject(toAgentError(err ?? new Error("no entry"))) : resolve(mapEntry(resp.entry)),
        );
      });
    },
    uploadFile(slug: string, path: string, data: Buffer) {
      return new Promise<AgentFileEntry>((resolve, reject) => {
        client.uploadFile({ slug, path, data }, new Metadata(), filesDeadline(), (err, resp) =>
          err || !resp.entry ? reject(toAgentError(err ?? new Error("no entry"))) : resolve(mapEntry(resp.entry)),
        );
      });
    },
    createDir(slug: string, path: string) {
      return new Promise<AgentFileEntry>((resolve, reject) => {
        client.createDir({ slug, path }, new Metadata(), filesDeadline(), (err, resp) =>
          err || !resp.entry ? reject(toAgentError(err ?? new Error("no entry"))) : resolve(mapEntry(resp.entry)),
        );
      });
    },
    deleteFile(slug: string, path: string) {
      return new Promise<boolean>((resolve, reject) => {
        client.deleteFile({ slug, path }, new Metadata(), filesDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve(resp.ok),
        );
      });
    },
    renameFile(slug: string, path: string, newPath: string) {
      return new Promise<AgentFileEntry>((resolve, reject) => {
        client.renameFile({ slug, path, newPath }, new Metadata(), filesDeadline(), (err, resp) =>
          err || !resp.entry ? reject(toAgentError(err ?? new Error("no entry"))) : resolve(mapEntry(resp.entry)),
        );
      });
    },
    filesExist(slug: string) {
      return new Promise<boolean>((resolve, reject) => {
        client.filesExist({ slug }, new Metadata(), filesDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve(resp.exists),
        );
      });
    },

    close() {
      client.close();
    },
  };
}

/**
 * Open a connection to the agent owning `serverId`. The caller must `close()` it.
 * Throws if the agent is unreachable/unavailable (caller falls back).
 */
export async function connectAgent(serverId: string): Promise<AgentConnection> {
  const target = await resolveTarget(serverId);
  return dial(target);
}

/** The capability an agent advertises in Hello once it can dump/restore to S3
 *  (mirrors the "backup" entry in the agent's server.Capabilities). */
const BACKUP_CAPABILITY = "backup";
/**
 * Holding artifacts on THIS host's disk (the StoreTarget arms plus
 * ReadStoreFile / WriteStoreFile / RestoreFrom). Split from `"backup"` because
 * the two shipped in different agent releases: a fleet mid-rollout has agents
 * that can dump to S3 but not store, and telling that operator "backups are
 * unsupported" would send them looking in the wrong place.
 */
const BACKUP_STORE_CAPABILITY = "backup-store";

/**
 * The agent honours `age_recipient` for a BUCKET artifact (and reports a sha256
 * for the upload). Without it the field is silently ignored, the archive - which
 * carries the app's whole decrypted env - lands in the bucket in the clear, and
 * the run records a `.age` key for a file that is not encrypted. That downgrade
 * is invisible, so an encrypted destination refuses to run on an agent lacking
 * this rather than quietly writing plaintext.
 */
const BACKUP_ENCRYPT_S3_CAPABILITY = "backup-encrypt-s3";

/**
 * The agent reads `S3Target.extra_args` — a destination's advanced quirk flags
 * reach its minio client instead of being ignored.
 *
 * A SOFT gate, unlike the encryption one above, and the difference is what is at
 * stake: an agent that ignores the age recipient writes a decrypted archive into
 * somebody's bucket, so that one refuses to run. An agent that ignores
 * `--s3-force-path-style` just talks to the store the way it always did — the
 * backup either works anyway or fails loudly at the gateway. Refusing there
 * would take backups away from a whole fleet mid-rollout over a workaround.
 */
const BACKUP_S3_ARGS_CAPABILITY = "backup-s3-args";

/**
 * `ReadStoreFile` accepts an S3Target, so an artifact in a BUCKET can be streamed
 * back out decrypted - which is the whole of the Download button for a bucket
 * destination.
 *
 * A HARD gate. Without it there is no RPC to call at all, and the honest answer
 * is "update the agent on this server": a download that silently does not happen,
 * or hands back a file nobody decrypted, is worse than one that says why.
 */
const BACKUP_S3_READ_CAPABILITY = "backup-s3-read";

/**
 * `RestoreFrom` honours `untrusted_config`: an artifact that came from OUTSIDE
 * the fleet contributes data only, never the compose/env/mounts the stack comes
 * back up with.
 *
 * A HARD gate, and it has to be. An agent without this ignores the field, and
 * ignoring it restores precisely what the flag exists to prevent: with no digest
 * to prove an uploaded archive, the agent falls back to ITS config whenever the
 * control plane sends none, which is root on that host for whoever uploaded the
 * file. A silently-ignored security flag is worse than a refused restore.
 */
const BACKUP_UNTRUSTED_CONFIG_CAPABILITY = "backup-untrusted-config";

/** The capability an agent advertises once it can run cron jobs
 *  (StartJob/PollJob/KillJob - ADR-0018). */
export const CRON_CAPABILITY = "cron";

/**
 * The reachable agent does not (yet) implement the cron RPCs - it predates the
 * `"cron"` capability, or answers them with gRPC UNIMPLEMENTED.
 *
 * There is deliberately NO fallback path. Emulating a long job over the 30s
 * `Exec` would mean backgrounding the command with `nohup` and polling a marker
 * file, which needs a shell, a writable `/tmp` and PID bookkeeping inside every
 * user's container - more code than the RPCs, and fragile in ways the user would
 * discover at 03:00. An old agent gets an honest "update this server's agent"
 * instead. Mirrors {@link AgentBackupUnsupportedError}.
 */
export class AgentCronUnsupportedError extends Error {}

const CRON_UNSUPPORTED_MESSAGE =
  "This server's agent is too old to run cron jobs. Update the agent on this server, then try again.";

/**
 * Open a connection to an agent that can run cron jobs, or throw.
 *
 * Preflights the capability rather than relying on UNIMPLEMENTED alone, because
 * the scheduler decides what to do about a whole server before it starts firing
 * its jobs - one Hello beats one failed StartJob per job.
 *
 * Throws {@link AgentUnreachableError} when the host is unreachable and
 * {@link AgentCronUnsupportedError} when it is up but too old. The scheduler
 * treats those very differently: unreachable means "leave the run alone and ask
 * again next minute", too-old means "this attempt failed, say why".
 */
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

/**
 * Map a cron RPC error to {@link AgentCronUnsupportedError} when it is a gRPC
 * UNIMPLEMENTED, passing everything else through unchanged. The belt-and-braces
 * behind {@link connectCronAgent}'s preflight, for an agent that advertises the
 * capability but cannot actually serve the call. Idempotent.
 */
export function mapCronUnsupported(e: unknown): Error {
  if (e instanceof AgentCronUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCronUnsupportedError(CRON_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** The capability an agent advertises once it can serve per-container
 *  `docker stats` (ContainerStats) — the per-app/per-database Monitoring tab.
 *  Mirrors BACKUP_CAPABILITY; the primary gate is the RPC's UNIMPLEMENTED, so
 *  there is no dedicated connect* preflight for this one — it is the fallback
 *  path, reached only for a server whose agent lacks METRICS_STREAM_CAPABILITY. */
export const CONTAINER_STATS_CAPABILITY = "container-stats";

/** The capability an agent advertises once it can serve the long-lived
 *  {@link AgentConnection.streamMetrics} telemetry stream. Unlike container-stats
 *  this one IS preflighted at connect time ({@link connectMetricsStreamAgent}),
 *  because the answer selects between two entirely different collection
 *  strategies for that host — and Hello already tells us, so discovering it from
 *  a failed RPC would mean opening a stream in order to learn we cannot. */
export const METRICS_STREAM_CAPABILITY = "metrics-stream";

/**
 * Open a connection for the telemetry stream, preflighting the capability.
 *
 * Returns the LIVE connection (the caller owns closing it) together with the
 * opening Hello, because the supervisor needs that Hello anyway: it is where
 * `agentVersion` / `traefikRunning` / `dockerVersion` come from for the
 * once-per-connection `markServerSeen`, and it is a health OBSERVATION carrying
 * the `trust` flag on a certificate failure — the signal the old metrics poll
 * structurally could not produce, because it issued `metrics()` first and a
 * cert-pin rejection there arrives without it.
 *
 * Throws {@link AgentMetricsStreamUnsupportedError} when the agent is too old,
 * which the supervisor reads as "poll this one" rather than as a failure.
 */
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

/**
 * Map a {@link AgentConnection.containerStats} error to
 * {@link AgentContainerStatsUnsupportedError} when it is a gRPC UNIMPLEMENTED (an
 * agent too old to serve the RPC), passing every other error through unchanged.
 * The data layer wraps its `conn.containerStats(...)` call with this so the
 * Monitoring tab can show "update the agent" instead of an opaque failure.
 * Idempotent on an already-mapped error. Mirrors {@link mapBackupUnsupported}.
 */
export function mapContainerStatsUnsupported(e: unknown): Error {
  if (e instanceof AgentContainerStatsUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentContainerStatsUnsupportedError(
      `The agent on this server is too old to report per-container metrics. ` +
        `Update the agent on this server, then try again.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Open a connection to the agent owning `serverId` AND preflight that it can do
 * backups — the entry point every real backup/restore path uses (Step 3). It
 * dials, confirms the agent answers Hello, and checks the `"backup"` capability;
 * if the agent is too old (no capability), it closes the connection and throws
 * {@link AgentBackupUnsupportedError} so the caller surfaces "update the agent"
 * rather than a fake success — exactly the contract gate the PLAN locked. On
 * success the LIVE connection is returned (caller must `close()` it). Mirrors
 * the self-update preflight ({@link selfUpdateServerAgent}).
 *
 * The capability check is the PRIMARY gate and catches the common case here. But
 * the actual backup/restore/s3* RPCs run AFTER this returns (on the live
 * connection), so a just-old-enough agent that advertises `"backup"` yet rejects
 * an RPC with gRPC UNIMPLEMENTED wouldn't be caught here — the data layer (Step 3)
 * must wrap those RPC calls with {@link mapBackupUnsupported} to get the same
 * actionable error.
 *
 * Throws:
 *  - {@link AgentUnreachableError} when the server is unknown / not provisioned /
 *    offline (the data layer surfaces "not provisioned / unreachable").
 *  - {@link AgentBackupUnsupportedError} when the reachable agent doesn't
 *    advertise `"backup"` — the UI tells the operator to update the agent.
 */
export async function connectBackupAgent(
  serverId: string,
  /** Also require `"backup-store"` — set when the artifact lives on THIS host's
   *  disk. Split from the base check so an agent that can dump to S3 but cannot
   *  hold artifacts fails the SECOND thing with a message that names it. */
  opts: {
    store?: boolean;
    encryptedS3?: boolean;
    /** This destination carries advanced S3 flags — warn if they will be
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
    // writes the artifact - the app's entire decrypted env included - to the
    // bucket in plaintext, under a key whose `.age` suffix says otherwise. A
    // backup that is quietly not encrypted is worse than one that did not run.
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
    if (opts.s3Read && !hello.capabilities?.includes(BACKUP_S3_READ_CAPABILITY)) {
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
    // Said out loud, not swallowed: the flags exist because a store misbehaves
    // without them, so an operator whose backup is failing needs to know this
    // host is not applying them. It is a log line rather than an error because
    // taking backups away is the worse outcome of the two.
    if (
      opts.s3Args &&
      !hello.capabilities?.includes(BACKUP_S3_ARGS_CAPABILITY)
    ) {
      console.warn(
        `[backups] the agent on server ${serverId} is too old to apply this ` +
          `destination's advanced S3 flags — it is talking to the bucket ` +
          `without them. Update the agent on this server to apply them.`,
      );
    }
  } catch (e) {
    conn.close();
    throw mapBackupUnsupported(e);
  }
  return conn;
}

/**
 * Map a backup/restore/s3* RPC error to {@link AgentBackupUnsupportedError} when
 * it is a gRPC UNIMPLEMENTED (an agent that advertised `"backup"` but is too old
 * to actually serve the RPC), passing every other error through unchanged. The
 * data layer (Step 3) wraps each `conn.backup()/restore()/s3Check()/s3Delete()`
 * call with this — `connectBackupAgent`'s capability preflight is the primary
 * gate, this is the backstop for the RPC itself. Idempotent on an already-mapped
 * error.
 */
export function mapBackupUnsupported(e: unknown): Error {
  if (e instanceof AgentBackupUnsupportedError) return e;
  if (e instanceof AgentBackupStoreUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentBackupUnsupportedError(
      `The agent on this server is too old to run backups. ` +
        `Update the agent on this server, then try again.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Mandatory pre-flight (PLAN P5): confirm the agent answers Hello before a
 * deploy, with a contract-version check. Returns the HelloResponse or throws a
 * clear "server unreachable" error — never hangs. Also refreshes the server's
 * lastSeenAt cache (P5) on success for the chosen server.
 */
export async function agentPreflight(serverId: string): Promise<HelloResponse> {
  const conn = await connectAgent(serverId);
  try {
    const resp = await conn.hello();
    if (resp.contractVersion !== ContractVersion.CONTRACT_VERSION_V1) {
      throw new Error(
        `agent speaks contract ${resp.contractVersion}, control plane speaks V1`,
      );
    }
    // Heartbeat cache (P5): best-effort, behind the live-read. Also refresh the
    // server's traefikEnabled from this live Hello so the badge reflects reality.
    try {
      void markServerSeen(serverId, resp.agentVersion, observedTraefik(resp));
    } catch {
      /* unknown id: no row to touch */
    }
    return resp;
  } finally {
    conn.close();
  }
}

/*
 * There is deliberately NO teardownServerAgent here.
 *
 * There used to be: removeServer called it, and the UI told the operator it
 * "tells the agent to tear down its containers". It did nothing of the sort — it
 * sent a single Hello and closed the connection. The honest reading is that no
 * such function CAN exist: removeServer blocks while any App or database is still
 * on the host, so there is no stack left for the control plane to even name; and
 * everything that genuinely survives a removal (the agent binary, its systemd
 * unit, /var/lib/deplo-agent, deplo-traefik on :80/:443, the `deplo` network,
 * Docker itself) has no RPC behind it in the V1 contract. Removal also revokes the
 * pinned cert, which is exactly the moment we lose the right to dial that agent.
 *
 * The host cleanup is therefore host-side: `uninstall-agent.sh`, whose one-liner
 * removeServer returns (see lib/agent/bootstrap.ts `uninstallCommand`). If a
 * future agent ever grows a real host-teardown RPC, gate it on a Hello capability
 * the way SELF_UPDATE_CAPABILITY / BACKUP_CAPABILITY are gated below — do not
 * bring back a function whose name promises more than it does.
 */

/** The capability an agent advertises in Hello once it can self-update (mirrors
 *  the "self-update" entry in the agent's server.Capabilities). */
const SELF_UPDATE_CAPABILITY = "self-update";

/**
 * Update a server's agent binary IN PLACE to the latest release, WITHOUT
 * reissuing its certificates. We dial the agent over its existing pinned-mTLS
 * channel (`resolveTarget` proves it is provisioned + reachable, and the dial
 * reuses the cert fingerprint recorded at bootstrap) and ask it to self-update:
 * it fetches the checksum-verified binary for its own arch from GitHub Releases,
 * swaps itself on disk, and re-execs keeping the SAME on-disk `agent.crt` /
 * `agent.key` / `ca.crt`. Trust is untouched — no new CSR, no re-bootstrap, no
 * token — so the server stays "online" with the same pinned fingerprint across
 * the upgrade. This is the whole point of doing it over the agent channel rather
 * than re-running install-agent.sh (which clears materials and re-bootstraps).
 *
 * The control plane resolves the release and sends EVERY published per-arch asset
 * (url + sha256 from the release's checksums.txt — the same integrity source the
 * installer pins); the agent selects its own arch. We do NOT pass the target
 * version in from the caller's idea of "latest" only — we re-resolve here so the
 * url/sha/version are internally consistent (one release).
 *
 * Throws:
 *  - {@link AgentUnreachableError} when the server is unknown / not provisioned /
 *    offline (the data layer surfaces "not provisioned / unreachable").
 *  - {@link AgentUpdateUnsupportedError} when the reachable agent is too OLD to
 *    self-update (it doesn't advertise the `self-update` capability, or it returns
 *    gRPC UNIMPLEMENTED) — the UI tells the operator to re-run the installer.
 *  - a plain error when no agent release can be resolved (GitHub unreachable), so
 *    we never tell the agent to update to nothing.
 */
export async function selfUpdateServerAgent(
  serverId: string,
): Promise<{ version: string; restarting: boolean }> {
  // Resolves only for a provisioned server with un-revoked trust; throws
  // AgentUnreachableError otherwise.
  const target = await resolveTarget(serverId);

  // Resolve the release to install (version + per-arch url/sha). Out here so a
  // GitHub outage fails before we touch the agent, and so version/urls are one
  // consistent release. Lazy import keeps release.ts (and its server-only fetch)
  // out of modules that never update an agent.
  const { resolveLatestAgentRelease } = await import("../agent/release");
  const release = await resolveLatestAgentRelease();
  if (!release) {
    throw new Error(
      "Could not resolve the latest agent release from GitHub — try again, or use Check for updates.",
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
    // Pre-flight: confirm the agent answers AND can self-update. An agent too old
    // to know the RPC won't advertise the capability — reject distinctly so the UI
    // says "re-run the installer" rather than emitting a confusing UNIMPLEMENTED.
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(SELF_UPDATE_CAPABILITY)) {
      throw new AgentUpdateUnsupportedError(
        `The agent on this server is too old to update itself remotely ` +
          `(target v${release.version}). Re-run the install command to upgrade it.`,
      );
    }
    return await conn.selfUpdate(release.version, binaries);
  } catch (e) {
    // Belt-and-braces: a just-old-enough agent that advertises nothing useful, or
    // a version skew, may still answer the call with UNIMPLEMENTED — map it to the
    // same actionable message rather than a raw gRPC error.
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

/** The capability an agent advertises in Hello once it can reclaim Docker disk
 *  (mirrors the "docker-cleanup" entry in the agent's server.Capabilities).
 *  Exported so the readiness report can name the gap before anyone clicks. */
export const DOCKER_CLEANUP_CAPABILITY = "docker-cleanup";

/**
 * Reclaim Docker disk on `serverId`'s host: dial → Hello → capability pre-flight →
 * DockerCleanup → close, all in one self-contained op. Shaped like
 * {@link selfUpdateServerAgent} rather than {@link connectBackupAgent} because a
 * cleanup is a single unary RPC — there is no live connection left for the caller to
 * hold, so the caller never has to remember to close one.
 *
 * This is a HOST-level RPC, and the note above {@link selfUpdateServerAgent} says any
 * such RPC must be gated on a Hello capability the way SELF_UPDATE / BACKUP are. Here
 * the gate is load-bearing beyond mere ergonomics: an agent that does not advertise
 * `"docker-cleanup"` is never asked, and the failure it produces is
 * {@link AgentCleanupUnsupportedError} — "update the agent on this server" — never an
 * ok response with zero bytes reclaimed. A cleanup is only ever trusted, never
 * watched; the operator has no way to tell a sweep that quietly did nothing from one
 * that worked, so the ONE thing this function must not do is fake a success.
 *
 * `req.dryRun` picks the preview or the real sweep — the same RPC, the same deadline,
 * the same enumeration either way; under `dryRun` the agent removes nothing. The
 * safety of what gets removed is agent-side and allow-listed (never `system prune` /
 * `container prune` / `volume prune` / `network prune`): the control plane owns the
 * scope SET, not the deletion logic.
 *
 * Throws:
 *  - {@link AgentUnreachableError} when the server is unknown / not provisioned /
 *    offline. The caller writes the failed run — history never lies about a sweep it
 *    could not even start.
 *  - {@link AgentCleanupUnsupportedError} when the reachable agent is too old, whether
 *    that shows up in Hello or as UNIMPLEMENTED on the call itself.
 */
export async function runAgentCleanup(
  serverId: string,
  req: DockerCleanupRequest,
): Promise<DockerCleanupResponse> {
  // Resolves only for a provisioned server with un-revoked trust; throws
  // AgentUnreachableError otherwise.
  const target = await resolveTarget(serverId);

  const conn = dial(target);
  try {
    // Pre-flight: the agent must SAY it can clean up before we ask it to. An agent
    // too old to know the RPC won't advertise the capability.
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(DOCKER_CLEANUP_CAPABILITY)) {
      throw new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
    }
    return await conn.dockerCleanup(req);
  } catch (e) {
    // Belt-and-braces: an agent one version behind on the RPC can advertise the
    // capability and still answer UNIMPLEMENTED. mapCleanupUnsupported turns that
    // into the same actionable error, passes every other failure (an unreachable
    // host, a docker error the agent reported) through untouched, and is idempotent
    // on the pre-flight throw above.
    throw mapCleanupUnsupported(e);
  } finally {
    conn.close();
  }
}

/* ------------------------------------------------------------------ */
/* Host ops (hostops)                                                  */
/* ------------------------------------------------------------------ */

/** The Hello capability gating the four host-level RPCs. */
const HOSTOPS_CAPABILITY = "hostops";

/**
 * The reachable agent is too old for the host-ops RPCs — it cannot report what
 * the hardware is, move the clock, restart Traefik or restart the panel.
 *
 * A distinct error rather than a generic failure because the fix is specific and
 * the operator can do it from the same page: update the agent. Mirrors
 * {@link AgentCleanupUnsupportedError}.
 */
export class AgentHostOpsUnsupportedError extends Error {}

/** One message wherever the gap surfaces — the Hello pre-flight or UNIMPLEMENTED
 *  on the call itself — so the two paths cannot tell two different stories. */
const HOSTOPS_UNSUPPORTED_MESSAGE =
  "The agent on this server is too old for host management. " +
  "Update the agent on this server, then try again.";

/** UNIMPLEMENTED from a host-ops call means the same thing as a missing
 *  capability: an agent one version behind can advertise it and still not
 *  implement the RPC. Every other error passes through untouched. */
function mapHostOpsUnsupported(e: unknown): Error {
  if (e instanceof AgentHostOpsUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentHostOpsUnsupportedError(HOSTOPS_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Run one host-ops call against a server: resolve the pinned target, pre-flight
 * the capability via Hello, invoke, and always close the channel.
 *
 * Every host-ops entry point below is this plus a one-line body, so the
 * capability gate cannot be forgotten on a future fifth verb — the mistake that
 * would show up as a confusing UNIMPLEMENTED instead of "update the agent".
 */
async function withHostOps<T>(
  serverId: string,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  const target = await resolveTarget(serverId);
  const conn = dial(target);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(HOSTOPS_CAPABILITY)) {
      throw new AgentHostOpsUnsupportedError(HOSTOPS_UNSUPPORTED_MESSAGE);
    }
    return await fn(conn);
  } catch (e) {
    throw mapHostOpsUnsupported(e);
  } finally {
    conn.close();
  }
}

/** What this host IS: CPU model, distro, kernel, clock, Docker root dir, plus the
 *  deplo-traefik stack file and whether `controlPlaneHint` names a live container. */
export function fetchHostInfo(
  serverId: string,
  opts: { dataDir?: string; controlPlaneHint?: string } = {},
): Promise<HostInfoResponse> {
  return withHostOps(serverId, (conn) =>
    conn.hostInfo({
      dataDir: opts.dataDir ?? "",
      controlPlaneHint: opts.controlPlaneHint ?? "",
    }),
  );
}

/** Move the host clock to an IANA zone, answering with a fresh reading of it. */
export function setHostTimezone(
  serverId: string,
  timezone: string,
  opts: { dataDir?: string; controlPlaneHint?: string } = {},
): Promise<HostInfoResponse> {
  return withHostOps(serverId, (conn) =>
    conn.setTimezone({
      timezone,
      dataDir: opts.dataDir ?? "",
      controlPlaneHint: opts.controlPlaneHint ?? "",
    }),
  );
}

/**
 * Restart the host's Traefik, or rewrite its stack and recreate it.
 *
 * `composeYaml` is rendered by lib/deploy/traefik-stack.ts and applied verbatim
 * (ADR-0006). A refusal — a host running a Traefik Deplo did not install — comes
 * back as `ok:false` with a reason, not as a thrown error: it is an answer about
 * the host, not a failure to reach it.
 */
/**
 * Serialise stack rewrites for ONE host.
 *
 * Every writer here reads the host's whole stack file, edits it, and writes the
 * whole thing back: the certificates tab, the ACME account email and the Traefik
 * dashboard toggle all do. Two of them interleaving means the second read misses
 * the first write and puts it back the way it was - a certificate that reports
 * itself installed and is not on the host. There is no compare-and-swap to lean
 * on (the agent takes the file it is given), so the read and the write are held
 * together instead.
 *
 * In-process, which is the whole of it today: one control plane owns the fleet.
 * A second instance writing the same host would need a lock the database holds.
 */
const stackWrites = new Map<string, Promise<unknown>>();

export function withTraefikStackLock<T>(
  serverId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queued = (stackWrites.get(serverId) ?? Promise.resolve()).then(fn, fn);
  // Swallowed on the CHAIN only: the next writer must run whether or not this one
  // failed, while the caller still sees its own rejection.
  stackWrites.set(
    serverId,
    queued.catch(() => {}),
  );
  return queued;
}

export function applyTraefikConfig(
  serverId: string,
  req: { composeYaml?: string; restartOnly?: boolean },
): Promise<TraefikConfigResponse> {
  return withHostOps(serverId, (conn) =>
    conn.traefikConfig({
      composeYaml: req.composeYaml ?? "",
      restartOnly: req.restartOnly ?? false,
    }),
  );
}

/**
 * Bounce the container the Deplo panel runs in on this host.
 *
 * `ok:true` means SCHEDULED: the restart kills the process waiting on the reply,
 * so the agent answers first and restarts a moment later. The caller identifies
 * itself with `controlPlaneHint` — its own hostname, which inside a container is
 * the short container id.
 */
export function restartControlPlaneOn(
  serverId: string,
  controlPlaneHint: string,
): Promise<RestartControlPlaneResponse> {
  return withHostOps(serverId, (conn) => conn.restartControlPlane({ controlPlaneHint }));
}
