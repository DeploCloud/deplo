import "server-only";

import {
  credentials,
  Metadata,
  status as GrpcStatus,
  type ClientReadableStream,
  type ClientDuplexStream,
  type ServiceError,
} from "@grpc/grpc-js";
import type { PeerCertificate } from "node:tls";
import {
  AgentClient as GrpcAgentClient,
  ContractVersion,
  type HelloResponse,
  type HostMetrics,
  type DeployRequest,
  type DeployEvent,
  type ReattachRequest,
  type LogChunk,
  type AttachInput,
  type AttachOutput,
  type ConsoleInstance as PbConsoleInstance,
  type FileEntry as PbFileEntry,
  type StartDevRequest,
  type GatewayConfig as PbGatewayConfig,
  type UserSteps as PbUserSteps,
  type GatewayStep as PbGatewayStep,
} from "../agent/gen/agent";
import type { AttachHandle } from "./docker";
import { read } from "../store";
import { markServerSeen } from "../data/servers";
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
const DEPLOY_DEADLINE_MS = 30 * 60_000; // a build can be long
const CONSOLE_TIMEOUT_MS = 30_000; // exec runs in-container; match docker.ts exec
const FILES_TIMEOUT_MS = 15_000;
const STREAM_DEADLINE_MS = 30 * 60_000; // logs/attach are long-lived
const GATEWAY_TIMEOUT_MS = 4 * 60_000; // gateway compose-up + sshd-wait + reconcile (Part D)

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

/** Part D: everything the agent needs to start a project's dev container. The
 *  control plane renders all of it (D2); the agent writes files + drives Docker. */
export interface AgentStartDev {
  slug: string;
  projectId: string;
  /** Rendered dev compose YAML (renderDevCompose) — opaque to the agent. */
  composeYaml: string;
  /** The dev entrypoint script (DEV_ENTRY_SCRIPT), bind-mounted into the container. */
  entryScript: string;
  /** Tokenized clone URL for a git source (staged 0600); "" => not git. */
  cloneSecretUrl: string;
  /** The upload archive to seed an upload workspace host-side; empty => none. */
  uploadTar: Buffer;
  /** Host-translated `-v` source for the pre-chown helper; "" => plain path. */
  workspaceHostPath: string;
}
/** Part D: a rendered SSH-gateway step (one `docker exec -i <gw> <argv>`). */
export interface AgentGatewayStep {
  argv: string[];
  input: string;
}
/** Part D: the rendered SSH-gateway config the agent writes to its bind mount. */
export interface AgentGatewayConfig {
  composeYaml: string;
  sshdConfig: string;
  wrapperScript: string;
  entrypointScript: string;
  socketFilterCfg: string;
}
/** Part D: VS Code tunnel status — the agent returns the RAW log; the control
 *  plane parses it (parseTunnelLog) into the device-login link / connected URL. */
export interface AgentTunnelStatus {
  running: boolean;
  log: string;
}

/** A live, mTLS-secured connection to one agent, with a typed wrapper. */
export interface AgentConnection {
  hello(): Promise<HelloResponse>;
  metrics(dataDir?: string): Promise<HostMetrics>;
  /** Stream a deploy; yields DeployEvents until the terminal result. */
  deploy(req: DeployRequest): AsyncGenerator<DeployEvent, void, unknown>;
  /** Reconnect to an in-flight deploy and replay missed events (D5, Part B). */
  reattach(req: ReattachRequest): AsyncGenerator<DeployEvent, void, unknown>;
  /** Stack lifecycle on the agent (Part C: stop/start; destroy from Part B). */
  stopStack(slug: string): Promise<{ ok: boolean; error: string }>;
  startStack(slug: string): Promise<{ ok: boolean; error: string }>;
  /** Tear down a stack on the agent (P6 teardown / lifecycle). */
  destroyStack(slug: string): Promise<{ ok: boolean; error: string }>;
  /** Re-apply routing to a running stack WITHOUT a rebuild: the control plane
   *  re-renders the stack YAML (+ env + compose mounts) and the agent writes it
   *  and `compose up`s in place. Replaces the old in-process reroute. */
  reroute(req: {
    slug: string;
    composeYaml: string;
    env: Record<string, string>;
    mounts: { path: string; content: string }[];
  }): Promise<{ ok: boolean; error: string }>;
  /** Read back the rendered stack YAML the agent has on disk, for the "View full
   *  compose" preview. `exists` is false (empty yaml) when never deployed. */
  readStack(slug: string): Promise<{ exists: boolean; yaml: string }>;

  // ---- Part C: console observability ----
  /** Live `docker logs -f` as an output-only AttachHandle (reuses the SSE session
   *  plumbing). `write` is a no-op; `close()` cancels the stream + the grpc client. */
  followLogs(projectId: string, container: string, tail: number): AttachHandle;
  /** Interactive attach as a full-duplex AttachHandle (write = stdin, onData =
   *  output). `tty` selects the pty backing agent-side. */
  attach(
    projectId: string,
    container: string,
    tty: boolean,
    cols: number,
    rows: number,
  ): AttachHandle;
  /** Every attachable container in a project's stack (no synthetic fallback). */
  listInstances(
    projectId: string,
    slug: string,
    exposeService: string,
  ): Promise<AgentConsoleInstance[]>;
  /** Run a command in a container (docker exec); guest exit code, never throws on it. */
  exec(
    projectId: string,
    container: string,
    command: string,
    image: string,
  ): Promise<AgentExecResult>;
  /** The container's shell label for the console banner. */
  shellLabel(projectId: string, container: string, image: string): Promise<string>;

  // ---- Part C: project config files ----
  listFiles(slug: string, path: string): Promise<AgentFileEntry[]>;
  readFile(slug: string, path: string): Promise<AgentFileContent>;
  writeFile(slug: string, path: string, content: string): Promise<AgentFileEntry>;
  uploadFile(slug: string, path: string, data: Buffer): Promise<AgentFileEntry>;
  createDir(slug: string, path: string): Promise<AgentFileEntry>;
  deleteFile(slug: string, path: string): Promise<boolean>;
  renameFile(slug: string, path: string, newPath: string): Promise<AgentFileEntry>;
  filesExist(slug: string): Promise<boolean>;

  // ---- Part D: dev containers + SSH gateway + VS Code tunnel ----
  /** Start (or restart) a project's dev container; streams progress like deploy. */
  startDev(req: AgentStartDev): AsyncGenerator<DeployEvent, void, unknown>;
  /** DESTRUCTIVE reset: wipe workspace + deps volume, then reseed (streams). */
  resetDevWorkspace(req: AgentStartDev): AsyncGenerator<DeployEvent, void, unknown>;
  /** Stop a project's dev container (reversible; workspace kept). */
  stopDev(slug: string): Promise<{ ok: boolean; error: string }>;
  /** Tear down a dev container on project delete (wipes the workspace). */
  teardownDev(slug: string): Promise<{ ok: boolean; error: string }>;
  /** Ensure the SSH gateway is up and reconcile every supplied user into it. */
  ensureGateway(
    config: AgentGatewayConfig,
    users: AgentGatewayStep[][],
  ): Promise<{ ok: boolean; error: string }>;
  /** Provision a user: ensure the gateway, then reconcile the full user set. */
  provisionSshUser(
    config: AgentGatewayConfig,
    users: AgentGatewayStep[][],
  ): Promise<{ ok: boolean; error: string }>;
  /** Remove one user from the gateway (the deprovision steps). */
  deprovisionSshUser(
    steps: AgentGatewayStep[],
  ): Promise<{ ok: boolean; error: string }>;
  /** Launch the VS Code tunnel (idempotent); returns the raw log + running flag. */
  startTunnel(slug: string, launchScript: string): Promise<AgentTunnelStatus>;
  /** Read the current tunnel status (no side effects). */
  getTunnel(slug: string): Promise<AgentTunnelStatus>;
  /** Stop the tunnel process (CLI download + auth token kept). */
  stopTunnel(slug: string): Promise<{ ok: boolean; error: string }>;

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

/** A typed availability error: the agent could not be reached (caller falls back). */
export class AgentUnreachableError extends Error {}

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
    return new AgentUnreachableError(msg);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Resolve a server to a dial target: its declared host/port + the control plane's
 * client cert, pinning the agent cert recorded at bootstrap. Applies uniformly to
 * every server, the host running Deplo included. Throws {@link AgentUnreachableError}
 * if the server is unknown, has no provisioned agent yet, or trust was revoked —
 * the caller surfaces "server unreachable / not provisioned" instead of hanging.
 */
async function resolveTarget(serverId: string): Promise<DialTarget> {
  const server = read().servers.find((s) => s.id === serverId);
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
  const { issueControlPlaneClientCert, caCertPem } = await import("../agent/pki");
  const client = await issueControlPlaneClientCert();
  const agent = server.agent!;
  const host = server.ip || server.host;
  return {
    address: `${host}:${agent.port}`,
    // The agent cert's SANs cover the server's IP/host (signAgentCsr used them),
    // so verify against the dial host.
    serverName: host,
    clientCreds: { certPem: client.certPem, keyPem: client.keyPem, caPem: await caCertPem() },
    pinnedFingerprint: agent.certFingerprint,
  };
}

/** Normalise a tls PeerCertificate fingerprint ("AA:BB:..") to lowercase hex. */
function peerFingerprint(cert: PeerCertificate): string {
  return (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
}

/** Build a typed connection over an mTLS channel to the given target. */
function dial(target: DialTarget): AgentConnection {
  const { certPem, keyPem, caPem } = target.clientCreds;
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
  });

  /** Bridge a grpc server-stream into a backpressured async generator. */
  async function* streamEvents(
    stream: ClientReadableStream<DeployEvent>,
  ): AsyncGenerator<DeployEvent, void, unknown> {
    const queue: DeployEvent[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const signal = () => {
      wake?.();
      wake = null;
    };
    stream.on("data", (ev: DeployEvent) => {
      queue.push(ev);
      signal();
    });
    stream.on("error", (err: Error) => {
      failure = err;
      done = true;
      signal();
    });
    stream.on("end", () => {
      done = true;
      signal();
    });
    try {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    } finally {
      stream.cancel();
    }
  }

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
    let exitCb: (() => void) | null = null;
    let closed = false;
    const fanout = (buf: Buffer) => {
      if (subs.size === 0 && pending) {
        pending.push(buf);
        return;
      }
      for (const s of subs) s(buf);
    };
    stream.on("data", (c: LogChunk) => fanout(Buffer.from(c.data)));
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
  const gatewayDeadline = () => ({ deadline: new Date(Date.now() + GATEWAY_TIMEOUT_MS) });
  const toStartDevPb = (r: AgentStartDev): StartDevRequest => ({
    slug: r.slug,
    projectId: r.projectId,
    composeYaml: r.composeYaml,
    entryScript: r.entryScript,
    cloneSecretUrl: r.cloneSecretUrl,
    uploadTar: r.uploadTar,
    workspaceHostPath: r.workspaceHostPath,
  });
  const toGatewayStepPb = (s: AgentGatewayStep): PbGatewayStep => ({
    argv: s.argv,
    input: s.input,
  });
  const toUserStepsPb = (users: AgentGatewayStep[][]): PbUserSteps[] =>
    users.map((steps) => ({ steps: steps.map(toGatewayStepPb) }));
  const toGatewayConfigPb = (c: AgentGatewayConfig): PbGatewayConfig => ({
    composeYaml: c.composeYaml,
    sshdConfig: c.sshdConfig,
    wrapperScript: c.wrapperScript,
    entrypointScript: c.entrypointScript,
    socketFilterCfg: c.socketFilterCfg,
  });
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
  });
  const mapEntry = (e: PbFileEntry): AgentFileEntry => ({
    path: e.path,
    name: e.name,
    kind: e.kind,
    size: Number(e.size),
    modifiedAt: e.modifiedAt,
  });

  return {
    hello() {
      return new Promise<HelloResponse>((resolve, reject) => {
        const deadline = new Date(Date.now() + HELLO_TIMEOUT_MS);
        client.hello(
          { contractVersion: ContractVersion.CONTRACT_VERSION_V1, controlPlaneVersion: "" },
          new Metadata(),
          { deadline },
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp)),
        );
      });
    },
    metrics(dataDir = "") {
      return new Promise<HostMetrics>((resolve, reject) => {
        // A deadline is mandatory: the dashboard polls metrics ~1s, so a remote
        // agent that accepts the connection but never replies must time out (and
        // be classified unreachable) rather than hang the poll + leak the client.
        client.metrics({ dataDir }, new Metadata(), consoleDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve(resp),
        );
      });
    },
    deploy(req: DeployRequest) {
      return streamEvents(
        client.deploy(req, { deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS) }),
      );
    },
    reattach(req: ReattachRequest) {
      return streamEvents(
        client.reattachDeploy(req, {
          deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
        }),
      );
    },
    stopStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.stopStack({ slug }, (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    startStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.startStack({ slug }, (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    destroyStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.destroyStack({ slug }, (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    reroute(req: {
      slug: string;
      composeYaml: string;
      env: Record<string, string>;
      mounts: { path: string; content: string }[];
    }) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.reroute(
          {
            slug: req.slug,
            composeYaml: req.composeYaml,
            env: req.env,
            mounts: req.mounts,
          },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    readStack(slug: string) {
      return new Promise<{ exists: boolean; yaml: string }>((resolve, reject) => {
        client.readStack({ slug }, (err, resp) =>
          err
            ? reject(toAgentError(err))
            : resolve({ exists: resp.exists, yaml: resp.yaml }),
        );
      });
    },

    // ---- Part C: console observability ----
    followLogs(projectId: string, container: string, tail: number) {
      return logsHandle(
        client.followLogs(
          { projectId, container, tail },
          { deadline: new Date(Date.now() + STREAM_DEADLINE_MS) },
        ),
      );
    },
    attach(
      projectId: string,
      container: string,
      tty: boolean,
      cols: number,
      rows: number,
    ) {
      const stream = client.attach({
        deadline: new Date(Date.now() + STREAM_DEADLINE_MS),
      });
      // The agent requires AttachOpen as the FIRST frame.
      stream.write({ open: { projectId, container, tty, cols, rows } });
      return attachHandle(stream);
    },
    listInstances(projectId: string, slug: string, exposeService: string) {
      return new Promise<AgentConsoleInstance[]>((resolve, reject) => {
        client.listInstances(
          { projectId, slug, exposeService },
          new Metadata(),
          consoleDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.instances.map(mapInstance)),
        );
      });
    },
    exec(projectId: string, container: string, command: string, image: string) {
      return new Promise<AgentExecResult>((resolve, reject) => {
        client.exec(
          { projectId, container, command, image },
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
    shellLabel(projectId: string, container: string, image: string) {
      return new Promise<string>((resolve, reject) => {
        client.shellLabel(
          { projectId, container, image },
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

    // ---- Part D: dev containers + SSH gateway + VS Code tunnel ----
    startDev(req: AgentStartDev) {
      return streamEvents(
        client.startDev(toStartDevPb(req), {
          deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
        }),
      );
    },
    resetDevWorkspace(req: AgentStartDev) {
      return streamEvents(
        client.resetDevWorkspace(toStartDevPb(req), {
          deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
        }),
      );
    },
    stopDev(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.stopDev({ slug }, (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    teardownDev(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.teardownDev({ slug }, (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    ensureGateway(config: AgentGatewayConfig, users: AgentGatewayStep[][]) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.ensureGateway(
          { config: toGatewayConfigPb(config), users: toUserStepsPb(users) },
          new Metadata(),
          gatewayDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    provisionSshUser(config: AgentGatewayConfig, users: AgentGatewayStep[][]) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.provisionSshUser(
          { config: toGatewayConfigPb(config), users: toUserStepsPb(users) },
          new Metadata(),
          gatewayDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    deprovisionSshUser(steps: AgentGatewayStep[]) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.deprovisionSshUser(
          { steps: steps.map(toGatewayStepPb) },
          new Metadata(),
          gatewayDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    startTunnel(slug: string, launchScript: string) {
      return new Promise<AgentTunnelStatus>((resolve, reject) => {
        client.startTunnel(
          { slug, launchScript },
          new Metadata(),
          { deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ running: resp.running, log: resp.log }),
        );
      });
    },
    getTunnel(slug: string) {
      return new Promise<AgentTunnelStatus>((resolve, reject) => {
        client.getTunnel({ slug, launchScript: "" }, new Metadata(), consoleDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ running: resp.running, log: resp.log }),
        );
      });
    },
    stopTunnel(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.stopTunnel({ slug, launchScript: "" }, new Metadata(), consoleDeadline(), (err, resp) =>
          err ? reject(toAgentError(err)) : resolve({ ok: resp.ok, error: resp.error }),
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
      markServerSeen(serverId, resp.agentVersion, resp.traefikRunning);
    } catch {
      /* unknown id: no row to touch */
    }
    return resp;
  } finally {
    conn.close();
  }
}

/**
 * Best-effort agent teardown for server removal (PLAN P6, move c). Pre-flight
 * Hello to confirm the agent answers; if it does, the removal is clean and the
 * operator is not warned. (Container cleanup is bounded: removeServer blocks
 * while any project is still assigned, so by the time we reach here the control
 * plane owns no stacks on this host — the meaningful signal is reachability.)
 * Throws if the agent is unreachable so the caller warns about manual cleanup.
 * Applies to every server uniformly (the host running Deplo included).
 */
export async function teardownServerAgent(server: Server): Promise<void> {
  const target = await remoteTarget(server).catch(() => null);
  if (!target) return; // never provisioned; nothing to reach
  const conn = dial(target);
  try {
    await conn.hello(); // reachability pre-flight; throws if the box is gone
  } finally {
    conn.close();
  }
}
