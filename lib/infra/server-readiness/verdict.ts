import type {
  ReadinessCheck,
  ReadinessProbe,
  ReadinessReport,
  ReadinessVerdict,
} from "./types";

/**
 * `fail` beats everything - a brand-new server no team can reach is "not ready", not
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

// readinessSummary - the banner sentence; a `skip` must not be laundered into a pass here.
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
      return "No agent has called home for this server yet - run its install command on the host.";
    case "not_ready":
      return `Not ready to deploy - ${fails === 1 ? "1 check failed" : `${fails} checks failed`}.`;
    case "degraded":
      return `Deploys will run, but ${warns === 1 ? "1 check needs" : `${warns} checks need`} attention.`;
    case "ready":
      return skips === 0
        ? "Ready to deploy - every check passed."
        : `Deploys should run - ${passes === 1 ? "1 check passed" : `${passes} checks passed`}, ${skips === 1 ? "1 could not be checked" : `${skips} could not be checked`}.`;
  }
}

// report - the finished ReadinessReport for a probe and the rows it produced.
export function report(
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
