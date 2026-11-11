// Healthy once something LISTENs (state 0A) on `port`. Plain POSIX sh: no curl, nc or grep in the image.
export function portProbeCommand(port: number, procNet = "/proc/net"): string {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return (
    `for f in ${procNet}/tcp ${procNet}/tcp6; do [ -r "$f" ] || continue; ` +
    `while read -r _ a _ s _; do [ "$s" = 0A ] && [ "\${a##*:}" = ${hex} ] && exit 0; done < "$f"; ` +
    `done; exit 1`
  );
}

// The health check that runs it; `$$` is how a compose file spells a `$` the shell must receive.
export function portProbeHealthCheck(port: number): Record<string, unknown> {
  return {
    test: ["CMD-SHELL", portProbeCommand(port).replace(/\$/g, "$$$$")],
    interval: "30s",
    timeout: "5s",
    retries: 3,
    start_period: "180s",
  };
}
