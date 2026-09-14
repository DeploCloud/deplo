import type { ID } from "./identity";

// ServerStatus - health as last OBSERVED by a live agent `Hello` probe, not a
// lifecycle the control plane drives.
export type ServerStatus =
  "online" | "warning" | "error" | "offline" | "provisioning";

// ServerAgent - the agent trust + reachability material for a server.
export interface ServerAgent {
  // The TCP port the agent's gRPC listener is on (default 9443).
  port: number;
  // sha256(DER) of the agent's signed server cert, lowercase hex - the pinning
  // identity. The control plane trusts an agent iff the cert it presents on dial
  // matches this. Cleared on removal to revoke trust.
  certFingerprint: string;
  // The agent's signed server certificate, PEM (public; diagnostics/renewal).
  certPem: string;
  // The agent binary version reported at the last successful Hello.
  version: string;
}

// ServerBootstrap - the one-time bootstrap secret for a provisioning server.
// Only the token's sha256 is stored, like a {@link RegistrationLink}.
export interface ServerBootstrap {
  // sha256 of the raw one-time token; the raw token lives only in the install command.
  tokenHash: string;
  // When the token expires (ISO). Past it, call-home is refused.
  expiresAt: string;
  // Set once the agent has called home and been provisioned.
  usedAt: string | null;
}

export interface Server {
  id: ID;
  name: string;
  // The server's reachable IP/host (the host running Deplo is dialed the same way).
  host: string;
  // Every server is reached only through its agent over mTLS, the host running
  // Deplo included, so there is no longer a special "localhost" kind.
  type: "remote";
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
  traefikEnabled: boolean;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  // Team access scope.
  allTeams: boolean;
  // A server bought purely to HOLD BACKUPS: the agent is installed, Docker is
  // not, and nothing is ever deployed here.
  storageOnly: boolean;
  // A server bought purely to COMPILE: Docker is installed, Traefik is not, and
  // no app of any team runs here.
  buildOnly: boolean;
  // Whether this host compiles for an app whose own build server could not. null
  // is automatic, which is the Deplo host and nothing else.
  buildFallback: boolean | null;
  // A server registered ONLY to import from another platform - the host the
  // migration reads its volumes from, nothing else.
  importOnly: boolean;
  // Deplo is still trying to take its agent off this migration source.
  uninstallPending: boolean;
  // Why Deplo could not take its agent off this migration source.
  uninstallError: string;
  // This host's CPU architecture ("amd64" | "arm64"), observed from each Hello.
  // "" when the agent is too old to report it, which keeps the server out of the
  // build-server picker rather than risking an image the target cannot execute.
  hostArch: string;
  // Per-server deploy slots the queue enforces. 1 (the default) = one deploy at a
  // time on this host; deploys on other servers still run in parallel.
  deployConcurrency: number;
  createdAt: string;
  // Agent trust material - absent only while a server is still `provisioning`.
  agent?: ServerAgent;
  // The pending call-home bootstrap secret, cleared once the agent is provisioned.
  bootstrap?: ServerBootstrap;
  // Last time the agent answered (ISO). A CACHE behind the live-read health
  // check, never the source of truth.
  lastSeenAt?: string;
  // When [[Server.status]] was last OBSERVED, i.e. when a probe recorded a result.
  statusCheckedAt?: string;
  // The operator-facing reason behind a non-`online` status, from the closed set
  // in `classifyServerHealth`. Absent when `online` or never probed.
  statusMessage?: string;
}
