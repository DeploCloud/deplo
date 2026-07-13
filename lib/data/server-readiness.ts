import "server-only";

import { status as GrpcStatus } from "@grpc/grpc-js";

import {
  AgentCheckPortUnsupportedError,
  AgentUnreachableError,
  connectAgent,
  mapCheckPortUnsupported,
  HEALTH_HELLO_TIMEOUT_MS,
  type AgentConnection,
} from "../infra/agent-client";
import {
  CHECKPORT_CAPABILITY,
  classifyServerReadiness,
  HTTPS_PORT,
  HTTP_PORT,
  type PortProbe,
  type ReadinessReport,
} from "../infra/server-readiness";
import { requireInstanceAdmin } from "../membership";
import { nowIso } from "../ids";
import { resolveExpectedAgentVersion } from "../version";
import { getServerById, getServerTeamIds } from "./servers";
import type { HelloResponse, HostMetrics } from "../agent/gen/agent";
import type { Server } from "../types";

/**
 * Server READINESS (Settings → Servers → ⋯ → Check readiness): a live, never-stored answer
 * to "is this host's installation complete enough to deploy Apps to?".
 *
 * This module is only the ORCHESTRATOR. It gates the call, dials the owning server's agent
 * exactly once, collects everything one bounded probe can honestly learn (a Hello, two host
 * port bind-tests, host metrics) plus the control plane's own facts about the row, and hands
 * the lot to the pure classifier in lib/infra/server-readiness.ts. Every decision — which
 * signal proves what, which absence is normal, which string may be shown — lives THERE, so it
 * can be tested without a socket (there is no mocking seam for `connectAgent`).
 *
 * IT WRITES NOTHING. Not `servers.status`, not `status_checked_at`, not `status_probed_at`,
 * not `last_seen_at`; it calls neither `recordServerHealth` nor `markServerSeen` nor
 * `claimProbe` nor `recordActivity`. Two reasons, and they are the same reason `metricsFor`
 * refuses to persist:
 *   - this probe has NO confirming retry and NO throttle lease. `probeServer` demotes a server
 *     only after a second look, because a persisted false `offline` sits on the operator's
 *     screen for the whole throttle window after the blip is over. A readiness check that wrote
 *     a status on a single failed Hello would reintroduce exactly that bug.
 *   - it is a DIAGNOSTIC the operator runs *because* something already looks wrong. Opening a
 *     dialog must not perturb what the page is telling them. Health stays the health prober's
 *     story (lib/data/server-health.ts owns `servers.status`); readiness is a READ.
 * There is no throttle for the same reason: nothing is persisted, so a re-run costs one dial
 * and the operator is the one waiting on it.
 *
 * An unreachable or untrusted agent is NOT an exception here — it IS the report ("Not ready to
 * deploy: the agent did not answer"). The raw error, which carries the pinned certificate
 * fingerprint and the dial address, goes to `console.error` and nowhere else; the report
 * carries only the classifier's curated, closed-set strings.
 */

/**
 * Belt-and-braces bound around the WHOLE probe: connectAgent's DB read + cert issue, the
 * Hello, and the concurrent CheckPort/Metrics phase. The individual RPCs have their own
 * deadlines (Hello 3s, CheckPort 15s, Metrics 30s), but an operator is WATCHING this dialog —
 * a slow answer is itself the answer. Same discipline as PROBE_DEADLINE_MS in server-health.ts.
 */
export const READINESS_DEADLINE_MS = 12_000;

/**
 * The bound on the POST-HELLO phase (the two CheckPort bind-tests + the metrics read), which
 * must sit BELOW {@link READINESS_DEADLINE_MS}. Their own RPC deadlines are longer than the
 * whole-probe budget (CheckPort 15s, Metrics 30s — both shared with other callers, so neither
 * can be lowered here), which means that without this phase bound a stall in the port/metrics
 * phase would always trip the OUTER deadline and throw away a Hello that demonstrably
 * succeeded — reporting "the agent did not answer" about an agent that answered in 300ms.
 * A phase overrun is a `skip`, not a fail: we could not evaluate those rows, so we say so, and
 * everything the Hello already told us survives.
 */
export const READINESS_PHASE_DEADLINE_MS = 8_000;

/** Race the probe against a hard deadline. A rejection here means "we ran out of time". */
class ProbeTimeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout("readiness probe timed out")), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

const SKIPPED: PortProbe = { kind: "skipped" };

/** Everything the dial contributes to a {@link ReadinessProbe}. */
interface DialedProbe {
  hello: HelloResponse | null;
  helloError: unknown;
  port80: PortProbe;
  port443: PortProbe;
  metrics: HostMetrics | null;
}

/** What a probe that ran out of time contributes: the same shape a dead agent produces. */
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

/** We never dialed at all (no agent has been provisioned / trust was revoked). */
const NOT_DIALED: DialedProbe = {
  hello: null,
  helloError: null,
  port80: SKIPPED,
  port443: SKIPPED,
  metrics: null,
};

/**
 * Run the readiness check for ONE server and return the report. Instance-admin only: servers
 * are instance-wide infra, and every other server mutation gates the same way. The gate lives
 * HERE, in the data layer — the GraphQL `authScopes` is the introspectable contract, this is
 * the boundary.
 */
export async function checkServerReadiness(id: string): Promise<ReadinessReport> {
  await requireInstanceAdmin();

  const server = await getServerById(id);
  // The same message checkServerHealth throws, so the UI's toast reads identically.
  if (!server) throw new Error("Server not found");

  const observedAt = nowIso();
  const [expectedAgentVersion, teamIds] = await Promise.all([
    resolveExpectedAgentVersion(),
    getServerTeamIds(id),
  ]);
  const grantedTeamCount = teamIds.length;

  // The fence, identical to the health prober's: a NON-EMPTY cert pin is the only proof there
  // is an agent on the other end. `removeServer` revokes trust by writing "" (not NULL), so a
  // trust-revoked row is fenced exactly like a never-provisioned one — dialing either would
  // make `resolveTarget` throw from a pure DB read, and reporting THAT as "the agent did not
  // answer" would tell an operator their brand-new server is broken when it simply hasn't been
  // installed yet.
  if (!server.agent?.certFingerprint) {
    return classifyServerReadiness({
      server,
      expectedAgentVersion,
      grantedTeamCount,
      observedAt,
      ...NOT_DIALED,
    });
  }

  const dialed = await withDeadline(probeAgent(server), READINESS_DEADLINE_MS).catch(
    (e: unknown) => {
      if (e instanceof ProbeTimeout) {
        console.error(`[deplo] readiness check for ${server.name} timed out`);
        // Honest, not a guess: the deploy pre-flight budgets only 8s for its Hello, so a
        // server that cannot finish a 12s bounded probe would not pass one either.
        return TIMED_OUT;
      }
      throw e;
    },
  );

  return classifyServerReadiness({
    server,
    expectedAgentVersion,
    grantedTeamCount,
    observedAt,
    ...dialed,
  });
}

/**
 * ONE dial, closed in a `finally`. The Hello is the gate: if it fails, the channel is dead or
 * untrusted and we do not keep talking to it — that single failure IS the report. If it
 * succeeds, the two port bind-tests and the host-metrics read run CONCURRENTLY (the metrics
 * RPC blocks ~1s agent-side computing its CPU/net deltas), so the whole phase costs ~1.2s on a
 * healthy host.
 *
 * Neither the port checks nor the metrics read is skipped when Docker is down: CheckPort is a
 * raw TCP bind and Metrics is procfs/statfs — both are Docker-independent, and a broken-install
 * host (Docker dead, something else squatting on :80) is exactly the case this feature exists
 * to explain.
 *
 * NO confirming retry, deliberately. Nothing is persisted, so a false negative costs the
 * operator one click of "Run again", not a wrong badge in the database.
 */
async function probeAgent(server: Server): Promise<DialedProbe> {
  let conn: AgentConnection;
  try {
    // connectAgent itself rejects for an unknown/unprovisioned/trust-revoked server. The
    // fence above covers those, so a rejection here is a genuine dial failure — which is a
    // REPORT ("the agent did not answer"), never an exception thrown at the client.
    conn = await connectAgent(server.id);
  } catch (e) {
    console.error(`[deplo] readiness check for ${server.name}: ${String(e)}`);
    return { hello: null, helloError: e, port80: SKIPPED, port443: SKIPPED, metrics: null };
  }

  try {
    let hello: HelloResponse;
    try {
      hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    } catch (e) {
      // The raw error carries the PINNED FINGERPRINT and the dial address. Console only —
      // the classifier turns the outcome into one of its curated, closed-set strings.
      console.error(`[deplo] readiness check for ${server.name}: ${String(e)}`);
      return { hello: null, helloError: e, port80: SKIPPED, port443: SKIPPED, metrics: null };
    }

    const portsSupported = (hello.capabilities ?? []).includes(CHECKPORT_CAPABILITY);
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
        // The Hello SUCCEEDED — keep it, and every row it feeds. Only the rows this phase
        // would have produced are unknown, and unknown is a skip.
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

/**
 * Bind-test one host port. The capability preflight mirrors `connectBackupAgent`: an agent
 * that never advertised `checkport` is not asked, so an old agent degrades to an honest
 * "skipped" row instead of a fabricated pass. The catch is the belt-and-braces for an agent
 * that advertises the flag yet answers UNIMPLEMENTED anyway.
 */
async function probePort(
  conn: AgentConnection,
  port: number,
  supported: boolean,
  name: string,
): Promise<PortProbe> {
  if (!supported) return { kind: "unsupported" };
  try {
    const res = await conn.checkPort(port);
    // Polarity inverts for a WEB port: "available" (nothing listening) is the BAD outcome.
    return res.available ? { kind: "free" } : { kind: "held" };
  } catch (e) {
    const mapped = mapCheckPortUnsupported(e);
    if (mapped instanceof AgentCheckPortUnsupportedError) return { kind: "unsupported" };
    console.error(`[deplo] readiness check for ${name}: checkPort(${port}): ${String(e)}`);
    return { kind: "failed" };
  }
}

/**
 * Host metrics. NOT capability-preflighted — Metrics predates the feature list and `metricsFor`
 * doesn't gate it either; an agent old enough to lack the flag may still answer. A failure is
 * simply "we don't know", which the classifier reports as a skipped disk row.
 */
async function probeMetrics(conn: AgentConnection, name: string): Promise<HostMetrics | null> {
  try {
    // "" => the agent measures its own --data-dir (the installer points it at the host root).
    return await conn.metrics("");
  } catch (e) {
    console.error(`[deplo] readiness check for ${name}: metrics: ${String(e)}`);
    return null;
  }
}
