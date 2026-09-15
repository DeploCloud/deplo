import type { HelloResponse, HostMetrics } from "../../agent/gen/agent";
import type { Server } from "../../types/server";

export type ReadinessSeverity = "pass" | "info" | "warn" | "fail" | "skip";

export type ReadinessGroup =
  "agent" | "docker" | "routing" | "capacity" | "build" | "config";

export interface ReadinessCheck {
  id: string;
  group: ReadinessGroup;
  label: string;
  severity: ReadinessSeverity;
  detail: string;
  hint?: string;
}

export type ReadinessVerdict =
  "ready" | "degraded" | "not_ready" | "provisioning";

export interface ReadinessReport {
  serverId: string;
  serverName: string;
  checkedAt: string;
  verdict: ReadinessVerdict;
  summary: string;
  checks: ReadinessCheck[];
}

export type PortProbe =
  | { kind: "held" }
  | { kind: "free" }
  | { kind: "unsupported" }
  | { kind: "failed" }
  | { kind: "skipped" };

export interface ReadinessProbe {
  server: Server;
  grantedTeamCount: number;
  observedAt: string;
  hello: HelloResponse | null;
  helloError: unknown;
  port80: PortProbe;
  port443: PortProbe;
  metrics: HostMetrics | null;
}
