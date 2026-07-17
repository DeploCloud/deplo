import { status as GrpcStatus } from "@grpc/grpc-js";

import { ContractVersion, type HelloResponse, type HostMetrics } from "../agent/gen/agent";
import { AgentUnreachableError } from "./agent-client";
import { isAgentOutdated } from "../version";
import type { Server } from "../types";

/**
 * The readiness CLASSIFIER: given everything one bounded probe of a server can honestly
 * learn — a Hello (or the error it rejected with), two host-port bind tests, host metrics,
 * and the control-plane's own row — decide what we can TRUTHFULLY tell the operator about
 * whether this host is set up to run deployments.
 *
 * It is a pure function, deliberately hoisted out of the dial, for exactly the reason
 * `classifyServerHealth` is: there is no mocking seam for `connectAgent` in this repo (grpc
 * is real, `dial`/`resolveTarget` are module-private), so a decision welded to the RPC is a
 * decision that can never be tested. Everything hard here — which signals prove what, which
 * absences are normal, which strings may be shown — lives in this file and is exercised by
 * lib/infra/server-readiness.test.ts without a socket.
 *
 * THE HONESTY RULE, which every string below obeys:
 *   A Hello `capabilities[]` entry is a compiled-in constant of the agent BINARY. It proves
 *   "this agent knows how to run Nixpacks builds". It does NOT prove the `nixpacks` binary is
 *   on the host — the agent downloads it on the first Nixpacks build. There is no RPC that
 *   reports tool presence, so this module never claims one is "installed". Likewise
 *   `traefikRunning` is a substring match over running containers' image/name, and it is
 *   FORCED false when Docker is unreachable — so Docker-down makes the Traefik row `skip`,
 *   not `warn`. Never let copy promise a capability the contract does not have (ADR-0011).
 *
 * This module NEVER produces a ServerStatus and nothing here is persisted. Readiness is a
 * live read; `servers.status` belongs to the health prober (lib/data/server-health.ts).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a row means. The contract, in one line each — hold to it, or the report becomes a
 * wall of colour nobody reads:
 *   fail — a deployment to this server CANNOT succeed.
 *   warn — a deployment succeeds, but the result is not fully usable / needs attention.
 *   info — a true, neutral fact worth showing. Never a problem.
 *   pass — verified good.
 *   skip — we could not evaluate this (the agent is too old, or an upstream fact is missing).
 *          A skip NEVER moves the verdict: "we didn't look" is not "it's broken".
 */
export type ReadinessSeverity = "pass" | "info" | "warn" | "fail" | "skip";

export type ReadinessGroup =
  | "agent"
  | "docker"
  | "routing"
  | "capacity"
  | "build"
  | "config";

export interface ReadinessCheck {
  /** Stable id, e.g. "build.nixpacks". Not a GraphQL enum (it contains a dot). */
  id: string;
  group: ReadinessGroup;
  /** The short row title, e.g. "Nixpacks". */
  label: string;
  severity: ReadinessSeverity;
  /** What we found. Drawn from the CLOSED set below whenever it describes a failure. */
  detail: string;
  /** What to do about it. Only present on info/warn/fail/skip rows, never on `pass`. */
  hint?: string;
}

export type ReadinessVerdict = "ready" | "degraded" | "not_ready" | "provisioning";

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

/** The outcome of one CheckPort RPC, as a closed set — never a raw error. */
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
  /** The latest agent release, resolved by the CALLER (async, so never in here). */
  expectedAgentVersion: string;
  /** How many teams are explicitly granted this server (0 when `server.allTeams`). */
  grantedTeamCount: number;
  /** ISO instant the probe started. */
  observedAt: string;
  /** The Hello response, or null when the dial/handshake failed or was never made. */
  hello: HelloResponse | null;
  /** The Hello rejection, or null. `hello: null` + `helloError: null` = we never dialed. */
  helloError: unknown;
  port80: PortProbe;
  port443: PortProbe;
  /** Host metrics, or null when the Metrics RPC failed or was never made. */
  metrics: HostMetrics | null;
}

/* ------------------------------------------------------------------ */
/* The closed sets                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every reason string this classifier can produce for a FAILURE, and every remediation it can
 * suggest. Closed on purpose, exactly like HEALTH_MESSAGES: these strings are served over
 * GraphQL, and the raw errors they would otherwise carry are not safe to show.
 * `checkServerIdentity`'s text embeds the PINNED FINGERPRINT (our trust anchor); grpc-js
 * UNAVAILABLE details routinely embed the dial address (`10.x.x.x:9443`). None of that belongs
 * in a report. The raw error goes to `console.error` in lib/data/server-readiness.ts and
 * nowhere else.
 *
 * THE INVARIANT (asserted by lib/infra/server-readiness.test.ts): no value derived from an
 * Error — its `message`, its gRPC `details`, its `code` — may ever reach a `detail` or a
 * `hint`. The formatters below interpolate only numbers and strings the CONTROL PLANE owns
 * (a port, a percentage, a version, a team count, a build-method label).
 */
export const READINESS_MESSAGES = {
  // agent
  notProvisioned:
    "No agent has been provisioned for this server yet — nothing has called home, so there is nothing on the host to check.",
  untrusted:
    "The agent's certificate is not the one we trust for this server. Reissue the install command to re-provision it.",
  contract:
    "The agent speaks an unsupported protocol version, so nothing else it reports can be trusted.",
  agentError: "The agent answered with an error. Check the agent's logs on the host.",
  refused: "The agent did not answer (connection refused). Is it running on the host?",
  timedOut: "The agent did not answer within the readiness check's deadline.",
  featuresUnknown:
    "This agent does not report which features it supports — it predates the feature list.",
  // docker
  dockerDown:
    "The agent is up, but the Docker daemon did not answer. Nothing can be built or run on this server.",
  // routing
  traefikDown:
    "No running Traefik container was found on this host. Apps deployed here will start, but they won't be reachable on their domains.",
  traefikUnknown:
    "Docker is unreachable, so the agent could not see whether a Traefik container is running.",
  // capacity
  metricsUnavailable:
    "The agent did not report host metrics, so disk headroom was not checked.",
  diskUnmeasured:
    "The agent could not measure the host's filesystem, so disk headroom was not checked.",
  // config
  noTeamAccess:
    "No team can deploy to this server: it is restricted, but no team has been granted access.",
} as const;

export const READINESS_HINTS = {
  installAgent:
    "Run the install command on the host (Server actions → Show install command). The agent calls home and provisions itself.",
  reissue:
    "Reissue the install command for this server (Server actions → Reissue install command) and run it on the host.",
  agentLogs:
    "Check that the deplo-agent service is running on the host and that this control plane can reach it on its agent port.",
  updateAgent:
    "Update the agent on this server (Server actions → Update agent), then run this check again.",
  startDocker:
    "Install Docker on the host, or start it (systemctl start docker), then run this check again.",
  installTraefik:
    "Normal for a database-only or worker host. Otherwise re-run the install command on the host — it brings Traefik up.",
  // NOT installTraefik: Traefik is already running here, and this is demonstrably not a
  // database-only host — telling the operator it is "normal" would invite them to dismiss the
  // one row that explains why every domain on this host 404s.
  publishWebPorts:
    "Traefik is running but is not publishing the web ports. Check its port bindings on the host, then re-run the install command so it binds them.",
  freeWebPort:
    "Stop whatever holds the port on the host, then re-run the install command so Traefik can bind it.",
  freeDisk:
    "Free space on the host — remove unused images and build caches (docker system prune -af).",
  retry: "Run the check again; if it keeps failing, check the agent's logs on the host.",
  grantTeamAccess:
    "Grant a team access (Server actions → Team access), or open the server to all teams.",
} as const;

/** Interpolating copy. Every argument is a control-plane-owned value, never error text. */
export const READINESS_DETAILS = {
  helloOk:
    "The agent answered a live handshake over its pinned, mutually-authenticated connection.",
  contractOk: "The agent speaks the V1 agent contract this control plane uses.",
  versionUnreported: "The agent did not report a version.",
  versionUncomparable: (v: string) =>
    `The agent reports version "${v}", which can't be compared to a release.`,
  versionLatest: (v: string) => `The agent is running v${v} — the latest release.`,
  versionAhead: (v: string, expected: string) =>
    `The agent is running v${v}, ahead of the latest release (v${expected}).`,
  versionOutdated: (v: string, expected: string) =>
    `This server runs agent v${v}. v${expected} is available.`,
  featuresAllSupported:
    "This agent supports every platform feature Deplo uses: backups, dev containers, the SSH gateway, VS Code tunnels, host metrics, host port checks, in-place agent updates, and moving data between servers.",
  featuresMissing: (names: string[]) =>
    `This agent does not support ${names.length} feature${names.length === 1 ? "" : "s"} Deplo uses (${names.join(", ")}). Apps still deploy here, but those features won't work on this server.`,
  dockerOk: (version: string) =>
    version
      ? `The Docker daemon answered on the host — engine ${version}.`
      : "The Docker daemon answered on the host.",
  // The ONLY signal is `traefikRunning`: a substring match over running containers' image and
  // name, which the agent's own comment says "covers the deplo-traefik instance and a
  // bring-your-own proxy alike". It does not prove the container is the one Deplo installed,
  // that it is attached to the `deplo` network app routers are pinned to, or that its
  // entrypoints are the web ports. State the observation, hedge the consequence — the same
  // register the sibling port rows already use.
  traefikOk:
    "A container whose image or name contains \"traefik\" is running on this host — consistent with a proxy that can route apps to their domains. Deplo cannot verify from here that it is the one it installed, or that it is on the deplo network.",
  portHeldWithTraefik: (port: number) =>
    `Port ${port} is held by a listener on the host, and a Traefik container is running — consistent with Traefik serving it.`,
  portHeldNoTraefik: (port: number) =>
    `Port ${port} is already held on the host, but no Traefik container is running. Another process owns the web port, so Traefik cannot bind it.`,
  portHeldTraefikUnknown: (port: number) =>
    `Port ${port} is held by a listener on the host.`,
  portFreeWithTraefik: (port: number) =>
    `Nothing is listening on port ${port}, although a Traefik container is running — it is up but not publishing the web ports, so apps here won't be reachable on their domains.`,
  portFreeNoTraefik: (port: number) =>
    `Nothing is listening on port ${port} — consistent with no Traefik container running on this host.`,
  portFreeTraefikUnknown: (port: number) => `Nothing is listening on port ${port}.`,
  portUnsupported: (port: number) =>
    `This server's agent is too old to test host ports, so port ${port} was not checked.`,
  portFailed: (port: number) => `Port ${port} could not be checked on the host.`,
  portSkipped: (port: number) => `Port ${port} was not checked.`,
  diskOk: (pct: number, free: string) =>
    `The host's root filesystem is ${pct}% full (${free} free).`,
  diskLow: (pct: number, free: string) =>
    `The host's root filesystem is ${pct}% full (${free} free). Builds and image pulls may start failing.`,
  diskCritical: (pct: number, free: string) =>
    `The host's root filesystem is ${pct}% full (${free} free). A build or an image pull will almost certainly fail.`,
  buildMissing: (label: string) =>
    `This server's agent does not support ${label} builds — it predates the feature. An app on this server that builds this way will fail.`,
  teamsAll: "Every team can deploy to this server.",
  teamsSome: (n: number) =>
    `${n} team${n === 1 ? "" : "s"} can deploy to this server.`,
  concurrency: (n: number) =>
    n === 1
      ? "This server runs one deployment at a time."
      : `This server runs up to ${n} deployments at a time.`,
} as const;

/* ------------------------------------------------------------------ */
/* Thresholds + capability constants                                   */
/* ------------------------------------------------------------------ */

/**
 * Disk thresholds, on the filesystem the AGENT measures — which the installer points at `/`
 * (the host's ROOT filesystem), not `/var/lib/docker`. If the Docker graph dir is on its own
 * volume these numbers do not describe it; that caveat rides in the group's tooltip, and the
 * copy above says "root filesystem" and nothing more.
 */
export const DISK_WARN_PCT = 90;
export const DISK_FAIL_PCT = 95;

/** The Hello flag that gates CheckPort. Mirrors BACKUP_CAPABILITY / SELF_UPDATE_CAPABILITY. */
export const CHECKPORT_CAPABILITY = "checkport";

/** The web ports Traefik publishes. Nothing else is probed. */
export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;

/**
 * The BUILD METHODS an operator can select for an App, and the Hello flag each needs. The
 * `supported` copy is the whole honesty budget of this feature — it says what the flag proves
 * ("the agent supports X") and, where the tool is fetched at build time, says so.
 *
 * `deploy.compose.single` is deliberately NOT surfaced: it is the agent's internal
 * single-image runtime, not a build method the operator chooses, so a row for it would be one
 * nobody can act on.
 */
export interface BuildMethodSpec {
  id: string;
  capability: string;
  label: string;
  supported: string;
}

export const BUILD_METHODS: readonly BuildMethodSpec[] = [
  {
    id: "build.dockerfile",
    capability: "deploy.dockerfile",
    label: "Dockerfile",
    supported: "The agent supports Dockerfile builds.",
  },
  {
    id: "build.image",
    capability: "deploy.image",
    label: "Prebuilt image",
    supported: "The agent supports running a prebuilt image as-is.",
  },
  {
    id: "build.compose",
    capability: "deploy.compose.multi",
    label: "Compose stack",
    supported: "The agent supports multi-service Compose stacks.",
  },
  {
    id: "build.static",
    capability: "deploy.static",
    label: "Static site",
    supported:
      "The agent supports static-site builds. The nginx and Node images it needs are pulled from the registry on the first build — nothing is installed on the host.",
  },
  {
    id: "build.nixpacks",
    capability: "deploy.nixpacks",
    label: "Nixpacks",
    supported:
      "The agent supports Nixpacks builds. The nixpacks binary itself is downloaded to the host on the first Nixpacks build — Deplo cannot verify from here that it is already there.",
  },
  {
    id: "build.buildpacks",
    capability: "deploy.buildpacks",
    label: "Buildpacks",
    supported:
      "The agent supports Cloud Native Buildpacks. pack and the builder images run in containers, pulled on the first build — nothing is installed on the host.",
  },
  {
    id: "build.railpack",
    capability: "deploy.railpack",
    label: "Railpack",
    supported:
      "The agent supports Railpack builds. Railpack and BuildKit run in throwaway containers, pulled on the first build — nothing is installed on the host.",
  },
] as const;

/**
 * The non-build platform features Deplo drives through the agent. Rendered as ONE row: their
 * value is the ABSENCE case (a missing one means the agent predates the feature → "update the
 * agent"), exactly how BACKUP_CAPABILITY / SELF_UPDATE_CAPABILITY are already used.
 */
export const PLATFORM_FEATURES: readonly { capability: string; name: string }[] = [
  { capability: "metrics", name: "host metrics" },
  { capability: "container-stats", name: "per-app monitoring" },
  { capability: "checkport", name: "host port checks" },
  { capability: "backup", name: "backups" },
  { capability: "dev", name: "dev containers" },
  { capability: "ssh-gateway", name: "the SSH gateway" },
  { capability: "tunnel", name: "VS Code tunnels" },
  { capability: "self-update", name: "in-place agent updates" },
  { capability: "volume-copy", name: "moving data between servers" },
  { capability: "files-copy", name: "moving app files between servers" },
] as const;

/* ------------------------------------------------------------------ */
/* Verdict + summary                                                   */
/* ------------------------------------------------------------------ */

/**
 * `fail` beats everything — a brand-new server that no team can reach is "not ready", not
 * "provisioning". `skip` never moves the verdict: "we didn't look" is not "it's broken".
 */
export function readinessVerdict(
  checks: ReadinessCheck[],
  opts: { provisioning: boolean },
): ReadinessVerdict {
  if (checks.some((c) => c.severity === "fail")) return "not_ready";
  if (opts.provisioning) return "provisioning";
  if (checks.some((c) => c.severity === "warn")) return "degraded";
  return "ready";
}

/**
 * A `skip` does not move the VERDICT ("we didn't look" is not "it's broken"), but it must not
 * be laundered into a pass by the sentence the operator actually reads. A report where both
 * CheckPort probes were skipped, or where the agent reported no capabilities at all, is not one
 * where "every check passed" — it is one where some checks were never run. Say so.
 */
export function readinessSummary(
  verdict: ReadinessVerdict,
  checks: ReadinessCheck[],
): string {
  const fails = checks.filter((c) => c.severity === "fail").length;
  const warns = checks.filter((c) => c.severity === "warn").length;
  const skips = checks.filter((c) => c.severity === "skip").length;
  const passes = checks.filter((c) => c.severity === "pass").length;
  switch (verdict) {
    case "provisioning":
      return "No agent has called home for this server yet — run its install command on the host.";
    case "not_ready":
      return `Not ready to deploy — ${fails === 1 ? "1 check failed" : `${fails} checks failed`}.`;
    case "degraded":
      return `Deploys will run, but ${warns === 1 ? "1 check needs" : `${warns} checks need`} attention.`;
    case "ready":
      return skips === 0
        ? "Ready to deploy — every check passed."
        : `Deploys should run — ${passes === 1 ? "1 check passed" : `${passes} checks passed`}, ${skips === 1 ? "1 could not be checked" : `${skips} could not be checked`}.`;
  }
}

/* ------------------------------------------------------------------ */
/* The classifier                                                      */
/* ------------------------------------------------------------------ */

/**
 * THE PRINCIPLE that decides which rows exist:
 *   the report always contains every check whose INPUTS we actually have.
 * Control-plane facts (the `config` group) never need a dial, so they are ALWAYS present.
 * Dial-derived facts appear only when the dial produced them. Concretely:
 *   - no agent yet / trust revoked → [agent.bootstrap] + config.*      (verdict: provisioning)
 *   - the Hello failed             → [agent.hello (fail)] + config.*   (verdict: not_ready)
 *   - the contract is wrong        → [agent.hello (pass), agent.contract (fail)] + config.*
 *   - the Hello succeeded          → the full set.
 * A wall of grey "skipped" rows under a dead agent would bury the one fact that matters, and a
 * response from an agent speaking a protocol we don't understand is not evidence of anything.
 */
export function classifyServerReadiness(probe: ReadinessProbe): ReadinessReport {
  const { server } = probe;
  const checks: ReadinessCheck[] = [];

  // The fence, identical to the health prober's: a NON-EMPTY cert pin is the only proof there
  // is an agent on the other end. `removeServer` revokes trust by writing "" (not NULL), so
  // the empty string is a second sentinel and a revoked row is treated exactly like a
  // never-provisioned one.
  const provisioning = !server.agent?.certFingerprint;

  if (provisioning) {
    checks.push({
      id: "agent.bootstrap",
      group: "agent",
      label: "Agent installed",
      severity: "warn",
      detail: READINESS_MESSAGES.notProvisioned,
      hint: READINESS_HINTS.installAgent,
    });
    checks.push(...configChecks(probe));
    return report(probe, checks, { provisioning: true });
  }

  if (probe.helloError || !probe.hello) {
    checks.push(helloFailure(probe.helloError));
    checks.push(...configChecks(probe));
    return report(probe, checks, { provisioning: false });
  }

  const hello = probe.hello;

  checks.push({
    id: "agent.hello",
    group: "agent",
    label: "Agent handshake",
    severity: "pass",
    detail: READINESS_DETAILS.helloOk,
  });

  if (hello.contractVersion !== ContractVersion.CONTRACT_VERSION_V1) {
    checks.push({
      id: "agent.contract",
      group: "agent",
      label: "Agent protocol",
      severity: "fail",
      detail: READINESS_MESSAGES.contract,
      hint: READINESS_HINTS.updateAgent,
    });
    checks.push(...configChecks(probe));
    return report(probe, checks, { provisioning: false });
  }

  checks.push({
    id: "agent.contract",
    group: "agent",
    label: "Agent protocol",
    severity: "pass",
    detail: READINESS_DETAILS.contractOk,
  });
  checks.push(versionCheck(hello.agentVersion, probe.expectedAgentVersion));
  checks.push(featuresCheck(hello.capabilities ?? []));

  // docker
  checks.push(
    hello.dockerAvailable
      ? {
          id: "docker.available",
          group: "docker",
          label: "Docker engine",
          severity: "pass",
          detail: READINESS_DETAILS.dockerOk(hello.dockerVersion),
        }
      : {
          id: "docker.available",
          group: "docker",
          label: "Docker engine",
          severity: "fail",
          detail: READINESS_MESSAGES.dockerDown,
          hint: READINESS_HINTS.startDocker,
        },
  );

  // routing. `traefikRunning` is FORCED false by the agent when Docker is unreachable, so with
  // Docker down we never actually looked — that is `skip`, not `warn`. Downstream, `traefik`
  // becomes null ("unknown") so the port rows stop reasoning about a fact we don't have.
  const traefik: boolean | null = hello.dockerAvailable ? hello.traefikRunning : null;
  checks.push(traefikCheck(traefik));
  checks.push(portCheck("routing.port80", "Port 80 (HTTP)", HTTP_PORT, probe.port80, traefik));
  checks.push(
    portCheck("routing.port443", "Port 443 (HTTPS)", HTTPS_PORT, probe.port443, traefik),
  );

  // capacity
  checks.push(diskCheck(probe.metrics));

  // build methods
  checks.push(...buildChecks(hello.capabilities ?? []));

  // control-plane config
  checks.push(...configChecks(probe));

  return report(probe, checks, { provisioning: false });
}

/* ------------------------------------------------------------------ */
/* Row builders (module-private)                                       */
/* ------------------------------------------------------------------ */

function report(
  probe: ReadinessProbe,
  checks: ReadinessCheck[],
  opts: { provisioning: boolean },
): ReadinessReport {
  const verdict = readinessVerdict(checks, opts);
  return {
    serverId: probe.server.id,
    serverName: probe.server.name,
    checkedAt: probe.observedAt,
    verdict,
    summary: readinessSummary(verdict, checks),
    checks,
  };
}

/**
 * The ONE failed row a dead / untrusted / broken agent produces. Mirrors
 * `classifyServerHealth`'s error branch exactly, including why a TRUST failure is never
 * reported as "did not answer": the peer answered, it just isn't the agent we pinned.
 */
function helloFailure(err: unknown): ReadinessCheck {
  const row = (detail: string, hint: string): ReadinessCheck => ({
    id: "agent.hello",
    group: "agent",
    label: "Agent handshake",
    severity: "fail",
    detail,
    hint,
  });
  if (err instanceof AgentUnreachableError) {
    if (err.trust) return row(READINESS_MESSAGES.untrusted, READINESS_HINTS.reissue);
    return err.code === GrpcStatus.DEADLINE_EXCEEDED
      ? row(READINESS_MESSAGES.timedOut, READINESS_HINTS.agentLogs)
      : row(READINESS_MESSAGES.refused, READINESS_HINTS.agentLogs);
  }
  return row(READINESS_MESSAGES.agentError, READINESS_HINTS.agentLogs);
}

/** Deliberately local: lib/version.ts has no exported "is this comparable?" predicate. */
const AGENT_SEMVER_RE = /^v?\d+\.\d+\.\d+/;
const stripV = (v: string) => v.replace(/^v/i, "");

function versionCheck(agentVersion: string, expected: string): ReadinessCheck {
  const base = { id: "agent.version", group: "agent" as const, label: "Agent version" };
  if (!agentVersion)
    return { ...base, severity: "info", detail: READINESS_DETAILS.versionUnreported };
  if (!AGENT_SEMVER_RE.test(agentVersion))
    return {
      ...base,
      severity: "info",
      detail: READINESS_DETAILS.versionUncomparable(agentVersion),
    };
  if (isAgentOutdated(agentVersion, expected))
    return {
      ...base,
      severity: "warn",
      detail: READINESS_DETAILS.versionOutdated(stripV(agentVersion), stripV(expected)),
      hint: READINESS_HINTS.updateAgent,
    };
  return stripV(agentVersion) === stripV(expected)
    ? { ...base, severity: "pass", detail: READINESS_DETAILS.versionLatest(stripV(agentVersion)) }
    : {
        ...base,
        severity: "pass",
        detail: READINESS_DETAILS.versionAhead(stripV(agentVersion), stripV(expected)),
      };
}

function featuresCheck(capabilities: string[]): ReadinessCheck {
  const base = { id: "agent.features", group: "agent" as const, label: "Agent features" };
  if (capabilities.length === 0)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.featuresUnknown,
      hint: READINESS_HINTS.updateAgent,
    };
  const missing = PLATFORM_FEATURES.filter((f) => !capabilities.includes(f.capability));
  if (missing.length === 0)
    return { ...base, severity: "pass", detail: READINESS_DETAILS.featuresAllSupported };
  return {
    ...base,
    severity: "warn",
    detail: READINESS_DETAILS.featuresMissing(missing.map((f) => f.name)),
    hint: READINESS_HINTS.updateAgent,
  };
}

/**
 * Traefik being down is a WARN, never a fail — a database-only or worker host legitimately has
 * none, and a status that fires on a normal configuration is one operators learn to ignore
 * (the same decision `classifyServerHealth` makes and lib/infra/server-health.test.ts pins).
 */
function traefikCheck(traefik: boolean | null): ReadinessCheck {
  const base = { id: "routing.traefik", group: "routing" as const, label: "Traefik proxy" };
  if (traefik === null)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.traefikUnknown,
      hint: READINESS_HINTS.startDocker,
    };
  return traefik
    ? { ...base, severity: "pass", detail: READINESS_DETAILS.traefikOk }
    : {
        ...base,
        severity: "warn",
        detail: READINESS_MESSAGES.traefikDown,
        hint: READINESS_HINTS.installTraefik,
      };
}

/**
 * CheckPort binds 0.0.0.0:<port> and releases it. For a WEB port the polarity inverts:
 * "available" (nothing listening) is the BAD outcome. Crossed with the Traefik fact this is
 * the report's most valuable finding — a held :80 with no Traefik running is the classic
 * "something else owns the web port, so Traefik never came up" broken install.
 */
function portCheck(
  id: string,
  label: string,
  port: number,
  probe: PortProbe,
  traefik: boolean | null,
): ReadinessCheck {
  const base = { id, group: "routing" as const, label };
  switch (probe.kind) {
    case "unsupported":
      return {
        ...base,
        severity: "skip",
        detail: READINESS_DETAILS.portUnsupported(port),
        hint: READINESS_HINTS.updateAgent,
      };
    case "failed":
      return {
        ...base,
        severity: "skip",
        detail: READINESS_DETAILS.portFailed(port),
        hint: READINESS_HINTS.retry,
      };
    case "skipped":
      return {
        ...base,
        severity: "skip",
        detail: READINESS_DETAILS.portSkipped(port),
        hint: READINESS_HINTS.retry,
      };
    case "held":
      if (traefik === null)
        return {
          ...base,
          severity: "info",
          detail: READINESS_DETAILS.portHeldTraefikUnknown(port),
        };
      return traefik
        ? { ...base, severity: "pass", detail: READINESS_DETAILS.portHeldWithTraefik(port) }
        : {
            ...base,
            severity: "warn",
            detail: READINESS_DETAILS.portHeldNoTraefik(port),
            hint: READINESS_HINTS.freeWebPort,
          };
    case "free":
      if (traefik === null)
        return {
          ...base,
          severity: "info",
          detail: READINESS_DETAILS.portFreeTraefikUnknown(port),
        };
      return traefik
        ? {
            ...base,
            severity: "warn",
            detail: READINESS_DETAILS.portFreeWithTraefik(port),
            hint: READINESS_HINTS.publishWebPorts,
          }
        : // Restating what routing.traefik already warned about — `info`, not a second warn.
          { ...base, severity: "info", detail: READINESS_DETAILS.portFreeNoTraefik(port) };
  }
}

/** `diskTotal === 0` means the agent's statfs FAILED. It is not "0% used" — it is unknown. */
function diskCheck(metrics: HostMetrics | null): ReadinessCheck {
  const base = { id: "capacity.disk", group: "capacity" as const, label: "Disk headroom" };
  if (!metrics)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.metricsUnavailable,
      hint: READINESS_HINTS.retry,
    };
  const total = Number(metrics.diskTotal);
  const used = Number(metrics.diskUsed);
  if (!Number.isFinite(total) || total <= 0)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.diskUnmeasured,
      hint: READINESS_HINTS.retry,
    };
  // ONE number, displayed and classified. `diskPct` is a proto3 double with no field presence,
  // so an agent that fills disk_total/disk_used but not disk_pct arrives here as 0 — hence the
  // used/total fallback. Classifying on the raw field while PRINTING the fallback would render
  // a 98%-full host as a green `pass` whose own text says it is 98% full. And `floor`, never
  // `round`: rounding 94.7 up to "95% full" while classifying it as a warn puts the number on
  // the wrong side of the threshold the copy is read against.
  const rawPct = Number(metrics.diskPct);
  const pct = Math.floor(
    Number.isFinite(rawPct) && rawPct > 0 ? rawPct : (used / total) * 100,
  );
  const free = formatBytes(Math.max(0, total - used));
  if (pct >= DISK_FAIL_PCT)
    return {
      ...base,
      severity: "fail",
      detail: READINESS_DETAILS.diskCritical(pct, free),
      hint: READINESS_HINTS.freeDisk,
    };
  if (pct >= DISK_WARN_PCT)
    return {
      ...base,
      severity: "warn",
      detail: READINESS_DETAILS.diskLow(pct, free),
      hint: READINESS_HINTS.freeDisk,
    };
  return { ...base, severity: "pass", detail: READINESS_DETAILS.diskOk(pct, free) };
}

function buildChecks(capabilities: string[]): ReadinessCheck[] {
  if (capabilities.length === 0)
    return [
      {
        id: "build.unknown",
        group: "build",
        label: "Build methods",
        severity: "skip",
        detail: READINESS_MESSAGES.featuresUnknown,
        hint: READINESS_HINTS.updateAgent,
      },
    ];
  return BUILD_METHODS.map((m) =>
    capabilities.includes(m.capability)
      ? {
          id: m.id,
          group: "build" as const,
          label: m.label,
          severity: "pass" as const,
          detail: m.supported,
        }
      : {
          id: m.id,
          group: "build" as const,
          label: m.label,
          severity: "warn" as const,
          detail: READINESS_DETAILS.buildMissing(m.label),
          hint: READINESS_HINTS.updateAgent,
        },
  );
}

/**
 * Control-plane facts. No dial, so these are in EVERY report — including a provisioning one,
 * where "you restricted this server and granted it to nobody" is exactly what an operator
 * needs to see before they wonder why they can't target it.
 */
function configChecks(probe: ReadinessProbe): ReadinessCheck[] {
  const { server, grantedTeamCount } = probe;
  const access: ReadinessCheck = server.allTeams
    ? {
        id: "config.teamAccess",
        group: "config",
        label: "Team access",
        severity: "info",
        detail: READINESS_DETAILS.teamsAll,
      }
    : grantedTeamCount > 0
      ? {
          id: "config.teamAccess",
          group: "config",
          label: "Team access",
          severity: "info",
          detail: READINESS_DETAILS.teamsSome(grantedTeamCount),
        }
      : {
          id: "config.teamAccess",
          group: "config",
          label: "Team access",
          severity: "fail",
          detail: READINESS_MESSAGES.noTeamAccess,
          hint: READINESS_HINTS.grantTeamAccess,
        };
  return [
    access,
    {
      id: "config.deployConcurrency",
      group: "config",
      label: "Deploy concurrency",
      severity: "info",
      detail: READINESS_DETAILS.concurrency(server.deployConcurrency),
    },
  ];
}

/** GB with one decimal. Exported for the tests that pin the disk copy. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}
