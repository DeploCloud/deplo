// READINESS_MESSAGES - every failure reason string this classifier can produce.
export const READINESS_MESSAGES = {
  notProvisioned:
    "No agent has been provisioned for this server yet - nothing has called home, so there is nothing on the host to check.",
  untrusted:
    "The agent's certificate is not the one we trust for this server. Reissue the install command to re-provision it.",
  contract:
    "The agent speaks an unsupported protocol version, so nothing else it reports can be trusted.",
  agentError:
    "The agent answered with an error. Check the agent's logs on the host.",
  refused:
    "The agent did not answer (connection refused). Is it running on the host?",
  timedOut: "The agent did not answer within the readiness check's deadline.",
  featuresUnknown:
    "This agent does not report which features it supports - it predates the feature list.",
  dockerDown:
    "The agent is up, but the Docker daemon did not answer. Nothing can be built or run on this server.",
  traefikDown:
    "No running Traefik container was found on this host. Apps deployed here will start, but they won't be reachable on their domains.",
  traefikUnknown:
    "Docker is unreachable, so the agent could not see whether a Traefik container is running.",
  metricsUnavailable:
    "The agent did not report host metrics, so disk headroom was not checked.",
  diskUnmeasured:
    "The agent could not measure the host's filesystem, so disk headroom was not checked.",
  noTeamAccess:
    "No team can deploy to this server: it is restricted, but no team has been granted access.",
} as const;

// READINESS_HINTS - every remediation this classifier can suggest.
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
    "Normal for a database-only or worker host. Otherwise re-run the install command on the host - it brings Traefik up.",
  // NOT installTraefik: Traefik is already running here, so calling this "normal" would invite
  // the operator to dismiss the one row explaining why every domain on this host 404s.
  publishWebPorts:
    "Traefik is running but is not publishing the web ports. Check its port bindings on the host, then re-run the install command so it binds them.",
  freeWebPort:
    "Stop whatever holds the port on the host, then re-run the install command so Traefik can bind it.",
  freeDisk:
    "Free space on the host - remove unused images and build caches (docker system prune -af).",
  retry:
    "Run the check again; if it keeps failing, check the agent's logs on the host.",
  grantTeamAccess:
    "Grant a team access (Server actions → Team access), or open the server to all teams.",
} as const;

// READINESS_DETAILS - interpolating copy; every argument is control-plane-owned, never error text.
export const READINESS_DETAILS = {
  helloOk:
    "The agent answered a live handshake over its pinned, mutually-authenticated connection.",
  contractOk: "The agent speaks the V1 agent contract this control plane uses.",
  versionUnreported: "The agent did not report a version.",
  versionUncomparable: (v: string) => `The agent reports version "${v}".`,
  versionRunning: (v: string) => `The agent is running v${v}.`,
  featuresAllSupported:
    "This agent supports every platform feature Deplo uses: backups, host metrics, host port checks, in-place agent updates, and moving data between servers.",
  featuresMissing: (names: string[]) =>
    `This agent does not support ${names.length} feature${names.length === 1 ? "" : "s"} Deplo uses (${names.join(", ")}). Apps still deploy here, but those features won't work on this server.`,
  dockerOk: (version: string) =>
    version
      ? `The Docker daemon answered on the host - engine ${version}.`
      : "The Docker daemon answered on the host.",
  dockerSkippedStorageOnly:
    "This server only stores backups, so Docker is not installed. Nothing is deployed here.",
  traefikSkippedBuildOnly:
    "This server only builds images, so no proxy is installed. Nothing is routed here.",
  traefikOk:
    'A container whose image or name contains "traefik" is running on this host - consistent with a proxy that can route apps to their domains. Deplo cannot verify from here that it is the one it installed, or that it is on the Deplo network.',
  portHeldWithTraefik: (port: number) =>
    `Port ${port} is held by a listener on the host, and a Traefik container is running - consistent with Traefik serving it.`,
  portHeldNoTraefik: (port: number) =>
    `Port ${port} is already held on the host, but no Traefik container is running. Another process owns the web port, so Traefik cannot bind it.`,
  portHeldTraefikUnknown: (port: number) =>
    `Port ${port} is held by a listener on the host.`,
  portFreeWithTraefik: (port: number) =>
    `Nothing is listening on port ${port}, although a Traefik container is running - it is up but not publishing the web ports, so apps here won't be reachable on their domains.`,
  portFreeNoTraefik: (port: number) =>
    `Nothing is listening on port ${port} - consistent with no Traefik container running on this host.`,
  portFreeTraefikUnknown: (port: number) =>
    `Nothing is listening on port ${port}.`,
  portUnsupported: (port: number) =>
    `This server's agent is too old to test host ports, so port ${port} was not checked.`,
  portFailed: (port: number) =>
    `Port ${port} could not be checked on the host.`,
  portSkipped: (port: number) => `Port ${port} was not checked.`,
  diskOk: (pct: number, free: string) =>
    `The host's root filesystem is ${pct}% full (${free} free).`,
  diskLow: (pct: number, free: string) =>
    `The host's root filesystem is ${pct}% full (${free} free). Builds and image pulls may start failing.`,
  diskCritical: (pct: number, free: string) =>
    `The host's root filesystem is ${pct}% full (${free} free). A build or an image pull will almost certainly fail.`,
  buildMissing: (label: string) =>
    `This server's agent does not support ${label} builds - it predates the feature. An app on this server that builds this way will fail.`,
  teamsAll: "Every team can deploy to this server.",
  teamsSome: (n: number) =>
    `${n} team${n === 1 ? "" : "s"} can deploy to this server.`,
  concurrency: (n: number) =>
    n === 1
      ? "This server runs one deployment at a time."
      : `This server runs up to ${n} deployments at a time.`,
} as const;
