import type { SourceMember, SourceSchedule, SourceServer } from "../../model";
import type {
  CoolifyS3Storage,
  CoolifyScheduledTask,
  CoolifyServer,
  CoolifyUser,
} from "../client";

export function coolifyIsPanelHost(row: CoolifyServer): boolean {
  return row.ip?.trim() === "host.docker.internal" || row.id === 0;
}

export function coolifyServer(row: CoolifyServer): SourceServer {
  return {
    serverId: coolifyIsPanelHost(row) ? "" : row.uuid,
    name: row.name?.trim() || row.uuid,
    ipAddress: coolifyIsPanelHost(row) ? null : (row.ip ?? null),
  };
}

export function coolifyMember(row: CoolifyUser): SourceMember {
  return {
    id: row.id == null ? undefined : String(row.id),
    role: row.pivot?.role?.trim() || row.role?.trim() || null,
    email: row.email ?? null,
    name: row.name ?? null,
  };
}

const CRON_WORDS: Record<string, string> = {
  every_minute: "* * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  monthly: "0 0 1 * *",
  yearly: "0 0 1 1 *",
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

export function coolifySchedule(row: CoolifyScheduledTask): SourceSchedule {
  const raw = (row.frequency ?? "").trim();
  return {
    scheduleId: row.uuid,
    name: row.name?.trim() || row.uuid,
    cronExpression: CRON_WORDS[raw] ?? raw,
    command: row.command ?? null,
    serviceName: row.container ?? null,
    enabled: row.enabled ?? true,
  };
}

export function coolifyDestination(row: CoolifyS3Storage): {
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  const endpoint = row.endpoint?.trim();
  const bucket = row.bucket?.trim();
  if (!endpoint || !bucket || !row.key?.trim() || !row.secret?.trim())
    return null;
  return {
    name: row.name?.trim() || bucket,
    endpoint,
    bucket,
    region: row.region?.trim() || "us-east-1",
    accessKeyId: row.key.trim(),
    secretAccessKey: row.secret.trim(),
  };
}
