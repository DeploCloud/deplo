import type { HelloResponse, HostMetrics } from "../../agent/gen/agent";
import type { Server } from "../../types/server";

// ReadinessSeverity - a `skip` NEVER moves the verdict: "we didn't look" is not "it's broken".
export type ReadinessSeverity = "pass" | "info" | "warn" | "fail" | "skip";

export type ReadinessGroup =
  "agent" | "docker" | "routing" | "capacity" | "build" | "config";

export interface ReadinessCheck {
  /** Stable id, e.g. "build.nixpacks". Not a GraphQL enum (it contains a dot). */
  id: string;
  group: ReadinessGroup;
  label: string;
  severity: ReadinessSeverity;
  detail: string;
  /** Only present on info/warn/fail/skip rows, never on `pass`. */
  hint?: string;
}

export type ReadinessVerdict =
  "ready" | "degraded" | "not_ready" | "provisioning";

export interface ReadinessReport {
  serverId: string;
  serverName: string;
  /** ISO instant the probe STARTED. Never fabricated. */
  checkedAt: string;
  verdict: ReadinessVerdict;
  /** One sentence for the banner. Closed set (see {@link readinessSummary}). */
  summary: string;
  /** Emitted in group order: agent → docker → routing → capacity → build → config. */
  checks: ReadinessCheck[];
}

/** The outcome of one CheckPort RPC, as a closed set, never a raw error. */
export type PortProbe =
  /** The agent could NOT bind it: something on the host is listening. */
  | { kind: "held" }
  /** The agent bound and released it: NOTHING is listening. */
  | { kind: "free" }
  /** The agent is too old to test host ports (no `checkport` in Hello, or UNIMPLEMENTED). */
  | { kind: "unsupported" }
  /** The RPC errored for another reason. The raw error went to the console, not here. */
  | { kind: "failed" }
  /** We never asked (no agent to dial, or the Hello failed first). */
  | { kind: "skipped" };

/** Everything one probe collected. The classifier's ONLY input. */
export interface ReadinessProbe {
  /** The row as the control plane knows it. Never dialed to obtain. */
  server: Server;
  /** How many teams are explicitly granted this server (0 when `server.allTeams`). */
  grantedTeamCount: number;
  observedAt: string;
  hello: HelloResponse | null;
  /** The Hello rejection. `hello: null` + `helloError: null` = we never dialed. */
  helloError: unknown;
  port80: PortProbe;
  port443: PortProbe;
  /** Host metrics, or null when the Metrics RPC failed or was never made. */
  metrics: HostMetrics | null;
}
