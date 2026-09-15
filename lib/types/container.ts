import type { ID } from "./identity";

export const MOUNT_PROPAGATIONS = ["rslave", "rshared"] as const;
export type MountPropagation = (typeof MOUNT_PROPAGATIONS)[number];

export interface VolumeMount {
  id: ID;
  type?: "named" | "app" | "host";
  name: string;
  projectPath?: string;
  hostPath?: string;
  service?: string | null;
  mountPath: string;
  readOnly: boolean;
  propagation?: MountPropagation;
}

export const MAX_PUBLISHED_PORTS = 20;

export interface PublishedPort {
  id: ID;
  published: number;
  target: number;
  protocol: "tcp" | "udp";
}

export interface ResourceLimits {
  memoryMb: number | null;
  memoryReservationMb: number | null;
  swapMb: number | null;
  cpuMilli: number | null;
  cpuShares: number | null;
  cpuset: string | null;
  pidsLimit: number | null;
  shmSizeMb: number | null;
  storageGb: number | null;
  nofile: number | null;
  nproc: number | null;
  oomScoreAdj: number | null;
}

export interface HealthCheck {
  type: "http" | "command";
  path: string | null;
  port: number | null;
  command: string | null;
  intervalS: number;
  timeoutS: number;
  retries: number;
  startPeriodS: number;
}
