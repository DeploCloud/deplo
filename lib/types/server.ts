import type { ID } from "./identity";

export type ServerStatus =
  "online" | "warning" | "error" | "offline" | "provisioning";

export interface ServerAgent {
  port: number;
  certFingerprint: string;
  certPem: string;
  version: string;
}

export interface ServerBootstrap {
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
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
  importOnly: boolean;
  uninstallPending: boolean;
  uninstallError: string;
  hostArch: string;
  deployConcurrency: number;
  /** Offer this server canary agent releases as updates. */
  agentCanary: boolean;
  createdAt: string;
  agent?: ServerAgent;
  bootstrap?: ServerBootstrap;
  lastSeenAt?: string;
  statusCheckedAt?: string;
  statusMessage?: string;
}
