import "server-only";

// https://deplo.build/docs/advanced/server-roles

import { status as GrpcStatus } from "@grpc/grpc-js";

import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { HEALTH_HELLO_TIMEOUT_MS } from "../infra/agent-client/deadlines";
import {
  AgentCheckPortUnsupportedError,
  AgentUnreachableError,
  mapCheckPortUnsupported,
} from "../infra/agent-client/errors";
import { classifyServerReadiness } from "../infra/server-readiness/classify";
import {
  CHECKPORT_CAPABILITY,
  HTTPS_PORT,
  HTTP_PORT,
} from "../infra/server-readiness/routing-checks";
import type {
  PortProbe,
  ReadinessReport,
} from "../infra/server-readiness/types";
import { requireInstanceAdmin } from "../membership";
import { nowIso } from "../ids";
import { getServerById } from "./servers/roster";
import { getServerTeamIds } from "./servers/team-access";
import type { HelloResponse, HostMetrics } from "../agent/gen/agent";
import type { Server } from "../types/server";

// READINESS_DEADLINE_MS bounds the WHOLE probe: the dial, the Hello and the port/metrics phase.
export const READINESS_DEADLINE_MS = 12_000;

// READINESS_PHASE_DEADLINE_MS bounds the post-Hello phase; it must sit below the deadline above.
export const READINESS_PHASE_DEADLINE_MS = 8_000;

class ProbeTimeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeout("readiness probe timed out")),
      ms,
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

const SKIPPED: PortProbe = { kind: "skipped" };

interface DialedProbe {
  hello: HelloResponse | null;
  helloError: unknown;
  port80: PortProbe;
  port443: PortProbe;
  metrics: HostMetrics | null;
}

const TIMED_OUT: DialedProbe = {
  hello: null,
  helloError: new AgentUnreachableError(
    "readiness check timed out",
    GrpcStatus.DEADLINE_EXCEEDED,
  ),
  port80: SKIPPED,
  port443: SKIPPED,
  metrics: null,
};

const NOT_DIALED: DialedProbe = {
  hello: null,
  helloError: null,
  port80: SKIPPED,
  port443: SKIPPED,
  metrics: null,
};

// checkServerReadiness reports one server's readiness; the gate lives here, in the data layer.
export async function checkServerReadiness(
  id: string,
): Promise<ReadinessReport> {
  await requireInstanceAdmin();

  const server = await getServerById(id);
  // The same message checkServerHealth throws, so the UI's toast reads identically.
  if (!server) throw new Error("Server not found");
  // Readiness asks "could a deployment land here?" - a migration source deploys nothing.
  if (server.importOnly)
    throw new Error(
      `${server.name} is a migration source - nothing is deployed there, so there ` +
        `is no readiness to check.`,
    );

  const observedAt = nowIso();
  const grantedTeamCount = (await getServerTeamIds(id)).length;

  // The fence, identical to the health prober's: a non-empty cert pin is the only proof of an agent.
  if (!server.agent?.certFingerprint) {
    return classifyServerReadiness({
      server,
      grantedTeamCount,
      observedAt,
      ...NOT_DIALED,
    });
  }

  const dialed = await withDeadline(
    probeAgent(server),
    READINESS_DEADLINE_MS,
  ).catch((e: unknown) => {
    if (e instanceof ProbeTimeout) {
      console.error(`[deplo] readiness check for ${server.name} timed out`);
      // The deploy pre-flight budgets 8s for its Hello, so a 12s timeout would not pass one either.
      return TIMED_OUT;
    }
    throw e;
  });

  return classifyServerReadiness({
    server,
    grantedTeamCount,
    observedAt,
    ...dialed,
  });
}

async function probeAgent(server: Server): Promise<DialedProbe> {
  let conn: AgentConnection;
  try {
    // The fence above covers unprovisioned/untrusted, so a rejection here is a report, not a throw.
    conn = await connectAgent(server.id);
  } catch (e) {
    console.error(`[deplo] readiness check for ${server.name}: ${String(e)}`);
    return {
      hello: null,
      helloError: e,
      port80: SKIPPED,
      port443: SKIPPED,
      metrics: null,
    };
  }

  try {
    let hello: HelloResponse;
    try {
      hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    } catch (e) {
      // Console only: the raw error carries the pinned fingerprint and the dial address.
      console.error(`[deplo] readiness check for ${server.name}: ${String(e)}`);
      return {
        hello: null,
        helloError: e,
        port80: SKIPPED,
        port443: SKIPPED,
        metrics: null,
      };
    }

    const portsSupported = (hello.capabilities ?? []).includes(
      CHECKPORT_CAPABILITY,
    );
    const collected = await withDeadline(
      Promise.all([
        probePort(conn, HTTP_PORT, portsSupported, server.name),
        probePort(conn, HTTPS_PORT, portsSupported, server.name),
        probeMetrics(conn, server.name),
      ]),
      READINESS_PHASE_DEADLINE_MS,
    ).catch((e: unknown) => {
      if (e instanceof ProbeTimeout) {
        console.error(
          `[deplo] readiness check for ${server.name}: port/metrics phase timed out`,
        );
        return null;
      }
      throw e;
    });
    if (!collected)
      return {
        hello,
        helloError: null,
        port80: { kind: "failed" },
        port443: { kind: "failed" },
        metrics: null,
      };
    const [port80, port443, metrics] = collected;
    return { hello, helloError: null, port80, port443, metrics };
  } finally {
    conn.close();
  }
}

async function probePort(
  conn: AgentConnection,
  port: number,
  supported: boolean,
  name: string,
): Promise<PortProbe> {
  if (!supported) return { kind: "unsupported" };
  try {
    const res = await conn.checkPort(port);
    // Polarity inverts for a web port: "available" (nothing listening) is the BAD outcome.
    return res.available ? { kind: "free" } : { kind: "held" };
  } catch (e) {
    const mapped = mapCheckPortUnsupported(e);
    if (mapped instanceof AgentCheckPortUnsupportedError)
      return { kind: "unsupported" };
    console.error(
      `[deplo] readiness check for ${name}: checkPort(${port}): ${String(e)}`,
    );
    return { kind: "failed" };
  }
}

// Deliberately NOT capability-preflighted: Metrics predates the feature list and `metricsFor`
// does not gate it either, so an agent old enough to lack the flag may still answer.
async function probeMetrics(
  conn: AgentConnection,
  name: string,
): Promise<HostMetrics | null> {
  try {
    // "" => the agent measures its own --data-dir (the installer points it at the host root).
    return await conn.metrics("");
  } catch (e) {
    console.error(`[deplo] readiness check for ${name}: metrics: ${String(e)}`);
    return null;
  }
}
