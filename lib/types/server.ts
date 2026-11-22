import type { ID } from "./identity";

export type ServerStatus =
  "online" | "warning" | "error" | "offline" | "provisioning";

export interface ServerAgent {
  certFingerprint: string;
  certPem: string;
  version: string;
}

export interface ServerBootstrap {
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
}

export type AddressFamily = "ipv4" | "ipv6";

/** A server's last reading, against the size it reported. */
export interface ServerUsage {
  cpu: number;
  cores: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}

export interface Server {
  id: ID;
  name: string;
  host: string;
  type: "remote";
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
  traefikEnabled: boolean;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  allTeams: boolean;
  storageOnly: boolean;
  buildOnly: boolean;
  buildFallback: boolean | null;
  generatedAddressFamily: AddressFamily | null;
  importOnly: boolean;
  uninstallPending: boolean;
  uninstallError: string;
  hostArch: string;
  deployConcurrency: number;
  createdAt: string;
  agent?: ServerAgent;
  bootstrap?: ServerBootstrap;
  lastSeenAt?: string;
  statusCheckedAt?: string;
  statusMessage?: string;
  /** When its agent first linked (ADR-0041). */
  firstLinkedAt?: string;
  /** When an instance admin let the update stop pass without it: until it links, only a reinstall brings it back. */
  leftBehindAt?: string;
  /** The server the installer enrolled for the machine Deplo runs on (ADR-0050). */
  deploHost?: boolean;
  /** Where its agent link last came from; information only, never an identity. */
  connectedFrom?: string;
  /** That address was none of its own: it sits behind a router. */
  behindRouter?: boolean;
}
