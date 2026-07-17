import { test } from "node:test";
import assert from "node:assert/strict";
import { status as GrpcStatus } from "@grpc/grpc-js";

import { AgentUnreachableError } from "./agent-client";
import {
  BUILD_METHODS,
  classifyServerReadiness,
  READINESS_DETAILS,
  READINESS_HINTS,
  READINESS_MESSAGES,
  readinessVerdict,
  type ReadinessCheck,
  type ReadinessProbe,
  type ReadinessReport,
} from "./server-readiness";
import { ContractVersion, type HelloResponse, type HostMetrics } from "../agent/gen/agent";
import type { Server } from "../types";

/**
 * The readiness classifier, tested without a socket and without a DB.
 *
 * This is the whole reason the decision is hoisted out of the dial: there is no mocking seam
 * for `connectAgent` in this repo, so a classification welded to the RPC is one that can never
 * be exercised. Every honesty rule the feature makes — a Hello flag is not proof of an
 * installed binary, Docker-down means we never LOOKED for Traefik, a raw error never reaches
 * an operator-facing string — is pinned here.
 */

const ALL_CAPS = [
  "deploy.dockerfile",
  "deploy.image",
  "deploy.compose.single",
  "deploy.compose.multi",
  "deploy.static",
  "deploy.nixpacks",
  "deploy.buildpacks",
  "deploy.railpack",
  "metrics",
  "container-stats",
  "dev",
  "ssh-gateway",
  "tunnel",
  "self-update",
  "backup",
  "checkport",
  "volume-copy",
  "files-copy",
];

function hello(over: Partial<HelloResponse> = {}): HelloResponse {
  return {
    contractVersion: ContractVersion.CONTRACT_VERSION_V1,
    agentVersion: "1.1.0",
    dockerAvailable: true,
    dockerVersion: "27.0",
    capabilities: [...ALL_CAPS],
    traefikRunning: true,
    ...over,
  };
}

const GB = 1024 ** 3;

function metrics(over: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpu: 0,
    cpuCores: 0,
    memUsed: 0,
    memTotal: 0,
    memPct: 0,
    diskUsed: 20 * GB,
    diskTotal: 100 * GB,
    diskPct: 20,
    netRx: 0,
    netTx: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    uptimeSec: 0,
    runningContainers: 0,
    ...over,
  };
}

function srv(over: Partial<Server> = {}): Server {
  return {
    id: "srv_1",
    name: "eu-west-1",
    host: "10.0.0.5",
    type: "remote",
    status: "online",
    ip: "10.0.0.5",
    dockerVersion: "27.0",
    traefikEnabled: true,
    cpuCores: 4,
    memoryMb: 8192,
    diskGb: 100,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    allTeams: true,
    deployConcurrency: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    agent: { port: 9443, certFingerprint: "fp_1", certPem: "pem", version: "1.1.0" },
    ...over,
  };
}

function probe(over: Partial<ReadinessProbe> = {}): ReadinessProbe {
  return {
    server: srv(),
    expectedAgentVersion: "1.1.0",
    grantedTeamCount: 0,
    observedAt: "2026-07-13T10:00:00.000Z",
    hello: hello(),
    helloError: null,
    port80: { kind: "held" },
    port443: { kind: "held" },
    metrics: metrics(),
    ...over,
  };
}

const byId = (r: ReadinessReport, id: string) => r.checks.find((c) => c.id === id)!;
const countOf = (r: ReadinessReport, sev: ReadinessCheck["severity"]) =>
  r.checks.filter((c) => c.severity === sev).length;

/* ------------------------------------------------------------------ */
/* 1. the happy path                                                   */
/* ------------------------------------------------------------------ */

test("a fully-installed host is `ready` — every check passed", () => {
  const r = classifyServerReadiness(probe());
  assert.equal(r.verdict, "ready");
  assert.equal(countOf(r, "fail"), 0);
  assert.equal(countOf(r, "warn"), 0);
  assert.equal(r.summary, "Ready to deploy — every check passed.");
  assert.equal(r.serverId, "srv_1");
  assert.equal(r.serverName, "eu-west-1");
  assert.equal(r.checkedAt, "2026-07-13T10:00:00.000Z");
});

/* ------------------------------------------------------------------ */
/* 2-3. the fence: no agent, and trust revoked                         */
/* ------------------------------------------------------------------ */

test("no agent yet → `provisioning`, and we never pretend to have dialed", () => {
  const r = classifyServerReadiness(probe({ server: srv({ agent: undefined }) }));
  assert.equal(r.verdict, "provisioning");
  assert.deepEqual(
    r.checks.map((c) => c.id),
    ["agent.bootstrap", "config.teamAccess", "config.deployConcurrency"],
  );
  assert.equal(byId(r, "agent.bootstrap").severity, "warn");
  assert.equal(byId(r, "agent.bootstrap").detail, READINESS_MESSAGES.notProvisioned);
});

test("a trust-revoked server (certFingerprint: '') is fenced exactly like an unprovisioned one", () => {
  // `removeServer` revokes trust by writing "" — not NULL — so the empty string is a second
  // sentinel and must be treated as "there is no agent on the other end".
  const server = srv({
    agent: { port: 9443, certFingerprint: "", certPem: "", version: "" },
  });
  const r = classifyServerReadiness(probe({ server }));
  assert.equal(r.verdict, "provisioning");
  assert.deepEqual(
    r.checks.map((c) => c.id),
    ["agent.bootstrap", "config.teamAccess", "config.deployConcurrency"],
  );
  assert.equal(byId(r, "agent.bootstrap").severity, "warn");
});

/* ------------------------------------------------------------------ */
/* 4-7. the dial failed                                                */
/* ------------------------------------------------------------------ */

test("an unreachable agent produces ONE failed row, not a wall of grey skips", () => {
  const r = classifyServerReadiness(
    probe({
      hello: null,
      helloError: new AgentUnreachableError("no connection", GrpcStatus.UNAVAILABLE),
      port80: { kind: "skipped" },
      port443: { kind: "skipped" },
      metrics: null,
    }),
  );
  assert.equal(r.verdict, "not_ready");
  assert.equal(countOf(r, "fail"), 1);
  assert.equal(byId(r, "agent.hello").severity, "fail");
  assert.equal(byId(r, "agent.hello").detail, READINESS_MESSAGES.refused);
  // Nothing the dead agent could have told us is invented.
  for (const g of ["docker", "routing", "capacity", "build"]) {
    assert.equal(
      r.checks.some((c) => c.group === g),
      false,
      `fabricated a ${g} row for an agent that never answered`,
    );
  }
});

test("a deadline overrun says so specifically", () => {
  const r = classifyServerReadiness(
    probe({
      hello: null,
      helloError: new AgentUnreachableError("deadline", GrpcStatus.DEADLINE_EXCEEDED),
    }),
  );
  assert.equal(byId(r, "agent.hello").detail, READINESS_MESSAGES.timedOut);
});

test("a cert-pin mismatch is `untrusted`, NEVER 'did not answer' — the peer answered, it just isn't ours", () => {
  const r = classifyServerReadiness(
    probe({
      hello: null,
      helloError: new AgentUnreachableError(
        "agent cert fingerprint mismatch",
        GrpcStatus.UNAVAILABLE,
        true,
      ),
    }),
  );
  assert.equal(byId(r, "agent.hello").severity, "fail");
  assert.equal(byId(r, "agent.hello").detail, READINESS_MESSAGES.untrusted);
  assert.equal(byId(r, "agent.hello").hint, READINESS_HINTS.reissue);
});

test("an application-level gRPC error is the generic agent error", () => {
  const err = Object.assign(new Error("failed precondition"), {
    code: GrpcStatus.FAILED_PRECONDITION,
  });
  const r = classifyServerReadiness(probe({ hello: null, helloError: err }));
  assert.equal(byId(r, "agent.hello").detail, READINESS_MESSAGES.agentError);
});

/* ------------------------------------------------------------------ */
/* 8. the contract is wrong                                            */
/* ------------------------------------------------------------------ */

test("a contract mismatch fails the protocol row and trusts NOTHING else the agent said", () => {
  const r = classifyServerReadiness(
    probe({ hello: hello({ contractVersion: ContractVersion.CONTRACT_VERSION_UNSPECIFIED }) }),
  );
  assert.equal(byId(r, "agent.hello").severity, "pass");
  assert.equal(byId(r, "agent.contract").severity, "fail");
  assert.equal(byId(r, "agent.contract").detail, READINESS_MESSAGES.contract);
  assert.equal(r.verdict, "not_ready");
  for (const g of ["docker", "routing", "capacity", "build"]) {
    assert.equal(
      r.checks.some((c) => c.group === g),
      false,
      `reported a ${g} row from an agent speaking a protocol we don't understand`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 9. the no-leak invariant                                            */
/* ------------------------------------------------------------------ */

test("a report NEVER leaks the pinned fingerprint or the dial address, in ANY failure branch", () => {
  // The raw errors carry our trust anchor and the dial address. They go to console.error in
  // lib/data/server-readiness.ts and nowhere else — this is the assertion that keeps the
  // closed message set closed.
  const raw =
    "14 UNAVAILABLE: agent cert fingerprint mismatch: pinned deadbeefcafe, got 0badf00d (10.4.2.9:9443)";
  const reports = [
    classifyServerReadiness(
      probe({
        hello: null,
        helloError: new AgentUnreachableError(raw, GrpcStatus.UNAVAILABLE, true),
      }),
    ),
    classifyServerReadiness(
      probe({ hello: null, helloError: new AgentUnreachableError(raw, GrpcStatus.UNAVAILABLE) }),
    ),
    classifyServerReadiness(
      probe({
        hello: null,
        helloError: Object.assign(new Error(raw), { code: GrpcStatus.INTERNAL }),
      }),
    ),
  ];

  const closed: string[] = Object.values(READINESS_MESSAGES);
  for (const r of reports) {
    for (const c of r.checks) {
      for (const s of [c.detail, c.hint ?? ""]) {
        assert.ok(!/fingerprint/i.test(s), `leaked the word fingerprint: ${s}`);
        assert.ok(!/deadbeefcafe|0badf00d/i.test(s), `leaked cert material: ${s}`);
        assert.ok(!/10\.4\.2\.9|9443/.test(s), `leaked the dial address: ${s}`);
      }
      if (c.severity === "fail")
        assert.ok(closed.includes(c.detail), `failure detail escaped the closed set: ${c.detail}`);
    }
    assert.ok(!/deadbeefcafe|0badf00d|9443/.test(r.summary));
  }
});

/* ------------------------------------------------------------------ */
/* 10-15. docker + routing                                             */
/* ------------------------------------------------------------------ */

test("Docker down fails the engine row AND SKIPS Traefik — the agent forces traefikRunning false, so we never looked", () => {
  const r = classifyServerReadiness(
    probe({ hello: hello({ dockerAvailable: false, traefikRunning: false }) }),
  );
  assert.equal(byId(r, "docker.available").severity, "fail");
  assert.equal(byId(r, "docker.available").detail, READINESS_MESSAGES.dockerDown);
  assert.equal(byId(r, "routing.traefik").severity, "skip");
  assert.equal(byId(r, "routing.traefik").detail, READINESS_MESSAGES.traefikUnknown);
  assert.equal(r.verdict, "not_ready");
});

test("Traefik being down (with Docker up) is a WARN, never a fail — a DB/worker host legitimately has none", () => {
  // Same call lib/infra/server-health.test.ts:46 makes: a status that fires on a normal
  // configuration is a status operators learn to ignore.
  const r = classifyServerReadiness(
    probe({
      hello: hello({ traefikRunning: false }),
      port80: { kind: "free" },
      port443: { kind: "free" },
    }),
  );
  assert.equal(byId(r, "routing.traefik").severity, "warn");
  assert.equal(byId(r, "routing.traefik").detail, READINESS_MESSAGES.traefikDown);
  assert.equal(r.verdict, "degraded");
  assert.equal(countOf(r, "fail"), 0);
});

test("Traefik up + both web ports held → both port rows pass", () => {
  const r = classifyServerReadiness(probe());
  assert.equal(byId(r, "routing.port80").severity, "pass");
  assert.equal(byId(r, "routing.port80").detail, READINESS_DETAILS.portHeldWithTraefik(80));
  assert.equal(byId(r, "routing.port443").severity, "pass");
  assert.equal(byId(r, "routing.port443").detail, READINESS_DETAILS.portHeldWithTraefik(443));
});

test("Traefik up but :80 free → warn: it is up and not publishing the web ports", () => {
  const r = classifyServerReadiness(probe({ port80: { kind: "free" } }));
  assert.equal(byId(r, "routing.port80").severity, "warn");
  assert.equal(byId(r, "routing.port80").detail, READINESS_DETAILS.portFreeWithTraefik(80));
  assert.equal(byId(r, "routing.port443").severity, "pass");
  // NOT the install-Traefik hint: Traefik is already up, and "Normal for a database-only or
  // worker host" would invite the operator to dismiss the one row explaining the 404s.
  assert.equal(byId(r, "routing.port80").hint, READINESS_HINTS.publishWebPorts);
  assert.ok(!/^Normal for/.test(byId(r, "routing.port80").hint!));
});

test("Traefik down but :80 held → warn: another process owns the web port, so Traefik cannot bind it", () => {
  // The report's most valuable finding: the classic broken install.
  const r = classifyServerReadiness(probe({ hello: hello({ traefikRunning: false }) }));
  assert.equal(byId(r, "routing.port80").severity, "warn");
  assert.equal(byId(r, "routing.port80").detail, READINESS_DETAILS.portHeldNoTraefik(80));
  assert.equal(byId(r, "routing.port80").hint, READINESS_HINTS.freeWebPort);
});

test("Traefik down + :80 free is INFO, not a second warn — the Traefik row already carries it", () => {
  const r = classifyServerReadiness(
    probe({
      hello: hello({ traefikRunning: false }),
      port80: { kind: "free" },
      port443: { kind: "free" },
    }),
  );
  assert.equal(byId(r, "routing.port80").severity, "info");
  assert.equal(byId(r, "routing.port80").detail, READINESS_DETAILS.portFreeNoTraefik(80));
  assert.equal(byId(r, "routing.port443").severity, "info");
  // Exactly one warn: the Traefik row itself.
  assert.equal(countOf(r, "warn"), 1);
});

/* ------------------------------------------------------------------ */
/* 16. an old agent that cannot bind-test ports                        */
/* ------------------------------------------------------------------ */

test("CheckPort unsupported → both port rows skip, and a skip NEVER moves the verdict", () => {
  // "We didn't look" is not "it's broken" — degrading to a skipped row is the honest answer,
  // and it must not cost the operator a red banner.
  const r = classifyServerReadiness(
    probe({ port80: { kind: "unsupported" }, port443: { kind: "unsupported" } }),
  );
  assert.equal(r.verdict, "ready");
  assert.equal(byId(r, "routing.port80").severity, "skip");
  assert.equal(byId(r, "routing.port80").detail, READINESS_DETAILS.portUnsupported(80));
  assert.equal(byId(r, "routing.port80").hint, READINESS_HINTS.updateAgent);
  assert.equal(byId(r, "routing.port443").severity, "skip");
  assert.equal(byId(r, "routing.port443").detail, READINESS_DETAILS.portUnsupported(443));
});

/* ------------------------------------------------------------------ */
/* 17-18. build methods                                                */
/* ------------------------------------------------------------------ */

test("an agent missing deploy.nixpacks warns on THAT row only", () => {
  const caps = ALL_CAPS.filter((c) => c !== "deploy.nixpacks");
  const r = classifyServerReadiness(probe({ hello: hello({ capabilities: caps }) }));
  assert.equal(byId(r, "build.nixpacks").severity, "warn");
  assert.equal(byId(r, "build.nixpacks").detail, READINESS_DETAILS.buildMissing("Nixpacks"));
  assert.equal(byId(r, "build.nixpacks").hint, READINESS_HINTS.updateAgent);
  const others = r.checks.filter((c) => c.group === "build" && c.id !== "build.nixpacks");
  assert.equal(others.length, BUILD_METHODS.length - 1);
  assert.ok(others.every((c) => c.severity === "pass"));
  assert.equal(r.verdict, "degraded");
});

test("an agent with NO capability list gets one honest skip, not seven fabricated warns", () => {
  const r = classifyServerReadiness(probe({ hello: hello({ capabilities: [] }) }));
  const build = r.checks.filter((c) => c.group === "build");
  assert.equal(build.length, 1);
  assert.equal(build[0].id, "build.unknown");
  assert.equal(build[0].severity, "skip");
  assert.equal(byId(r, "agent.features").severity, "skip");
  assert.equal(byId(r, "agent.features").detail, READINESS_MESSAGES.featuresUnknown);
});

/* ------------------------------------------------------------------ */
/* 19-21. disk                                                         */
/* ------------------------------------------------------------------ */

test("disk headroom: 20% passes, 92% warns, 97% fails the whole report", () => {
  const ok = classifyServerReadiness(probe());
  assert.equal(byId(ok, "capacity.disk").severity, "pass");

  const low = classifyServerReadiness(
    probe({ metrics: metrics({ diskPct: 92, diskUsed: 92 * GB, diskTotal: 100 * GB }) }),
  );
  assert.equal(byId(low, "capacity.disk").severity, "warn");
  assert.equal(byId(low, "capacity.disk").hint, READINESS_HINTS.freeDisk);
  assert.equal(low.verdict, "degraded");

  const critical = classifyServerReadiness(
    probe({ metrics: metrics({ diskPct: 97, diskUsed: 97 * GB, diskTotal: 100 * GB }) }),
  );
  assert.equal(byId(critical, "capacity.disk").severity, "fail");
  assert.equal(critical.verdict, "not_ready");
});

test("diskTotal === 0 means statfs FAILED — that is a skip, never '0% used'", () => {
  const r = classifyServerReadiness(
    probe({ metrics: metrics({ diskTotal: 0, diskUsed: 0, diskPct: 0 }) }),
  );
  assert.equal(byId(r, "capacity.disk").severity, "skip");
  assert.equal(byId(r, "capacity.disk").detail, READINESS_MESSAGES.diskUnmeasured);
  assert.equal(r.verdict, "ready");
});

test("no metrics at all → the disk row is skipped, and says so", () => {
  const r = classifyServerReadiness(probe({ metrics: null }));
  assert.equal(byId(r, "capacity.disk").severity, "skip");
  assert.equal(byId(r, "capacity.disk").detail, READINESS_MESSAGES.metricsUnavailable);
});

test("an unset disk_pct (proto3 default 0) is classified from used/total — never a green 98%-full pass", () => {
  // `diskPct` is a proto3 double with no field presence: an agent that fills disk_total /
  // disk_used but not disk_pct arrives here as 0. Classifying on the raw field while printing
  // the used/total fallback rendered a nearly-full host as `pass`.
  for (const diskPct of [0, Number.NaN]) {
    const r = classifyServerReadiness(
      probe({ metrics: metrics({ diskPct, diskUsed: 98 * GB, diskTotal: 100 * GB }) }),
    );
    assert.equal(byId(r, "capacity.disk").severity, "fail", `diskPct=${diskPct}`);
    assert.equal(r.verdict, "not_ready");
  }
});

test("the disk percentage shown is the one classified — a fraction never crosses a threshold on display", () => {
  // 94.7 must not render "95% full" (the documented hard-fail number) next to a warn icon.
  const warn = classifyServerReadiness(
    probe({ metrics: metrics({ diskPct: 94.7, diskUsed: 94.7 * GB, diskTotal: 100 * GB }) }),
  );
  assert.equal(byId(warn, "capacity.disk").severity, "warn");
  assert.match(byId(warn, "capacity.disk").detail, /is 94% full/);

  // ...and 89.7 must not render "90% full" (the warn number) next to a green tick.
  const ok = classifyServerReadiness(
    probe({ metrics: metrics({ diskPct: 89.7, diskUsed: 89.7 * GB, diskTotal: 100 * GB }) }),
  );
  assert.equal(byId(ok, "capacity.disk").severity, "pass");
  assert.match(byId(ok, "capacity.disk").detail, /is 89% full/);
});

/* ------------------------------------------------------------------ */
/* 22-23. control-plane config                                         */
/* ------------------------------------------------------------------ */

test("a restricted server with zero team grants can never receive a deploy → FAIL", () => {
  const none = classifyServerReadiness(
    probe({ server: srv({ allTeams: false }), grantedTeamCount: 0 }),
  );
  assert.equal(byId(none, "config.teamAccess").severity, "fail");
  assert.equal(byId(none, "config.teamAccess").detail, READINESS_MESSAGES.noTeamAccess);
  assert.equal(none.verdict, "not_ready");

  const some = classifyServerReadiness(
    probe({ server: srv({ allTeams: false }), grantedTeamCount: 2 }),
  );
  assert.equal(byId(some, "config.teamAccess").severity, "info");
  assert.equal(byId(some, "config.teamAccess").detail, "2 teams can deploy to this server.");
  assert.equal(some.verdict, "ready");
});

test("a `fail` outranks `provisioning` — an unreachable, ungranted server is NOT ready", () => {
  const r = classifyServerReadiness(
    probe({
      server: srv({ agent: undefined, allTeams: false }),
      grantedTeamCount: 0,
    }),
  );
  assert.equal(r.verdict, "not_ready");
  assert.equal(r.summary, "Not ready to deploy — 1 check failed.");
});

/* ------------------------------------------------------------------ */
/* 24. agent version                                                   */
/* ------------------------------------------------------------------ */

test("agent version: outdated warns, current passes, and a version we cannot compare is INFO — never 'up to date'", () => {
  const outdated = classifyServerReadiness(
    probe({ hello: hello({ agentVersion: "1.0.0" }), expectedAgentVersion: "1.1.0" }),
  );
  assert.equal(byId(outdated, "agent.version").severity, "warn");
  assert.equal(byId(outdated, "agent.version").detail, READINESS_DETAILS.versionOutdated("1.0.0", "1.1.0"));
  assert.equal(byId(outdated, "agent.version").hint, READINESS_HINTS.updateAgent);

  const latest = classifyServerReadiness(probe());
  assert.equal(byId(latest, "agent.version").severity, "pass");
  assert.equal(byId(latest, "agent.version").detail, READINESS_DETAILS.versionLatest("1.1.0"));

  const dev = classifyServerReadiness(probe({ hello: hello({ agentVersion: "dev" }) }));
  assert.equal(byId(dev, "agent.version").severity, "info");
  assert.equal(byId(dev, "agent.version").detail, READINESS_DETAILS.versionUncomparable("dev"));

  const missing = classifyServerReadiness(probe({ hello: hello({ agentVersion: "" }) }));
  assert.equal(byId(missing, "agent.version").severity, "info");
  assert.equal(byId(missing, "agent.version").detail, READINESS_DETAILS.versionUnreported);
});

/* ------------------------------------------------------------------ */
/* 25. verdict precedence                                              */
/* ------------------------------------------------------------------ */

test("readinessVerdict: fail beats everything, skips alone leave `ready`, provisioning outranks warn", () => {
  const row = (severity: ReadinessCheck["severity"]): ReadinessCheck => ({
    id: `x.${severity}`,
    group: "agent",
    label: "x",
    severity,
    detail: "d",
  });
  assert.equal(readinessVerdict([row("fail"), row("warn")], { provisioning: false }), "not_ready");
  assert.equal(readinessVerdict([row("fail")], { provisioning: true }), "not_ready");
  assert.equal(readinessVerdict([row("skip"), row("pass")], { provisioning: false }), "ready");
  assert.equal(readinessVerdict([row("warn")], { provisioning: true }), "provisioning");
  assert.equal(readinessVerdict([row("warn")], { provisioning: false }), "degraded");
  assert.equal(readinessVerdict([row("info"), row("pass")], { provisioning: false }), "ready");
});

/* ------------------------------------------------------------------ */
/* 26-27. the honesty guards                                           */
/* ------------------------------------------------------------------ */

test("a supported build method NEVER claims the tool is installed on the host", () => {
  // A Hello flag is a compiled-in constant of the agent BINARY. It proves the agent knows how
  // to run a Nixpacks build; the nixpacks binary is downloaded on the first such build. If
  // someone rewrites this copy to say "Nixpacks installed", this test fails — on purpose.
  const r = classifyServerReadiness(probe());
  const passes = r.checks.filter((c) => c.group === "build" && c.severity === "pass");
  assert.equal(passes.length, BUILD_METHODS.length);
  for (const c of passes) {
    assert.ok(
      c.detail.startsWith("The agent supports "),
      `a build row must say what the flag PROVES: ${c.detail}`,
    );
    // The guard hunts for a CLAIM. The copy's explicit DENIALS ("nothing is installed on the
    // host") are the opposite of one — they are what honesty looks like here — so they are
    // dropped before the hunt. Everything that survives is an assertion the row is making.
    const claimed = c.detail.replace(/nothing is installed on the host/gi, "");
    assert.ok(
      !/\binstalled on (the|this) host\b/i.test(claimed),
      `a Hello flag is not proof of an installed binary: ${c.detail}`,
    );
  }
});

test("a `ready` report with skipped rows NEVER claims 'every check passed'", () => {
  // A skip must not move the verdict ("we didn't look" is not "it's broken") — but it must not
  // be laundered into a pass by the one sentence the operator actually reads either.
  const ports = classifyServerReadiness(
    probe({ port80: { kind: "unsupported" }, port443: { kind: "unsupported" } }),
  );
  assert.equal(ports.verdict, "ready");
  assert.ok(!/every check passed/.test(ports.summary), ports.summary);
  assert.match(ports.summary, /2 could not be checked\.$/);

  // The worst shape: an agent reporting no capabilities at all. Deplo has verified NOTHING
  // about whether it can run any build method, and never bind-tested the web ports.
  const blind = classifyServerReadiness(
    probe({
      hello: hello({ capabilities: [] }),
      port80: { kind: "unsupported" },
      port443: { kind: "unsupported" },
    }),
  );
  assert.equal(blind.verdict, "ready");
  assert.ok(!/every check passed/.test(blind.summary), blind.summary);

  // The genuinely clean report still says it plainly.
  assert.equal(
    classifyServerReadiness(probe()).summary,
    "Ready to deploy — every check passed.",
  );
});

test("the Traefik row states what it OBSERVED, and never promises routing works", () => {
  // The signal is a substring match over running containers' image/name — it matches a
  // bring-your-own proxy, and cannot see whether the container is on the `deplo` network app
  // routers are pinned to. The copy may not turn that into a guarantee.
  const detail = byId(classifyServerReadiness(probe()), "routing.traefik").detail;
  assert.ok(!/\bso apps\b/i.test(detail), `promised a routing outcome: ${detail}`);
  assert.match(detail, /cannot verify/i);
});

test("a `pass` row never carries a hint — there is nothing to do about good news", () => {
  const reports = [
    classifyServerReadiness(probe()),
    classifyServerReadiness(probe({ hello: hello({ traefikRunning: false }) })),
    classifyServerReadiness(probe({ hello: hello({ capabilities: [] }) })),
    classifyServerReadiness(probe({ server: srv({ agent: undefined }) })),
  ];
  for (const r of reports)
    for (const c of r.checks.filter((c) => c.severity === "pass"))
      assert.equal(c.hint, undefined, `a pass row carried a hint: ${c.id}`);
});
