import "server-only";

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

export interface AgentProbeHttpRequest {
  appId: string;
  slug: string;
  service: string;
  port: number;
  path: string;
  host: string;
  maxBytes: number;
}

export interface AgentProbeHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
  location: string;
}

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
  state: string;
  // "" when the image has no healthcheck, and from an agent older than the field - never read it as healthy.
  health: string;
  restartCount: number;
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

export interface AgentStartJobRequest {
  projectId: string;
  container: string;
  image: string;
  shell: string;
  command: string;
  timeoutSeconds: number;
  workdir: string;
  user: string;
  // The NAME rides argv, the VALUE the docker client's own env, so a secret is never readable from ps.
  env: { name: string; value: string }[];
}

export interface AgentJobStatus {
  found: boolean;
  running: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DroppedEntries {
  links: number;
  special: number;
  names: string[];
}

export interface FollowLogsOptions {
  sinceUnix?: number;
  untilUnix?: number;
  timestamps?: boolean;
}

export interface AgentConnection {
  hello(timeoutMs?: number): Promise<HelloResponse>;
  metrics(dataDir?: string): Promise<HostMetrics>;
  containerStats(
    projectId: string,
    containers: string[],
  ): Promise<ContainerStat[]>;
  streamMetrics(
    req: MetricsStreamRequest,
  ): AsyncGenerator<MetricsSample, void, unknown>;
  deploy(req: DeployRequest): AsyncGenerator<DeployEvent, void, unknown>;
  reattach(req: ReattachRequest): AsyncGenerator<DeployEvent, void, unknown>;
  stopStack(
    slug: string,
    services?: string[],
  ): Promise<{ ok: boolean; error: string }>;
  startStack(slug: string): Promise<{ ok: boolean; error: string }>;
  destroyStack(
    slug: string,
    removeVolumes?: boolean,
    reclaimVolumes?: string[],
  ): Promise<{ ok: boolean; error: string }>;
  reroute(req: {
    slug: string;
    composeYaml: string;
    env: Record<string, string>;
    mounts: { path: string; content: string }[];
    network: string;
    composeUpArgs?: string[];
  }): Promise<{ ok: boolean; error: string }>;
  renewalCsr(): Promise<{ csrPem: string }>;
  installRenewedCert(req: {
    certPem: string;
    caPem: string;
  }): Promise<{ ok: boolean; error: string }>;
  exportVolume(volumeName: string): AsyncGenerator<Buffer, void, unknown>;
  volumeUsage(volumeNames: string[]): Promise<Map<string, number>>;
  importVolume(
    volumeName: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{
    ok: boolean;
    error: string;
    bytesWritten: number;
    sha256: string;
    dropped: DroppedEntries;
  }>;
  exportHostPath(
    path: string,
    allowFile?: boolean,
  ): AsyncGenerator<Buffer, void, unknown>;
  importHostPath(
    path: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
    file?: boolean,
  ): Promise<{
    ok: boolean;
    error: string;
    bytesWritten: number;
    sha256: string;
    dropped: DroppedEntries;
  }>;
  exportFiles(slug: string): AsyncGenerator<Buffer, void, unknown>;
  importFiles(
    slug: string,
    wipeFirst: boolean,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string }>;
  exportImage(
    imageRef: string,
    removeAfter: boolean,
  ): AsyncGenerator<Buffer, void, unknown>;
  importImage(
    imageRef: string,
    chunks: AsyncIterable<Buffer>,
  ): Promise<{ ok: boolean; error: string; bytesWritten: number }>;
  readStack(slug: string): Promise<{ exists: boolean; yaml: string }>;
  checkPort(port: number): Promise<{ available: boolean; reason: string }>;
  probeHttp(req: AgentProbeHttpRequest): Promise<AgentProbeHttpResult>;
  selfUpdate(
    version: string,
    binaries: Record<string, { url: string; sha256: string }>,
  ): Promise<{ version: string; restarting: boolean }>;
  selfUninstall(deadlineMs?: number): Promise<string[]>;
  dockerCleanup(req: DockerCleanupRequest): Promise<DockerCleanupResponse>;

  hostInfo(req: HostInfoRequest): Promise<HostInfoResponse>;
  setTimezone(req: SetTimezoneRequest): Promise<HostInfoResponse>;
  traefikConfig(req: TraefikConfigRequest): Promise<TraefikConfigResponse>;
  restartControlPlane(
    req: RestartControlPlaneRequest,
  ): Promise<RestartControlPlaneResponse>;
  updateControlPlane(
    req: UpdateControlPlaneRequest,
  ): Promise<UpdateControlPlaneResponse>;

  backup(req: BackupRequest): AsyncGenerator<BackupEvent, void, unknown>;
  restore(req: RestoreRequest): AsyncGenerator<RestoreEvent, void, unknown>;
  s3Check(s3: S3Target): Promise<{ ok: boolean; error: string }>;
  s3Delete(
    s3: S3Target,
    prefix?: boolean,
  ): Promise<{ ok: boolean; error: string; deleted: number }>;

  storeCheck(store: StoreTarget): Promise<{
    ok: boolean;
    error: string;
    freeBytes: number;
    totalBytes: number;
    root: string;
  }>;
  storeDelete(
    store: StoreTarget,
    prefix?: boolean,
  ): Promise<{ ok: boolean; error: string; deleted: number }>;
  readStoreFile(
    target: { store?: StoreTarget; s3?: S3Target },
    ageIdentity?: string,
    expectedSha256?: string,
  ): AsyncGenerator<Buffer, void, unknown>;
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
  restoreFrom(
    header: RestoreChunk_Header,
    chunks: AsyncIterable<Buffer>,
  ): AsyncGenerator<RestoreEvent, void, unknown>;

  inspect(
    slug: string,
  ): Promise<{ exists: boolean; running: boolean; state: string }>;
  followLogs(
    appId: string,
    container: string,
    tail: number,
    opts?: FollowLogsOptions,
  ): AttachHandle;
  attach(
    appId: string,
    container: string,
    tty: boolean,
    cols: number,
    rows: number,
  ): AttachHandle;
  listInstances(
    appId: string,
    slug: string,
    exposeService: string,
  ): Promise<AgentConsoleInstance[]>;
  exec(
    appId: string,
    container: string,
    command: string,
    image: string,
  ): Promise<AgentExecResult>;
  shellLabel(appId: string, container: string, image: string): Promise<string>;

  startJob(req: AgentStartJobRequest): Promise<string>;
  pollJob(jobId: string): Promise<AgentJobStatus>;
  killJob(jobId: string): Promise<boolean>;

  listFiles(slug: string, path: string): Promise<AgentFileEntry[]>;
  readFile(slug: string, path: string): Promise<AgentFileContent>;
  writeFile(
    slug: string,
    path: string,
    content: string,
  ): Promise<AgentFileEntry>;
  filesExist(slug: string): Promise<boolean>;
  deleteFile(slug: string, path: string): Promise<void>;

  close(): void;
}
