import { builder } from "../../builder";
import { ServerRef } from "./server-ref";
import {
  checkServerHealth,
  checkAllServerHealth,
} from "@/lib/data/server-health";
import { checkServerReadiness } from "@/lib/data/server-readiness";
import { refreshAgentVersion } from "@/lib/data/updates";
import type {
  ReadinessCheck,
  ReadinessReport,
} from "@/lib/infra/server-readiness/types";

const ServerReadinessSeverityEnum = builder.enumType(
  "ServerReadinessSeverity",
  {
    description:
      "How much a readiness row matters. fail = a deployment to this server cannot succeed. warn = a deployment succeeds, but the result is not fully usable. info = a true, neutral fact. pass = verified good. skip = we could not evaluate it (the agent is too old, or an upstream fact is missing) - a skip never moves the verdict.",
    values: ["pass", "info", "warn", "fail", "skip"] as const,
  },
);

const ServerReadinessGroupEnum = builder.enumType("ServerReadinessGroup", {
  values: [
    "agent",
    "docker",
    "routing",
    "capacity",
    "build",
    "config",
  ] as const,
});

const ServerReadinessVerdictEnum = builder.enumType("ServerReadinessVerdict", {
  description:
    "The report's overall answer. provisioning = no agent has called home yet (never dialed). A `fail` row outranks `provisioning`.",
  values: ["ready", "degraded", "not_ready", "provisioning"] as const,
});

const ServerReadinessCheckRef = builder
  .objectRef<ReadinessCheck>("ServerReadinessCheck")
  .implement({
    description:
      "One row of a server readiness report: a single thing Deplo could verify about the host, and what it found.",
    fields: (t) => ({
      id: t.exposeString("id", {
        description:
          'Stable row id, e.g. "docker.available" or "build.nixpacks".',
      }),
      group: t.field({
        type: ServerReadinessGroupEnum,
        resolve: (c) => c.group,
      }),
      label: t.exposeString("label"),
      severity: t.field({
        type: ServerReadinessSeverityEnum,
        resolve: (c) => c.severity,
      }),
      detail: t.exposeString("detail", {
        description:
          "What we found. Drawn from a closed, curated set whenever it describes a failure, never a raw agent error (which would leak the pinned certificate fingerprint and the dial address).",
      }),
      hint: t.string({
        nullable: true,
        description: "What to do about it. Null on a `pass` row.",
        resolve: (c) => c.hint ?? null,
      }),
    }),
  });

const ServerReadinessReportRef = builder
  .objectRef<ReadinessReport>("ServerReadinessReport")
  .implement({
    description:
      "A live, never-persisted answer to 'is this host set up to run deployments?'. Assembled from one agent Hello, two host port bind-tests and one host-metrics call, plus the control plane's own record of the server. It is NOT a sixth ServerStatus and nothing gates on it - the deploy gate is and stays the mandatory live Hello pre-flight.",
    fields: (t) => ({
      serverId: t.exposeString("serverId"),
      serverName: t.exposeString("serverName"),
      checkedAt: t.exposeString("checkedAt", {
        description: "When the probe STARTED (ISO). Never fabricated.",
      }),
      verdict: t.field({
        type: ServerReadinessVerdictEnum,
        resolve: (r) => r.verdict,
      }),
      summary: t.exposeString("summary", {
        description: "One sentence for the banner.",
      }),
      checks: t.field({
        type: [ServerReadinessCheckRef],
        resolve: (r) => r.checks,
      }),
    }),
  });

builder.mutationFields((t) => ({
  checkServerHealth: t.field({
    type: ServerRef,
    authScopes: { instanceAdmin: true },
    description:
      "Probe ONE server's agent right now (a live Hello) and persist what it reports: online, warning (agent up, Docker unreachable), error (agent untrusted or broken) or offline. Returns the refreshed server. Throttled server-side even when forced, so it cannot be used to hammer a host; an inconclusive probe leaves the previous observation untouched rather than guessing.",
    args: {
      id: t.arg.string({ required: true }),
      force: t.arg.boolean({
        required: false,
        description:
          "Bypass the ambient throttle (the operator asked for this check explicitly). A short floor still applies.",
      }),
    },
    resolve: (_r, { id, force }) =>
      checkServerHealth(id, { force: force ?? false }),
  }),
  checkAllServerHealth: t.field({
    type: [ServerRef],
    authScopes: { instanceAdmin: true },
    description:
      "Probe every provisioned server's agent and persist each outcome; returns every server (unprovisioned ones pass through untouched). This is what the Servers page runs on load, so a reload always reflects reality rather than the status a server had when it first called home.",
    args: {
      force: t.arg.boolean({
        required: false,
        description:
          "Bypass the ambient throttle (the header's 'Check all' button).",
      }),
    },
    resolve: (_r, { force }) => checkAllServerHealth({ force: force ?? false }),
  }),
  checkServerReadiness: t.field({
    type: ServerReadinessReportRef,
    authScopes: { instanceAdmin: true },
    description:
      "Check whether ONE server's installation is complete enough to run deployments, right now. Dials the agent (Hello), bind-tests host ports 80 and 443, and reads host metrics, then reports what it found: the agent's handshake/protocol/version and which build methods and platform features it supports, whether Docker answers, whether a Traefik container is running and holds the web ports, disk headroom, and this server's team access and deploy concurrency. Never persisted - it does not touch `status`, so it can neither create nor cure a stale badge. Degrades honestly: an agent too old to bind-test ports reports those rows as skipped, never as a pass.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => checkServerReadiness(id),
  }),
  checkAgentUpdates: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "Force an immediate re-resolution of the latest agent release from GitHub, bypassing the in-process cache. Returns the resolved expected agent version so the dashboard re-renders with fresh outdated badges. Use after publishing a new agent release rather than waiting out the cache TTL.",
    resolve: () => refreshAgentVersion(),
  }),
}));
