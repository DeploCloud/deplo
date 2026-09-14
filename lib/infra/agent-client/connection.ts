import "server-only";

// https://deplo.build/docs/concepts/servers-and-the-agent

import type {
  HelloResponse,
  HostMetrics,
  ContainerStat,
  MetricsStreamRequest,
  MetricsSample,
  DeployRequest,
  DeployEvent,
  ReattachRequest,
  BackupRequest,
  BackupEvent,
  RestoreRequest,
  RestoreEvent,
  S3Target,
  StoreTarget,
  RestoreChunk_Header,
  DockerCleanupRequest,
  DockerCleanupResponse,
  HostInfoRequest,
  HostInfoResponse,
  SetTimezoneRequest,
  TraefikConfigRequest,
  TraefikConfigResponse,
  RestartControlPlaneRequest,
  RestartControlPlaneResponse,
  UpdateControlPlaneRequest,
  UpdateControlPlaneResponse,
} from "../../agent/gen/agent";
export type {
  HostInfoResponse,
  TraefikConfigResponse,
  RestartControlPlaneResponse,
  UpdateControlPlaneResponse,
} from "../../agent/gen/agent";
import type { AttachHandle } from "../docker";

/** What to ask an app's own container for, never an address (see `probeHttp`). */
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

/** Plain structural shapes the agent returns - mapped 1:1 by the data layer. */
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
  /** Raw docker state. EMPTY from an agent older than the field, and a bool cannot
   *  tell a crash loop from a clean stop: treat "" as unknown, never as a state. */
  state: string;
  /** "healthy" | "unhealthy" | "starting", or "" when the image has no
   *  healthcheck (which is NOT the same as healthy). */
  health: string;
  /** How many times docker has restarted this container. */
  restartCount: number;
  /** Epoch seconds. 0 = never started, or an agent older than the field - both
   *  mean "no uptime", never 1970. */
  startedAtUnix: number;
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

/** What an import's sanitizer threw away, as the agent reported it. */
export interface DroppedEntries {
  /** Links whose target leaves the archive. */
  links: number;
  /** Devices, sockets and fifos. */
  special: number;
  /** The first few names, for a message that can be concrete. */
  names: string[];
}

/** The window for `followLogs`, in Unix SECONDS; 0 or omitted on either end is
 *  unset: no lower bound, follow live forever. */
export interface FollowLogsOptions {
  sinceUnix?: number;
  untilUnix?: number;
  /** Prefix each line with its RFC3339Nano write time. */
  timestamps?: boolean;
}

/** A live, mTLS-secured connection to one agent, with a typed wrapper. */
export interface AgentConnection {
  /** The reachability + capability handshake. */
  hello(timeoutMs?: number): Promise<HelloResponse>;
  metrics(dataDir?: string): Promise<HostMetrics>;
  /** Live per-container resource usage for one project's containers. */
  containerStats(
    projectId: string,
    containers: string[],
  ): Promise<ContainerStat[]>;
  /** ONE long-lived stream carrying this host's metrics AND every Deplo-managed
   *  container's stats, sampled on the AGENT's ticker rather than pulled per
   *  viewer per resource. */
  streamMetrics(
    req: MetricsStreamRequest,
  ): AsyncGenerator<MetricsSample, void, unknown>;
  deploy(req: DeployRequest): AsyncGenerator<DeployEvent, void, unknown>;
  /** Reconnect to an in-flight deploy and replay missed events. */
  reattach(req: ReattachRequest): AsyncGenerator<DeployEvent, void, unknown>;
  stopStack(slug: string): Promise<{ ok: boolean; error: string }>;
  startStack(slug: string): Promise<{ ok: boolean; error: string }>;
  destroyStack(
    slug: string,
    removeVolumes?: boolean,
    reclaimVolumes?: string[],
  ): Promise<{ ok: boolean; error: string }>;
  /** Re-apply routing to a running stack WITHOUT a rebuild: the control plane
   *  re-renders the stack YAML (+ env + compose mounts) and the agent writes it
   *  and `compose up`s in place. */
  reroute(req: {
    slug: string;
    composeYaml: string;
    env: Record<string, string>;
    mounts: { path: string; content: string }[];
    /** The stack's own Docker network - the agent creates it and puts Traefik on
     *  it before bringing the stack up. See `lib/deploy/network.ts`. */
    network: string;
    /** The app's extra `compose up` flags (already split into argv tokens); an
     *  agent without "deploy.compose-args" ignores them. */
    composeUpArgs?: string[];
  }): Promise<{ ok: boolean; error: string }>;
  /** Cert renewal, step 1: a fresh CSR whose private key never leaves the host.
   *  Gated on the "cert-renewal" capability; a too-old agent rejects with
   *  UNIMPLEMENTED. */
  renewalCsr(): Promise<{ csrPem: string }>;
  /** Cert renewal, step 2: the CA-signed leaf from its last CSR, hot-swapped
   *  without a restart. `caPem` empty ⇒ the CA is unchanged (leaf-only rotate). */
  installRenewedCert(req: {
    certPem: string;
    caPem: string;
  }): Promise<{ ok: boolean; error: string }>;
  /** Stream a named Docker volume's gzipped tar OUT of this (source) host. The
   *  caller must have QUIESCED the source first so the files can't change. */
  exportVolume(volumeName: string): AsyncGenerator<Buffer, void, unknown>;
  /** On-disk bytes per named volume. A name the host does not have is simply
   *  absent from the answer - "no such volume" is not "an empty volume". */
  volumeUsage(volumeNames: string[]): Promise<Map<string, number>>;
  /** Untar a stream of gzipped-tar chunks INTO a named Docker volume on this
   *  (destination) host. `wipeFirst` empties the target first. */
  importVolume(
    volumeName: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{
    ok: boolean;
    error: string;
    /** Compressed bytes this host consumed, and their sha256. 0/"" from an agent
     *  older than the fields; that is "not reported", never "nothing arrived". */
    bytesWritten: number;
    sha256: string;
    /** Empty from an agent without `volume-copy.drop-report`, which is "not
     *  reported". */
    dropped: DroppedEntries;
  }>;
  /** Stream an arbitrary HOST DIRECTORY out of this host as a gzipped tar - the
   *  bind-mount half of a migration from another platform. */
  exportHostPath(
    path: string,
    /** Take a plain FILE at `path` too, as a one-entry tar. Off by default, so a
     *  caller that means a directory still gets told when it named a file. */
    allowFile?: boolean,
  ): AsyncGenerator<Buffer, void, unknown>;
  /** Untar a stream into a HOST DIRECTORY on this host. The wipe happens on the
   *  first data frame, never on the header alone. */
  importHostPath(
    path: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
    /** `path` names a FILE: the one entry replaces it in place. */
    file?: boolean,
  ): Promise<{
    ok: boolean;
    error: string;
    bytesWritten: number;
    sha256: string;
    dropped: DroppedEntries;
  }>;
  /** Stream an app's host-side FILES DIR (a plain host directory, not a Docker
   *  volume) OUT of this host as a gzipped tar. */
  exportFiles(slug: string): AsyncGenerator<Buffer, void, unknown>;
  /** The receiving half. `wipeFirst` empties the dir first (overwrite, not merge). */
  importFiles(
    slug: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string }>;
  /** Stream a locally BUILT image OUT of this host as a gzipped `docker save`,
   *  for a build server that compiles for machines it does not run on. */
  exportImage(
    imageRef: string,
    removeAfter: boolean,
  ): AsyncGenerator<Buffer, void, unknown>;
  /** Load a streamed image INTO this host's daemon. No wipe flag: loading a tag
   *  replaces it, so there is nothing to empty first. */
  importImage(
    imageRef: string,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string; bytesWritten: number }>;
  /** Read back the rendered stack YAML the agent has on disk. `exists` is false
   *  (empty yaml) when never deployed. */
  readStack(slug: string): Promise<{ exists: boolean; yaml: string }>;
  /** Whether a host TCP port is free to publish. */
  checkPort(port: number): Promise<{ available: boolean; reason: string }>;
  /** One bounded HTTP GET to a container of an app's OWN stack, issued from the
   *  host over Docker's network. */
  probeHttp(req: AgentProbeHttpRequest): Promise<AgentProbeHttpResult>;
  /** Update the agent BINARY in place to `version`, WITHOUT reissuing certs: it
   *  picks the asset for its own arch, verifies the sha256, swaps itself, and
   *  re-execs reusing the on-disk mTLS materials. */
  selfUpdate(
    version: string,
    binaries: Record<string, { url: string; sha256: string }>,
  ): Promise<{ version: string; restarting: boolean }>;
  /** Remove the agent's OWN footprint from the host - systemd unit, binary, state
   *  dir (mTLS materials included) - and stop. Docker is never touched. */
  selfUninstall(deadlineMs?: number): Promise<string[]>;
  /** Reclaim Docker disk on the host - a STRICT ALLOW-LIST, never a prune verb. */
  dockerCleanup(req: DockerCleanupRequest): Promise<DockerCleanupResponse>;

  /** What this host IS (CPU model, distro, kernel, clock, Docker root dir) plus
   *  the deplo-traefik stack file and whether the control-plane hint resolves. */
  hostInfo(req: HostInfoRequest): Promise<HostInfoResponse>;
  /** Move the host clock to an IANA zone; answers with a FRESH HostInfoResponse
   *  so the caller sees the clock that actually moved. */
  setTimezone(req: SetTimezoneRequest): Promise<HostInfoResponse>;
  /** Rewrite and/or restart the deplo-traefik stack from control-plane-rendered
   *  YAML (ADR-0006). Refuses as `ok:false`, not an RPC error, when Deplo did not
   *  install Traefik on that host. */
  traefikConfig(req: TraefikConfigRequest): Promise<TraefikConfigResponse>;
  /** `ok:true` means SCHEDULED, not done: the restart kills the process waiting
   *  on the reply. */
  restartControlPlane(
    req: RestartControlPlaneRequest,
  ): Promise<RestartControlPlaneResponse>;
  updateControlPlane(
    req: UpdateControlPlaneRequest,
  ): Promise<UpdateControlPlaneResponse>;

  /** Dump a database or project to S3, streaming progress (ADR-0007). */
  backup(req: BackupRequest): AsyncGenerator<BackupEvent, void, unknown>;
  /** Restore in place. DB = drop-and-recreate; project = stop → wipe + untar
   *  volumes/files → re-Reroute the snapshot. */
  restore(req: RestoreRequest): AsyncGenerator<RestoreEvent, void, unknown>;
  /** Verify S3 connectivity + that the bucket is writable. */
  s3Check(s3: S3Target): Promise<{ ok: boolean; error: string }>;
  /** Delete a single object (or, with `prefix`, a whole target folder) from S3.
   *  Idempotent; returns the count removed. `s3.objectKey` is the key or prefix. */
  s3Delete(
    s3: S3Target,
    prefix?: boolean,
  ): Promise<{ ok: boolean; error: string; deleted: number }>;

  /** Verify a store root on THIS host: resolve it, probe writability, sweep stale
   *  `.partial` artifacts, and report the filesystem headroom. */
  storeCheck(store: StoreTarget): Promise<{
    ok: boolean;
    error: string;
    freeBytes: number;
    totalBytes: number;
    root: string;
  }>;
  /** Idempotent; a prefix that resolves to the root itself is refused agent-side. */
  storeDelete(
    store: StoreTarget,
    prefix?: boolean,
  ): Promise<{ ok: boolean; error: string; deleted: number }>;
  /** Stream an artifact out of wherever it is kept: this host's store, or a bucket
   *  the host can dial (exactly one of `store` / `s3`). */
  readStoreFile(
    target: { store?: StoreTarget; s3?: S3Target },
    ageIdentity?: string,
    /** The sha256 recorded when this artifact was written. Omit only for a run
     *  taken before integrity checking shipped. */
    expectedSha256?: string,
  ): AsyncGenerator<Buffer, void, unknown>;
  /** Returns what actually landed (bytes + sha256), which is the number the run
   *  records: on a filesystem there is no ETag. */
  writeStoreFile(
    store: StoreTarget,
    overwrite: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{
    ok: boolean;
    error: string;
    bytesWritten: number;
    sha256: string;
  }>;
  /** Restore from an artifact this host cannot reach: the header carries the kind,
   *  the descriptor and the age identity, then the artifact's bytes stream in. */
  restoreFrom(
    header: RestoreChunk_Header,
    chunks: AsyncIterable<Buffer>,
  ): AsyncGenerator<RestoreEvent, void, unknown>;

  /** The RAW docker state of an app's single-image container (`deplo-<slug>`). */
  inspect(
    slug: string,
  ): Promise<{ exists: boolean; running: boolean; state: string }>;
  /** Live `docker logs -f` as an output-only AttachHandle. */
  followLogs(
    appId: string,
    container: string,
    tail: number,
    opts?: FollowLogsOptions,
  ): AttachHandle;
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

  /** Spawn a scheduled command in a container and get its handle back (ADR-0018).
   *  Deliberately NOT `exec`, which is capped at 30s and unary. */
  startJob(req: AgentStartJobRequest): Promise<string>;
  /** `found: false` means this agent has no record of it - it restarted, or the
   *  job was evicted after its retention window. */
  pollJob(jobId: string): Promise<AgentJobStatus>;
  /** Stop a running job. Idempotent: unknown or finished answers `false`. */
  killJob(jobId: string): Promise<boolean>;

  listFiles(slug: string, path: string): Promise<AgentFileEntry[]>;
  readFile(slug: string, path: string): Promise<AgentFileContent>;
  writeFile(
    slug: string,
    path: string,
    content: string,
  ): Promise<AgentFileEntry>;
  filesExist(slug: string): Promise<boolean>;
  /** Remove a file or a whole folder under the app's files dir. */
  deleteFile(slug: string, path: string): Promise<void>;

  close(): void;
}
