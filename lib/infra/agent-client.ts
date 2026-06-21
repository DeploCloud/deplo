import "server-only";

import {
  credentials,
  Metadata,
  type ClientReadableStream,
} from "@grpc/grpc-js";
import {
  AgentClient as GrpcAgentClient,
  ContractVersion,
  type HelloResponse,
  type HostMetrics,
  type DeployRequest,
  type DeployEvent,
} from "../agent/gen/agent";
import { ensureLocalAgent, type LocalAgentHandle } from "../agent/local-agent";

/**
 * The agent client — the control plane's side of the second system boundary
 * (ADR-0006). Given a `serverId`, it dials that server's agent over mTLS and
 * exposes a small promise/async-iterator API (`hello`, `metrics`, `deploy`).
 * This is the ONE choke point that replaces direct `lib/infra/docker.ts` calls
 * in the deploy path: `runDeployment` calls `agentDeploy(...)` instead of
 * spawning docker locally.
 *
 * PART A: every server resolves to the LOCAL agent on the Deplo host
 * (`local-agent.ts` supervises it). Part B resolves a remote server to its
 * address + pinned cert from the `Server` row. The dial is mTLS in both worlds —
 * one trust model — so the only thing that changes in B is the address lookup.
 */

const HELLO_TIMEOUT_MS = 8_000;
const DEPLOY_DEADLINE_MS = 30 * 60_000; // a build can be long

/** A live, mTLS-secured connection to one agent, with a typed wrapper. */
export interface AgentConnection {
  hello(): Promise<HelloResponse>;
  metrics(dataDir?: string): Promise<HostMetrics>;
  /** Stream a deploy; yields DeployEvents until the terminal result. */
  deploy(req: DeployRequest): AsyncGenerator<DeployEvent, void, unknown>;
  close(): void;
}

/**
 * Resolve a server to a dial target. Part A: always the local agent (the binary
 * is supervised in-process). Throws if the local agent can't be brought up — the
 * caller treats that as "agent unavailable" and falls back to the legacy path.
 */
async function resolveAgent(serverId: string): Promise<LocalAgentHandle> {
  // Part A: every server — localhost or remote — resolves to the local agent on
  // the Deplo host. Part B replaces this with a Server-row lookup ({host, port,
  // pinned cert}) keyed by serverId; the parameter is threaded through now so
  // that swap is local to this function.
  void serverId;
  // The Hello probe used both to confirm readiness here AND inside the
  // supervisor's startup wait — one definition of "reachable".
  return ensureLocalAgent(async (h) => {
    const conn = dial(h);
    try {
      await conn.hello();
      return true;
    } catch {
      return false;
    } finally {
      conn.close();
    }
  });
}

/** Build a typed connection over an mTLS channel to the given handle. */
function dial(handle: LocalAgentHandle): AgentConnection {
  const { certPem, keyPem, caPem } = handle.clientCreds;
  const creds = credentials.createSsl(
    Buffer.from(caPem),
    Buffer.from(keyPem),
    Buffer.from(certPem),
  );
  const client = new GrpcAgentClient(handle.address, creds, {
    // Verify the agent cert against this name (covered by the cert SANs).
    "grpc.ssl_target_name_override": handle.serverName,
    "grpc.default_authority": handle.serverName,
    // Large messages: a streamed build context rides inside the Deploy request.
    "grpc.max_receive_message_length": 256 * 1024 * 1024,
    "grpc.max_send_message_length": 256 * 1024 * 1024,
  });

  return {
    hello() {
      return new Promise<HelloResponse>((resolve, reject) => {
        const deadline = new Date(Date.now() + HELLO_TIMEOUT_MS);
        client.hello(
          { contractVersion: ContractVersion.CONTRACT_VERSION_V1, controlPlaneVersion: "" },
          new Metadata(),
          { deadline },
          (err, resp) => (err ? reject(err) : resolve(resp)),
        );
      });
    },
    metrics(dataDir = "") {
      return new Promise<HostMetrics>((resolve, reject) => {
        client.metrics({ dataDir }, (err, resp) =>
          err ? reject(err) : resolve(resp),
        );
      });
    },
    async *deploy(req: DeployRequest) {
      const stream: ClientReadableStream<DeployEvent> = client.deploy(req, {
        deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
      });
      // Bridge the event-emitter stream to an async generator with backpressure
      // via a simple queue + signal.
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
  const handle = await resolveAgent(serverId);
  return dial(handle);
}

/**
 * Mandatory pre-flight (PLAN P5): confirm the agent answers Hello before a
 * deploy, with a contract-version check. Returns the HelloResponse or throws a
 * clear "server unreachable" error — never hangs.
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
    return resp;
  } finally {
    conn.close();
  }
}
