import { dataDir } from "../data-dir";

// Healthy once something LISTENs (state 0A) on `port`. Plain POSIX sh: no curl, nc or grep in the image.
export function portProbeCommand(port: number, procNet = "/proc/net"): string {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return (
    `for f in ${procNet}/tcp ${procNet}/tcp6; do [ -r "$f" ] || continue; ` +
    `while read -r _ a _ s _; do [ "$s" = 0A ] && [ "\${a##*:}" = ${hex} ] && exit 0; done < "$f"; ` +
    `done; exit 1`
  );
}

// An agent with Hello `deploy.probe` keeps its own binary in the stack directory's `.deplo-probe`: mounted
// read-only, it is the same check with nothing needed from the image, a shell least of all (deplo#281).
export const AGENT_PROBE_DIR = "/.deplo-probe";
const AGENT_PROBE = `${AGENT_PROBE_DIR}/deplo-agent`;

/** The mount an agent probe runs from; the agent's `--stack-dir` is `<data dir>/stacks`, as for Files. */
export function agentProbeMount(): string {
  return `${dataDir()}/stacks/.deplo-probe:${AGENT_PROBE_DIR}:ro`;
}

// The health check that runs it; `$$` is how a compose file spells a `$` the shell must receive.
export function portProbeHealthCheck(
  port: number,
  agentProbe = false,
): Record<string, unknown> {
  return {
    test: agentProbe
      ? ["CMD", AGENT_PROBE, "probe", String(port)]
      : ["CMD-SHELL", portProbeCommand(port).replace(/\$/g, "$$$$")],
    interval: "30s",
    timeout: "5s",
    retries: 3,
    start_period: "180s",
  };
}

/** A health check that runs the agent's probe, so its service must mount it. */
export function runsAgentProbe(healthcheck: unknown): boolean {
  const test =
    healthcheck && typeof healthcheck === "object"
      ? (healthcheck as { test?: unknown }).test
      : null;
  return Array.isArray(test) && test[0] === "CMD" && test[1] === AGENT_PROBE;
}
